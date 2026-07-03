import type { ConfluenceClient } from './confluenceClient.js';
import { ConfluenceClientError } from './confluenceClient.js';
import type { ConfluenceWriteStore, PendingWrite } from './confluenceWriteStore.js';
import type { EntityRef, EntityRefBus } from './kernel-types.js';

/**
 * Write-side business logic. Mirrors `confluenceCore.ts` (the read side) but
 * for the gated create/update/comment operations.
 *
 * Everything that protects the operator lives here, server-side — exactly as
 * `wrapWithSpaceScope` protects reads:
 *   - space-scope: update/comment fetch the target page and reject if it is
 *     not in the configured space; create forces `space.key` in the client.
 *   - version concurrency: update fetches the current version and stages
 *     `current + 1`, so a stale write surfaces as a 409 instead of a silent
 *     clobber.
 *   - confirm gate: `prepare*` never writes — it stages a validated descriptor
 *     and returns a token + preview. Only `commitWrite(token)` mutates
 *     Confluence, and it executes the stored descriptor verbatim.
 *
 * `op: 'write'` EntityRefs are published on commit (not on prepare) so the
 * transcript records the mutation, not the dry-run.
 */

export const MAX_TITLE_CHARS = 255;
export const MAX_BODY_CHARS = 100_000;
const PREVIEW_EXCERPT_CHARS = 600;

export interface WriteDeps {
  client: ConfluenceClient;
  entityRefBus: EntityRefBus;
  store: ConfluenceWriteStore;
}

export interface CreatePagePrepareInput {
  title: string;
  body_storage: string;
  parent_id?: string;
}

export interface UpdatePagePrepareInput {
  id: string;
  body_storage: string;
  /** Optional — keeps the existing title when omitted. */
  title?: string;
}

export interface AddCommentPrepareInput {
  page_id: string;
  body_storage: string;
}

/** Returned by every `prepare*` — the agent must surface `preview` to the
 *  operator and only call `confluence_commit_write` once it is confirmed. */
interface PrepareResult {
  status: 'preview';
  action: PendingWrite['kind'];
  write_token: string;
  preview: string;
  instructions: string;
}

const CONFIRM_INSTRUCTIONS =
  'VORSCHAU — es wurde noch NICHTS geschrieben. Zeige dem Nutzer die `preview` ' +
  'und rufe `confluence_commit_write` mit diesem `write_token` ERST auf, nachdem ' +
  'der Nutzer die Änderung ausdrücklich bestätigt hat. Ohne Bestätigung: nicht committen. ' +
  'Der Token ist 5 Minuten gültig und nur einmal verwendbar.';

// --- prepare (phase 1: validate + stage, no write) -------------------------

export async function prepareCreate(
  input: CreatePagePrepareInput,
  deps: WriteDeps,
): Promise<PrepareResult> {
  validateTitle(input.title);
  validateBody(input.body_storage);
  if (input.parent_id !== undefined) {
    const parent = await fetchPageForWrite(deps.client, input.parent_id);
    assertInScope(parent.spaceKey, deps.client.spaceKey);
  }
  const write: PendingWrite = {
    kind: 'create',
    title: input.title,
    bodyStorage: input.body_storage,
    parentId: input.parent_id,
  };
  const preview = renderCreatePreview(write, deps.client.spaceKey);
  return stage(write, preview, deps.store);
}

export async function prepareUpdate(
  input: UpdatePagePrepareInput,
  deps: WriteDeps,
): Promise<PrepareResult> {
  const current = await fetchPageForWrite(deps.client, input.id);
  assertInScope(current.spaceKey, deps.client.spaceKey);
  const title = input.title ?? current.title;
  validateTitle(title);
  validateBody(input.body_storage);
  const write: PendingWrite = {
    kind: 'update',
    id: input.id,
    title,
    bodyStorage: input.body_storage,
    nextVersion: current.version + 1,
    fromVersion: current.version,
  };
  const preview = renderUpdatePreview(write, current.title);
  return stage(write, preview, deps.store);
}

export async function prepareComment(
  input: AddCommentPrepareInput,
  deps: WriteDeps,
): Promise<PrepareResult> {
  const page = await fetchPageForWrite(deps.client, input.page_id);
  assertInScope(page.spaceKey, deps.client.spaceKey);
  validateBody(input.body_storage);
  const write: PendingWrite = {
    kind: 'comment',
    pageId: input.page_id,
    bodyStorage: input.body_storage,
  };
  const preview = renderCommentPreview(write, page.title);
  return stage(write, preview, deps.store);
}

// --- commit (phase 2: execute the staged descriptor) -----------------------

export async function commitWrite(
  token: string,
  deps: WriteDeps,
): Promise<unknown> {
  const entry = deps.store.take(token);
  if (!entry) {
    throw new ConfluenceClientError(
      'write_token unbekannt oder abgelaufen (TTL 5 min, einmalig nutzbar). Erzeuge zuerst eine neue Vorschau.',
      410,
    );
  }
  const w = entry.write;
  let result: unknown;
  let ref: EntityRef;
  switch (w.kind) {
    case 'create': {
      result = await deps.client.createPage({
        title: w.title,
        bodyStorage: w.bodyStorage,
        parentId: w.parentId,
      });
      const created = extractWriteResult(result);
      ref = {
        system: 'confluence',
        model: 'confluence.page',
        id: created.id ?? '0',
        displayName: w.title,
        op: 'write',
      };
      break;
    }
    case 'update': {
      result = await deps.client.updatePage({
        id: w.id,
        title: w.title,
        bodyStorage: w.bodyStorage,
        nextVersion: w.nextVersion,
      });
      ref = {
        system: 'confluence',
        model: 'confluence.page',
        id: w.id,
        displayName: w.title,
        op: 'write',
      };
      break;
    }
    case 'comment': {
      result = await deps.client.addComment({
        pageId: w.pageId,
        bodyStorage: w.bodyStorage,
      });
      ref = {
        system: 'confluence',
        model: 'confluence.page',
        id: w.pageId,
        op: 'write',
      };
      break;
    }
  }
  deps.entityRefBus.publish(ref);
  const summary = extractWriteResult(result);
  return {
    status: 'committed',
    kind: w.kind,
    id: summary.id,
    title: summary.title,
    version: summary.version,
    link: summary.link,
  };
}

// --- validation + scope ----------------------------------------------------

function validateTitle(title: string): void {
  if (typeof title !== 'string' || title.trim().length === 0) {
    throw new ConfluenceClientError('Titel darf nicht leer sein.', 400);
  }
  if (title.length > MAX_TITLE_CHARS) {
    throw new ConfluenceClientError(
      `Titel zu lang (max ${String(MAX_TITLE_CHARS)} Zeichen).`,
      400,
    );
  }
}

function validateBody(body: string): void {
  if (typeof body !== 'string' || body.trim().length === 0) {
    throw new ConfluenceClientError(
      'body_storage darf nicht leer sein (Confluence-Storage-Format, XHTML).',
      400,
    );
  }
  if (body.length > MAX_BODY_CHARS) {
    throw new ConfluenceClientError(
      `body_storage zu groß (max ${String(MAX_BODY_CHARS)} Zeichen) — splitte den Inhalt.`,
      400,
    );
  }
}

function assertInScope(actualSpaceKey: string, configuredSpaceKey: string): void {
  if (actualSpaceKey !== configuredSpaceKey) {
    throw new ConfluenceClientError(
      `Ziel-Seite liegt im Space '${actualSpaceKey}', Schreibzugriff ist auf '${configuredSpaceKey}' beschränkt — verweigert.`,
      403,
    );
  }
}

interface PageWriteMeta {
  title: string;
  spaceKey: string;
  version: number;
}

async function fetchPageForWrite(
  client: ConfluenceClient,
  id: string,
): Promise<PageWriteMeta> {
  const data = await client.getPage(id, 'version,space');
  const rec = asRecord(data);
  if (!rec) {
    throw new ConfluenceClientError(`Seite ${id} nicht gefunden.`, 404);
  }
  const space = asRecord(rec['space']);
  const version = asRecord(rec['version']);
  const spaceKey = space && typeof space['key'] === 'string' ? space['key'] : undefined;
  const versionNumber =
    version && typeof version['number'] === 'number' ? version['number'] : undefined;
  const title = typeof rec['title'] === 'string' ? rec['title'] : '';
  if (spaceKey === undefined || versionNumber === undefined) {
    throw new ConfluenceClientError(
      `Seite ${id} ohne version/space-Metadaten — kann nicht sicher schreiben.`,
      502,
    );
  }
  return { title, spaceKey, version: versionNumber };
}

// --- previews --------------------------------------------------------------

function stage(
  write: PendingWrite,
  preview: string,
  store: ConfluenceWriteStore,
): PrepareResult {
  const write_token = store.stage(write, preview);
  return {
    status: 'preview',
    action: write.kind,
    write_token,
    preview,
    instructions: CONFIRM_INSTRUCTIONS,
  };
}

function renderCreatePreview(
  write: Extract<PendingWrite, { kind: 'create' }>,
  spaceKey: string,
): string {
  const parent = write.parentId ? `\nUnterseite von: ${write.parentId}` : '';
  return (
    `NEUER ENTWURF (Draft) im Space ${spaceKey} — wird NICHT veröffentlicht, ` +
    `sondern als Entwurf angelegt; veröffentlichen muss ein Mensch in Confluence.\n` +
    `Titel: ${write.title}${parent}\n\n` +
    `Inhalt (Auszug):\n${summariseStorage(write.bodyStorage)}`
  );
}

function renderUpdatePreview(
  write: Extract<PendingWrite, { kind: 'update' }>,
  currentTitle: string,
): string {
  const titleLine =
    write.title === currentTitle
      ? `Titel: ${write.title} (unverändert)`
      : `Titel: ${currentTitle} → ${write.title}`;
  return (
    `SEITE AKTUALISIEREN als ENTWURF (Draft) (id ${write.id}, Version ${String(write.fromVersion)} → ${String(write.nextVersion)}) — ` +
    `die Änderung geht NICHT live, sie wird als Entwurf gespeichert; veröffentlichen muss ein Mensch in Confluence.\n` +
    `${titleLine}\n\n` +
    `Neuer Inhalt (Auszug):\n${summariseStorage(write.bodyStorage)}`
  );
}

function renderCommentPreview(
  write: Extract<PendingWrite, { kind: 'comment' }>,
  pageTitle: string,
): string {
  return (
    `KOMMENTAR an Seite "${pageTitle}" (id ${write.pageId})\n\n` +
    `${summariseStorage(write.bodyStorage)}`
  );
}

/** Strip storage-format tags + collapse whitespace for a readable preview. */
function summariseStorage(storage: string): string {
  const text = storage
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > PREVIEW_EXCERPT_CHARS
    ? `${text.slice(0, PREVIEW_EXCERPT_CHARS)}…`
    : text;
}

// --- result extraction -----------------------------------------------------

interface WriteResultSummary {
  id?: string;
  title?: string;
  version?: number;
  link?: string;
}

function extractWriteResult(data: unknown): WriteResultSummary {
  const rec = asRecord(data);
  if (!rec) return {};
  const id = typeof rec['id'] === 'string' ? rec['id'] : undefined;
  const title = typeof rec['title'] === 'string' ? rec['title'] : undefined;
  const version = asRecord(rec['version']);
  const versionNumber =
    version && typeof version['number'] === 'number' ? version['number'] : undefined;
  const links = asRecord(rec['_links']);
  const webui = links && typeof links['webui'] === 'string' ? links['webui'] : undefined;
  const base = links && typeof links['base'] === 'string' ? links['base'] : undefined;
  const link = webui ? `${base ?? ''}${webui}` : undefined;
  return { id, title, version: versionNumber, link };
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;
}
