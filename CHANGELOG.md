# Changelog

## 0.6.0

- Manifest: all 11 tools have a `capabilities:` entry with `side_effects` (spec 2042 plugin boundary): 7 `read` (`search_confluence_pages`, `list_confluence_child_pages`, `confluence_search`, `confluence_get_page`, `confluence_get_page_by_title`, `confluence_get_children`, `confluence_get_space`), 4 `write` (`confluence_create_page`, `confluence_update_page`, `confluence_add_comment` stage a write behind the two-phase confirm flow; `confluence_commit_write` executes it).
- `permissions.network.outbound` now lists `$config.confluence_base_url` (the operator-entered host the client reaches).
- `compat.core` is now `>=1.76.0 <2.0`.
- Known, not changed: the REST client still uses global `fetch` (src/confluenceClient.ts:99), not `ctx.http`; `verifyConnection` relies on it (tests/connectionStatus.test.ts). Switch is a follow-up once the kernel observes it.
