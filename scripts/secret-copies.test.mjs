import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { forbiddenRules } from './check-worktreeinclude.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SENTINEL = 'SENTINEL-NOT-A-SECRET-1234';

function child(command, args, env = process.env) {
  return spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 30000, env });
}

test('worktree includes reject credential names without opening any listed path', () => {
  for (const name of ['.env.local', '.env.prod', '.envrc', '.ENV.PROD', 'private.key', 'tls.pem',
    'accessToken', 'secret-config', 'auth.json', 'credentials.json']) {
    assert.deepEqual(forbiddenRules(`services/${name}\n`), [`services/${name}`]);
  }
  assert.deepEqual(forbiddenRules('# .env is local config\n'), []);
  assert.deepEqual(forbiddenRules('settings/editor.json\n'), ['settings/editor.json']);
  assert.deepEqual(forbiddenRules('services\\infisical\\.env\n'), ['services\\infisical\\.env']);
});

test('local config .env copies are allowed by kind, not by one path', () => {
  for (const rule of ['services/litellm/.env', 'services\\litellm\\.env', './services/litellm/.env',
    'services/dbgate/.env', 'services/litellm/.ENV']) {
    assert.deepEqual(forbiddenRules(`${rule}\n`), [], rule);
  }
});

test('known secret sources stay blocked even though they are named .env', () => {
  for (const rule of ['settings/.env', 'Settings\\.ENV', './settings/.env',
    'services/infisical/.env', 'SERVICES/Infisical/.env', '.\\services\\infisical\\.env']) {
    assert.deepEqual(forbiddenRules(`${rule}\n`), [rule], rule);
  }
});

test('internal dot segments cannot reach a known secret source', () => {
  for (const rule of ['settings/./.env', 'settings\\.\\.env', './settings/./.env',
    'services/infisical/./.env', 'services\\infisical\\.\\.env', 'services/./infisical/.env',
    'SERVICES/./Infisical/./.ENV', '././settings/.env']) {
    assert.deepEqual(forbiddenRules(`${rule}\n`), [rule], rule);
  }
  assert.deepEqual(forbiddenRules('services/./litellm/.env\n'), []);
});

test('drive-qualified and absolute paths are rejected in every Windows form', () => {
  for (const rule of ['C:/foo/.env', 'C:\\foo\\.env', 'C:foo/.env', 'c:.env', 'C:.env',
    'D:\\dev\\simpsonm09\\services\\litellm\\.env', 'D:/dev/simpsonm09/services/litellm/.env',
    'services/litellm/C:.env', 'services/litellm/.env:Zone.Identifier', '\\\\server\\share\\.env',
    '//server/share/.env', '/services/litellm/.env']) {
    assert.deepEqual(forbiddenRules(`${rule}\n`), [rule], rule);
  }
});

test('rules that cannot be checked by exact name are rejected', () => {
  for (const rule of ['services/*/.env', 'services/litellm/.env.*', 'services/litellm/.env?',
    'services/litellm/', 'services/litellm', 'services/infisical', '!services/litellm/.env',
    '../other/.env', '/abs/.env', 'services/secrets/config.json', 'services/token/.env',
    'services/litellm/config.yaml']) {
    assert.deepEqual(forbiddenRules(`${rule}\n`), [rule], rule);
  }
});

test('the committed include copies only the gateway local config', () => {
  const rules = readFileSync(join(ROOT, '.worktreeinclude'), 'utf8').split(/\r?\n/)
    .map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
  assert.deepEqual(rules, ['services/litellm/.env']);
  assert.deepEqual(forbiddenRules(rules.join('\n')), []);
});

test('.env stays ignored and the tracked scaffolds stay unignored', () => {
  const ignore = readFileSync(join(ROOT, '.gitignore'), 'utf8').split(/\r?\n/);
  assert.ok(ignore.includes('.env'));
  assert.ok(ignore.includes('!.env.example'));
});

test('worktreeinclude CLI exits 1 for the broker .env fixture', () => {
  const root = mkdtempSync(join(tmpdir(), 'dev-setup-includes-'));
  try {
    const fixture = join(root, 'include');
    writeFileSync(fixture, 'services/infisical/.env\n');
    const bad = child(process.execPath, [join(HERE, 'check-worktreeinclude.mjs'), fixture]);
    assert.equal(bad.status, 1, bad.stderr);
    assert.match(bad.stderr, /only exact local config .env rules are allowed/);
    writeFileSync(fixture, '# No credential files.\n');
    assert.equal(child(process.execPath, [join(HERE, 'check-worktreeinclude.mjs'), fixture]).status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixtureSnapshot(t, variant) {
  const root = mkdtempSync(join(tmpdir(), 'dev-setup-snapshot-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configDir = join(root, '.config', 'opencode');
  mkdirSync(configDir, { recursive: true });
  const config = JSON.stringify({ unexpected: SENTINEL, apiKey: SENTINEL,
    headers: { Authorization: SENTINEL }, env: { anything: SENTINEL },
    provider: { example: { password: SENTINEL } } });
  writeFileSync(join(configDir, 'opencode.jsonc'), config);
  writeFileSync(join(configDir, 'AGENTS.md'), SENTINEL);
  writeFileSync(join(root, '.wslconfig'), SENTINEL);
  const out = join(root, 'snapshot.json');
  let command;
  let args;
  if (variant === 'powershell') {
    command = 'pwsh';
    args = ['-NoLogo', '-NoProfile', '-File', join(HERE, 'Get-WorkspaceEnvironmentSnapshot.ps1'),
      '-FixtureRoot', root, '-OutputPath', out];
  } else {
    command = 'bash';
    const available = child(command, ['-c', 'command -v python3 >/dev/null && python3 --version']);
    if (available.error || available.status !== 0) {
      t.skip('bash with a working python3 is unavailable');
      return;
    }
    const wsl = child(command, ['-c', 'command -v wslpath']);
    const shellPath = (path) => {
      if (wsl.status === 0 && process.platform === 'win32') {
        return path.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => `/mnt/${drive.toLowerCase()}`);
      }
      return path.replaceAll('\\', '/');
    };
    args = [shellPath(join(HERE, 'get-workspace-environment-snapshot.sh')),
      '--fixture-root', shellPath(root), shellPath(out)];
  }
  // The script is Windows-only; give pwsh on other hosts a profile folder so its defaults resolve.
  const env = { ...process.env, USERPROFILE: process.env.USERPROFILE ?? root };
  const audit = child(command, args, env);
  if (variant === 'powershell' && audit.error?.code === 'ENOENT') {
    t.skip('PowerShell is unavailable');
    return;
  }
  assert.equal(audit.status, 0, `${audit.error ?? ''}${audit.stderr}`);
  assert.ok(!`${audit.stdout}${audit.stderr}`.includes(SENTINEL));
  const snapshot = JSON.parse(audit.stdout);
  assert.deepEqual(Object.keys(snapshot.opencode.config).sort(), ['exists', 'lastWriteTime', 'size']);
  assert.equal(snapshot.opencode.config.exists, true);
  assert.equal(snapshot.opencode.config.size, Buffer.byteLength(config));
  assert.equal(snapshot.opencode.globalAgentsMd.size, SENTINEL.length);
  const written = child(command, [...args, variant === 'powershell' ? '-Write' : '--write'], env);
  assert.equal(written.status, 0, written.stderr);
  const json = readFileSync(out, 'utf8');
  assert.ok(!`${written.stdout}${written.stderr}${json}`.includes(SENTINEL));
  assert.deepEqual(JSON.parse(json).opencode, snapshot.opencode);
}

for (const variant of ['powershell', 'sh']) {
  test(`${variant} snapshot stdout and JSON contain metadata only`, (t) => fixtureSnapshot(t, variant));
}
