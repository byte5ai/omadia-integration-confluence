import type { EntityRef } from './kernel-types.js';

/**
 * Confluence proxy responses come in two shapes we currently care about:
 * - single page: `{ id, title, … }` (from /page/:id, /page-by-title)
 * - search/children list: `{ results: [{ id, title, … }, …] }`
 * These helpers normalise both into EntityRefs with `model = "confluence.page"`.
 */

export function extractConfluencePageRef(result: unknown): EntityRef | undefined {
  return extractPageRef(result);
}

export function extractConfluencePageRefs(result: unknown): EntityRef[] {
  if (typeof result !== 'object' || result === null) return [];
  const results = (result as Record<string, unknown>)['results'];
  if (!Array.isArray(results)) return [];
  const refs: EntityRef[] = [];
  for (const item of results) {
    const ref = extractPageRef(item);
    if (ref) refs.push(ref);
  }
  return refs;
}

function extractPageRef(obj: unknown): EntityRef | undefined {
  if (typeof obj !== 'object' || obj === null) return undefined;
  const rec = obj as Record<string, unknown>;
  // CQL search hits wrap the page under `content`. Unwrap if present.
  const inner =
    typeof rec['content'] === 'object' && rec['content'] !== null
      ? (rec['content'] as Record<string, unknown>)
      : rec;
  const idRaw = inner['id'];
  if (typeof idRaw !== 'string' && typeof idRaw !== 'number') return undefined;
  const titleRaw = inner['title'];
  return {
    system: 'confluence',
    model: 'confluence.page',
    id: idRaw,
    displayName: typeof titleRaw === 'string' ? titleRaw : undefined,
    op: 'read',
  };
}
