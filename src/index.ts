/**
 * @omadia/integration-confluence — public surface.
 *
 * This barrel re-exports the concrete classes + types the middleware kernel
 * currently constructs directly. The plugin's `plugin.ts` entry point (wired
 * in phase-2.3-ii) will eventually own all construction and publish services
 * via ServiceRegistry; until then the kernel in `src/index.ts` imports the
 * classes from here to preserve behaviour during the move.
 */

export { ConfluenceClient, ConfluenceClientError } from './confluenceClient.js';
export type {
  CreatePageInput,
  UpdatePageInput,
  AddCommentInput,
} from './confluenceClient.js';

export { ConfluenceWriteStore } from './confluenceWriteStore.js';
export type { PendingWrite } from './confluenceWriteStore.js';

export {
  prepareCreate,
  prepareUpdate,
  prepareComment,
  commitWrite,
  MAX_TITLE_CHARS,
  MAX_BODY_CHARS,
} from './confluenceWriteCore.js';
export type { WriteDeps } from './confluenceWriteCore.js';

export {
  activate,
  CONFLUENCE_CLIENT_SERVICE_NAME,
  CONFLUENCE_TOOLKIT_SERVICE_NAME,
} from './plugin.js';
export type { ConfluencePluginHandle } from './plugin.js';

export {
  ALLOWED_EXPAND,
  wrapWithSpaceScope,
  search,
  getPage,
  getPageByTitle,
  getChildren,
  getSpace,
} from './confluenceCore.js';

export { createConfluenceTools } from './confluenceToolkit.js';

export { ConfluenceEntitySync } from './confluenceEntitySync.js';
export type {
  ConfluenceEntitySyncOptions,
  ConfluenceSyncResult,
} from './confluenceEntitySync.js';

export {
  extractConfluencePageRef,
  extractConfluencePageRefs,
} from './confluenceEntityExtractor.js';
