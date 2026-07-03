import { z } from 'zod';
import { ALLOWED_EXPAND, getChildren, getPage, getPageByTitle, getSpace, search } from './confluenceCore.js';
import {
  commitWrite,
  prepareComment,
  prepareCreate,
  prepareUpdate,
} from './confluenceWriteCore.js';
import type { WriteDeps } from './confluenceWriteCore.js';
import type { ConfluenceClient } from './confluenceClient.js';
import { ConfluenceClientError } from './confluenceClient.js';
import type { ConfluenceWriteStore } from './confluenceWriteStore.js';
import type { EntityRefBus, LocalSubAgentTool } from './kernel-types.js';

const MAX_OUTPUT_CHARS = 60_000;

const PageIdSchema = z.string().regex(/^\d{1,20}$/, 'page id must be numeric');
const ExpandSchema = z
  .string()
  .optional()
  .refine(
    (v) => v === undefined || ALLOWED_EXPAND.has(v),
    { message: `invalid expand — allowed: ${[...ALLOWED_EXPAND].join(', ')}` },
  );
const BodyStorageSchema = z
  .string()
  .min(1, 'body_storage must not be empty')
  .max(100_000, 'body_storage too large');

interface Deps {
  client: ConfluenceClient;
  entityRefBus: EntityRefBus;
  /** When `true`, the create/update/comment + commit tools are appended.
   *  Requires `store`. Driven by `confluence_write_enabled` in plugin.ts. */
  writeEnabled?: boolean;
  /** Server-side staging store for the two-phase write/confirm flow. */
  store?: ConfluenceWriteStore;
}

/**
 * Confluence sub-agent toolkit. One tool per endpoint — the sub-agent picks
 * by name, no dispatch switch. The five read tools are always present and
 * space-scoped to the configured space.
 *
 * When `writeEnabled` is set (operator opted in via `confluence_write_enabled`)
 * four more tools are appended: `confluence_create_page`,
 * `confluence_update_page`, `confluence_add_comment` (each stages a preview +
 * returns a `write_token`) and `confluence_commit_write` (executes a confirmed
 * token). Nothing is ever written in a single tool call — the two-phase split
 * is the structural half of the human-confirm guarantee.
 */
export function createConfluenceTools(deps: Deps): LocalSubAgentTool[] {
  const tools = [
    searchTool(deps),
    getPageTool(deps),
    getPageByTitleTool(deps),
    getChildrenTool(deps),
    getSpaceTool(deps),
  ];
  if (deps.writeEnabled) {
    if (!deps.store) {
      throw new Error(
        '[confluence] createConfluenceTools: writeEnabled=true requires a `store` (ConfluenceWriteStore).',
      );
    }
    const writeDeps: WriteDeps = {
      client: deps.client,
      entityRefBus: deps.entityRefBus,
      store: deps.store,
    };
    tools.push(
      createPageTool(writeDeps),
      updatePageTool(writeDeps),
      addCommentTool(writeDeps),
      commitWriteTool(writeDeps),
    );
  }
  return tools;
}

function searchTool(deps: Deps): LocalSubAgentTool {
  const schema = z.object({
    cql: z.string().min(1).max(2_000),
    limit: z.coerce.number().int().min(1).max(50).default(10),
  });
  return {
    spec: {
      name: 'confluence_search',
      description: `Search Confluence pages via CQL. Scope is hard-locked to the configured space (${deps.client.spaceKey}) — no need to include \`space = …\` yourself. Returns the raw Confluence search result JSON.`,
      input_schema: {
        type: 'object',
        properties: {
          cql: {
            type: 'string',
            description:
              "CQL expression, e.g. `title ~ \"Onboarding\"` or `text ~ \"OKR Q2\"`.",
          },
          limit: { type: 'integer' },
        },
        required: ['cql'],
      },
    },
    handle: withCommonHandling(schema, async (input) => {
      const { cql, limit } = input;
      return search(cql, limit, deps);
    }),
  };
}

function getPageTool(deps: Deps): LocalSubAgentTool {
  const schema = z.object({ id: PageIdSchema, expand: ExpandSchema });
  return {
    spec: {
      name: 'confluence_get_page',
      description:
        'Fetch a single Confluence page by numeric id. Pass `expand=body.view,version` to get rendered HTML + version metadata.',
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          expand: { type: 'string', enum: [...ALLOWED_EXPAND] },
        },
        required: ['id'],
      },
    },
    handle: withCommonHandling(schema, async (input) =>
      getPage(input.id, input.expand, deps),
    ),
  };
}

function getPageByTitleTool(deps: Deps): LocalSubAgentTool {
  const schema = z.object({
    title: z.string().min(1).max(500),
    expand: ExpandSchema,
  });
  return {
    spec: {
      name: 'confluence_get_page_by_title',
      description:
        'Look up a page by exact title within the configured space. Returns a search-style response with up to 5 matches.',
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          expand: { type: 'string', enum: [...ALLOWED_EXPAND] },
        },
        required: ['title'],
      },
    },
    handle: withCommonHandling(schema, async (input) =>
      getPageByTitle(input.title, input.expand, deps),
    ),
  };
}

function getChildrenTool(deps: Deps): LocalSubAgentTool {
  const schema = z.object({
    id: PageIdSchema,
    limit: z.coerce.number().int().min(1).max(100).default(25),
  });
  return {
    spec: {
      name: 'confluence_get_children',
      description: 'List child pages of a given page id.',
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          limit: { type: 'integer' },
        },
        required: ['id'],
      },
    },
    handle: withCommonHandling(schema, async (input) =>
      getChildren(input.id, input.limit, deps),
    ),
  };
}

function getSpaceTool(deps: Deps): LocalSubAgentTool {
  const schema = z.object({}).strict();
  return {
    spec: {
      name: 'confluence_get_space',
      description: 'Return metadata for the configured Confluence space.',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    handle: withCommonHandling(schema, async () => getSpace(deps)),
  };
}

// --- Write tools (only registered when confluence_write_enabled=true) -------
// Each prepare* tool validates + stages and returns a preview + write_token;
// nothing is written until confluence_commit_write is called with that token.

const STORAGE_HINT =
  'Body in Confluence-Storage-Format (XHTML), z.B. `<p>Text</p><h2>Titel</h2>`. ' +
  'NICHT das gerenderte body.view-HTML aus Lesezugriffen wiederverwenden.';

function createPageTool(deps: WriteDeps): LocalSubAgentTool {
  const schema = z.object({
    title: z.string().min(1).max(255),
    body_storage: BodyStorageSchema,
    parent_id: PageIdSchema.optional(),
  });
  return {
    spec: {
      name: 'confluence_create_page',
      description: `Stage a NEW page in the configured space (${deps.client.spaceKey}). Returns a preview + write_token — does NOT write yet. Confirm with the user, then call confluence_commit_write. ${STORAGE_HINT}`,
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          body_storage: { type: 'string', description: STORAGE_HINT },
          parent_id: {
            type: 'string',
            description: 'Optional parent page id (must be in the same space).',
          },
        },
        required: ['title', 'body_storage'],
      },
    },
    handle: withCommonHandling(schema, async (input) => prepareCreate(input, deps)),
  };
}

function updatePageTool(deps: WriteDeps): LocalSubAgentTool {
  const schema = z.object({
    id: PageIdSchema,
    body_storage: BodyStorageSchema,
    title: z.string().min(1).max(255).optional(),
  });
  return {
    spec: {
      name: 'confluence_update_page',
      description: `Stage an UPDATE to an existing page's body (and optionally title). Reads the current version server-side and bumps it. Returns a preview + write_token — does NOT write yet. Rejected if the page is outside the configured space. ${STORAGE_HINT}`,
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          body_storage: { type: 'string', description: STORAGE_HINT },
          title: {
            type: 'string',
            description: 'Optional — keeps the existing title when omitted.',
          },
        },
        required: ['id', 'body_storage'],
      },
    },
    handle: withCommonHandling(schema, async (input) => prepareUpdate(input, deps)),
  };
}

function addCommentTool(deps: WriteDeps): LocalSubAgentTool {
  const schema = z.object({
    page_id: PageIdSchema,
    body_storage: BodyStorageSchema,
  });
  return {
    spec: {
      name: 'confluence_add_comment',
      description: `Stage a footer COMMENT on a page. Returns a preview + write_token — does NOT write yet. Rejected if the page is outside the configured space. ${STORAGE_HINT}`,
      input_schema: {
        type: 'object',
        properties: {
          page_id: { type: 'string' },
          body_storage: { type: 'string', description: STORAGE_HINT },
        },
        required: ['page_id', 'body_storage'],
      },
    },
    handle: withCommonHandling(schema, async (input) => prepareComment(input, deps)),
  };
}

function commitWriteTool(deps: WriteDeps): LocalSubAgentTool {
  const schema = z.object({ write_token: z.string().uuid() });
  return {
    spec: {
      name: 'confluence_commit_write',
      description:
        'Execute a previously staged write. Call ONLY after the user has explicitly confirmed the preview returned by confluence_create_page / _update_page / _add_comment. The token is single-use and expires after 5 minutes.',
      input_schema: {
        type: 'object',
        properties: {
          write_token: {
            type: 'string',
            description: 'The write_token returned by a prepare step.',
          },
        },
        required: ['write_token'],
      },
    },
    handle: withCommonHandling(schema, async (input) =>
      commitWrite(input.write_token, deps),
    ),
  };
}

/**
 * Common input-validation + error-formatting shell shared by every tool in
 * this toolkit. Centralising it keeps each tool handler tiny and makes the
 * error strings consistent for the sub-agent's tool-loop.
 */
function withCommonHandling<S extends z.ZodTypeAny>(
  schema: S,
  run: (parsed: z.infer<S>) => Promise<unknown>,
): (input: unknown) => Promise<string> {
  return async (input: unknown): Promise<string> => {
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      return `Error: invalid tool input — ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`;
    }
    try {
      const data = await run(parsed.data);
      const json = JSON.stringify(data);
      if (json.length > MAX_OUTPUT_CHARS) {
        return `${json.slice(0, MAX_OUTPUT_CHARS)}\n\n…[gekürzt, Original ${String(json.length)} Zeichen — bitte gezielter anfragen]`;
      }
      return json;
    } catch (err) {
      if (err instanceof ConfluenceClientError) {
        return `Error: confluence_upstream_${String(err.status)} — ${err.message}`;
      }
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  };
}
