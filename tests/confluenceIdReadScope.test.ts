import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  ConfluenceClient,
  SpaceScopeError,
  getChildren,
  getPage,
  createConfluenceTools,
} from '@omadia/integration-confluence';

/**
 * byte5ai/omadia#1597 — reads by page id honour `confluence_space_key`.
 * Configured space is HOME; page 950273 lives in PLAY.
 */

const PAGES: Record<string, { title: string; space: string }> = {
  '100': { title: 'Home page', space: 'HOME' },
  '950273': { title: 'Onboarding', space: 'PLAY' },
};

function setup(): {
  client: ConfluenceClient;
  urls: string[];
  published: unknown[];
} {
  const urls: string[] = [];
  const fetchImpl = (async (input: string) => {
    urls.push(input);
    const url = new URL(input);
    const m = /\/rest\/api\/content\/(\d+)(\/child\/page)?$/.exec(url.pathname);
    const page = m ? PAGES[m[1] ?? ''] : undefined;
    if (!m || !page) {
      return { ok: false, status: 404, text: async () => '' } as Response;
    }
    const expand = url.searchParams.get('expand') ?? '';
    const body = m[2]
      ? { results: [{ id: '101', type: 'page', title: `${page.title} child` }], size: 1 }
      : {
          id: m[1],
          type: 'page',
          title: page.title,
          ...(expand.split(',').includes('space') ? { space: { key: page.space } } : {}),
          body: { view: { value: `<p>${page.title} SECRET BODY</p>` } },
        };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) } as Response;
  }) as unknown as typeof fetch;
  const client = new ConfluenceClient({
    email: 'a@b.de',
    apiToken: 'tok',
    baseUrl: 'https://x.atlassian.net/wiki',
    spaceKey: 'HOME',
    maxBytes: 200_000,
    fetchImpl,
  });
  const published: unknown[] = [];
  return { client, urls, published };
}

function deps(s: ReturnType<typeof setup>) {
  return {
    client: s.client,
    entityRefBus: { publish: (r: unknown) => void s.published.push(r) },
  } as never;
}

describe('#1597 — confluence_get_page is scoped to the configured space', () => {
  it('reads a page of the configured space', async () => {
    const s = setup();
    const data = (await getPage('100', 'body.view', deps(s))) as { title: string };
    assert.equal(data.title, 'Home page');
    // `space` is requested on top of what the caller asked for.
    assert.match(s.urls[0] ?? '', /expand=body\.view%2Cspace/);
  });

  it('refuses a page of another space, and publishes nothing', async () => {
    const s = setup();
    await assert.rejects(getPage('950273', 'body.view', deps(s)), SpaceScopeError);
    assert.deepEqual(s.published, []);
  });

  it('the tool answers with an error that leaks neither title nor body', async () => {
    const s = setup();
    const tool = createConfluenceTools(deps(s)).find(
      (t) => t.spec.name === 'confluence_get_page',
    );
    assert.ok(tool);
    const out = await tool.handle({ id: '950273', expand: 'body.view' });
    assert.match(out, /^Error: .*verweigert/);
    assert.equal(out.includes('Onboarding'), false);
    assert.equal(out.includes('SECRET BODY'), false);
    assert.equal(out.includes('PLAY'), false);
  });
});

describe('#1597 — confluence_get_children is scoped to the configured space', () => {
  it('lists children of a page in the configured space', async () => {
    const s = setup();
    const data = (await getChildren('100', 25, deps(s))) as { size: number };
    assert.equal(data.size, 1);
  });

  it('refuses children of a page in another space without listing them', async () => {
    const s = setup();
    await assert.rejects(getChildren('950273', 25, deps(s)), SpaceScopeError);
    assert.equal(
      s.urls.some((u) => u.includes('/child/page')),
      false,
      'the children listing must not be requested',
    );
  });
});
