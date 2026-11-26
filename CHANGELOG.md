# Changelog

## 0.6.1

- Manifest: `permissions.graph.entity_systems: ["confluence"]` (ADR 0167, byte5ai/omadia#2242). The kernel holds this plugin's `knowledgeGraph@1` entity and fact writes to its declared systems; the entity sync writes only `confluence` entities. Without the declaration the kernel logs a `[security-audit]` warning now and refuses the writes once the ADR 0167 transition ends (byte5ai/omadia#2244). Kernels before ADR 0167 strip `confluence` from the list, so the plugin still runs there unchanged.

## 0.6.0

- Manifest: all 11 tools have a `capabilities:` entry with `side_effects` (spec 2042 plugin boundary): 10 `read` (`search_confluence_pages`, `list_confluence_child_pages`, `confluence_search`, `confluence_get_page`, `confluence_get_page_by_title`, `confluence_get_children`, `confluence_get_space`, and the three staging tools `confluence_create_page`, `confluence_update_page`, `confluence_add_comment`, which only read the page and stage a preview), 1 `write` (`confluence_commit_write`, which executes the confirmed write).
- `permissions.network.outbound` now lists `$config.confluence_base_url` (the operator-entered host the client reaches).
- `compat.core` is now `>=1.78.0 <2.0`.
- Known, not changed: the REST client still uses global `fetch` (src/confluenceClient.ts:99), not `ctx.http`; `verifyConnection` relies on it (tests/connectionStatus.test.ts). Switch is a follow-up once the kernel observes it.
