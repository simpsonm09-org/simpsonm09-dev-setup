import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { commandFor, dispatch, hostMatches, hostPlatform, validateOperations } from './setup-ops.mjs';

test('hostPlatform maps the runtime to the manifest vocabulary', () => {
  assert.equal(hostPlatform('win32'), 'windows');
  assert.equal(hostPlatform('darwin'), 'macos');
  assert.equal(hostPlatform('linux'), 'linux');
  assert.equal(hostPlatform('freebsd'), 'linux');
});

test('posix matches any POSIX host but never windows', () => {
  assert.equal(hostMatches(['posix'], 'linux'), true);
  assert.equal(hostMatches(['posix'], 'macos'), true);
  assert.equal(hostMatches(['posix'], 'windows'), false);
  assert.equal(hostMatches(['linux'], 'linux'), true);
  assert.equal(hostMatches(['linux'], 'macos'), false);
  assert.equal(hostMatches(['windows'], 'linux'), false);
});

test('a macOS host refuses a linux operation before spawning', () => {
  let spawned = false;
  const result = dispatch(
    { id: 'bootstrap', platforms: ['linux'], posix: 'wsl/bootstrap.sh' },
    [],
    { host: 'macos', spawn: () => { spawned = true; return { status: 0 }; } },
  );
  assert.equal(spawned, false);
  assert.equal(result.status, 3);
  assert.match(result.error, /runs on linux; this host is macos/);
});

test('a linux host refuses a windows operation before spawning', () => {
  let spawned = false;
  const result = dispatch(
    { id: 'import-secrets', platforms: ['windows'], windows: 'scripts/Import-Secrets.ps1' },
    [],
    { host: 'linux', spawn: () => { spawned = true; return { status: 0 }; } },
  );
  assert.equal(spawned, false);
  assert.equal(result.status, 3);
  assert.match(result.error, /runs on windows; this host is linux/);
});

test('a linux host runs a linux operation through bash', () => {
  const calls = [];
  const result = dispatch(
    {
      id: 'snapshot',
      platforms: ['windows', 'linux'],
      windows: 'scripts/Get-WorkspaceEnvironmentSnapshot.ps1',
      posix: 'scripts/get-workspace-environment-snapshot.sh',
    },
    ['--write'],
    { host: 'linux', spawn: (command, args) => { calls.push([command, args]); return { status: 0 }; } },
  );
  assert.equal(result.status, 0);
  assert.deepEqual(calls, [['bash', ['scripts/get-workspace-environment-snapshot.sh', '--write']]]);
});

test('a macOS host runs a posix operation through bash', () => {
  const calls = [];
  dispatch(
    { id: 'publish-repos', platforms: ['posix'], posix: 'scripts/publish-repos.sh' },
    [],
    { host: 'macos', spawn: (command, args) => { calls.push([command, args]); return { status: 0 }; } },
  );
  assert.deepEqual(calls, [['bash', ['scripts/publish-repos.sh']]]);
});

test('a windows host runs a windows operation through pwsh', () => {
  const calls = [];
  dispatch(
    { id: 'import-secrets', platforms: ['windows'], windows: 'scripts/Import-Secrets.ps1' },
    ['-Apply'],
    { host: 'windows', spawn: (command, args) => { calls.push([command, args]); return { status: 0 }; } },
  );
  assert.deepEqual(calls, [['pwsh', ['-NoLogo', '-NoProfile', '-File', 'scripts/Import-Secrets.ps1', '-Apply']]]);
});

test('commandFor refuses a host with no script for it', () => {
  const result = commandFor({ id: 'bootstrap', platforms: ['linux'], windows: 'x.ps1' }, 'linux', []);
  assert.equal(result.status, 1);
  assert.match(result.error, /has no posix script/);
});

test('validateOperations reports a missing id, platforms, or scripts without throwing', () => {
  const errors = validateOperations([
    { platforms: ['posix'], posix: 'a.sh' },
    { id: 'no-platforms', posix: 'a.sh' },
    { id: 'no-scripts', platforms: ['posix'] },
  ]);
  assert.match(errors.join('\n'), /operation 1: id is required/);
  assert.match(errors.join('\n'), /"no-platforms": platforms is required/);
  assert.match(errors.join('\n'), /"no-scripts": a windows or posix script is required/);
});

test('validateOperations accepts every operation in setup-ops.json', () => {
  const data = JSON.parse(readFileSync(new URL('../setup-ops.json', import.meta.url), 'utf8'));
  assert.deepEqual(validateOperations(data.operations), []);
});
