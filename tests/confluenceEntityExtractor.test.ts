import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  extractConfluencePageRef,
  extractConfluencePageRefs,
} from '@omadia/integration-confluence';

describe('extractConfluencePageRef (single page)', () => {
  it('extracts id + title from a plain page object', () => {
    const ref = extractConfluencePageRef({ id: '123', title: 'Onboarding' });
    assert.ok(ref);
    assert.equal(ref.system, 'confluence');
    assert.equal(ref.model, 'confluence.page');
    assert.equal(ref.id, '123');
    assert.equal(ref.displayName, 'Onboarding');
  });

  it('returns undefined when the id is missing', () => {
    assert.equal(extractConfluencePageRef({ title: 'no id' }), undefined);
    assert.equal(extractConfluencePageRef(null), undefined);
    assert.equal(extractConfluencePageRef('nope'), undefined);
  });
});

describe('extractConfluencePageRefs (search list)', () => {
  it('unwraps hits that nest the page under `content`', () => {
    const refs = extractConfluencePageRefs({
      results: [
        { content: { id: '1', title: 'A' } },
        { content: { id: '2', title: 'B' } },
      ],
    });
    assert.equal(refs.length, 2);
    assert.equal(refs[0]?.displayName, 'A');
  });

  it('also handles flat result shapes', () => {
    const refs = extractConfluencePageRefs({
      results: [{ id: '9', title: 'Flat' }],
    });
    assert.equal(refs.length, 1);
    assert.equal(refs[0]?.id, '9');
  });

  it('skips malformed entries silently', () => {
    const refs = extractConfluencePageRefs({
      results: [{ content: { id: '1' } }, null, { bogus: true }, { content: null }],
    });
    assert.equal(refs.length, 1);
  });

  it('returns [] for missing/malformed container', () => {
    assert.deepEqual(extractConfluencePageRefs(null), []);
    assert.deepEqual(extractConfluencePageRefs({}), []);
    assert.deepEqual(extractConfluencePageRefs({ results: 'nope' }), []);
  });
});
