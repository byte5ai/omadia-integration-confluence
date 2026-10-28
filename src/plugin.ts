import type { PluginConnectionVerdict, PluginContext } from '@omadia/plugin-api';

import { ConfluenceClient } from './confluenceClient.js';
import {
  CallTimeStatusReporter,
  INCONCLUSIVE,
  verdictFromProbe,
} from './connectionStatus.js';
import { ConfluenceEntitySync } from './confluenceEntitySync.js';
import { createConfluenceTools } from './confluenceToolkit.js';
import { ConfluenceWriteStore } from './confluenceWriteStore.js';
import type {
  EntityRefBus,
  KnowledgeGraph,
  LocalSubAgentTool,
} from './kernel-types.js';

/**
 * @omadia/integration-confluence — plugin entry point.
 *
 * `kind: integration`. Exposes two things to the kernel on activate():
 *   - `confluence.client`   ConfluenceClient (REST wrapper, space-scoped,
 *                           maxBytes-capped, read-only)
 *   - `confluence.toolkit`  LocalSubAgentTool[] (5 tools: search, get_page,
 *                           get_page_by_title, get_children, get_space)
 *
 * Plus (when `confluence_entity_sync_enabled = true`): registers a background
 * job `entity-sync` via `ctx.jobs.register` — the second consumer of the
 * S+3.5 JobScheduler platform after Odoo's own entity-sync.
 *
 * Required config (via `ctx.config`):
 *   - `confluence_base_url`  e.g. https://your-instance.atlassian.net/wiki
 *   - `confluence_email`     Atlassian account e-mail
 *   - `confluence_space_key` hard-locked space scope (default 'HOME')
 * Optional config:
 *   - `confluence_proxy_max_bytes`        default 200000 — caps response size
 *   - `confluence_entity_sync_enabled`    default false  — opt-in job
 *   - `confluence_entity_sync_interval_hours` default 12
 *   - `confluence_entity_sync_page_size`   default 50
 *   - `confluence_entity_sync_max_pages`   default 2000
 *
 * Required secret (via `ctx.secrets`):
 *   - `confluence_api_token` rotated via Atlassian → Security → API tokens
 *
 * Required kernel-provided services:
 *   - `entityRefBus`    kernel bridges via serviceRegistry.provide (pre-S+8).
 *                       Consumed by the Confluence tools to publish page
 *                       references observed in tool responses.
 *   - `knowledgeGraph`  kernel bridges via serviceRegistry.provide (pre-S+8).
 *                       Consumed ONLY when entity-sync is enabled — the sync
 *                       job ingests `confluence.page` entities via
 *                       `graph.ingestEntities(...)`.
 *
 * Consumers (confluence-playbook sub-agent in the kernel) reach the services
 * via serviceRegistry.get<...>.
 *
 * Connection health (byte5ai/omadia#1453): the module also exports
 * `verifyConnection`, which the kernel runs after each activation; and the
 * client reports call-time auth refusals into `ctx.status` itself.
 */

export const CONFLUENCE_CLIENT_SERVICE_NAME = 'confluence.client';
export const CONFLUENCE_TOOLKIT_SERVICE_NAME = 'confluence.toolkit';

const ENTITY_REF_BUS_SERVICE_NAME = 'entityRefBus';
const KNOWLEDGE_GRAPH_SERVICE_NAME = 'knowledgeGraph';

export interface ConfluencePluginHandle {
  close(): Promise<void>;
}

function parseBoolean(raw: string | undefined): boolean {
  return String(raw ?? '').trim().toLowerCase() === 'true';
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Kernel budget for the probe is 5s; abort our request before that so it
 *  does not outlive the kernel's wait. */
const PROBE_TIMEOUT_MS = 4_000;
/** `user/current` is a few hundred bytes; cap generously, independent of the
 *  operator's `confluence_proxy_max_bytes`. */
const PROBE_MAX_BYTES = 64_000;

/**
 * byte5ai/omadia#1453 — kernel-called connection probe. One authenticated
 * `GET /rest/api/user/current` through the plugin's own client (same
 * transport as every other call).
 *
 *  - 401 / auth-403 (core's rule, see `authRejectionCause`) ⇒ `rejected`
 *  - 2xx JSON naming a real user                          ⇒ `connected`
 *  - timeout, 5xx, DNS, redirect, HTML, missing secrets,
 *    anything else                                        ⇒ `inconclusive`
 *
 * Never throws. Builds a throwaway client without the call-time reporter: the
 * kernel writes this verdict into `ctx.status` itself.
 */
export async function verifyConnection(
  ctx: PluginContext,
): Promise<PluginConnectionVerdict> {
  try {
    const client = await ConfluenceClient.fromContext(ctx, PROBE_MAX_BYTES);
    const res = await client.probeCurrentUser(AbortSignal.timeout(PROBE_TIMEOUT_MS));
    return verdictFromProbe(res);
  } catch {
    return INCONCLUSIVE;
  }
}

export async function activate(
  ctx: PluginContext,
): Promise<ConfluencePluginHandle> {
  ctx.log('activating confluence integration');

  const maxBytes = parsePositiveInt(
    ctx.config.get<string>('confluence_proxy_max_bytes'),
    200_000,
  );

  // #1453 — a real call refused for auth reasons flips ctx.status to `error`
  // right away; the next successful call reports `ok` again.
  const client = await ConfluenceClient.fromContext(ctx, maxBytes, {
    observer: new CallTimeStatusReporter(ctx.status, (msg) => {
      ctx.log(msg);
    }),
  });

  const entityRefBus = ctx.services.get<EntityRefBus>(ENTITY_REF_BUS_SERVICE_NAME);
  if (!entityRefBus) {
    throw new Error(
      `[confluence] requires '${ENTITY_REF_BUS_SERVICE_NAME}' service (kernel must publish before plugin activation)`,
    );
  }

  // Opt-in write access. Default off — the toolkit only gains the
  // create/update/comment + commit tools when the operator explicitly sets
  // confluence_write_enabled=true. The store backs the two-phase confirm flow.
  const writeEnabled = parseBoolean(
    ctx.config.get<string>('confluence_write_enabled'),
  );
  const writeStore = writeEnabled ? new ConfluenceWriteStore() : undefined;

  const tools = createConfluenceTools({
    client,
    entityRefBus,
    writeEnabled,
    store: writeStore,
  });

  const disposeClient = ctx.services.provide<ConfluenceClient>(
    CONFLUENCE_CLIENT_SERVICE_NAME,
    client,
  );
  const disposeToolkit = ctx.services.provide<LocalSubAgentTool[]>(
    CONFLUENCE_TOOLKIT_SERVICE_NAME,
    tools,
  );

  ctx.log(
    `[confluence] ready (space=${client.spaceKey}, maxBytes=${String(maxBytes)}, write=${writeEnabled ? 'ENABLED' : 'read-only'}) — services '${CONFLUENCE_CLIENT_SERVICE_NAME}' + '${CONFLUENCE_TOOLKIT_SERVICE_NAME}' published (${String(tools.length)} tools)`,
  );

  // --- Background entity-sync job ------------------------------------------
  // Second consumer of the S+3.5 JobScheduler platform (after
  // @omadia/integration-odoo's entity-sync). Replaces the kernel's
  // prior setTimeout+setInterval pair: the scheduler owns the interval tick +
  // singleton-lock (overlap: 'skip'); the plugin's close() bulk-stops the job
  // via scheduler.stopForPlugin() — dispose here is the explicit handle.
  // Initial sync stays fire-and-forget setTimeout so activate() returns
  // quickly; subsequent runs go through the scheduler.
  let disposeEntitySync: (() => void) | undefined;
  let initialSyncTimer: NodeJS.Timeout | undefined;
  const entitySyncEnabled = parseBoolean(
    ctx.config.get<string>('confluence_entity_sync_enabled'),
  );
  if (entitySyncEnabled) {
    const graph = ctx.services.get<KnowledgeGraph>(KNOWLEDGE_GRAPH_SERVICE_NAME);
    if (!graph) {
      throw new Error(
        `[confluence] confluence_entity_sync_enabled=true requires '${KNOWLEDGE_GRAPH_SERVICE_NAME}' service (kernel must publish before plugin activation)`,
      );
    }
    const intervalHours = parsePositiveInt(
      ctx.config.get<string>('confluence_entity_sync_interval_hours'),
      12,
    );
    const pageSize = parsePositiveInt(
      ctx.config.get<string>('confluence_entity_sync_page_size'),
      50,
    );
    const maxPages = parsePositiveInt(
      ctx.config.get<string>('confluence_entity_sync_max_pages'),
      2000,
    );
    const sync = new ConfluenceEntitySync({
      confluence: client,
      graph,
      spaceKey: client.spaceKey,
      pageSize,
      maxPages,
      log: (msg) => {
        console.error(msg);
      },
    });
    const intervalMs = intervalHours * 60 * 60 * 1000;

    // Jittered initial run — fires up to 30s after activate() returns so a
    // restart-storm across machines doesn't all hit Atlassian at once.
    const jitterMs = Math.floor(Math.random() * 30_000);
    initialSyncTimer = setTimeout(() => {
      void sync.syncAll().catch((err: unknown) => {
        console.error(
          '[confluence-sync] initial sync failed:',
          err instanceof Error ? err.message : err,
        );
      });
    }, jitterMs);
    initialSyncTimer.unref?.();

    disposeEntitySync = ctx.jobs.register(
      {
        name: 'entity-sync',
        schedule: { intervalMs },
        timeoutMs: 10 * 60 * 1000,
        overlap: 'skip',
      },
      async (_signal) => {
        await sync.syncAll();
      },
    );
    ctx.log(
      `[confluence] entity-sync job registered (every ${String(intervalHours)}h, space=${client.spaceKey}, page=${String(pageSize)}, cap=${String(maxPages)})`,
    );
  } else {
    ctx.log(
      '[confluence] entity-sync DISABLED (set confluence_entity_sync_enabled=true to enable)',
    );
  }

  return {
    async close(): Promise<void> {
      ctx.log('deactivating confluence integration');
      if (initialSyncTimer !== undefined) clearTimeout(initialSyncTimer);
      disposeEntitySync?.();
      disposeToolkit();
      disposeClient();
    },
  };
}
