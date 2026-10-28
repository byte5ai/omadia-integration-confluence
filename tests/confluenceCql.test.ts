import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  ConfluenceClient,
  ConfluenceClientError,
  CqlScopeError,
  wrapWithSpaceScope,
} from '@omadia/integration-confluence';
import { readBoolean, readPositiveInt } from '../src/configValues.js';

// byte5ai/omadia#1504 — a trailing ORDER BY must end up AFTER the scope group.
describe('wrapWithSpaceScope', () => {
  it('scopes plain CQL inside parentheses', () => {
    assert.equal(
      wrapWithSpaceScope('type = page', 'DEV'),
      'space = "DEV" AND (type = page)',
    );
  });

  it('moves a trailing ORDER BY outside the scope group', () => {
    assert.equal(
      wrapWithSpaceScope('type=page ORDER BY lastModified DESC', 'DEV'),
      'space = "DEV" AND (type=page) ORDER BY lastModified DESC',
    );
  });

  it('handles lower-case keywords, several sort keys and extra whitespace', () => {
    assert.equal(
      wrapWithSpaceScope(
        'lastModified >= now("-7d")  order   by lastmodified desc, title',
        'HOME',
      ),
      'space = "HOME" AND (lastModified >= now("-7d")) ORDER BY lastmodified desc, title',
    );
  });

  it('keeps OR precedence inside the scope group', () => {
    assert.equal(
      wrapWithSpaceScope('title ~ "a" OR title ~ "b" ORDER BY created', 'X'),
      'space = "X" AND (title ~ "a" OR title ~ "b") ORDER BY created',
    );
  });

  it('ignores "order by" inside a quoted string', () => {
    assert.equal(
      wrapWithSpaceScope('text ~ "order by date"', 'X'),
      'space = "X" AND (text ~ "order by date")',
    );
    assert.equal(
      wrapWithSpaceScope('text ~ "say \\"order by\\" twice" ORDER BY title', 'X'),
      'space = "X" AND (text ~ "say \\"order by\\" twice") ORDER BY title',
    );
  });

  it('ignores "order by" inside parentheses', () => {
    assert.equal(
      wrapWithSpaceScope('(title ~ "x order by y")', 'X'),
      'space = "X" AND ((title ~ "x order by y"))',
    );
  });

  it('does not treat a field name containing "order" as ORDER BY', () => {
    assert.equal(
      wrapWithSpaceScope('reorder by = 1', 'X'),
      'space = "X" AND (reorder by = 1)',
    );
  });

  it('rejects an unmatched ")" that would escape the space scope', () => {
    assert.throws(
      () => wrapWithSpaceScope('type = page) OR (space = "OTHER"', 'X'),
      CqlScopeError,
    );
  });

  it('rejects unmatched "(" and unterminated quotes', () => {
    assert.throws(() => wrapWithSpaceScope('(type = page', 'X'), CqlScopeError);
    assert.throws(() => wrapWithSpaceScope('title ~ "open', 'X'), CqlScopeError);
  });

  it('rejects an ORDER BY clause that carries more than sort keys', () => {
    assert.throws(
      () => wrapWithSpaceScope('type = page ORDER BY title OR space = OTHER', 'X'),
      CqlScopeError,
    );
  });

  it('rejects ORDER BY without a condition', () => {
    assert.throws(
      () => wrapWithSpaceScope('ORDER BY lastmodified DESC', 'X'),
      CqlScopeError,
    );
  });
});

describe('ConfluenceClient upstream errors', () => {
  function clientReturning(status: number, body: string): ConfluenceClient {
    const fetchImpl = (async () =>
      ({
        ok: status >= 200 && status < 300,
        status,
        text: async () => body,
      }) as Response) as unknown as typeof fetch;
    return new ConfluenceClient({
      email: 'a@b.de',
      apiToken: 't',
      baseUrl: 'https://example.atlassian.net/wiki',
      spaceKey: 'DEV',
      maxBytes: 100_000,
      fetchImpl,
    });
  }

  it("carries Atlassian's message so the agent can fix its CQL", async () => {
    const client = clientReturning(
      400,
      JSON.stringify({ statusCode: 400, message: 'Could not parse cql : foo' }),
    );
    await assert.rejects(
      () => client.search('foo', 10),
      (err: unknown) =>
        err instanceof ConfluenceClientError &&
        err.status === 400 &&
        err.message === 'Confluence upstream 400: Could not parse cql : foo',
    );
  });

  it('keeps the bare status when the body has no message', async () => {
    const client = clientReturning(404, 'not json');
    await assert.rejects(
      () => client.search('foo', 10),
      (err: unknown) =>
        err instanceof ConfluenceClientError &&
        err.message === 'Confluence upstream 404',
    );
  });
});

// byte5ai/omadia#1478 — typed values (new installs) and legacy strings
// (installs configured before 0.3.4) must both read correctly.
describe('setup value readers', () => {
  const noWarn = (msg: string): void => {
    assert.fail(`unexpected warning: ${msg}`);
  };

  it('reads typed and legacy booleans', () => {
    assert.equal(readBoolean('k', true, false, noWarn), true);
    assert.equal(readBoolean('k', false, true, noWarn), false);
    assert.equal(readBoolean('k', 'true', false, noWarn), true);
    assert.equal(readBoolean('k', ' TRUE ', false, noWarn), true);
    assert.equal(readBoolean('k', 'false', true, noWarn), false);
    assert.equal(readBoolean('k', undefined, true, noWarn), true);
    assert.equal(readBoolean('k', '', false, noWarn), false);
  });

  it('warns instead of silently defaulting an unreadable boolean', () => {
    const warnings: string[] = [];
    assert.equal(readBoolean('k', 'ja', false, (m) => warnings.push(m)), false);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? '', /k="ja"/);
  });

  it('reads typed and legacy positive integers', () => {
    assert.equal(readPositiveInt('k', 50, 1, noWarn), 50);
    assert.equal(readPositiveInt('k', '200000', 1, noWarn), 200_000);
    assert.equal(readPositiveInt('k', ' 12 ', 1, noWarn), 12);
    assert.equal(readPositiveInt('k', undefined, 7, noWarn), 7);
  });

  it('warns and defaults on invalid integers', () => {
    const warnings: string[] = [];
    const warn = (m: string): void => {
      warnings.push(m);
    };
    assert.equal(readPositiveInt('k', '12abc', 7, warn), 7);
    assert.equal(readPositiveInt('k', 0, 7, warn), 7);
    assert.equal(readPositiveInt('k', 2.5, 7, warn), 7);
    assert.equal(readPositiveInt('k', '-3', 7, warn), 7);
    assert.equal(warnings.length, 4);
  });
});
