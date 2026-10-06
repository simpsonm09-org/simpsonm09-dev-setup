import assert from 'node:assert/strict';
import test from 'node:test';

import { parseYaml, stripComment } from './yaml.mjs';

test('parseYaml reads block mappings, sequences, and scalars', () => {
  const parsed = parseYaml([
    'name: example',
    'count: 3',
    'enabled: true',
    'missing: null',
    'items:',
    '  - id: one',
    '    role: first',
    '  - id: two',
    '    tags:',
    '      - a',
    '      - b',
    'fallback:',
    '  - manager: scoop',
    '    package: gh',
  ].join('\n'));
  assert.equal(parsed.name, 'example');
  assert.equal(parsed.count, 3);
  assert.equal(parsed.enabled, true);
  assert.equal(parsed.missing, null);
  assert.deepEqual(parsed.items, [
    { id: 'one', role: 'first' },
    { id: 'two', tags: ['a', 'b'] },
  ]);
  assert.deepEqual(parsed.fallback, [{ manager: 'scoop', package: 'gh' }]);
});

test('parseYaml rejects a duplicate key', () => {
  assert.throws(() => parseYaml(['name: one', 'name: two'].join('\n')), /duplicate key "name"/);
});

test('an apostrophe inside a plain scalar does not open a quoted run', () => {
  assert.equal(stripComment("note: don't # keep out").trim(), "note: don't");
  assert.equal(parseYaml("note: don't # comment").note, "don't");
});

test('a hash only starts a comment outside quotes and after whitespace', () => {
  assert.equal(parseYaml('url: https://example.com/a#b').url, 'https://example.com/a#b');
  assert.equal(parseYaml("url: 'https://example.com/#x' # tail").url, 'https://example.com/#x');
  assert.equal(parseYaml('url: "a # b"').url, 'a # b');
});
