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
 */
export function wrapWithSpaceScope(cql: string, spaceKey: string): string {
  return `space = "${spaceKey}" AND (${cql})`;
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

export async function getPage(
  id: string,
  expand: string | undefined,
  deps: Deps,
): Promise<unknown> {
  const data = await deps.client.getPage(id, expand);
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
  const data = await deps.client.getChildren(id, limit);
  for (const ref of extractConfluencePageRefs(data)) {
    deps.entityRefBus.publish(ref);
  }
  return data;
}

export async function getSpace(deps: Deps): Promise<unknown> {
  return deps.client.getSpace();
}
