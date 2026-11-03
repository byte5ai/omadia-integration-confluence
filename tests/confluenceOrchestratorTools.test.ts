import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  ConfluenceClient,
  buildSearchCql,
  cqlLiteral,
  createOrchestratorTools,
  LIST_CHILD_PAGES_TOOL,
  SEARCH_PAGES_TOOL,
} from '@omadia/integration-confluence';

/**
 * Orchestrator read tools: structured input → escaped, space-scoped CQL;
 * flat page rows the core's fast path can render without a model.
 */

const SEARCH_HIT = {
  content: { id: '4711', type: 'page', title: 'Onboarding Checkliste', _links: { webui: '/spaces/HOME/pages/4711' } },
  title: 'Onboarding @@@hl@@@Checkliste@@@endhl@@@',
  url: '/spaces/HOME/pages/4711/Onboarding',
  lastModified: '2026-10-30T09:12:44.000Z',
  excerpt: 'Erste @@@hl@@@Woche@@@endhl@@@: Laptop, Zugänge,\n Buddy',
};

function setup() {
  const urls: URL[] = [];
  const fetchImpl = (async (input: string) => {
    const url = new URL(input);
    urls.push(url);
    let body: unknown = { results: [] };
    if (url.pathname.endsWith('/rest/api/search')) body = { results: [SEARCH_HIT], size: 1 };
    else if (url.pathname.endsWith('/rest/api/content') && url.searchParams.get('title') === 'Handbuch') {
      body = { results: [{ id: '100', type: 'page', title: 'Handbuch' }] };
    } else if (/\/content\/100$/.test(url.pathname)) body = { id: '100', title: 'Handbuch', space: { key: 'HOME' } };
    else if (/\/content\/100\/child\/page$/.test(url.pathname)) {
      body = {
        results: [
          { id: '101', title: 'Urlaub', _links: { webui: '/spaces/HOME/pages/101' }, version: { when: '2026-09-01T10:00:00.000Z' } },
          { id: '102', title: 'Reisekosten', _links: { webui: '/spaces/HOME/pages/102' }, version: { when: '2026-08-15T10:00:00.000Z' } },
        ],
      };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(body) } as Response;
  }) as unknown as typeof fetch;
  const client = new ConfluenceClient({
    email: 'a@b.de',
    apiToken: 'tok',
    baseUrl: 'https://x.atlassian.net/wiki/',
    spaceKey: 'HOME',
    maxBytes: 200_000,
    fetchImpl,
  });
  const tools = createOrchestratorTools({ client, entityRefBus: { publish: () => {} } } as never);
  const tool = (name: string) => tools.find((t) => t.spec.name === name)!;
  return { urls, tool, tools };
}

describe('orchestrator tools — names the fast path plans', () => {
  it('two read tools, read verb first, rows at "pages" named in the description', () => {
    const { tools } = setup();
    assert.deepEqual(tools.map((t) => t.spec.name), [SEARCH_PAGES_TOOL, LIST_CHILD_PAGES_TOOL]);
    for (const t of tools) {
      assert.match(t.spec.name, /^(search|list)_/);
      assert.match(t.spec.description, /rows at "pages"/);
    }
  });
});

describe('search_confluence_pages', () => {
  it('builds escaped CQL from structured input; the space scope is added by the core', async () => {
    assert.equal(cqlLiteral('a "b" \\c'), '"a \\"b\\" \\\\c"');
    assert.equal(buildSearchCql({ text: 'Onboarding' }), 'type = page AND (title ~ "Onboarding" OR text ~ "Onboarding")');
    assert.equal(
      buildSearchCql({ modified_within_days: 7 }),
      'type = page AND lastmodified >= now("-7d") ORDER BY lastmodified DESC',
    );
    const { urls, tool } = setup();
    await tool(SEARCH_PAGES_TOOL).handler({ text: 'x") OR space = "OTHER' });
    const cql = urls[0]?.searchParams.get('cql') ?? '';
    assert.ok(cql.startsWith('space = "HOME" AND ('), cql);
    assert.match(cql, /title ~ "x\\"\) OR space = \\"OTHER"/);
  });

  it('returns flat rows: clean title, absolute link, day, excerpt without highlight markers', async () => {
    const { tool } = setup();
    const out = JSON.parse(await tool(SEARCH_PAGES_TOOL).handler({ text: 'Onboarding', limit: 5 }));
    assert.deepEqual(out, {
      space: 'HOME',
      count: 1,
      truncated: false,
      pages: [
        {
          id: '4711',
          title: 'Onboarding Checkliste',
          url: 'https://x.atlassian.net/wiki/spaces/HOME/pages/4711/Onboarding',
          last_modified: '2026-10-30',
          excerpt: 'Erste Woche: Laptop, Zugänge, Buddy',
        },
      ],
    });
  });

  it('refuses unknown or invalid input with an Error: string', async () => {
    const { tool } = setup();
    assert.match(await tool(SEARCH_PAGES_TOOL).handler({ cql: 'type = page' }), /^Error: invalid search_confluence_pages input/);
    assert.match(await tool(SEARCH_PAGES_TOOL).handler({ limit: 500 }), /^Error: invalid/);
  });
});

describe('list_confluence_child_pages', () => {
  it('resolves the parent by title and lists its children with their last change', async () => {
    const { tool, urls } = setup();
    const out = JSON.parse(await tool(LIST_CHILD_PAGES_TOOL).handler({ parent_title: 'Handbuch' }));
    assert.deepEqual(
      out.pages.map((p: { title: string; last_modified: string }) => [p.title, p.last_modified]),
      [
        ['Urlaub', '2026-09-01'],
        ['Reisekosten', '2026-08-15'],
      ],
    );
    assert.ok(urls.some((u) => u.pathname.endsWith('/child/page') && u.searchParams.get('expand') === 'version'));
  });

  it('an unknown parent is an Error: string, not an empty list', async () => {
    const { tool } = setup();
    assert.match(await tool(LIST_CHILD_PAGES_TOOL).handler({ parent_title: 'Gibt es nicht' }), /^Error: .*no page titled/);
  });
});
