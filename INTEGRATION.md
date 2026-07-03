# `@omadia/integration-confluence` — Integration Surface

**Source of truth for Builder-Agents that depend on this plugin.** Read this
before writing cross-integration code; do NOT trust your training-memory of
"the Confluence client API" — the surface here is narrower than the public
Confluence REST and is space-scoped at the integration level.

## Service Registry

| Service Name           | TypeScript Type                          | Purpose                                                  |
|------------------------|------------------------------------------|----------------------------------------------------------|
| `confluence.client`    | `ConfluenceClient`                       | Thin REST wrapper, space-scoped (read + gated write)     |
| `confluence.toolkit`   | `LocalSubAgentTool[]`                    | 5 read tools, +4 write tools when `confluence_write_enabled` |

## Consumption Pattern

Plugin must declare `de.byte5.integration.confluence` in `manifest.yaml`'s
`depends_on`. Then in `activate()`:

```typescript
import type { ConfluenceClient } from '@omadia/integration-confluence';
import type { LocalSubAgentTool } from '@omadia/orchestrator';

const confluence = ctx.services.get<ConfluenceClient>('confluence.client');
if (!confluence) {
  throw new Error(
    'confluence.client unavailable — ensure depends_on includes ' +
    '"de.byte5.integration.confluence" and the integration is installed/active',
  );
}

// Optional: reuse the prebuilt toolkit instead of writing your own search:
const toolkit = ctx.services.get<LocalSubAgentTool[]>('confluence.toolkit');
```

`peerDependencies` in `package.json` must include
`"@omadia/integration-confluence": "*"`.

## `ConfluenceClient` API — verbatim

```typescript
class ConfluenceClient {
  // The space this client is scoped to (set at integration boot from
  // `confluence_space_key`). Read-only, exposed for diagnostics.
  readonly spaceKey: string;

  // CQL search across the configured space. Returns the upstream JSON
  // verbatim — caller narrows.
  async search(cql: string, limit: number): Promise<unknown>;

  // Fetch one page by id. `expand` controls which related fields the
  // upstream returns (e.g. 'body.storage,version'). Pass undefined to omit.
  async getPage(id: string, expand: string | undefined): Promise<unknown>;

  // Lookup a page by exact title within the configured space.
  async getPageByTitle(title: string, expand: string | undefined): Promise<unknown>;

  // List child pages of a parent page.
  async getChildren(id: string, limit: number): Promise<unknown>;

  // Fetch the configured space's metadata.
  async getSpace(): Promise<unknown>;

  // --- Writes (reached only when confluence_write_enabled=true; the toolkit
  // gates registration, and the write-core layer enforces space-scope +
  // version concurrency before these run). All bodies use the `storage`
  // representation (XHTML), NOT the rendered `body.view` from reads.

  // Create a page in the configured space. `space.key` is forced.
  async createPage(input: { title: string; bodyStorage: string; parentId?: string }): Promise<unknown>;

  // Replace a page's title/body. `nextVersion` must be current+1 (else 409).
  async updatePage(input: { id: string; title: string; bodyStorage: string; nextVersion: number }): Promise<unknown>;

  // Add a footer comment to a page.
  async addComment(input: { pageId: string; bodyStorage: string }): Promise<unknown>;
}
```

> **Prefer the toolkit's two-phase write tools over calling these directly.**
> The `confluence_create_page` / `_update_page` / `_add_comment` tools stage a
> validated preview + `write_token`; `confluence_commit_write(token)` executes
> it. That flow enforces the space-scope, version fetch and human-confirm
> guarantees. The raw client methods do none of that — use them only if you
> are re-implementing the same guards yourself.

**Errors** raised as `ConfluenceClientError`:

```typescript
class ConfluenceClientError extends Error {
  readonly status: number;          // upstream HTTP status when available
  readonly upstreamBody?: string;   // truncated upstream body
}
```

## Concrete Snippets

### Search by CQL

```typescript
const result = await confluence.search(
  `space = "${confluence.spaceKey}" AND type = "page" AND title ~ "Onboarding"`,
  20,
) as { results: Array<{ id: string; title: string; _links: { webui: string } }> };
const hits = result.results;
```

### Read a page body

```typescript
const page = await confluence.getPage(
  '1234567',
  'body.storage,version',
) as {
  id: string;
  title: string;
  body: { storage: { value: string; representation: 'storage' } };
  version: { number: number };
};
const html = page.body.storage.value;
```

### Lookup by title

```typescript
const page = await confluence.getPageByTitle('Operations Runbook', 'body.storage');
if (!page) {
  // 404 surfaces as ConfluenceClientError(status: 404). Catch outside.
}
```

### Walk page tree

```typescript
const children = await confluence.getChildren('1234567', 50) as {
  results: Array<{ id: string; title: string }>;
};
```

## Was NICHT geht

- ⚠️ **Writes are gated** — `createPage`/`updatePage`/`addComment` exist, but
  the toolkit only registers the write tools when `confluence_write_enabled=true`,
  and every write goes through a preview→confirm flow. There is **no** delete,
  move or label — those are deliberately out of scope.
- ❌ **Cross-space queries** — `spaceKey` is integration-pinned at install time.
  CQL with `space != "${spaceKey}"` will return data from THIS space only;
  the upstream filter ignores the conflict.
- ❌ **Don't construct `ConfluenceClient` yourself** — credentials are vault-
  scoped and flow through the integration's `setup_fields`. Always consume
  via `ctx.services.get<ConfluenceClient>('confluence.client')`.
- ❌ **Don't parse storage-format HTML on the LLM-side** — that's a token
  black-hole. Use the prebuilt toolkit (`confluence.toolkit`) which the
  integration optimizes for projection + chunking.

## `confluence.toolkit` — when to use

If you only need standard "search-and-summarize" patterns, prefer the
prebuilt toolkit over `ConfluenceClient` directly:

```typescript
const toolkit = ctx.services.get<LocalSubAgentTool[]>('confluence.toolkit');
// Hand to your sub-agent / domain-tool wiring as-is.
```

Tools included (consume `LocalSubAgentTool[]`):
- `confluence_search` — CQL with bounded result set
- `confluence_get_page` — id-based read with body extraction
- `confluence_get_page_by_title` — title-based read
- `confluence_get_children` — child-tree walking
- `confluence_get_space` — metadata

When `confluence_write_enabled=true`, four more are appended:
- `confluence_create_page` — stage a new page (returns preview + `write_token`)
- `confluence_update_page` — stage a body/title update (version fetched server-side)
- `confluence_add_comment` — stage a footer comment
- `confluence_commit_write` — execute a confirmed `write_token` (single-use, 5-min TTL)

The toolkit handles upstream-body truncation + structured-output formatting,
and — for writes — the two-phase preview/confirm + server-side space-scope.
Reach for `ConfluenceClient` directly only when those patterns aren't enough.

## Reference implementations

- `confluence-playbook` sub-agent in `middleware/src/plugins/...` — uses
  `confluence.toolkit` exclusively.
- `harness-verifier` — uses `ctx.services.get('knowledgeGraph')` to
  consume Confluence-derived entity refs.

## Versioning

`ConfluenceClient` method additions are non-breaking. Removing a method
(e.g. dropping `getChildren` if Confluence v2-API removes the endpoint) is
a major-version event — check git-blame on this file.
