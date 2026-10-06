import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  checkArtifacts,
  loadManifest,
  planLines,
  renderArtifacts,
  REPO_ROOT,
  validateManifest,
} from './tools.mjs';

const TOOLS_CLI = fileURLToPath(new URL('./tools.mjs', import.meta.url));

function materialize(root, manifest) {
  for (const [relative, content] of Object.entries(renderArtifacts(manifest))) {
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}

const PLAN_ACTIONS = new Set(['present', 'install', 'manual', 'opt-in', 'deferred']);

function planActions(lines) {
  const actions = new Map();
  for (const line of lines) {
    const match = /^\s{2}(\S+)\s+(\S+)/.exec(line);
    if (match && PLAN_ACTIONS.has(match[1])) actions.set(match[2], match[1]);
  }
  return actions;
}

function runShPlanDarwin() {
  const script = [
    'uname() { echo Darwin; }',
    'export -f uname',
    'bash scripts/apply-tools.sh plan',
  ].join('\n');
  return spawnSync('bash', ['-c', script], { cwd: REPO_ROOT, encoding: 'utf8' });
}

function runCli(command) {
  return spawnSync(process.execPath, [TOOLS_CLI, command], { cwd: REPO_ROOT, encoding: 'utf8' });
}

test('tools.yaml is valid and every claimed platform resolves', () => {
  const manifest = loadManifest(REPO_ROOT);
  assert.deepEqual(validateManifest(manifest), []);
  assert.ok(manifest.tools.length >= 20);
});

test('windows/apps.json keeps every field Install-Apps.ps1 reads', () => {
  const manifest = loadManifest(REPO_ROOT);
  const apps = JSON.parse(renderArtifacts(manifest)['windows/apps.json']);
  assert.ok(apps.length > 0);
  for (const app of apps) {
    assert.equal(typeof app.name, 'string');
    assert.equal(typeof app.id, 'string');
    assert.ok(app.source === 'winget' || app.source === 'msstore');
    assert.equal(typeof app.installByDefault, 'boolean');
    assert.equal(typeof app.versionPolicy, 'string');
    assert.ok(app.version === null || typeof app.version === 'string');
  }
  const terminal = apps.find((app) => app.id === 'AmanThanvi.winghostty');
  assert.deepEqual(terminal.installedAliases, ['Noctty']);
  const docker = apps.find((app) => app.id === 'Docker.DockerDesktop');
  assert.equal(docker.installByDefault, false);
  assert.equal(docker.requiresExplicitOptIn, true);
});

test('renderWslPackages covers every WSL manager tools.yaml declares', () => {
  const manifest = loadManifest(REPO_ROOT);
  const wsl = JSON.parse(renderArtifacts(manifest)['wsl/packages.json']);
  assert.ok(wsl.aptPackages.includes('git'));
  assert.deepEqual(wsl.npmPackages, [
    { id: 'postman-cli', package: 'postman-cli' },
    { id: 'newman', package: 'newman' },
  ]);
  assert.deepEqual(wsl.snapPackages, [{ id: 'terminal', package: 'ghostty', classic: true }]);
  assert.equal(wsl.manualTools.opencode.updateCommand, 'opencode upgrade');
  assert.deepEqual(wsl.deferredTools.map((entry) => entry.id), ['docker']);
});

test('renderBrewfile comments out the opt-in docker-desktop cask', () => {
  const manifest = loadManifest(REPO_ROOT);
  const brewfile = renderArtifacts(manifest).Brewfile;
  assert.doesNotMatch(brewfile, /^cask "docker-desktop"$/m);
  assert.match(brewfile, /^# opt-in: cask "docker-desktop"/m);
});

test('checkArtifacts reports schema errors without throwing', () => {
  for (const bad of [{ tools: [null] }, { tools: ['x'] }, { tools: 'null' }, { tools: [] }, {}]) {
    const errors = checkArtifacts('/nonexistent-root', bad);
    assert.ok(errors.length > 0);
    assert.ok(!errors.some((error) => error.includes('is missing')), `schema errors only: ${errors}`);
  }
  assert.match(checkArtifacts('/nonexistent-root', { tools: [null] }).join('\n'), /every tool must be a mapping/);
  assert.match(checkArtifacts('/nonexistent-root', { tools: 'null' }).join('\n'), /tools must be a non-empty list/);
});

test('the committed artifacts match tools.yaml', () => {
  const manifest = loadManifest(REPO_ROOT);
  assert.deepEqual(checkArtifacts(REPO_ROOT, manifest), []);
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

test('check rejects a string equivalents without throwing', () => {
  const manifest = {
    tools: [{ id: 'x', name: 'X', role: 'r', kind: 'cli', equivalents: 'noctty', wsl: { manager: 'apt', package: 'x' } }],
  };
  const errors = checkArtifacts('/nonexistent-root', manifest);
  assert.match(errors.join('\n'), /x: equivalents must be a list of strings/);
  assert.ok(!errors.some((error) => error.includes('is missing')), `schema errors only: ${errors}`);
});

test('render and check exit 0 through the CLI', () => {
  for (const command of ['render', 'check']) {
    const result = runCli(command);
    assert.equal(result.status, 0, `${command}: ${result.stderr}`);
  }
});

test('the sh plan agrees with the node plan on the action for every tool', () => {
  const manifest = loadManifest(REPO_ROOT);

  // The macOS plan is comparable on any host: brew is absent on the CI runner
  // and on Windows, so both sides resolve every brew tool to "install". This
  // catches the docker opt-in and the manual action.
  const macos = runShPlanDarwin();
  if (macos.error) return;
  assert.equal(macos.status, 0, macos.stderr);
  assert.deepEqual(planActions(macos.stdout.split(/\r?\n/)), planActions(planLines(manifest, 'macos')));

  // The WSL plan is comparable only when node runs on the WSL host itself.
  // From Windows node, dpkg-query and snap are unreachable, so the presence
  // check legitimately differs from the shell plan's.
  if (process.platform !== 'linux') return;
  const wsl = spawnSync('bash', ['scripts/apply-tools.sh', 'plan'], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (wsl.error) return;
  assert.equal(wsl.status, 0, wsl.stderr);
  assert.deepEqual(planActions(wsl.stdout.split(/\r?\n/)), planActions(planLines(manifest, 'wsl')));
});

test('the sh twin exits non-zero when an install fails', () => {
  const script = [
    'd="/tmp/applytools-stub-$$"',
    'mkdir -p "$d" || exit 99',
    '[ -d "$d" ] || exit 99',
    'trap \'rm -rf "$d"\' EXIT',
    'printf \'#!/bin/sh\\nexec "$@"\\n\' > "$d/sudo"',
    'printf \'#!/bin/sh\\nexit 0\\n\' > "$d/apt-get"',
    'printf \'#!/bin/sh\\nexit 0\\n\' > "$d/snap"',
    'printf \'#!/bin/sh\\nexit 1\\n\' > "$d/npm"',
    'chmod +x "$d/sudo" "$d/apt-get" "$d/snap" "$d/npm"',
    '[ -x "$d/sudo" ] || exit 99',
    'PATH="$d:$PATH" bash scripts/apply-tools.sh apply',
  ].join('\n');
  const result = spawnSync('bash', ['-s'], { cwd: REPO_ROOT, encoding: 'utf8', input: script });
  if (result.error) return;
  assert.equal(result.status, 1, result.stderr);
});

test('the ps1 twin exits non-zero when an install fails', (t) => {
  const probe = spawnSync('pwsh', ['-Command', '(Get-Command pwsh).Source'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) return t.skip('pwsh is not available');
  const stub = mkdtempSync(join(tmpdir(), 'tools-ps1-'));
  try {
    writeFileSync(join(stub, 'npm.cmd'), '@echo off\r\nexit /b 1\r\n');
    const result = spawnSync(probe.stdout.trim(), ['-File', 'scripts/apply-tools.ps1', 'apply'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, PATH: stub },
    });
    assert.equal(result.status, 1, result.stderr);
  } finally {
    rmSync(stub, { recursive: true, force: true });
  }
});
