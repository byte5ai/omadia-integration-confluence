import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { ConfluenceClient } from '../src/confluenceClient.js';
import { ConfluenceEntitySync } from '../src/confluenceEntitySync.js';
import searchPages from './fixtures/confluenceSearchPages.json';
import type { EntityIngest, KnowledgeGraph } from '../src/kernel-types.js';

// byte5ai/omadia-integration-confluence#10: shape of a Confluence Cloud
// `GET /rest/api/search` answer (CQL), two pages with a cursor `_links.next`.
// esbuild bundles the JSON into the test build.
const fixture = searchPages as { page1: { _links: { next: string } }; page2: unknown };

interface Harness {
  sync: ConfluenceEntitySync;
  requests: URL[];
  ingested: EntityIngest[][];
}

function harness(
  answer: (url: URL, call: number) => unknown,
  opts: { pageSize?: number; maxPages?: number } = {},
): Harness {
  const requests: URL[] = [];
  const ingested: EntityIngest[][] = [];
  const fetchImpl = (async (url: string) => {
    const parsed = new URL(url);
    requests.push(parsed);
    return new Response(JSON.stringify(answer(parsed, requests.length)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as (url: string, init?: RequestInit) => Promise<Response>;
  const client = new ConfluenceClient({
    email: 'a@b.de',
    apiToken: 't',
    baseUrl: 'https://example.atlassian.net/wiki',
    spaceKey: 'HOME',
    maxBytes: 1_000_000,
    fetchImpl,
  });
  const graph = {
    async ingestEntities(entities: EntityIngest[]) {
      ingested.push(entities);
      return {
        entityIds: entities.map((e) => `${e.system}:${e.model}:${String(e.id)}`),
        inserted: entities.length,
        updated: 0,
      };
    },
  } as unknown as KnowledgeGraph;
  const sync = new ConfluenceEntitySync({
    confluence: client,
    graph,
    spaceKey: 'HOME',
    pageSize: opts.pageSize ?? 2,
    maxPages: opts.maxPages ?? 100,
    log: () => {},
  });
  return { sync, requests, ingested };
}

describe('ConfluenceEntitySync (#10)', () => {
  it('maps results[].content into confluence entities instead of skipping them', async () => {
    const h = harness((_url, call) => (call === 1 ? fixture.page1 : fixture.page2));
    const result = await h.sync.syncAll();

    assert.equal(result.error, undefined);
    assert.equal(result.skipped, 0);
    assert.equal(result.read, 3);
    assert.equal(result.ingested, 3);
    const first = h.ingested[0]?.[0];
    assert.deepEqual(first, {
      system: 'confluence',
      model: 'confluence.page',
      id: '1000',
      displayName: 'Onboarding Guide',
      extras: {
        status: 'current',
        lastModified: '2026-11-20T09:10:00.000Z',
        webUiPath: '/spaces/HOME/pages/1000/Onboarding+Guide',
      },
    });
    for (const batch of h.ingested) {
      for (const e of batch) assert.equal(e.system, 'confluence');
    }
  });

  it('follows the _links.next cursor and never reads page 1 twice', async () => {
    const h = harness((_url, call) => (call === 1 ? fixture.page1 : fixture.page2));
    await h.sync.syncAll();

    assert.equal(h.requests.length, 2);
    const [p1, p2] = h.requests;
    assert.equal(p1?.searchParams.get('start'), null);
    assert.equal(p1?.searchParams.get('cursor'), null);
    const nextLink = new URL(fixture.page1._links.next, 'https://x.invalid');
    assert.equal(p2?.searchParams.get('cursor'), nextLink.searchParams.get('cursor'));
    assert.equal(p2?.searchParams.get('start'), '2');
    assert.equal(p2?.searchParams.get('next'), 'true');
    assert.equal(p1?.searchParams.get('next'), null);
    assert.equal(p2?.searchParams.get('cql'), p1?.searchParams.get('cql'));
    const ids = h.ingested.flat().map((e) => e.id);
    assert.deepEqual(ids, ['1000', '1001', '1002']);
  });

  it('stops at maxPages even while the server offers a next page', async () => {
    const h = harness(() => fixture.page1, { pageSize: 2, maxPages: 2 });
    const result = await h.sync.syncAll();
    assert.equal(h.requests.length, 1);
    assert.equal(result.read, 2);
  });

  it('stops when a server repeats the same next link (cursor ignored)', async () => {
    const h = harness(() => fixture.page1, { pageSize: 2, maxPages: 100 });
    const result = await h.sync.syncAll();
    assert.equal(h.requests.length, 2);
    assert.equal(result.read, 4);
  });

  it('maps a flat result without content, skips non-page content, and falls back to the result title', async () => {
    const answer = {
      results: [
        { id: '2001', type: 'page', title: 'Flat Page', _links: { webui: '/spaces/HOME/pages/2001' } },
        { content: { id: '2002', type: 'attachment', title: 'logo.png' }, title: 'logo.png' },
        {
          content: { id: '2003', type: 'page', title: '   ' },
          title: '@@@hl@@@Quarterly@@@endhl@@@ Review',
          url: '/spaces/HOME/pages/2003',
          lastModified: '2026-11-01T08:00:00.000Z',
        },
      ],
      start: 0,
      limit: 25,
      size: 3,
      _links: {},
    };
    const h = harness(() => answer, { pageSize: 25 });
    const result = await h.sync.syncAll();

    assert.equal(result.read, 3);
    assert.equal(result.skipped, 1);
    const entities = h.ingested.flat();
    assert.deepEqual(
      entities.map((e) => [e.id, e.displayName]),
      [
        ['2001', 'Flat Page'],
        ['2003', 'Quarterly Review'],
      ],
    );
    assert.deepEqual(entities[1]?.extras, {
      lastModified: '2026-11-01T08:00:00.000Z',
      webUiPath: '/spaces/HOME/pages/2003',
    });
  });

  it('continues at the next offset when the next link has a cursor but no start', async () => {
    const page1 = {
      ...(fixture.page1 as object),
      _links: { next: '/rest/api/search?next=true&cursor=abc123&limit=2' },
    };
    const h = harness((_url, call) => (call === 1 ? page1 : fixture.page2));
    await h.sync.syncAll();

    assert.equal(h.requests.length, 2);
    assert.equal(h.requests[1]?.searchParams.get('cursor'), 'abc123');
    assert.equal(h.requests[1]?.searchParams.get('start'), '2');
    assert.equal(h.requests[1]?.searchParams.get('next'), 'true');
  });
});
