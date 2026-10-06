import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  checkArtifacts,
  loadManifest,
  parseYaml,
  renderArtifacts,
  REPO_ROOT,
  validateManifest,
} from './tools.mjs';

function materialize(root, manifest) {
  for (const [relative, content] of Object.entries(renderArtifacts(manifest))) {
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}

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

test('tools.yaml is valid and every claimed platform resolves', () => {
  const manifest = loadManifest(REPO_ROOT);
  assert.deepEqual(validateManifest(manifest), []);
  assert.ok(manifest.tools.length >= 20);
});

test('renderArtifacts is deterministic', () => {
  const manifest = loadManifest(REPO_ROOT);
  assert.deepEqual(renderArtifacts(manifest), renderArtifacts(manifest));
});

test('the committed artifacts match tools.yaml', () => {
  const manifest = loadManifest(REPO_ROOT);
  assert.deepEqual(checkArtifacts(REPO_ROOT, manifest), []);
});

test('windows/apps.json keeps the fields Install-Apps.ps1 reads', () => {
  const manifest = loadManifest(REPO_ROOT);
  const apps = JSON.parse(renderArtifacts(manifest)['windows/apps.json']);
  assert.ok(apps.length > 0);
  for (const app of apps) {
    assert.equal(typeof app.name, 'string');
    assert.equal(typeof app.id, 'string');
    assert.ok(app.source === 'winget' || app.source === 'msstore');
    assert.equal(typeof app.installByDefault, 'boolean');
    assert.equal(typeof app.versionPolicy, 'string');
  }
});

test('check fails when a generated artifact is stale', () => {
  const manifest = loadManifest(REPO_ROOT);
  const root = mkdtempSync(join(tmpdir(), 'tools-check-'));
  try {
    materialize(root, manifest);
    assert.deepEqual(checkArtifacts(root, manifest), []);
    const target = join(root, 'docs', 'apps.md');
    writeFileSync(target, `${readFileSync(target, 'utf8')}stale edit\n`);
    const errors = checkArtifacts(root, manifest);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /docs[/\\]apps\.md is out of date/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('check fails when a generated artifact is missing', () => {
  const manifest = loadManifest(REPO_ROOT);
  const root = mkdtempSync(join(tmpdir(), 'tools-missing-'));
  try {
    materialize(root, manifest);
    rmSync(join(root, 'Brewfile'));
    const errors = checkArtifacts(root, manifest);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Brewfile is missing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('validation rejects a tool with no role', () => {
  const manifest = { tools: [{ id: 'x', name: 'X', kind: 'cli', wsl: { manager: 'apt', package: 'x' } }] };
  assert.match(validateManifest(manifest).join('\n'), /x: role is required/);
});
