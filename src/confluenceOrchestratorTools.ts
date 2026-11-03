import { z } from 'zod';

import type { ConfluenceClient } from './confluenceClient.js';
import { getChildren, getPageByTitle, search } from './confluenceCore.js';
import type { EntityRefBus } from './kernel-types.js';

/**
 * Read tools for the ORCHESTRATOR (registered via `ctx.tools.register`), next
 * to the sub-agent toolkit. They answer list questions — "which pages are
 * there about X", "the children of page Y", "recently changed pages" — with
 * FLAT rows (`{ space, count, truncated, pages: [{ id, title, url,
 * last_modified, excerpt }] }`), so the deterministic fast path of the core
 * (`@omadia/fast-path`) can plan them and render the rows without a model.
 *
 * Input is structured, never raw CQL: the CQL is built here with escaped
 * literals and stays hard-scoped to the configured space
 * (`wrapWithSpaceScope`). Read-only; content beyond a short excerpt stays with
 * the sub-agent.
 */

export const SEARCH_PAGES_TOOL = 'search_confluence_pages';
export const LIST_CHILD_PAGES_TOOL = 'list_confluence_child_pages';

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 50;
const MAX_EXCERPT = 200;
const MAX_TERM = 200;

export interface ConfluencePageRow {
  id: string;
  title: string;
  url: string;
  last_modified: string;
  excerpt: string;
}

interface Deps {
  client: ConfluenceClient;
  entityRefBus: EntityRefBus;
}

export interface OrchestratorTool {
  spec: {
    name: string;
    description: string;
    input_schema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  };
  handler: (input: unknown) => Promise<string>;
  promptDoc: string;
}

/** A CQL string literal: backslash and double quote escaped. */
export function cqlLiteral(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

const SearchInput = z
  .object({
    text: z.string().trim().min(1).max(MAX_TERM).optional(),
    title: z.string().trim().min(1).max(MAX_TERM).optional(),
    modified_within_days: z.coerce.number().int().min(1).max(3650).optional(),
    order: z.enum(['relevance', 'last_modified']).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
  })
  .strict();

/** The (unscoped) CQL of a structured search — the core adds the space. */
export function buildSearchCql(input: z.infer<typeof SearchInput>): string {
  const clauses = ['type = page'];
  if (input.title !== undefined) clauses.push(`title ~ ${cqlLiteral(input.title)}`);
  if (input.text !== undefined) {
    const t = cqlLiteral(input.text);
    clauses.push(`(title ~ ${t} OR text ~ ${t})`);
  }
  if (input.modified_within_days !== undefined) {
    clauses.push(`lastmodified >= now("-${String(input.modified_within_days)}d")`);
  }
  const order = input.order ?? (input.text === undefined && input.title === undefined ? 'last_modified' : 'relevance');
  return order === 'last_modified' ? `${clauses.join(' AND ')} ORDER BY lastmodified DESC` : clauses.join(' AND ');
}

const ChildrenInput = z
  .object({
    parent_title: z.string().trim().min(1).max(MAX_TERM),
    limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
  })
  .strict();

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Confluence highlight markers (`@@@hl@@@`) and whitespace out, capped. */
function cleanExcerpt(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const text = raw.replace(/@@@(end)?hl@@@/g, '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  return text.length > MAX_EXCERPT ? `${text.slice(0, MAX_EXCERPT - 1)}…` : text;
}

/** `2026-10-30T09:12:44.000Z` → `2026-10-30`. */
function day(raw: unknown): string {
  return typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : '';
}

function absoluteUrl(baseUrl: string, link: unknown): string {
  if (typeof link !== 'string' || link.length === 0) return '';
  if (/^https?:\/\//.test(link)) return link;
  return `${baseUrl.replace(/\/+$/, '')}${link.startsWith('/') ? '' : '/'}${link}`;
}

/** One flat row from a search hit (`{ content, url, lastModified, excerpt }`)
 *  or a content item (`{ id, title, _links.webui, version.when }`). */
export function pageRow(item: unknown, baseUrl: string): ConfluencePageRow | undefined {
  if (!isRecord(item)) return undefined;
  const content = isRecord(item['content']) ? item['content'] : item;
  const id = content['id'];
  const title = typeof content['title'] === 'string' ? content['title'] : item['title'];
  if ((typeof id !== 'string' && typeof id !== 'number') || typeof title !== 'string') return undefined;
  const links = isRecord(content['_links']) ? content['_links'] : {};
  const version = isRecord(content['version']) ? content['version'] : {};
  return {
    id: String(id),
    title: cleanExcerpt(title) || title,
    url: absoluteUrl(baseUrl, item['url'] ?? links['webui']),
    last_modified: day(item['lastModified'] ?? version['when']),
    excerpt: cleanExcerpt(item['excerpt']),
  };
}

function rowsOf(data: unknown, baseUrl: string): ConfluencePageRow[] {
  const results = isRecord(data) ? data['results'] : undefined;
  if (!Array.isArray(results)) return [];
  return results.flatMap((r) => {
    const row = pageRow(r, baseUrl);
    return row ? [row] : [];
  });
}

function envelope(spaceKey: string, pages: ConfluencePageRow[], limit: number): string {
  return JSON.stringify({ space: spaceKey, count: pages.length, truncated: pages.length >= limit, pages });
}

function errorText(tool: string, err: unknown): string {
  return `Error: ${tool} failed — ${err instanceof Error ? err.message : String(err)}`;
}

function invalid(tool: string, error: z.ZodError): string {
  return `Error: invalid ${tool} input — ${error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`;
}

const OUTPUT_NOTE =
  'Returns JSON { space, count, truncated, pages: [{ id, title, url, last_modified (YYYY-MM-DD), excerpt }] } — rows at "pages".';

export function createOrchestratorTools(deps: Deps): OrchestratorTool[] {
  const { client } = deps;
  const searchTool: OrchestratorTool = {
    spec: {
      name: SEARCH_PAGES_TOOL,
      description:
        `Read-only list of Confluence pages in the "${client.spaceKey}" space: by words in title or text, by title only, and/or changed in the last N days. ` +
        OUTPUT_NOTE,
      input_schema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Words to find in title or page text, e.g. "Onboarding".' },
          title: { type: 'string', description: 'Words the page title must contain.' },
          modified_within_days: { type: 'integer', description: 'Only pages changed in the last N days.' },
          order: { type: 'string', enum: ['relevance', 'last_modified'] },
          limit: { type: 'integer', description: `Max pages (1–${String(MAX_LIMIT)}, default ${String(DEFAULT_LIMIT)}).` },
        },
        required: [],
      },
    },
    promptDoc:
      `\n- \`${SEARCH_PAGES_TOOL}\`: read-only LIST of Confluence pages (space ${client.spaceKey}) by words, title or recent change — title, link, last change, short excerpt. For page CONTENT or summaries use the Confluence sub-agent.\n`,
    handler: async (input) => {
      const parsed = SearchInput.safeParse(input ?? {});
      if (!parsed.success) return invalid(SEARCH_PAGES_TOOL, parsed.error);
      const limit = parsed.data.limit ?? DEFAULT_LIMIT;
      try {
        const data = await search(buildSearchCql(parsed.data), limit, deps);
        return envelope(client.spaceKey, rowsOf(data, client.baseUrl), limit);
      } catch (err) {
        return errorText(SEARCH_PAGES_TOOL, err);
      }
    },
  };
  const childrenTool: OrchestratorTool = {
    spec: {
      name: LIST_CHILD_PAGES_TOOL,
      description:
        `Read-only list of the child pages of a Confluence page in the "${client.spaceKey}" space, named by the parent's exact title. ` +
        OUTPUT_NOTE,
      input_schema: {
        type: 'object',
        properties: {
          parent_title: { type: 'string', description: 'Exact title of the parent page.' },
          limit: { type: 'integer', description: `Max pages (1–${String(MAX_LIMIT)}, default ${String(DEFAULT_LIMIT)}).` },
        },
        required: ['parent_title'],
      },
    },
    promptDoc: `\n- \`${LIST_CHILD_PAGES_TOOL}\`: read-only list of the child pages of a Confluence page (by its exact title).\n`,
    handler: async (input) => {
      const parsed = ChildrenInput.safeParse(input ?? {});
      if (!parsed.success) return invalid(LIST_CHILD_PAGES_TOOL, parsed.error);
      const limit = parsed.data.limit ?? DEFAULT_LIMIT;
      try {
        const found = await getPageByTitle(parsed.data.parent_title, undefined, deps);
        const parent = rowsOf(found, client.baseUrl)[0];
        if (!parent) return `Error: ${LIST_CHILD_PAGES_TOOL} — no page titled "${parsed.data.parent_title}" in space ${client.spaceKey}.`;
        const data = await getChildren(parent.id, limit, deps);
        return envelope(client.spaceKey, rowsOf(data, client.baseUrl), limit);
      } catch (err) {
        return errorText(LIST_CHILD_PAGES_TOOL, err);
      }
    },
  };
  return [searchTool, childrenTool];
}
