import type { PluginContext } from '@omadia/plugin-api';

/**
 * Error raised by ConfluenceClient. `status` mirrors the upstream HTTP status
 * when available so the proxy route can translate it into a meaningful
 * response for the Managed Agent.
 */
export class ConfluenceClientError extends Error {
  public readonly status: number;
  public readonly upstreamBody?: string;

  constructor(message: string, status: number, upstreamBody?: string) {
    super(message);
    this.name = 'ConfluenceClientError';
    this.status = status;
    this.upstreamBody = upstreamBody;
  }
}

interface ConfluenceClientOptions {
  email: string;
  apiToken: string;
  baseUrl: string;
  spaceKey: string;
  maxBytes: number;
  fetchImpl?: typeof fetch;
}

/** Storage-format input shared by every write method (XHTML, Confluence
 *  `representation: "storage"` — NOT the rendered `body.view` HTML returned by
 *  reads). */
export interface CreatePageInput {
  title: string;
  bodyStorage: string;
  /** Optional parent page id — must live in the configured space (the core
   *  layer verifies this before the call reaches here). */
  parentId?: string;
}

export interface UpdatePageInput {
  id: string;
  title: string;
  bodyStorage: string;
  /** Already-incremented version number (current + 1). The core layer fetches
   *  the current version and computes this so the client stays dumb. */
  nextVersion: number;
}

export interface AddCommentInput {
  pageId: string;
  bodyStorage: string;
}

/**
 * Thin HTTP wrapper around the Confluence REST API. Holds credentials in
 * closure and exposes only the narrow set of operations the playbook agent
 * needs.
 *
 * Reads (`search`/`getPage`/…) are unconditional. Writes
 * (`createPage`/`updatePage`/`addComment`) are only ever reached when the
 * operator set `confluence_write_enabled=true` — the gating happens one layer
 * up in `createConfluenceTools`; the client itself is capability-neutral. All
 * write bodies use the `storage` representation and are space-scoped server
 * side (create injects `space.key`; update/comment are validated against the
 * configured space by the core layer before they reach the client).
 */
export class ConfluenceClient {
  private readonly authHeader: string;
  private readonly baseUrl: string;
  public readonly spaceKey: string;
  private readonly maxBytes: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ConfluenceClientOptions) {
    const token = Buffer.from(`${opts.email}:${opts.apiToken}`, 'utf8').toString('base64');
    this.authHeader = `Basic ${token}`;
    // Strip trailing slash so we can always concat with leading slash.
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.spaceKey = opts.spaceKey;
    this.maxBytes = opts.maxBytes;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /**
   * Build a client from a PluginContext. Secrets come from the vault, the
   * non-secret fields from the installed-agent registry. This is the path
   * used once an agent is installed via the new platform flow; byte5-internal
   * limits like max-bytes still flow from the Config until we add a
   * per-plugin "operational" settings layer.
   */
  static async fromContext(
    ctx: PluginContext,
    maxBytes: number,
  ): Promise<ConfluenceClient> {
    const [email, apiToken] = await Promise.all([
      ctx.secrets.require('confluence_email').catch(() => ''),
      ctx.secrets.require('confluence_api_token'),
    ]);
    // `confluence_email` is declared as non-secret in the manifest (type=string)
    // so callers that set it through the install UI land it in ctx.config, not
    // in the vault. Fall back transparently.
    const resolvedEmail = email || ctx.config.require<string>('confluence_email');
    const baseUrl = ctx.config.require<string>('confluence_base_url');
    const spaceKey = ctx.config.require<string>('confluence_space_key');
    return new ConfluenceClient({
      email: resolvedEmail,
      apiToken,
      baseUrl,
      spaceKey,
      maxBytes,
    });
  }

  async search(
    cql: string,
    limit: number,
    expand?: string,
  ): Promise<unknown> {
    const url = new URL(`${this.baseUrl}/rest/api/search`);
    url.searchParams.set('cql', cql);
    url.searchParams.set('limit', String(limit));
    if (expand) url.searchParams.set('expand', expand);
    return this.request('GET', url);
  }

  async getPage(id: string, expand: string | undefined): Promise<unknown> {
    const url = new URL(`${this.baseUrl}/rest/api/content/${encodeURIComponent(id)}`);
    if (expand) url.searchParams.set('expand', expand);
    return this.request('GET', url);
  }

  async getPageByTitle(title: string, expand: string | undefined): Promise<unknown> {
    const url = new URL(`${this.baseUrl}/rest/api/content`);
    url.searchParams.set('spaceKey', this.spaceKey);
    url.searchParams.set('title', title);
    url.searchParams.set('limit', '5');
    if (expand) url.searchParams.set('expand', expand);
    return this.request('GET', url);
  }

  async getChildren(id: string, limit: number): Promise<unknown> {
    const url = new URL(`${this.baseUrl}/rest/api/content/${encodeURIComponent(id)}/child/page`);
    url.searchParams.set('limit', String(limit));
    return this.request('GET', url);
  }

  async getSpace(): Promise<unknown> {
    const url = new URL(`${this.baseUrl}/rest/api/space/${encodeURIComponent(this.spaceKey)}`);
    return this.request('GET', url);
  }

  // --- Writes --------------------------------------------------------------
  // Reached only when `confluence_write_enabled=true` (gated in the toolkit).
  // Space-scope + version concurrency are enforced by the core layer before
  // these run — the client just assembles the storage-format payload.

  /** `POST /rest/api/content` — create a new page in the configured space.
   *  `space.key` is forced here, so the agent can never target another space. */
  async createPage(input: CreatePageInput): Promise<unknown> {
    const url = new URL(`${this.baseUrl}/rest/api/content`);
    const body: Record<string, unknown> = {
      type: 'page',
      // Create as an unpublished DRAFT. The agent never pushes live content —
      // a human reviews the draft in Confluence and publishes it there. Pinning
      // `draft` explicitly so the result does not depend on instance defaults.
      status: 'draft',
      title: input.title,
      space: { key: this.spaceKey },
      body: { storage: { value: input.bodyStorage, representation: 'storage' } },
    };
    if (input.parentId !== undefined) {
      body['ancestors'] = [{ id: input.parentId }];
    }
    return this.request('POST', url, body);
  }

  /** `PUT /rest/api/content/{id}` — replace a page's title/body. `nextVersion`
   *  must be current+1 (optimistic concurrency); a stale number yields 409. */
  async updatePage(input: UpdatePageInput): Promise<unknown> {
    const url = new URL(`${this.baseUrl}/rest/api/content/${encodeURIComponent(input.id)}`);
    // Save the edit as a DRAFT instead of publishing it live, via Confluence's
    // Shared-Drafts API: the `?status=draft` query param plus `status: 'draft'`
    // in the body stores the change as an unpublished draft of the page (a
    // human publishes it later in Confluence). `nextVersion` (= current
    // published version + 1) is the draft's version number.
    url.searchParams.set('status', 'draft');
    const body = {
      id: input.id,
      type: 'page',
      status: 'draft',
      title: input.title,
      space: { key: this.spaceKey },
      body: { storage: { value: input.bodyStorage, representation: 'storage' } },
      version: { number: input.nextVersion },
    };
    return this.request('PUT', url, body);
  }

  /** `POST /rest/api/content` with `type: comment` — add a footer comment to a
   *  page. The container page must live in the configured space (core-checked). */
  async addComment(input: AddCommentInput): Promise<unknown> {
    const url = new URL(`${this.baseUrl}/rest/api/content`);
    const body = {
      type: 'comment',
      container: { id: input.pageId, type: 'page' },
      body: { storage: { value: input.bodyStorage, representation: 'storage' } },
    };
    return this.request('POST', url, body);
  }

  private async request(
    method: 'GET' | 'POST' | 'PUT',
    url: URL,
    body?: unknown,
    attempt = 0,
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      Authorization: this.authHeader,
      Accept: 'application/json',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await this.fetchImpl(url.toString(), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (!response.ok) {
      const bodyText = await safeReadText(response, this.maxBytes);
      // Retry only idempotent GETs on a transient upstream 5xx. NEVER retry a
      // POST/PUT — a second attempt could create a duplicate page or apply a
      // version bump twice.
      if (method === 'GET' && response.status >= 500 && attempt === 0) {
        return this.request(method, url, body, attempt + 1);
      }
      throw new ConfluenceClientError(
        `Confluence upstream ${response.status}`,
        response.status,
        bodyText,
      );
    }

    const bodyText = await safeReadText(response, this.maxBytes);
    if (bodyText === TRUNCATED_MARKER) {
      throw new ConfluenceClientError(
        `Confluence response exceeded ${this.maxBytes} bytes — verfeinere die Anfrage.`,
        413,
      );
    }
    if (bodyText.length === 0) {
      return null;
    }
    try {
      return JSON.parse(bodyText);
    } catch {
      throw new ConfluenceClientError('Confluence returned non-JSON body', 502, bodyText);
    }
  }
}

const TRUNCATED_MARKER = '__CONFLUENCE_BODY_TRUNCATED__';

async function safeReadText(response: Response, maxBytes: number): Promise<string> {
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    return TRUNCATED_MARKER;
  }
  return text;
}
