import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

// ADR 0167 (byte5ai/omadia#2242): the kernel holds a plugin's knowledgeGraph@1
// entity and fact writes to permissions.graph.entity_systems. Once the
// transition ends (byte5ai/omadia#2244) an undeclared plugin cannot write.
describe('manifest graph entity systems', () => {
  const manifest = readFileSync(new URL('../manifest.yaml', import.meta.url), 'utf8');

  it('declares exactly the system the entity sync writes', () => {
    const block = /\n  graph:\n[\s\S]*?\n    entity_systems:\n((?:\s+#.*\n|\s+- ".*"\n)+)/.exec(manifest);
    assert.ok(block, 'permissions.graph.entity_systems is missing');
    const systems = [...block[1].matchAll(/- "([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(systems, ['confluence']);
  });
});
