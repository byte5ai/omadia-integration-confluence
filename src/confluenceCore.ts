import type { ConfluenceClient } from './confluenceClient.js';
import {
  extractConfluencePageRef,
  extractConfluencePageRefs,
} from './confluenceEntityExtractor.js';
import type { EntityRefBus } from './kernel-types.js';

export const ALLOWED_EXPAND = new Set<string>([
  'body.view',
  'body.view,version',
  'body.view,version,space',
  'body.view,version,space,ancestors',
  'version',
  'version,space',
  'space',
  'ancestors',
]);

/**
 * Defense-in-depth: always inject a space-scope into user-supplied CQL,
 * regardless of what the agent wrote. Parenthesise the incoming CQL so
 * operator precedence stays safe (`a OR b` shouldn't split our AND).
 *
 * CQL only accepts `ORDER BY` at the very end of the whole query, so a
 * trailing `ORDER BY …` is split off and re-appended AFTER the scoped
 * expression (byte5ai/omadia#1504) — `space = "X" AND (a ORDER BY b)` is a
 * Confluence 400, `space = "X" AND (a) ORDER BY b` is not.
 *
 * Throws `CqlScopeError` when the expression's parentheses do not balance:
 * an unbalanced `)` would close our scope group early and let the rest of
 * the query (`… ) OR (space = "OTHER"`) escape the configured space.
 */
export function wrapWithSpaceScope(cql: string, spaceKey: string): string {
  const { where, orderBy } = splitCql(cql);
  const scoped = `space = "${spaceKey}" AND (${where})`;
  return orderBy ? `${scoped} ORDER BY ${orderBy}` : scoped;
}

export class CqlScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CqlScopeError';
  }
}

/** Sort keys only: `field [ASC|DESC]`, comma-separated. Nothing that could
 *  carry a condition, a quote or a parenthesis out of the scope group. */
const ORDER_BY_CLAUSE =
  /^[A-Za-z_][\w.-]*(\s+(asc|desc))?(\s*,\s*[A-Za-z_][\w.-]*(\s+(asc|desc))?)*$/i;

/**
 * Split CQL into its condition and a trailing top-level `ORDER BY` clause.
 * `ORDER BY` inside a quoted string (`text ~ "order by"`) or inside
 * parentheses is part of the condition, not a sort clause.
 */
export function splitCql(cql: string): { where: string; orderBy?: string } {
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let orderByAt = -1;
  for (let i = 0; i < cql.length; i++) {
    const ch = cql[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth < 0) {
        throw new CqlScopeError(
          'CQL has an unmatched ")" — balance the parentheses.',
        );
      }
    } else if (
      depth === 0 &&
      (i === 0 || /[\s)]/.test(cql[i - 1] ?? '')) &&
      /^order\s+by\s/i.test(cql.slice(i))
    ) {
      orderByAt = i;
    }
  }
  if (quote) {
    throw new CqlScopeError('CQL has an unterminated quoted string.');
  }
  if (depth !== 0) {
    throw new CqlScopeError(
      'CQL has an unmatched "(" — balance the parentheses.',
    );
  }
  if (orderByAt < 0) return { where: cql };

  const where = cql.slice(0, orderByAt).trim();
  const orderBy = cql
    .slice(orderByAt)
    .replace(/^order\s+by\s+/i, '')
    .trim();
  if (where.length === 0) {
    throw new CqlScopeError(
      'CQL needs a condition before ORDER BY, e.g. `type = page ORDER BY lastmodified DESC`.',
    );
  }
  if (!ORDER_BY_CLAUSE.test(orderBy)) {
    throw new CqlScopeError(
      `ORDER BY accepts only field names with optional ASC/DESC, got "${orderBy}".`,
    );
  }
  return { where, orderBy };
}

interface Deps {
  client: ConfluenceClient;
  entityRefBus: EntityRefBus;
}

export async function search(
  cql: string,
  limit: number,
  deps: Deps,
): Promise<unknown> {
  const scoped = wrapWithSpaceScope(cql, deps.client.spaceKey);
  const data = await deps.client.search(scoped, limit);
  for (const ref of extractConfluencePageRefs(data)) {
    deps.entityRefBus.publish(ref);
  }
  return data;
}

/**
 * Thrown when a read by page id targets a page outside the configured space
 * (byte5ai/omadia#1597). Search, title lookup and every write are scoped
 * already; id reads went to `GET /rest/api/content/{id}` unchecked, so any page
 * the stored Atlassian account could see was readable — the whole wiki, not
 * the one space the agent is limited to.
 */
export class SpaceScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpaceScopeError';
  }
}

/** `expand` with `space` added, so the response says where the page lives. */
function expandWithSpace(expand: string | undefined): string {
  const parts = new Set((expand ?? '').split(',').filter((p) => p.length > 0));
  parts.add('space');
  return [...parts].join(',');
}

/**
 * Refuse unless `data` is a page of the configured space. A page whose space
 * the response does not name is refused too: unknown is not "in scope". The
 * message names neither the page title nor its actual space.
 */
function assertReadInScope(data: unknown, id: string, spaceKey: string): void {
  const space =
    data && typeof data === 'object'
      ? (data as { space?: { key?: unknown } }).space
      : undefined;
  if (space?.key !== spaceKey) {
    throw new SpaceScopeError(
      `Seite ${id} liegt nicht im Space '${spaceKey}', Lesezugriff ist auf diesen Space beschränkt — verweigert.`,
    );
  }
}

export async function getPage(
  id: string,
  expand: string | undefined,
  deps: Deps,
): Promise<unknown> {
  const data = await deps.client.getPage(id, expandWithSpace(expand));
  assertReadInScope(data, id, deps.client.spaceKey);
  const ref = extractConfluencePageRef(data);
  if (ref) deps.entityRefBus.publish(ref);
  return data;
}

export async function getPageByTitle(
  title: string,
  expand: string | undefined,
  deps: Deps,
): Promise<unknown> {
  const data = await deps.client.getPageByTitle(title, expand);
  const ref = extractConfluencePageRef(data);
  if (ref) deps.entityRefBus.publish(ref);
  return data;
}

export async function getChildren(
  id: string,
  limit: number,
  deps: Deps,
): Promise<unknown> {
  // A page's children live in the page's own space, so checking the parent
  // scopes the listing (byte5ai/omadia#1597).
  assertReadInScope(
    await deps.client.getPage(id, 'space'),
    id,
    deps.client.spaceKey,
  );
  const data = await deps.client.getChildren(id, limit);
  for (const ref of extractConfluencePageRefs(data)) {
    deps.entityRefBus.publish(ref);
  }
  return data;
}

export async function getSpace(deps: Deps): Promise<unknown> {
  return deps.client.getSpace();
}
