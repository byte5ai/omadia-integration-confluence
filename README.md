<div align="center">

# @omadia/integration-confluence

### Space-scoped Atlassian Confluence layer for omadia's agents — read-only by default, opt-in guarded writes.

A **Confluence** integration for [omadia](https://github.com/byte5ai/omadia).
Publishes the `confluence.client` and `confluence.toolkit` services; proactively
syncs page entities into the knowledge graph.

[![License: MIT](https://img.shields.io/badge/License-MIT-black.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/built%20with-TypeScript-3178C6.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

</div>

---

## How it works

| Concern | Implementation |
|---|---|
| Confluence access | Space-scoped REST client (`confluenceClient.ts`) |
| Tools | `createConfluenceTools` factory (`confluenceToolkit.ts`) |
| Entity sync | `confluenceEntitySync.ts`, `confluenceEntityExtractor.ts` — proactive page-entity sync into the knowledge graph |
| Writes | Read-only by default; optional writes (create/update page, comment) via `confluence_write_enabled`, gated by a two-step preview/confirm flow (`confluenceWriteCore.ts`, `confluenceWriteStore.ts`) |
| Service surface | Publishes `confluence.client` and `confluence.toolkit` to the service registry |

## Build, typecheck & test

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run build        # tsc
npm test             # esbuild-transpile tests/ → node --test
```

`@omadia/plugin-api` is a **peer dependency**, provided by the omadia host at
runtime. For local typechecking, `tsconfig.json` maps it to a sibling
`odoo-bot` checkout — see `paths` in `tsconfig.json`.

## Manifest

See [`manifest.yaml`](manifest.yaml) for the full plugin manifest.

## License

MIT © byte5 GmbH — see [LICENSE](LICENSE).
