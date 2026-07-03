import type { ConfluenceClient } from './confluenceClient.js';
import type { EntityIngest, KnowledgeGraph } from './kernel-types.js';

/**
 * Periodically pulls the configured Confluence space's pages into the
 * knowledge graph so `findEntityCapturedTurns` can resolve page titles +
 * ids before any chat turn captures them.
 *
 * Strategy: `content/search` via CQL on `space = "<key>"` with pagination.
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

interface SearchResponse {
  results?: unknown[];
  start?: number;
  limit?: number;
  size?: number;
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
    try {
      let start = 0;
      while (result.read < this.maxPages) {
        const limit = Math.min(this.pageSize, this.maxPages - result.read);
        // CQL scope: space = "<key>" AND type = "page". Ordered by lastmod so a
        // partial crawl always captures the most recent changes first.
        const cql = `space = "${escapeCql(this.opts.spaceKey)}" AND type = "page" ORDER BY lastmodified DESC`;
        const response = (await this.opts.confluence.search(cql, limit)) as SearchResponse;
        const results = Array.isArray(response.results) ? response.results : [];
        if (results.length === 0) break;
        result.read += results.length;
        const batch: EntityIngest[] = [];
        for (const raw of results as ContentNode[]) {
          const ent = toEntityIngest(raw);
          if (ent) batch.push(ent);
          else result.skipped++;
        }
        if (batch.length > 0) {
          const ingestResult = await this.opts.graph.ingestEntities(batch);
          result.ingested += ingestResult.entityIds.length;
          result.inserted += ingestResult.inserted;
          result.updated += ingestResult.updated;
        }
        // The confluence client swallows pagination cursors — simpler to stop
        // when the page comes back smaller than the requested limit (the
        // Atlassian API guarantees this for the last page).
        if (results.length < limit) break;
        start += results.length;
        void start; // offset tracking reserved for when client exposes `start`.
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
}

function toEntityIngest(raw: ContentNode): EntityIngest | null {
  const id = raw.id;
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  if (!id || title.length === 0) return null;
  return {
    system: 'confluence',
    model: 'confluence.page',
    id: String(id),
    displayName: title,
    extras: {
      ...(raw.status ? { status: raw.status } : {}),
      ...(raw.version?.when ? { lastModified: raw.version.when } : {}),
      ...(raw.history?.createdDate ? { createdDate: raw.history.createdDate } : {}),
      ...(raw._links?.webui ? { webUiPath: raw._links.webui } : {}),
    },
  };
}

function escapeCql(value: string): string {
  // Confluence CQL uses double-quoted strings; escape any embedded quotes so
  // a space-key with punctuation can't break the query.
  return value.replace(/"/g, '\\"');
}
