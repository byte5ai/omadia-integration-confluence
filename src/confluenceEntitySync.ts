import type { ConfluenceClient } from './confluenceClient.js';
import type { EntityIngest, KnowledgeGraph } from './kernel-types.js';

/**
 * Periodically pulls the configured Confluence space's pages into the
 * knowledge graph so `findEntityCapturedTurns` can resolve page titles +
 * ids before any chat turn captures them.
 *
 * Strategy: `/rest/api/search` via CQL on `space = "<key>"`, following the
 * `_links.next` cursor page by page.
 * We explicitly scope to the configured space (hard limit from the agent's
 * Confluence policy — same space-lock as the sub-agent tool), so this never
 * reaches beyond what byte5 would see through the bot anyway.
 *
 * Read-only. Fails soft: a hiccup on one page doesn't fail the whole run,
 * errors are logged with `[confluence-sync]` prefix so they're filterable.
 */

export interface ConfluenceEntitySyncOptions {
  confluence: ConfluenceClient;
  graph: KnowledgeGraph;
  spaceKey: string;
  /** CQL limit per page of results. Keep modest — Atlassian rate-limits. */
  pageSize?: number;
  maxPages?: number;
  log?: (msg: string) => void;
}

export interface ConfluenceSyncResult {
  read: number;
  ingested: number;
  inserted: number;
  updated: number;
  skipped: number;
  error?: string;
  durationMs: number;
}

/** `GET /rest/api/search` answer. Each result wraps its page in `content`. */
interface SearchResponse {
  results?: unknown[];
  start?: number;
  limit?: number;
  size?: number;
  totalSize?: number;
  _links?: { next?: string };
}

interface ContentNode {
  id?: string | number;
  type?: string;
  title?: string;
  status?: string;
  version?: { when?: string };
  history?: { createdDate?: string };
  _links?: { webui?: string };
}

/** One `results[]` entry of the CQL search. */
interface SearchResult {
  content?: ContentNode;
  title?: string;
  url?: string;
  lastModified?: string;
}

/** Where the next request continues, read from `_links.next`. */
interface NextPage {
  start: number;
  cursor?: string;
}

export class ConfluenceEntitySync {
  private readonly pageSize: number;
  private readonly maxPages: number;
  private readonly log: (msg: string) => void;

  constructor(private readonly opts: ConfluenceEntitySyncOptions) {
    this.pageSize = opts.pageSize ?? 50;
    this.maxPages = opts.maxPages ?? 2000;
    this.log = opts.log ?? ((msg: string): void => { console.log(msg); });
  }

  async syncAll(): Promise<ConfluenceSyncResult> {
    const started = Date.now();
    this.log(`[confluence-sync] starting (space=${this.opts.spaceKey})`);
    const result: ConfluenceSyncResult = {
      read: 0,
      ingested: 0,
      inserted: 0,
      updated: 0,
      skipped: 0,
      durationMs: 0,
    };
    // CQL scope: space = "<key>" AND type = "page". Ordered by lastmod so a
    // partial crawl always captures the most recent changes first.
    const cql = `space = "${escapeCql(this.opts.spaceKey)}" AND type = "page" ORDER BY lastmodified DESC`;
    try {
      let page: NextPage = { start: 0 };
      const seen = new Set<string>();
      while (result.read < this.maxPages) {
        const limit = Math.min(this.pageSize, this.maxPages - result.read);
        const response = (await this.opts.confluence.search(cql, limit, undefined, {
          start: page.start,
          ...(page.cursor ? { cursor: page.cursor, next: true } : {}),
        })) as SearchResponse;
        const results = Array.isArray(response.results) ? response.results : [];
        if (results.length === 0) break;
        result.read += results.length;
        await this.ingestBatch(results as SearchResult[], result);
        const next = nextPage(response, page.start + results.length);
        if (!next) break;
        // A server that ignores the cursor would hand back the same page
        // forever; stop instead of re-reading it until maxPages.
        const key = `${String(next.start)}|${next.cursor ?? ''}`;
        if (seen.has(key)) break;
        seen.add(key);
        page = next;
      }
      result.durationMs = Date.now() - started;
      this.log(
        `[confluence-sync] done read=${String(result.read)} ingested=${String(result.ingested)} ins=${String(result.inserted)} upd=${String(result.updated)} skip=${String(result.skipped)} took=${String(result.durationMs)}ms`,
      );
      return result;
    } catch (err) {
      result.durationMs = Date.now() - started;
      const msg = err instanceof Error ? err.message : String(err);
      result.error = msg;
      console.error(`[confluence-sync] FAIL (${String(result.durationMs)}ms):`, msg);
      return result;
    }
  }

  private async ingestBatch(
    results: SearchResult[],
    result: ConfluenceSyncResult,
  ): Promise<void> {
    const batch: EntityIngest[] = [];
    for (const raw of results) {
      const ent = toEntityIngest(raw);
      if (ent) batch.push(ent);
      else result.skipped++;
    }
    if (batch.length === 0) return;
    const ingestResult = await this.opts.graph.ingestEntities(batch);
    result.ingested += ingestResult.entityIds.length;
    result.inserted += ingestResult.inserted;
    result.updated += ingestResult.updated;
  }
}

/**
 * The next page, or `undefined` when the answer has none. Confluence sets
 * `_links.next` only while more results exist; Cloud's link carries an opaque
 * `cursor` (and a `start`), older servers only `start`. Without the link the
 * listing is complete.
 */
function nextPage(response: SearchResponse, fallbackStart: number): NextPage | undefined {
  const link = response._links?.next;
  if (typeof link !== 'string' || link.length === 0) return undefined;
  let params: URLSearchParams;
  try {
    params = new URL(link, 'https://confluence.invalid').searchParams;
  } catch {
    return undefined;
  }
  const startParam = Number(params.get('start'));
  const start = Number.isInteger(startParam) && startParam > 0 ? startParam : fallbackStart;
  const cursor = params.get('cursor') ?? undefined;
  return { start, ...(cursor ? { cursor } : {}) };
}

/**
 * Maps one search result onto an entity. The page lives in `content`; the
 * result's own `title` is highlight-marked and only a fallback. Non-page
 * content (a CQL override could return attachments) is skipped.
 */
function toEntityIngest(raw: SearchResult): EntityIngest | null {
  const content = raw.content ?? (raw as ContentNode);
  if (content.type !== undefined && content.type !== 'page') return null;
  const id = content.id;
  const title =
    typeof content.title === 'string' && content.title.trim().length > 0
      ? content.title.trim()
      : typeof raw.title === 'string'
        ? stripHighlight(raw.title).trim()
        : '';
  if (!id || title.length === 0) return null;
  const lastModified = content.version?.when ?? raw.lastModified;
  const webUiPath = content._links?.webui ?? raw.url;
  return {
    system: 'confluence',
    model: 'confluence.page',
    id: String(id),
    displayName: title,
    extras: {
      ...(content.status ? { status: content.status } : {}),
      ...(lastModified ? { lastModified } : {}),
      ...(content.history?.createdDate ? { createdDate: content.history.createdDate } : {}),
      ...(webUiPath ? { webUiPath } : {}),
    },
  };
}

/** Search titles mark hits as `@@@hl@@@…@@@endhl@@@`. */
function stripHighlight(value: string): string {
  return value.replace(/@@@(?:end)?hl@@@/g, '');
}

function escapeCql(value: string): string {
  // Confluence CQL uses double-quoted strings; escape any embedded quotes so
  // a space-key with punctuation can't break the query.
  return value.replace(/"/g, '\\"');
}
