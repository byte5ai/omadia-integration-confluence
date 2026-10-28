import { afterEach, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import type { PluginActionStatus, PluginContext } from '@omadia/plugin-api';
import {
  activate,
  verifyConnection,
  CallTimeStatusReporter,
  authRejectionCause,
  ConfluenceClient,
  ConfluenceClientError,
  CONFLUENCE_CLIENT_SERVICE_NAME,
} from '@omadia/integration-confluence';

// --- helpers ---------------------------------------------------------------

interface Call {
  url: string;
  init: RequestInit | undefined;
}

type Responder = (url: string, init?: RequestInit) => Promise<Response> | Response;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function textResponse(status: number, body: string, contentType = 'text/html'): Response {
  return new Response(body, { status, headers: { 'content-type': contentType } });
}

const USER = { type: 'known', accountId: '5b10a2844c20165700ede21g', displayName: 'Bot' };

interface FakeCtx {
  ctx: PluginContext;
  calls: Call[];
  reports: PluginActionStatus[];
  provided: Map<string, unknown>;
}

function fakeCtx(opts: {
  respond?: Responder;
  secrets?: Record<string, string>;
}): FakeCtx {
  const calls: Call[] = [];
  const reports: PluginActionStatus[] = [];
  const provided = new Map<string, unknown>();
  const secrets = opts.secrets ?? {
    confluence_email: 'bot@example.com',
    confluence_api_token: 'tok',
  };
  const config: Record<string, unknown> = {
    confluence_base_url: 'https://acme.atlassian.net/wiki/',
    confluence_space_key: 'ENG',
  };
  const respond = opts.respond ?? (() => jsonResponse(200, USER));
  // The client keeps its existing transport (global fetch) — ctx.http is
  // deliberately NOT used in this release; it is present here as a trap.
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return respond(String(url), init);
  }) as typeof fetch;
  const ctx = {
    agentId: '@omadia/integration-confluence',
    log: () => undefined,
    secrets: {
      require: async (key: string) => {
        const v = secrets[key];
        if (v === undefined) throw new Error(`missing secret ${key}`);
        return v;
      },
    },
    config: {
      get: (key: string) => config[key],
      require: (key: string) => {
        const v = config[key];
        if (v === undefined) throw new Error(`missing config ${key}`);
        return v;
      },
    },
    services: {
      get: (name: string) =>
        name === 'entityRefBus' ? { publish: () => undefined } : provided.get(name),
      provide: (name: string, value: unknown) => {
        provided.set(name, value);
        return () => provided.delete(name);
      },
    },
    status: {
      report: (s: PluginActionStatus) => {
        reports.push(s);
      },
      clear: () => undefined,
    },
    http: {
      fetch: async () => {
        throw new Error('ctx.http must not be used');
      },
    },
  } as unknown as PluginContext;
  return { ctx, calls, reports, provided };
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function clientWith(respond: Responder, reports: PluginActionStatus[]): ConfluenceClient {
  return new ConfluenceClient({
    email: 'bot@example.com',
    apiToken: 'tok',
    baseUrl: 'https://acme.atlassian.net/wiki',
    spaceKey: 'ENG',
    maxBytes: 200_000,
    fetchImpl: async (url, init) => respond(url, init),
    observer: new CallTimeStatusReporter({ report: (s) => reports.push(s) }),
  });
}

// --- verifyConnection ------------------------------------------------------

describe('verifyConnection', () => {
  it('probes GET /rest/api/user/current via the client transport (not ctx.http) with Basic auth, refusing redirects', async () => {
    const { ctx, calls } = fakeCtx({});
    const verdict = await verifyConnection(ctx);
    assert.equal(verdict.status, 'connected');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, 'https://acme.atlassian.net/wiki/rest/api/user/current');
    const headers = calls[0]!.init?.headers as Record<string, string>;
    assert.equal(
      headers['Authorization'],
      `Basic ${Buffer.from('bot@example.com:tok').toString('base64')}`,
    );
    assert.equal(calls[0]!.init?.redirect, 'error');
    assert.ok(calls[0]!.init?.signal, 'probe request carries an abort signal');
  });

  it('2xx JSON with a real user ⇒ connected, without copy', async () => {
    const { ctx } = fakeCtx({ respond: () => jsonResponse(200, USER) });
    assert.deepEqual(await verifyConnection(ctx), { status: 'connected' });
  });

  it('401 ⇒ rejected with cause http_401, without copy', async () => {
    const { ctx } = fakeCtx({ respond: () => textResponse(401, 'Unauthorized', 'text/plain') });
    assert.deepEqual(await verifyConnection(ctx), { status: 'rejected', cause: 'http_401' });
  });

  it('403 whose body names authentication ⇒ rejected http_403_auth', async () => {
    const { ctx } = fakeCtx({
      respond: () => jsonResponse(403, { message: 'Authentication failed' }),
    });
    assert.deepEqual(await verifyConnection(ctx), { status: 'rejected', cause: 'http_403_auth' });
  });

  it('plain permission 403 ⇒ inconclusive', async () => {
    const { ctx } = fakeCtx({
      respond: () => jsonResponse(403, { message: 'Current user not permitted to use Confluence' }),
    });
    assert.deepEqual(await verifyConnection(ctx), { status: 'inconclusive' });
  });

  for (const status of [500, 502, 503, 429, 404]) {
    it(`${String(status)} ⇒ inconclusive`, async () => {
      const { ctx } = fakeCtx({ respond: () => textResponse(status, 'upstream trouble') });
      assert.deepEqual(await verifyConnection(ctx), { status: 'inconclusive' });
    });
  }

  it('timeout / abort ⇒ inconclusive', async () => {
    const { ctx } = fakeCtx({
      respond: () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      },
    });
    assert.deepEqual(await verifyConnection(ctx), { status: 'inconclusive' });
  });

  it('DNS / network failure ⇒ inconclusive', async () => {
    const { ctx } = fakeCtx({
      respond: () => {
        throw new TypeError('fetch failed: getaddrinfo ENOTFOUND acme.atlassian.net');
      },
    });
    assert.deepEqual(await verifyConnection(ctx), { status: 'inconclusive' });
  });

  it('200 HTML (captive portal) ⇒ inconclusive', async () => {
    const { ctx } = fakeCtx({
      respond: () => textResponse(200, '<html><body>Please log in to the Wi-Fi</body></html>'),
    });
    assert.deepEqual(await verifyConnection(ctx), { status: 'inconclusive' });
  });

  it('200 JSON for an anonymous user ⇒ inconclusive', async () => {
    const { ctx } = fakeCtx({ respond: () => jsonResponse(200, { type: 'anonymous' }) });
    assert.deepEqual(await verifyConnection(ctx), { status: 'inconclusive' });
  });

  it('200 with unparseable JSON ⇒ inconclusive', async () => {
    const { ctx } = fakeCtx({ respond: () => textResponse(200, '{not json', 'application/json') });
    assert.deepEqual(await verifyConnection(ctx), { status: 'inconclusive' });
  });

  it('missing API token ⇒ inconclusive, never throws', async () => {
    const { ctx, calls } = fakeCtx({ secrets: { confluence_email: 'bot@example.com' } });
    assert.deepEqual(await verifyConnection(ctx), { status: 'inconclusive' });
    assert.equal(calls.length, 0);
  });
});

// --- call-time status reporting -------------------------------------------

describe('call-time status reporting', () => {
  it('a real call answered 401 reports state error and still throws to the caller', async () => {
    const reports: PluginActionStatus[] = [];
    const client = clientWith(() => textResponse(401, 'Unauthorized', 'text/plain'), reports);
    await assert.rejects(client.getSpace(), (err: unknown) => {
      assert.ok(err instanceof ConfluenceClientError);
      assert.equal(err.status, 401);
      return true;
    });
    assert.deepEqual(reports, [{ state: 'error' }]);
  });

  it('a later successful call reports ok again', async () => {
    const reports: PluginActionStatus[] = [];
    let status = 401;
    const client = clientWith(
      () => (status === 401 ? textResponse(401, '', 'text/plain') : jsonResponse(200, { key: 'ENG' })),
      reports,
    );
    await assert.rejects(client.getSpace());
    status = 200;
    assert.deepEqual(await client.getSpace(), { key: 'ENG' });
    assert.deepEqual(reports, [{ state: 'error' }, { state: 'ok' }]);
    // Further successes do not re-report.
    await client.getSpace();
    assert.equal(reports.length, 2);
  });

  it('success without a prior plugin-raised error reports nothing', async () => {
    const reports: PluginActionStatus[] = [];
    const client = clientWith(() => jsonResponse(200, { key: 'ENG' }), reports);
    await client.getSpace();
    assert.equal(reports.length, 0);
  });

  it('5xx, permission 403 and 404 do not report an error', async () => {
    for (const res of [
      () => textResponse(503, 'down'),
      () => jsonResponse(403, { message: 'not permitted to view this space' }),
      () => jsonResponse(404, { message: 'No space with key' }),
    ]) {
      const reports: PluginActionStatus[] = [];
      const client = clientWith(res, reports);
      await assert.rejects(client.getSpace());
      assert.equal(reports.length, 0);
    }
  });

  it('a 403 whose body names authentication reports error', async () => {
    const reports: PluginActionStatus[] = [];
    const client = clientWith(
      () => jsonResponse(403, { message: 'Authentication required' }),
      reports,
    );
    await assert.rejects(client.getSpace());
    assert.deepEqual(
      reports.map((r) => r.state),
      ['error'],
    );
  });

  it('a throwing status sink never breaks the request path', async () => {
    const client = new ConfluenceClient({
      email: 'a',
      apiToken: 'b',
      baseUrl: 'https://acme.atlassian.net/wiki',
      spaceKey: 'ENG',
      maxBytes: 200_000,
      fetchImpl: async () => textResponse(401, ''),
      observer: new CallTimeStatusReporter({
        report: () => {
          throw new Error('registry gone');
        },
      }),
    });
    await assert.rejects(client.getSpace(), ConfluenceClientError);
  });

  it('activate() wires the reporter into ctx.status and keeps the existing transport', async () => {
    let status = 401;
    const { ctx, calls, reports, provided } = fakeCtx({
      respond: () =>
        status === 401 ? textResponse(401, '', 'text/plain') : jsonResponse(200, { key: 'ENG' }),
    });
    const handle = await activate(ctx);
    try {
      const client = provided.get(CONFLUENCE_CLIENT_SERVICE_NAME) as ConfluenceClient;
      await assert.rejects(client.getSpace());
      assert.equal(calls.length, 1, 'request went through the existing transport');
      assert.deepEqual(
        reports.map((r) => r.state),
        ['error'],
      );
      status = 200;
      await client.getSpace();
      assert.deepEqual(
        reports.map((r) => r.state),
        ['error', 'ok'],
      );
    } finally {
      await handle.close();
    }
  });
});

// --- local copy of core's auth-refusal rule ----------------------------------

describe('authRejectionCause (mirror of core classifyHttpAuthFailure)', () => {
  const cases: Array<[number, string | undefined, string | undefined]> = [
    [401, undefined, 'http_401'],
    [401, '<html>login</html>', 'http_401'],
    [403, '{"message":"Authentication failed"}', 'http_403_auth'],
    [403, 'UNAUTHENTICATED', 'http_403_auth'],
    [403, 'invalid_token', 'http_403_auth'],
    [403, 'Invalid API key', 'http_403_auth'],
    [403, 'invalid x-api-key', 'http_403_auth'],
    [403, '{"message":"Current user not permitted to use Confluence"}', undefined],
    [403, undefined, undefined],
    [404, 'authentication', undefined],
    [500, 'authentication', undefined],
    [200, '', undefined],
  ];
  for (const [status, body, expected] of cases) {
    it(`${String(status)} ${JSON.stringify(body ?? null)} ⇒ ${String(expected)}`, () => {
      assert.equal(authRejectionCause(status, body), expected);
    });
  }
});
