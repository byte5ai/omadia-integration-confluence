import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  ConfluenceClient,
  ConfluenceClientError,
  ConfluenceWriteStore,
  prepareCreate,
  prepareUpdate,
  prepareComment,
  commitWrite,
} from '@omadia/integration-confluence';
import type { WriteDeps } from '@omadia/integration-confluence';

// --- helpers ---------------------------------------------------------------

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
}

/** Build a ConfluenceClient backed by a recording fake fetch. */
function clientWithFetch(
  responder: (call: FetchCall) => { status: number; body: unknown },
): { client: ConfluenceClient; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    const call: FetchCall = { url: input, method: init?.method ?? 'GET', body };
    calls.push(call);
    const { status, body: respBody } = responder(call);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (respBody === undefined ? '' : JSON.stringify(respBody)),
    } as Response;
  }) as unknown as typeof fetch;

  const client = new ConfluenceClient({
    email: 'a@b.de',
    apiToken: 'tok',
    baseUrl: 'https://x.atlassian.net/wiki',
    spaceKey: 'HOME',
    maxBytes: 200_000,
    fetchImpl,
  });
  return { client, calls };
}

interface RecordedRef {
  op: string;
  id: string | number;
  model: string;
}

function fakeBus(): { published: RecordedRef[]; publish: (r: RecordedRef) => void } {
  const published: RecordedRef[] = [];
  return { published, publish: (r) => published.push(r) };
}

// --- ConfluenceClient write payloads --------------------------------------

describe('ConfluenceClient.createPage', () => {
  it('POSTs storage-format body with forced space.key + optional ancestors', async () => {
    const { client, calls } = clientWithFetch(() => ({
      status: 200,
      body: { id: '999', title: 'New' },
    }));
    await client.createPage({ title: 'New', bodyStorage: '<p>hi</p>', parentId: '12' });
    assert.equal(calls.length, 1);
    const c = calls[0]!;
    assert.equal(c.method, 'POST');
    assert.ok(c.url.endsWith('/rest/api/content'));
    const body = c.body as Record<string, any>;
    assert.equal(body['type'], 'page');
    assert.equal(body['status'], 'draft', 'pages are created as draft, not published');
    assert.equal(body['space'].key, 'HOME');
    assert.equal(body['body'].storage.representation, 'storage');
    assert.equal(body['body'].storage.value, '<p>hi</p>');
    assert.deepEqual(body['ancestors'], [{ id: '12' }]);
  });
});

describe('ConfluenceClient.updatePage', () => {
  it('PUTs to /content/{id} with version.number', async () => {
    const { client, calls } = clientWithFetch(() => ({ status: 200, body: { id: '5' } }));
    await client.updatePage({ id: '5', title: 'T', bodyStorage: '<p>x</p>', nextVersion: 7 });
    const c = calls[0]!;
    assert.equal(c.method, 'PUT');
    assert.ok(c.url.includes('/rest/api/content/5'));
    assert.ok(c.url.includes('status=draft'), 'update saves as draft (Shared-Drafts API)');
    assert.equal((c.body as Record<string, any>)['version'].number, 7);
    assert.equal((c.body as Record<string, any>)['status'], 'draft', 'edit stays a draft, not live');
  });
});

describe('ConfluenceClient.addComment', () => {
  it('POSTs a comment with container id', async () => {
    const { client, calls } = clientWithFetch(() => ({ status: 200, body: {} }));
    await client.addComment({ pageId: '42', bodyStorage: '<p>c</p>' });
    const body = calls[0]!.body as Record<string, any>;
    assert.equal(body['type'], 'comment');
    assert.equal(body['container'].id, '42');
  });
});

describe('ConfluenceClient writes do not retry on 5xx', () => {
  it('throws after a single POST attempt (no duplicate create)', async () => {
    const { client, calls } = clientWithFetch(() => ({ status: 502, body: { msg: 'bad' } }));
    await assert.rejects(
      () => client.createPage({ title: 'X', bodyStorage: '<p>y</p>' }),
      (err: unknown) => err instanceof ConfluenceClientError && err.status === 502,
    );
    assert.equal(calls.length, 1, 'POST must not be retried');
  });
});

// --- ConfluenceWriteStore --------------------------------------------------

describe('ConfluenceWriteStore', () => {
  it('is single-use: take returns the entry once, then undefined', () => {
    const store = new ConfluenceWriteStore();
    const token = store.stage({ kind: 'comment', pageId: '1', bodyStorage: '<p>x</p>' }, 'preview');
    assert.equal(store.size, 1);
    assert.ok(store.take(token));
    assert.equal(store.take(token), undefined);
    assert.equal(store.size, 0);
  });

  it('returns undefined for unknown tokens', () => {
    const store = new ConfluenceWriteStore();
    assert.equal(store.take('nope'), undefined);
  });

  it('expires entries after the TTL', async () => {
    const store = new ConfluenceWriteStore(1);
    const token = store.stage({ kind: 'comment', pageId: '1', bodyStorage: '<p>x</p>' }, 'p');
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(store.take(token), undefined);
  });
});

// --- write core ------------------------------------------------------------

function coreDeps(clientStub: Partial<ConfluenceClient> & { spaceKey: string }): {
  deps: WriteDeps;
  bus: ReturnType<typeof fakeBus>;
} {
  const bus = fakeBus();
  const deps: WriteDeps = {
    client: clientStub as unknown as ConfluenceClient,
    entityRefBus: bus,
    store: new ConfluenceWriteStore(),
  };
  return { deps, bus };
}

describe('prepareCreate', () => {
  it('stages a preview + token WITHOUT writing', async () => {
    let createCalled = false;
    const { deps } = coreDeps({
      spaceKey: 'HOME',
      createPage: async () => {
        createCalled = true;
        return {};
      },
    });
    const res = (await prepareCreate(
      { title: 'Q3 OKRs', body_storage: '<p>goals</p>' },
      deps,
    )) as Record<string, any>;
    assert.equal(res['status'], 'preview');
    assert.equal(res['action'], 'create');
    assert.ok(typeof res['write_token'] === 'string' && res['write_token'].length > 0);
    assert.ok(res['preview'].includes('Q3 OKRs'));
    assert.equal(createCalled, false, 'prepare must not write');
    assert.equal(deps.store.size, 1);
  });
});

describe('commitWrite (create)', () => {
  it('executes the staged op and publishes an op:write ref', async () => {
    const { deps, bus } = coreDeps({
      spaceKey: 'HOME',
      createPage: async () => ({ id: '777', title: 'Q3 OKRs', version: { number: 1 } }),
    });
    const prepared = (await prepareCreate(
      { title: 'Q3 OKRs', body_storage: '<p>goals</p>' },
      deps,
    )) as Record<string, any>;
    const committed = (await commitWrite(prepared['write_token'], deps)) as Record<string, any>;
    assert.equal(committed['status'], 'committed');
    assert.equal(committed['id'], '777');
    assert.equal(bus.published.length, 1);
    assert.equal(bus.published[0]!.op, 'write');
    assert.equal(bus.published[0]!.id, '777');
  });

  it('token is single-use — second commit throws 410', async () => {
    const { deps } = coreDeps({
      spaceKey: 'HOME',
      createPage: async () => ({ id: '1' }),
    });
    const prepared = (await prepareCreate(
      { title: 'T', body_storage: '<p>x</p>' },
      deps,
    )) as Record<string, any>;
    await commitWrite(prepared['write_token'], deps);
    await assert.rejects(
      () => commitWrite(prepared['write_token'], deps),
      (e: unknown) => e instanceof ConfluenceClientError && e.status === 410,
    );
  });
});

describe('prepareUpdate', () => {
  it('rejects a page outside the configured space (403)', async () => {
    const { deps } = coreDeps({
      spaceKey: 'HOME',
      getPage: async () => ({ id: '9', title: 'Foreign', space: { key: 'OTHER' }, version: { number: 3 } }),
    });
    await assert.rejects(
      () => prepareUpdate({ id: '9', body_storage: '<p>x</p>' }, deps),
      (e: unknown) => e instanceof ConfluenceClientError && e.status === 403,
    );
  });

  it('bumps version to current+1 and applies it on commit', async () => {
    let updatedWith: Record<string, any> | undefined;
    const { deps } = coreDeps({
      spaceKey: 'HOME',
      getPage: async () => ({ id: '9', title: 'Doc', space: { key: 'HOME' }, version: { number: 4 } }),
      updatePage: async (input: any) => {
        updatedWith = input;
        return { id: '9', version: { number: 5 } };
      },
    });
    const prepared = (await prepareUpdate(
      { id: '9', body_storage: '<p>new</p>' },
      deps,
    )) as Record<string, any>;
    assert.ok(prepared['preview'].includes('4 → 5'));
    await commitWrite(prepared['write_token'], deps);
    assert.equal(updatedWith?.['nextVersion'], 5);
    assert.equal(updatedWith?.['title'], 'Doc', 'keeps existing title when omitted');
  });
});

describe('prepareComment', () => {
  it('rejects a container page outside the configured space (403)', async () => {
    const { deps } = coreDeps({
      spaceKey: 'HOME',
      getPage: async () => ({ id: '2', title: 'X', space: { key: 'NOPE' }, version: { number: 1 } }),
    });
    await assert.rejects(
      () => prepareComment({ page_id: '2', body_storage: '<p>c</p>' }, deps),
      (e: unknown) => e instanceof ConfluenceClientError && e.status === 403,
    );
  });
});

describe('commitWrite (unknown token)', () => {
  it('throws 410 for an unknown/expired token', async () => {
    const { deps } = coreDeps({ spaceKey: 'HOME' });
    await assert.rejects(
      () => commitWrite('00000000-0000-0000-0000-000000000000', deps),
      (e: unknown) => e instanceof ConfluenceClientError && e.status === 410,
    );
  });
});
