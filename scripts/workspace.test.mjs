import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { repositorySlug } from './workspace.mjs';

const WORKSPACE = fileURLToPath(new URL('./workspace.mjs', import.meta.url));
const ROSTER_REPO = 'repo-catalog';

// A root with a roster, so the script runs without touching the real workspace.
// The roster repository itself is present because the script clones it first and
// skips a checkout that already exists.
function makeRoot(t, names) {
  const root = mkdtempSync(join(tmpdir(), 'workspace-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const catalog = join(root, 'projects', 'repos', ROSTER_REPO);
  mkdirSync(catalog, { recursive: true });
  writeFileSync(
    join(catalog, 'repos.json'),
    JSON.stringify({ org: 'simpsonm09-projects', repos: [...names, ROSTER_REPO].map((name) => ({ name, tier: 'fixture' })) }),
  );
  return root;
}

function run(root, args, env = {}) {
  return spawnSync(process.execPath, [WORKSPACE, '--root', root, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, ...env },
  });
}

// A stand-in for gh that records every call and creates the clone directory, so
// the apply path needs no network and no credentials.
function fakeGh(root) {
  const bin = join(root, 'bin');
  const log = join(root, 'gh.log');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> '${log}'\nmkdir -p "\${@: -1}"\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  return { bin, calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []) };
}

test('the roster slug names the organization', () => {
  assert.equal(repositorySlug('simpsonm09-maxstack'), 'simpsonm09-projects/simpsonm09-maxstack');
});

test('a dry run plans clones from the organization and no upstream remote', (t) => {
  const root = makeRoot(t, ['alpha', 'beta']);
  const result = run(root, []);
  assert.equal(result.status, 0, result.stderr);
  for (const name of ['alpha', 'beta']) {
    assert.match(result.stdout, new RegExp(`plan {2}clone {2}simpsonm09-projects/${name} -> `));
  }
  assert.doesNotMatch(result.stdout, /upstream/);
  assert.doesNotMatch(result.stdout, /simpsonm09\/(?!-)/);
  assert.match(result.stdout, /dry run {2}repositories=2/);
});

test('an apply run clones each repository from the organization as origin', (t) => {
  const root = makeRoot(t, ['alpha']);
  const { bin, calls } = fakeGh(root);
  const result = run(root, ['--apply'], { PATH: `${bin}:${process.env.PATH}` });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls(), [`repo clone simpsonm09-projects/alpha ${join(root, 'projects', 'repos', 'alpha')}`]);
  assert.doesNotMatch(result.stdout, /upstream/);
  assert.match(result.stdout, /applied {2}repositories=1/);
});

test('an existing checkout is left alone', (t) => {
  const root = makeRoot(t, ['alpha']);
  mkdirSync(join(root, 'projects', 'repos', 'alpha'), { recursive: true });
  const { bin, calls } = fakeGh(root);
  const result = run(root, ['--apply'], { PATH: `${bin}:${process.env.PATH}` });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls(), []);
  assert.match(result.stdout, /applied {2}repositories=up to date/);
});

test('a root with no roster reports that the roster is unknown', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'workspace-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = run(root, []);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /repo-catalog is not cloned yet/);
});
