import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, linkSync, lstatSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { runWithSecrets } from './agent-vault/with-secrets.mjs';
import { parseEnvFile, initializeEnvFile } from './agent-vault/with-secrets-env.mjs';
import * as envModule from './agent-vault/with-secrets-env.mjs';
import { resolveInfisical } from './agent-vault/with-secrets-resolve.mjs';
import * as resolveModule from './agent-vault/with-secrets-resolve.mjs';
import { signalPlan, signalStatus, CHILD_TIMEOUT_MS, childSpawnOptions, runChild, treeKillCommand } from './agent-vault/with-secrets-run.mjs';
import { findRetiredEnvrc } from './agent-vault/with-secrets-envrc.mjs';
import { DENIED_NAMES, DENIED_PREFIXES, isDeniedName } from './agent-vault/with-secrets-policy.mjs';
import { prepareTargetEnvironment } from './agent-vault/with-secrets-store.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE = {
  FALLBACK: 'fake-fallback-value',
  EXPORT: 'fake-export-value',
  CLIENT: 'fake-client-secret',
  TOKEN: 'fake-session-token',
  REQUIRED: 'fake-required',
};

// Every child the suite starts gets an empty temp APPDATA and a stub CLI path. Without
// them the wrapper would find the installed Infisical CLI under %APPDATA%\npm.
const TEMP = resolve(tmpdir());
const ISOLATED_APPDATA = mkdtempSync(join(TEMP, 'dev-setup-secrets-appdata-'));
const STUB_DIR = mkdtempSync(join(TEMP, 'dev-setup-secrets-stub-'));
const STUB_CLI = join(STUB_DIR, process.platform === 'win32' ? 'infisical.exe' : 'infisical');
writeFileSync(STUB_CLI, 'stub: the test wrapper never runs this file\n');
process.on('exit', () => {
  rmSync(ISOLATED_APPDATA, { recursive: true, force: true });
  rmSync(STUB_DIR, { recursive: true, force: true });
});

function isInsideTemp(path) {
  const rel = relative(TEMP, resolve(path));
  return rel !== '' && rel.split(sep)[0] !== '..' && !isAbsolute(rel);
}

function isEmptyTempFolder(path) {
  if (typeof path !== 'string' || !isInsideTemp(path)) return false;
  try { return statSync(path).isDirectory() && readdirSync(path).length === 0; } catch { return false; }
}

function isTempStub(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || !isInsideTemp(path)) return false;
  try { return statSync(path).isFile(); } catch { return false; }
}

// The guard. The wrapper finds the real CLI through APPDATA and DEV_SETUP_INFISICAL_PATH,
// so a child that lacks either override could run the installed CLI with fake values.
function assertIsolatedEnv(env) {
  if (!isEmptyTempFolder(env?.APPDATA)) throw new Error('test child env must set APPDATA to an empty temp folder');
  if (!isTempStub(env?.DEV_SETUP_INFISICAL_PATH)) throw new Error('test child env must set DEV_SETUP_INFISICAL_PATH to the stub in the temp folder');
}

function isolatedEnv(extra = {}) {
  return { ...process.env, APPDATA: ISOLATED_APPDATA, DEV_SETUP_INFISICAL_PATH: STUB_CLI, ...extra };
}

function guardedSpawnSync(file, args, options) {
  assertIsolatedEnv(options.env);
  return spawnSync(file, args, { ...options, windowsHide: true });
}

function guardedSpawn(file, args, options) {
  assertIsolatedEnv(options.env);
  return spawn(file, args, { ...options, windowsHide: true });
}

// The fake CLI is split into helpers. Their source is embedded in the fixture ahead of
// the dispatcher (FIXTURE_HELPERS), so each helper must use only its arguments and globals.
function fakeGuard(mode, expectedCwd) {
  const fs = process.getBuiltinModule('node:fs');
  if (fs.realpathSync(process.cwd()) !== fs.realpathSync(expectedCwd)) process.exit(16);
  const proxyAllowed = mode === 'passthrough';
  if (process.env.NODE_OPTIONS !== undefined || process.env.SSL_CERT_FILE !== undefined) process.exit(13);
  if (!proxyAllowed && process.env.HTTPS_PROXY !== undefined) process.exit(13);
  if (proxyAllowed && process.env.HTTPS_PROXY !== 'fake-proxy') process.exit(14);
}

function fakeGrandchild(expectedCwd) {
  const fs = process.getBuiltinModule('node:fs');
  const grandchild = process.getBuiltinModule('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(()=>{},600000)'], { stdio: 'inherit' });
  fs.writeFileSync(`${expectedCwd}/grandchild.pid`, String(grandchild.pid));
  fs.writeFileSync(`${expectedCwd}/hang.pid`, String(process.pid));
  setInterval(() => {}, 1000);
}

function fakeHang(expectedCwd) {
  const fs = process.getBuiltinModule('node:fs');
  fs.writeFileSync(`${expectedCwd}/hang.pid`, String(process.pid));
  setInterval(() => {}, 1000);
  // Safety net for a mutant that never kills it; the timeout test expects a kill well before this.
  setTimeout(() => process.exit(0), 20000);
}

function fakeLogin(mode, CLIENT, TOKEN) {
  if (process.env.INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET !== CLIENT) process.exit(9);
  if (mode === 'empty-token') process.exit(0);
  if (mode === 'fail-login') {
    process.stdout.write('LOGIN_CANARY');
    process.stderr.write('LOGIN_CANARY');
    process.exit(7);
  }
  process.stdout.write(TOKEN);
  process.exit(0);
}

// The records one folder returns. Modes replace whole folders or add records.
function fakeFolderRecords(mode, folder, EXPORT, REQUIRED) {
  if (folder === '/pii') {
    if (mode === 'empty' || mode === 'empty-pii') return [];
    if (mode === 'dup-across') return [{ key: 'FALLBACK_VALUE', value: EXPORT }];
    if (mode === 'case-across') return [{ key: 'MIXED_CASE', value: 'b' }];
    return [{ key: 'PII_TEST', value: 'fake-pii' }];
  }
  if (mode === 'empty' || mode === 'empty-secrets') return [];
  const records = [{ key: 'FALLBACK_VALUE', value: EXPORT }];
  if (mode === 'required') records.push({ key: 'REQUIRED_EXPORT', value: REQUIRED });
  if (mode === 'empty-required') records.push({ key: 'REQUIRED_EXPORT', value: '' }, { key: 'EMPTY_OPTIONAL', value: '' });
  if (mode.startsWith('denied:')) records.push({ key: mode.slice('denied:'.length), value: 'CANARY_DENIED_VALUE' });
  const replaced = {
    'nul-export': () => [{ key: 'LEAK_MARKER', value: `FAKE_NUL_SECRET${String.fromCharCode(0)}TAIL` }],
    'large-export': () => [{ key: 'LEAK_MARKER', value: 'X'.repeat(65 * 1024) }],
    'value-exact': () => [{ key: 'EXACT', value: 'V'.repeat(64 * 1024) }],
    'total-exact': () => totalRecords(false),
    'total-over': () => totalRecords(true),
    'huge-export': () => Array.from({ length: 1100 }, (_, index) => ({ key: `H${index}`, value: 'x'.repeat(1000) })),
    'case-variant': () => [{ key: 'Mixed_Case', value: 'a' }, { key: 'MIXED_CASE', value: 'b' }],
    'case-across': () => [{ key: 'Mixed_Case', value: 'a' }],
  };
  // The /pii record adds 16 bytes (PII_TEST and fake-pii), so K4 is 16 bytes short of 64 KiB.
  function totalRecords(over) {
    const records = ['K1', 'K2', 'K3', 'K4'].map((key) => ({ key, value: 'V'.repeat(key === 'K4' ? 64 * 1024 - 18 : 64 * 1024 - 2) }));
    if (over) records.push({ key: 'K5', value: '' });
    return records;
  }
  return Object.hasOwn(replaced, mode) ? replaced[mode]() : records;
}

function fakeExport(mode, EXPORT, REQUIRED, TOKEN, args) {
  if (process.argv.includes(TOKEN) || process.env.INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET) process.exit(10);
  if (process.env.INFISICAL_TOKEN !== TOKEN && !(mode === 'empty-token' && process.env.INFISICAL_TOKEN === '')) process.exit(8);
  if (mode === 'fail-export') process.exit(11);
  if (mode === 'bad-json') {
    process.stdout.write('bad-json');
    process.exit(0);
  }
  const folder = args[args.indexOf('--path') + 1];
  process.stdout.write(JSON.stringify(fakeFolderRecords(mode, folder, EXPORT, REQUIRED)));
}

// Dispatch: the first argv value selects the scenario, which keeps caller environment
// variables out of the stub's control.
function fakeInfisical({ CLIENT, TOKEN, EXPORT, REQUIRED }) {
  const [mode, expectedCwd, action, ...args] = process.argv.slice(2);
  fakeGuard(mode, expectedCwd);
  if (mode === 'grandchild') return fakeGrandchild(expectedCwd);
  if (mode === 'hang') return fakeHang(expectedCwd);
  if (action === 'login') return fakeLogin(mode, CLIENT, TOKEN);
  if (action !== 'export') process.exit(12);
  return fakeExport(mode, EXPORT, REQUIRED, TOKEN, args);
}

const FIXTURE_HELPERS = [fakeGuard, fakeGrandchild, fakeHang, fakeLogin, fakeFolderRecords, fakeExport].map((fn) => fn.toString()).join('\n');

function fakeTarget({ EXPORT, FALLBACK, TOKEN, CLIENT }) {
  const env = process.env;
  const result = {
    args: process.argv.slice(2),
    fallback: env.FALLBACK_VALUE === EXPORT,
    offlineFallback: env.FALLBACK_VALUE === FALLBACK,
    caller: env.CALLER_VALUE,
    staleOnly: env.STALE_ONLY !== undefined,
    required: env.REQUIRED_EXPORT !== undefined,
    authLeaked: Boolean(env.INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET || env.INFISICAL_TOKEN || env.INFISICAL_INHERITED_TEST || env.INFISICAL_EXPORTED_TEST || env.INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET === CLIENT || env.INFISICAL_TOKEN === TOKEN),
    pii: env.PII_TEST === 'fake-pii',
  };
  process.stdout.write(`target-stdout\n${JSON.stringify(result)}`);
  process.stderr.write('target-stderr');
  process.exit(23);
}

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'dev-setup-secrets-'));
  mkdirSync(join(root, 'settings'));
  writeFileSync(join(root, 'settings', '.env.example'), 'INFISICAL_ENV=dev\n# FALLBACK_VALUE=\n');
  writeFileSync(join(root, 'fake-infisical.mjs'), `${FIXTURE_HELPERS}\n(${fakeInfisical.toString()})(${JSON.stringify(FAKE)});\n`);
  writeFileSync(join(root, 'secret-target.mjs'), `(${fakeTarget.toString()})(${JSON.stringify(FAKE)});\n`);
  return root;
}

function baseEnv() {
  return {
    INFISICAL_DOMAIN: 'https://fake.invalid',
    INFISICAL_PROJECT_ID: 'fake-project',
    INFISICAL_ENV: 'test',
    INFISICAL_UNIVERSAL_AUTH_CLIENT_ID: 'fake-client-id',
    INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET: FAKE.CLIENT,
    FALLBACK_VALUE: FAKE.FALLBACK,
  };
}

function writeEnv(root, values = baseEnv()) {
  writeFileSync(join(root, 'settings', '.env'), `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n')}\n`);
}

// `mode` selects the fake CLI scenario. Other options pass through to runWithSecrets.
function callTarget(root, argv, options = {}) {
  const { mode = 'ok', env = isolatedEnv(), ...rest } = options;
  assertIsolatedEnv(env);
  let diagnostics = '';
  return runWithSecrets({
    root,
    command: process.execPath,
    args: [join(root, 'secret-target.mjs'), ...argv],
    cli: { file: process.execPath, args: [join(root, 'fake-infisical.mjs'), mode, root] },
    captureTarget: true,
    forwardTargetOutput: false,
    diagnostic: (value) => { diagnostics += value; },
    env,
    ...rest,
  }).then((value) => ({ ...value, diagnostics }));
}

test('the target environment has no prototype, so __proto__, constructor, and toString from settings/.env are inert', async () => {
  const root = makeRoot();
  try {
    writeFileSync(join(root, 'settings', '.env'), `FALLBACK_VALUE=${FAKE.FALLBACK}\n__proto__=CANARY_PROTO\nconstructor=CANARY_CTOR\ntoString=CANARY_TOSTRING\n`);
    const prepared = await prepareTargetEnvironment({ root, offline: true, env: isolatedEnv(), platform: 'linux' });
    assert.equal(prepared.failure, undefined);
    assert.equal(Object.getPrototypeOf(prepared.env), null);
    assert.equal(Object.getOwnPropertyDescriptor(prepared.env, '__proto__').value, 'CANARY_PROTO');
    assert.equal(prepared.env.constructor, 'CANARY_CTOR');
    assert.equal(prepared.env.toString, 'CANARY_TOSTRING');
    assert.equal(Object.hasOwn(Object.prototype, 'CANARY_PROTO'), false);
    assert.equal(({}).constructor, Object);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the template reader strips a BOM before the first name and refuses a lone CR, as the .env reader does', () => {
  assert.deepEqual(envModule.expectedStoreNames('﻿FIRST_NAME=\nSECOND_NAME=\n'), ['FIRST_NAME', 'SECOND_NAME']);
  assert.deepEqual(envModule.expectedStoreNames('﻿INFISICAL_ENV=dev\nKEEP=\n'), ['KEEP']);
  assert.throws(() => envModule.expectedStoreNames('A_NAME=\rB_NAME=\n'), /invalid line 1/);
  assert.throws(() => parseEnvFile('A=x\rB=y\n'), /invalid line 1/);
  assert.deepEqual({ ...parseEnvFile('﻿A=one\r\nB=two\r\n') }, { A: 'one', B: 'two' });
});

test('the test-suite guard refuses a child env without the APPDATA and CLI overrides', () => {
  const busy = mkdtempSync(join(TEMP, 'dev-setup-secrets-busy-'));
  try {
    writeFileSync(join(busy, 'entry'), '');
    assert.throws(() => assertIsolatedEnv({ DEV_SETUP_INFISICAL_PATH: STUB_CLI }), /APPDATA/);
    assert.throws(() => assertIsolatedEnv({ APPDATA: busy, DEV_SETUP_INFISICAL_PATH: STUB_CLI }), /APPDATA/);
    assert.throws(() => assertIsolatedEnv({ APPDATA: 'C:/Users/someone/AppData/Roaming', DEV_SETUP_INFISICAL_PATH: STUB_CLI }), /APPDATA/);
    assert.throws(() => assertIsolatedEnv({ APPDATA: ISOLATED_APPDATA }), /DEV_SETUP_INFISICAL_PATH/);
    assert.throws(() => assertIsolatedEnv({ APPDATA: ISOLATED_APPDATA, DEV_SETUP_INFISICAL_PATH: process.execPath }), /DEV_SETUP_INFISICAL_PATH/);
    assert.doesNotThrow(() => assertIsolatedEnv(isolatedEnv()));
    assert.throws(() => guardedSpawnSync(process.execPath, ['-e', ''], { env: { DEV_SETUP_ROOT: busy } }), /APPDATA/);
  } finally {
    rmSync(busy, { recursive: true, force: true });
  }
});

test('strict dotenv parser accepts comments and equals in values, rejects duplicate and invalid names', () => {
  assert.deepEqual({ ...parseEnvFile('# comment\nA=one=two\nEMPTY=\n') }, { A: 'one=two', EMPTY: '' });
  assert.throws(() => parseEnvFile('A=one\nA=two\n'), /duplicate/);
  assert.throws(() => parseEnvFile('BAD-NAME=value\n'), /invalid/);
  assert.throws(() => parseEnvFile('not-an-assignment\n'), /invalid/);
});

test('Windows CLI resolution supports a native executable and refuses shell shims', () => {
  const native = 'C:\\tools\\infisical\\infisical.exe';
  const shim = 'C:\\tools\\infisical\\infisical.cmd';
  const appData = 'C:\\Users\\someone\\AppData\\Roaming';
  const installed = `${appData}\\npm\\node_modules\\@infisical\\cli\\bin\\infisical.exe`;
  const present = new Set([native, shim, installed]);
  const exists = (path) => present.has(path);
  assert.equal(resolveInfisical('win32', { DEV_SETUP_INFISICAL_PATH: native }, exists), native);
  assert.equal(resolveInfisical('win32', { DEV_SETUP_INFISICAL_PATH: shim }, exists), null);
  assert.equal(resolveInfisical('win32', { APPDATA: appData, PATH: '' }, exists), installed);
});

test('online wrapper gives merged values only to target, keeps argv/status/output, and hides bootstrap auth', async () => {
  const root = makeRoot();
  try {
    writeEnv(root);
    const result = await callTarget(root, ['arg with spaces', '', 'a"b'], {
      env: isolatedEnv({ INFISICAL_INHERITED_TEST: 'must-not-reach-target', INFISICAL_TOKEN: 'inherited-token', INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET: 'inherited-secret', CALLER_VALUE: 'caller' }),
    });
    assert.equal(result.status, 23, result.diagnostics);
    const targetOutput = JSON.parse(result.stdout.split('\n')[1]);
    assert.deepEqual(targetOutput.args, ['arg with spaces', '', 'a"b']);
    assert.equal(result.stdout.startsWith('target-stdout\n'), true);
    assert.equal(result.stderr, 'target-stderr');
    assert.equal(targetOutput.fallback, true);
    assert.equal(targetOutput.pii, true);
    assert.equal(targetOutput.caller, 'caller');
    assert.equal(targetOutput.authLeaked, false);
    assert.equal(process.env.FALLBACK_VALUE, undefined);
    const sibling = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.env.FALLBACK_VALUE))'], { encoding: 'utf8', windowsHide: true, cwd: root });
    assert.equal(sibling.stdout, 'undefined');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('malformed bootstrap and missing store fail without starting target or printing values', async () => {
  const root = makeRoot();
  try {
    writeFileSync(join(root, 'settings', '.env'), `INFISICAL_DOMAIN=x\nINFISICAL_PROJECT_ID=x\nINFISICAL_ENV=x\nINFISICAL_UNIVERSAL_AUTH_CLIENT_ID=x\nINFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET=${FAKE.CLIENT}\nA=one\nA=${FAKE.FALLBACK}\n`);
    const malformed = await callTarget(root, []);
    assert.notEqual(malformed.status, 0);
    assert.equal(malformed.targetStarted, false);
    assert.doesNotMatch(`${malformed.stdout}${malformed.stderr}${malformed.diagnostics}`, new RegExp(`${FAKE.CLIENT}|${FAKE.FALLBACK}`));
    writeEnv(root, { ...baseEnv(), INFISICAL_TOKEN: FAKE.TOKEN });
    const tokenField = await callTarget(root, []);
    assert.notEqual(tokenField.status, 0);
    assert.equal(tokenField.targetStarted, false);
    assert.doesNotMatch(tokenField.diagnostics, new RegExp(FAKE.TOKEN));
    rmSync(join(root, 'settings', '.env'));
    const missing = await callTarget(root, []);
    assert.notEqual(missing.status, 0);
    assert.equal(missing.targetStarted, false);
    assert.match(missing.diagnostics, /secrets-init/);
    assert.equal(existsSync(join(root, 'settings', '.env')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('online failures are closed and explicit offline uses fallback only', async () => {
  const root = makeRoot();
  try {
    writeEnv(root);
    const unavailable = await callTarget(root, [], { mode: 'fail-login' });
    assert.notEqual(unavailable.status, 0);
    assert.equal(unavailable.targetStarted, false);
    assert.doesNotMatch(unavailable.diagnostics, /LOGIN_CANARY/);
    const offline = await callTarget(root, [], { offline: true });
    assert.equal(offline.status, 23);
    const targetOutput = JSON.parse(offline.stdout.split('\n')[1]);
    assert.equal(targetOutput.offlineFallback, true);
    assert.equal(targetOutput.authLeaked, false);
    const exportFailure = await callTarget(root, [], { mode: 'fail-export' });
    assert.notEqual(exportFailure.status, 0);
    assert.equal(exportFailure.targetStarted, false);
    const malformedJson = await callTarget(root, [], { mode: 'bad-json' });
    assert.notEqual(malformedJson.status, 0);
    assert.equal(malformedJson.targetStarted, false);
    const missingCli = await callTarget(root, [], { cli: { file: 'missing-infisical-executable' } });
    assert.notEqual(missingCli.status, 0);
    assert.equal(missingCli.targetStarted, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('online mode fails closed when the store returns zero records for a folder', async () => {
  const root = makeRoot();
  try {
    writeEnv(root, { ...baseEnv(), CANARY_SECRET: 'CANARY_FALLBACK_STALE' });
    const cases = [
      ['empty', /no records for \/secrets/],
      ['empty-secrets', /no records for \/secrets/],
      ['empty-pii', /no records for \/pii/],
    ];
    for (const [mode, message] of cases) {
      const result = await callTarget(root, [], { mode });
      assert.notEqual(result.status, 0, mode);
      assert.equal(result.targetStarted, false, mode);
      assert.match(result.diagnostics, message, mode);
      assert.doesNotMatch(`${result.stdout}${result.stderr}${result.diagnostics}`, /CANARY|fake-export-value|fake-fallback-value/, mode);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('online mode requires each uncommented name in settings/.env.example and nothing else', async () => {
  const root = makeRoot();
  try {
    writeEnv(root);
    writeFileSync(join(root, 'settings', '.env.example'), 'INFISICAL_ENV=dev\nREQUIRED_EXPORT=\n# OPTIONAL_COMMENTED=\nOPTIONAL_MARKED=  # optional\n');
    const missing = await callTarget(root, [], { mode: 'ok' });
    assert.notEqual(missing.status, 0);
    assert.equal(missing.targetStarted, false);
    assert.match(missing.diagnostics, /REQUIRED_EXPORT/);
    assert.doesNotMatch(`${missing.stdout}${missing.stderr}${missing.diagnostics}`, /fake-export-value/);
    const present = await callTarget(root, [], { mode: 'required' });
    assert.equal(present.status, 23, present.diagnostics);
    assert.equal(JSON.parse(present.stdout.split('\n')[1]).required, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an empty session token from login fails the run before any export or target', async () => {
  const root = makeRoot();
  try {
    writeEnv(root);
    const result = await callTarget(root, [], { mode: 'empty-token' });
    assert.notEqual(result.status, 0);
    assert.equal(result.targetStarted, false);
    assert.match(result.diagnostics, /login or a required folder export failed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a required name exported with an empty value is missing, in online and offline mode alike', async () => {
  const root = makeRoot();
  try {
    writeFileSync(join(root, 'settings', '.env.example'), 'INFISICAL_ENV=dev\nREQUIRED_EXPORT=\n');
    writeEnv(root);
    const online = await callTarget(root, [], { mode: 'empty-required' });
    assert.notEqual(online.status, 0);
    assert.equal(online.targetStarted, false);
    assert.match(online.diagnostics, /required name\(s\) are missing or empty: REQUIRED_EXPORT/);
    assert.doesNotMatch(`${online.stdout}${online.stderr}${online.diagnostics}`, /fake-export-value/);
    writeEnv(root, { FALLBACK_VALUE: FAKE.FALLBACK, REQUIRED_EXPORT: '' });
    const offline = await callTarget(root, [], { offline: true });
    assert.notEqual(offline.status, 0);
    assert.equal(offline.targetStarted, false);
    assert.match(offline.diagnostics, /required name\(s\) are missing or empty: REQUIRED_EXPORT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an empty optional value from the store is dropped; --require names it and fails when it is empty', async () => {
  const root = makeRoot();
  try {
    writeEnv(root);
    const prepared = await prepareWith(root, 'empty-required');
    assert.equal(prepared.failure, undefined);
    assert.equal(prepared.env.EMPTY_OPTIONAL, undefined);
    assert.equal(prepared.env.REQUIRED_EXPORT, undefined);
    assert.equal(Object.hasOwn(prepared.env, 'EMPTY_OPTIONAL'), false);
    const required = await callTarget(root, [], { mode: 'empty-required', required: ['EMPTY_OPTIONAL'] });
    assert.notEqual(required.status, 0);
    assert.match(required.diagnostics, /EMPTY_OPTIONAL/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('online mode ignores fallback-only names; offline mode uses fallback alone and says so', async () => {
  const root = makeRoot();
  try {
    writeEnv(root, { ...baseEnv(), STALE_ONLY: 'CANARY_FALLBACK_STALE' });
    const online = await callTarget(root, []);
    assert.equal(online.status, 23, online.diagnostics);
    assert.equal(JSON.parse(online.stdout.split('\n')[1]).staleOnly, false);
    assert.doesNotMatch(online.diagnostics, /offline/);
    const offline = await callTarget(root, [], { offline: true });
    assert.equal(offline.status, 23, offline.diagnostics);
    assert.equal(JSON.parse(offline.stdout.split('\n')[1]).staleOnly, true);
    assert.match(offline.diagnostics, /offline mode enabled/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('invalid and oversized exports fail closed with value-free diagnostics', async () => {
  const root = makeRoot();
  try {
    writeEnv(root);
    // Each message names the wrapper's own limit, so the test does not depend on the OS environment-block size.
    const cases = [['nul-export', /contains a NUL byte/], ['large-export', /exceeds 64 KiB/]];
    for (const [mode, message] of cases) {
      const result = await callTarget(root, [], { mode });
      assert.notEqual(result.status, 0, mode);
      assert.equal(result.targetStarted, false, mode);
      assert.match(result.diagnostics, message, mode);
      assert.doesNotMatch(`${result.stdout}${result.stderr}${result.diagnostics}`, /FAKE_NUL_SECRET|LEAK_MARKER|X{100}/, mode);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('synchronous target spawn failures return generic diagnostics', async () => {
  const root = makeRoot();
  try {
    writeEnv(root, { FALLBACK_VALUE: FAKE.FALLBACK });
    const marker = 'FAKE_ARG_VALUE';
    const result = await callTarget(root, [], { command: process.execPath, args: [`bad\0${marker}`], offline: true });
    assert.equal(result.status, 127);
    assert.equal(result.targetStarted, false);
    assert.doesNotMatch(`${result.stdout}${result.stderr}${result.diagnostics}`, /FAKE_ARG_VALUE/);
    assert.match(result.diagnostics, /cannot start the requested command/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('foreground target output streams before target exit', { timeout: 5000 }, async (t) => {
  const root = makeRoot();
  writeEnv(root, { FALLBACK_VALUE: FAKE.FALLBACK });
  const child = guardedSpawn(process.execPath, [join(HERE, 'agent-vault', 'with-secrets.mjs'), '--offline', process.execPath, '-e', "process.stdout.write('EARLY_OUTPUT\\n'); setTimeout(() => process.exit(0), 1500)"], {
    env: isolatedEnv({ DEV_SETUP_ROOT: root }),
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  t.after(() => { if (child.exitCode === null) child.kill(); rmSync(root, { recursive: true, force: true }); });
  let output = '';
  const observedEarly = new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error('target output did not stream promptly')), 900);
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      if (output.includes('EARLY_OUTPUT')) { clearTimeout(timer); resolvePromise(); }
    });
    child.once('error', rejectPromise);
  });
  await observedEarly;
  assert.equal(child.exitCode, null, 'wrapper should still be running when output arrives');
  await new Promise((resolvePromise, rejectPromise) => {
    child.once('close', resolvePromise);
    child.once('error', rejectPromise);
  });
});

const SIGNAL_SKIP = process.platform === 'win32' ? 'Windows does not deliver POSIX signals to a process' : false;

// The fixture is an ES module, so it imports what it needs instead of using require.
function signalTarget(root, body) {
  const file = join(root, 'signal-target.mjs');
  writeFileSync(file, [
    "import { writeFileSync } from 'node:fs';",
    `const marker = ${JSON.stringify(join(root, 'target-marker'))};`,
    "process.stdout.write('READY\\n');",
    body,
  ].join('\n'));
  return file;
}

function startForegroundWrapper(t, root, target) {
  const child = guardedSpawn(process.execPath, [join(HERE, 'agent-vault', 'with-secrets.mjs'), '--offline', process.execPath, target], {
    env: isolatedEnv({ DEV_SETUP_ROOT: root }),
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); rmSync(root, { recursive: true, force: true }); });
  return child;
}

function waitForReady(child) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error('target did not become ready')), 3000);
    child.stdout.on('data', (chunk) => { if (chunk.toString().includes('READY')) { clearTimeout(timer); resolvePromise(); } });
    child.once('error', rejectPromise);
  });
}

function waitForClose(child) {
  return new Promise((resolvePromise, rejectPromise) => {
    child.once('close', (code, signal) => resolvePromise({ code, signal }));
    child.once('error', rejectPromise);
  });
}

test('POSIX SIGTERM reaches a target that handles it, and the wrapper returns the target exit code', { skip: SIGNAL_SKIP, timeout: 8000 }, async (t) => {
  const root = makeRoot();
  writeEnv(root, { FALLBACK_VALUE: FAKE.FALLBACK });
  const target = signalTarget(root, "process.on('SIGTERM', () => { writeFileSync(marker, 'terminated'); process.exit(42); }); setInterval(() => {}, 1000);");
  const child = startForegroundWrapper(t, root, target);
  await waitForReady(child);
  child.kill('SIGTERM');
  assert.deepEqual(await waitForClose(child), { code: 42, signal: null });
  assert.equal(readFileSync(join(root, 'target-marker'), 'utf8'), 'terminated');
});

test('POSIX SIGTERM to a target that does not handle it returns 143 (128 + SIGTERM)', { skip: SIGNAL_SKIP, timeout: 8000 }, async (t) => {
  const root = makeRoot();
  writeEnv(root, { FALLBACK_VALUE: FAKE.FALLBACK });
  const target = signalTarget(root, 'setInterval(() => {}, 1000);');
  const child = startForegroundWrapper(t, root, target);
  await waitForReady(child);
  child.kill('SIGTERM');
  assert.deepEqual(await waitForClose(child), { code: 143, signal: null });
});

test('POSIX SIGINT is not forwarded to the target; the wrapper absorbs it and waits for the target', { skip: SIGNAL_SKIP, timeout: 8000 }, async (t) => {
  const root = makeRoot();
  writeEnv(root, { FALLBACK_VALUE: FAKE.FALLBACK });
  const target = signalTarget(root, "process.on('SIGINT', () => writeFileSync(marker, 'interrupted')); setTimeout(() => process.exit(0), 1000);");
  const child = startForegroundWrapper(t, root, target);
  await waitForReady(child);
  child.kill('SIGINT');
  assert.deepEqual(await waitForClose(child), { code: 0, signal: null });
  assert.equal(existsSync(join(root, 'target-marker')), false);
});

test('signal plan: Windows registers no handlers; POSIX forwards TERM and HUP and absorbs INT', () => {
  assert.deepEqual(signalPlan('win32', 'target'), { forward: [], absorb: [] });
  assert.deepEqual(signalPlan('win32', 'retrieval'), { forward: [], absorb: [] });
  assert.deepEqual(signalPlan('linux', 'target'), { forward: ['SIGTERM', 'SIGHUP'], absorb: ['SIGINT'] });
  assert.deepEqual(signalPlan('darwin', 'retrieval').forward, ['SIGINT', 'SIGTERM', 'SIGHUP']);
});

test('a Windows run registers no SIGINT, SIGTERM, or SIGHUP listeners', async (t) => {
  const root = makeRoot();
  writeEnv(root, { FALLBACK_VALUE: FAKE.FALLBACK });
  const on = t.mock.method(process, 'on');
  const result = await runWithSecrets({
    root,
    command: process.execPath,
    args: ['-e', 'process.exit(0)'],
    offline: true,
    platform: 'win32',
    env: isolatedEnv(),
    captureTarget: false,
    forwardTargetOutput: false,
    diagnostic: () => {},
  });
  rmSync(root, { recursive: true, force: true });
  assert.equal(result.status, 0);
  const signalCalls = on.mock.calls.filter((call) => ['SIGINT', 'SIGTERM', 'SIGHUP'].includes(call.arguments[0]));
  assert.deepEqual(signalCalls, []);
});

test('POSIX-plan listeners are removed after the target exits', async () => {
  const root = makeRoot();
  writeEnv(root, { FALLBACK_VALUE: FAKE.FALLBACK });
  const before = ['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) => process.listenerCount(signal));
  const result = await runWithSecrets({
    root,
    command: process.execPath,
    args: ['-e', 'process.exit(0)'],
    offline: true,
    platform: 'linux',
    env: isolatedEnv(),
    captureTarget: false,
    forwardTargetOutput: false,
    diagnostic: () => {},
  });
  rmSync(root, { recursive: true, force: true });
  assert.equal(result.status, 0);
  assert.deepEqual(['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) => process.listenerCount(signal)), before);
});

test('secrets-init copies once, stays silent, and does not inspect or overwrite existing file', () => {
  const root = makeRoot();
  try {
    const template = join(root, 'settings', '.env.example');
    const destination = join(root, 'settings', '.env');
    writeFileSync(template, 'FAKE_TEMPLATE_VALUE=not-a-secret\n');
    assert.equal(initializeEnvFile(root), 0);
    assert.equal(readFileSync(destination, 'utf8'), readFileSync(template, 'utf8'));
    writeFileSync(destination, 'KEEP=existing\n');
    assert.equal(initializeEnvFile(root), 0);
    assert.equal(readFileSync(destination, 'utf8'), 'KEEP=existing\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('secrets-init creates settings/.env with mode 0600 on POSIX', { skip: process.platform === 'win32' ? 'Windows ignores POSIX mode bits; the file inherits the settings folder ACL' : false }, () => {
  const root = makeRoot();
  try {
    writeFileSync(join(root, 'settings', '.env.example'), 'FAKE_TEMPLATE_VALUE=not-a-secret\n');
    assert.equal(initializeEnvFile(root), 0);
    assert.equal(statSync(join(root, 'settings', '.env')).mode & 0o777, 0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('secrets-init refuses to overwrite a directory or a link at settings/.env, and writes nothing through it', (t) => {
  const root = makeRoot();
  const env = isolatedEnv({ DEV_SETUP_ROOT: root });
  try {
    writeFileSync(join(root, 'settings', '.env.example'), 'FAKE_TEMPLATE_VALUE=not-a-secret\n');
    const target = join(root, 'settings', '.env');
    mkdirSync(target);
    const onDirectory = guardedSpawnSync(process.execPath, [join(HERE, 'agent-vault', 'with-secrets.mjs'), 'secrets-init'], { env, cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(onDirectory.status, 1);
    assert.match(onDirectory.stderr, /settings\/\.env exists and is not a regular file/);
    assert.equal(statSync(target).isDirectory(), true);
    rmSync(target, { recursive: true });
    // A directory junction needs no privilege on Windows; a directory symlink on POSIX.
    const victimDir = join(root, 'victim-dir');
    mkdirSync(victimDir);
    symlinkSync(victimDir, target, 'junction');
    const onJunction = guardedSpawnSync(process.execPath, [join(HERE, 'agent-vault', 'with-secrets.mjs'), 'secrets-init'], { env, cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(onJunction.status, 1);
    assert.equal(readdirSync(victimDir).length, 0);
    rmSync(target);
    const victim = join(root, 'victim.txt');
    writeFileSync(victim, 'KEEP=victim\n');
    try {
      symlinkSync(victim, target, 'file');
    } catch (error) {
      t.skip(`cannot create a file symlink here: ${error.code}`);
      return;
    }
    const onLink = guardedSpawnSync(process.execPath, [join(HERE, 'agent-vault', 'with-secrets.mjs'), 'secrets-init'], { env, cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(onLink.status, 1);
    assert.doesNotMatch(`${onLink.stdout}${onLink.stderr}`, /KEEP=victim/);
    assert.equal(readFileSync(victim, 'utf8'), 'KEEP=victim\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('secrets-init refuses a dangling junction or link at settings/.env, creates nothing beyond it, and never unlinks it', () => {
  const root = makeRoot();
  const env = isolatedEnv({ DEV_SETUP_ROOT: root });
  try {
    writeFileSync(join(root, 'settings', '.env.example'), 'FAKE_TEMPLATE_VALUE=not-a-secret\n');
    const target = join(root, 'settings', '.env');
    const missingDir = join(root, 'missing-target-dir');
    // A junction on Windows needs no privilege; a directory symlink on POSIX.
    symlinkSync(missingDir, target, 'junction');
    const result = guardedSpawnSync(process.execPath, [join(HERE, 'agent-vault', 'with-secrets.mjs'), 'secrets-init'], { env, cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(existsSync(missingDir), false, 'the dangling target folder must not be created');
    assert.equal(lstatSync(target).isSymbolicLink(), true, 'the link must not be unlinked or replaced');
    assert.equal(existsSync(join(missingDir, '.env')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI entrypoint runs setup silently from a relocatable root and preserves existing files', () => {
  const root = makeRoot();
  try {
    const template = join(root, 'settings', '.env.example');
    const target = join(root, 'settings', '.env');
    writeFileSync(template, 'FAKE_TEMPLATE_VALUE=not-a-secret\n');
    const env = isolatedEnv({ DEV_SETUP_ROOT: root });
    const first = guardedSpawnSync(process.execPath, [join(HERE, 'agent-vault', 'with-secrets.mjs'), 'secrets-init'], { env, cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.stdout, '');
    assert.equal(first.stderr, `with-secrets: DEV_SETUP_ROOT redirects settings to ${root}\n`);
    assert.equal(readFileSync(target, 'utf8'), readFileSync(template, 'utf8'));
    writeFileSync(target, 'KEEP=existing\n');
    const second = guardedSpawnSync(process.execPath, [join(HERE, 'agent-vault', 'with-secrets.mjs'), 'secrets-init'], { env, cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(second.status, 0);
    assert.equal(second.stdout, '');
    assert.equal(second.stderr, `with-secrets: DEV_SETUP_ROOT redirects settings to ${root}\n`);
    assert.equal(readFileSync(target, 'utf8'), 'KEEP=existing\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI entrypoint wrapper forwards target argv and status with an isolated offline env', () => {
  const root = makeRoot();
  try {
    writeEnv(root, { FALLBACK_VALUE: FAKE.FALLBACK });
    const result = guardedSpawnSync(process.execPath, [join(HERE, 'agent-vault', 'with-secrets.mjs'), '--offline', process.execPath, join(root, 'secret-target.mjs'), 'spaced value', ''], {
      env: isolatedEnv({ DEV_SETUP_ROOT: root }),
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(result.status, 23);
    assert.match(result.stdout, /^target-stdout\n/);
    const output = JSON.parse(result.stdout.split('\n')[1]);
    assert.deepEqual(output.args, ['spaced value', '']);
    assert.equal(output.offlineFallback, true);
    assert.equal(output.authLeaked, false);
    assert.match(result.stderr, /offline mode enabled/);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(`${FAKE.FALLBACK}|${FAKE.CLIENT}|${FAKE.TOKEN}`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('PowerShell wrapper passes an isolated offline command and preserves its exit code', { skip: process.platform !== 'win32' }, () => {
  const root = makeRoot();
  try {
    writeEnv(root, { FALLBACK_VALUE: FAKE.FALLBACK });
    const result = guardedSpawnSync('pwsh', [
      '-NoLogo', '-NoProfile', '-File', join(HERE, 'agent-vault', 'with-secrets.ps1'),
      '--offline', process.execPath, join(root, 'secret-target.mjs'), 'spaced value', '',
    ], {
      env: isolatedEnv({ DEV_SETUP_ROOT: root }),
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(result.status, 23, result.stderr);
    const output = JSON.parse(result.stdout.split('\n')[1]);
    assert.deepEqual(output.args, ['spaced value', '']);
    assert.equal(output.offlineFallback, true);
    assert.equal(output.authLeaked, false);
    assert.match(result.stderr, /offline mode enabled/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('PowerShell wrapper passes argv through unchanged, including -v, -d, --, quotes, and empty arguments', { skip: process.platform !== 'win32' }, () => {
  const root = makeRoot();
  try {
    writeEnv(root, { FALLBACK_VALUE: FAKE.FALLBACK });
    const argv = ['-v', '-d', '--', 'a"b', 'spaced value', '', '-pv', 'x', '-ErrorAction', 'Stop', '-a', '-Ar', '-Arguments', 'x'];
    const result = guardedSpawnSync('pwsh', [
      '-NoLogo', '-NoProfile', '-File', join(HERE, 'agent-vault', 'with-secrets.ps1'),
      '--offline', process.execPath, join(root, 'secret-target.mjs'), ...argv,
    ], {
      env: isolatedEnv({ DEV_SETUP_ROOT: root }),
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(result.status, 23, result.stderr);
    const output = JSON.parse(result.stdout.split('\n')[1]);
    assert.deepEqual(output.args, argv);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('retired load-secrets returns to a sourcing shell and exits when executed', { skip: spawnSync('sh', ['-c', 'exit 0'], { windowsHide: true }).error ? 'sh is not available' : false }, () => {
  const root = makeRoot();
  try {
    const loader = join(HERE, '..', 'wsl', 'load-secrets.sh');
    const sourced = guardedSpawnSync('sh', ['-c', '. "$1"; echo ALIVE', 'sh', loader], { encoding: 'utf8', cwd: root, env: isolatedEnv(), windowsHide: true });
    assert.equal(sourced.stdout, 'ALIVE\n');
    assert.match(sourced.stderr, /load-secrets is retired; run with-secrets <command> or just secrets-init\./);
    const executed = guardedSpawnSync('sh', [loader], { encoding: 'utf8', cwd: root, env: isolatedEnv(), windowsHide: true });
    assert.equal(executed.status, 1);
    assert.match(executed.stderr, /load-secrets is retired/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a workspace .envrc is found by presence regardless of its content', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'dev-setup-secrets-envrc-'));
  try {
    const repo = join(workspace, 'projects', 'repos', 'repo');
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(workspace, '.envrc'), '# legacy\ndotenv_if_exists "settings/.env"\nCANARY_ENVRC_CONTENT=1\n');
    assert.equal(findRetiredEnvrc(repo), join(workspace, '.envrc'));
    writeFileSync(join(workspace, '.envrc'), 'export EDITOR=vim\n');
    assert.equal(findRetiredEnvrc(repo), join(workspace, '.envrc'));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('the .envrc detector never opens the file', () => {
  const workspace = mkdtempSync(join(TEMP, 'dev-setup-secrets-envrc-unread-'));
  try {
    const probe = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const { findRetiredEnvrc } = await import(${JSON.stringify(pathToFileURL(join(HERE, 'agent-vault', 'with-secrets-envrc.mjs')).href)});
      fs.lstatSync = (path) => {
        if (path === ${JSON.stringify(join(workspace, '.envrc'))}) return { isDirectory: () => false };
        throw new Error('unexpected metadata probe');
      };
      fs.openSync = fs.readFileSync = () => { throw new Error('file contents must never be read'); };
      syncBuiltinESMExports();
      process.stdout.write(findRetiredEnvrc(${JSON.stringify(workspace)}));
    `], { encoding: 'utf8', windowsHide: true });
    assert.equal(probe.status, 0, probe.stderr);
    assert.equal(probe.stdout, join(workspace, '.envrc'));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('the .envrc detector finds a FIFO without opening it', { skip: process.platform === 'win32' ? 'Windows has no FIFO; Linux CI runs this' : false, timeout: 15000 }, () => {
  const workspace = mkdtempSync(join(TEMP, 'dev-setup-secrets-fifo-'));
  try {
    const fifo = join(workspace, '.envrc');
    const made = spawnSync('mkfifo', [fifo], { windowsHide: true });
    assert.equal(made.status, 0, 'mkfifo is needed for this test');
    const probe = spawnSync(process.execPath, ['--input-type=module', '-e', `import { findRetiredEnvrc } from ${JSON.stringify(pathToFileURL(join(HERE, 'agent-vault', 'with-secrets-envrc.mjs')).href)}; process.stdout.write(String(findRetiredEnvrc(${JSON.stringify(workspace)})));`], { encoding: 'utf8', timeout: 5000, windowsHide: true, env: isolatedEnv() });
    assert.equal(probe.error, undefined, 'the detector blocked on the FIFO');
    assert.equal(probe.stdout, fifo);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('with-secrets and secrets-init print one warning for a retired .envrc and never print its content', () => {
  const root = makeRoot();
  const workspace = mkdtempSync(join(tmpdir(), 'dev-setup-secrets-ws-'));
  try {
    const repo = join(workspace, 'projects', 'repo');
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(workspace, '.envrc'), 'infisical export --path /secrets\nCANARY_ENVRC_CONTENT=1\n');
    writeEnv(root, { FALLBACK_VALUE: FAKE.FALLBACK });
    const env = isolatedEnv({ DEV_SETUP_ROOT: root });
    const init = guardedSpawnSync(process.execPath, [join(HERE, 'agent-vault', 'with-secrets.mjs'), 'secrets-init'], { env, cwd: repo, encoding: 'utf8', windowsHide: true });
    assert.equal(init.status, 0, init.stderr);
    assert.equal(init.stderr.split('\n').filter((line) => line.includes('.envrc')).length, 1);
    assert.doesNotMatch(init.stderr, /CANARY_ENVRC_CONTENT/);
    const run = guardedSpawnSync(process.execPath, [join(HERE, 'agent-vault', 'with-secrets.mjs'), '--offline', process.execPath, '-e', 'process.exit(0)'], { env, cwd: repo, encoding: 'utf8', windowsHide: true });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr.split('\n').filter((line) => line.includes('.envrc')).length, 1);
    assert.doesNotMatch(`${run.stdout}${run.stderr}`, /CANARY_ENVRC_CONTENT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('CLI children get a minimal environment and run from the repository root', async () => {
  const root = makeRoot();
  try {
    writeEnv(root);
    const env = isolatedEnv({ HTTPS_PROXY: 'fake-proxy', NODE_OPTIONS: '--no-warnings', SSL_CERT_FILE: 'fake-ca', CALLER_VALUE: 'caller' });
    const result = await callTarget(root, [], { env });
    assert.equal(result.status, 23, result.diagnostics);
    assert.equal(JSON.parse(result.stdout.split('\n')[1]).caller, 'caller');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('proxy settings reach the CLI only through the documented passthrough opt-in', async () => {
  const root = makeRoot();
  try {
    writeEnv(root);
    const optedIn = await callTarget(root, [], { mode: 'passthrough', env: isolatedEnv({ HTTPS_PROXY: 'fake-proxy', DEV_SETUP_INFISICAL_PASSTHROUGH: 'HTTPS_PROXY' }) });
    assert.equal(optedIn.status, 23, optedIn.diagnostics);
    const notAllowed = await callTarget(root, [], { env: isolatedEnv({ DEV_SETUP_INFISICAL_PASSTHROUGH: 'NODE_OPTIONS' }) });
    assert.notEqual(notAllowed.status, 0);
    assert.equal(notAllowed.targetStarted, false);
    assert.match(notAllowed.diagnostics, /unsupported variable: NODE_OPTIONS/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a planted infisical in the current directory is not selected through a relative PATH entry', () => {
  const planted = mkdtempSync(join(tmpdir(), 'dev-setup-secrets-planted-'));
  const previous = process.cwd();
  try {
    const name = process.platform === 'win32' ? 'infisical.exe' : 'infisical';
    writeFileSync(join(planted, name), 'planted');
    process.chdir(planted);
    assert.equal(resolveInfisical(process.platform, { PATH: '.' }), null);
    assert.equal(resolveInfisical(process.platform, { PATH: `${delimiter}${''}` }), null);
  } finally {
    process.chdir(previous);
    rmSync(planted, { recursive: true, force: true });
  }
});

// Only local absolute paths are trusted: a drive-letter path on Windows, a slash path on POSIX.
// The spy records every path the resolver would stat, so a refused shape must never be probed.
test('UNC, device, root-relative, drive-relative, and relative paths are refused before any stat on Windows', () => {
  const probed = [];
  const exists = (path) => { probed.push(path); return true; };
  const shapes = ['\\\\server\\share\\infisical.exe', '\\\\?\\C:\\infisical.exe', '\\Users\\someone\\infisical.exe', 'C:infisical.exe', 'relative\\infisical.exe'];
  for (const shape of shapes) {
    assert.equal(resolveInfisical('win32', { DEV_SETUP_INFISICAL_PATH: shape }, exists), null, shape);
    assert.equal(resolveModule.isLocalAbsolute('win32', shape), false, shape);
  }
  assert.deepEqual(probed, [], 'a refused override is never stat-ed');
  assert.equal(resolveModule.isLocalAbsolute('win32', 'C:\\Program Files\\infisical.exe'), true);
  assert.equal(resolveModule.isLocalAbsolute('linux', '/usr/bin/infisical'), true);
  assert.equal(resolveModule.isLocalAbsolute('linux', 'infisical'), false);
});

test('an APPDATA that is relative or UNC is never used to build the installed CLI path', () => {
  for (const appData of ['relative-appdata', '\\\\server\\share', '\\\\Users\\someone']) {
    const probed = [];
    const found = resolveInfisical('win32', { APPDATA: appData, PATH: '' }, (path) => { probed.push(path); return false; });
    assert.equal(found, null, appData);
    assert.deepEqual(probed.filter((path) => path.includes('npm')), [], appData);
  }
});

test('a UNC or root-relative PATH entry is never searched, so no target or CLI is read from a share', () => {
  const probed = [];
  const exists = (path) => { probed.push(path); return false; };
  resolveModule.resolveTarget('tool', 'win32', { PATH: '\\\\server\\share;\\Users\\someone;C:\\bin', PATHEXT: '.EXE' }, exists);
  assert.deepEqual(probed.filter((path) => !/^[A-Za-z]:\\/.test(path)), []);
  assert.ok(probed.some((path) => path.startsWith('C:\\bin')));
  resolveInfisical('win32', { PATH: '\\\\server\\share' }, exists);
  assert.deepEqual(probed.filter((path) => path.startsWith('\\\\')), []);
});

test('a relative DEV_SETUP_INFISICAL_PATH is refused even when it names an existing file in the current directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dev-setup-secrets-relative-'));
  const previous = process.cwd();
  try {
    const name = process.platform === 'win32' ? 'infisical.exe' : 'infisical';
    writeFileSync(join(dir, name), 'fake binary marker');
    process.chdir(dir);
    assert.equal(resolveInfisical(process.platform, { DEV_SETUP_INFISICAL_PATH: name }), null);
    assert.equal(resolveInfisical(process.platform, { DEV_SETUP_INFISICAL_PATH: `.${sep}${name}` }), null);
  } finally {
    process.chdir(previous);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI resolution skips relative PATH entries and validates DEV_SETUP_INFISICAL_PATH', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dev-setup-secrets-resolve-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const name = process.platform === 'win32' ? 'infisical.exe' : 'infisical';
    const found = join(bin, name);
    writeFileSync(found, 'fake binary marker');
    assert.equal(resolveInfisical(process.platform, { PATH: ['relative-dir', bin].join(delimiter) }), found);
    assert.equal(resolveInfisical(process.platform, { PATH: `.${delimiter}relative-dir` }), null);
    assert.equal(resolveInfisical(process.platform, { DEV_SETUP_INFISICAL_PATH: 'relative/infisical' }), null);
    assert.equal(resolveInfisical(process.platform, { DEV_SETUP_INFISICAL_PATH: join(dir, 'missing') }), null);
    assert.equal(resolveInfisical(process.platform, { DEV_SETUP_INFISICAL_PATH: bin }), null);
    assert.equal(resolveInfisical(process.platform, { DEV_SETUP_INFISICAL_PATH: found }), found);
    if (process.platform === 'win32') {
      const shim = join(bin, 'infisical.cmd');
      writeFileSync(shim, 'fake command shim');
      assert.equal(resolveInfisical('win32', { DEV_SETUP_INFISICAL_PATH: shim }), null);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loader-affecting names from the store export fail closed, naming the name and never its value', async () => {
  const root = makeRoot();
  try {
    writeEnv(root);
    const names = ['PATH', 'NODE_OPTIONS', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'BASH_ENV', 'ENV', 'PROMPT_COMMAND', 'PYTHONPATH', 'PYTHONSTARTUP', 'PERL5OPT', 'RUBYOPT', 'GIT_SSH_COMMAND', 'DEV_SETUP_ROOT', 'INFISICAL_EXPORTED_TEST'];
    for (const name of names) {
      const result = await callTarget(root, [], { mode: `denied:${name}` });
      assert.notEqual(result.status, 0, name);
      assert.equal(result.targetStarted, false, name);
      assert.match(result.diagnostics, new RegExp(name), name);
      assert.doesNotMatch(`${result.stdout}${result.stderr}${result.diagnostics}`, /CANARY_DENIED_VALUE/, name);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loader-affecting names in settings/.env fail closed in offline mode too', async () => {
  const root = makeRoot();
  try {
    writeEnv(root, { ...baseEnv(), NODE_OPTIONS: 'CANARY_FALLBACK_OPTIONS' });
    const result = await callTarget(root, [], { offline: true });
    assert.notEqual(result.status, 0);
    assert.equal(result.targetStarted, false);
    assert.match(result.diagnostics, /NODE_OPTIONS/);
    assert.doesNotMatch(`${result.stdout}${result.stderr}${result.diagnostics}`, /CANARY_FALLBACK_OPTIONS/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Every name the review listed as loader, interpreter, or TLS-trust control. Each must be refused.
const REVIEW_DENIED_NAMES = ['PYTHONHOME', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'LD_AUDIT', 'PATHEXT', 'npm_config_script_shell', 'PERL5LIB', 'RUBYLIB', 'PSModulePath', 'COMSPEC', 'SHELL', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'CURL_CA_BUNDLE', 'REQUESTS_CA_BUNDLE', 'GIT_SSL_NO_VERIFY'];
const REVIEW_DENIED_PREFIXES = ['LD_', 'DYLD_', 'npm_config_'];

test('the denylist table names every name and prefix the review requires, and refuses each one on Linux and Windows', () => {
  for (const name of REVIEW_DENIED_NAMES) assert.ok(DENIED_NAMES.includes(name) || DENIED_PREFIXES.some((prefix) => name.startsWith(prefix)), name);
  for (const prefix of REVIEW_DENIED_PREFIXES) assert.ok(DENIED_PREFIXES.includes(prefix), prefix);
  for (const name of [...DENIED_NAMES, ...REVIEW_DENIED_NAMES]) {
    assert.equal(isDeniedName(name, 'linux'), true, name);
    assert.equal(isDeniedName(name, 'win32'), true, name);
  }
  for (const prefix of DENIED_PREFIXES) {
    assert.equal(isDeniedName(`${prefix}X_VALUE`, 'linux'), true, prefix);
    assert.equal(isDeniedName(`${prefix.toLowerCase()}x_value`, 'linux'), true, prefix);
    assert.equal(isDeniedName(`${prefix.toLowerCase()}x_value`, 'win32'), true, prefix);
  }
  assert.equal(isDeniedName('FALLBACK_KEY', 'linux'), false);
});

test('a review-listed name in settings/.env is refused offline, naming the name and never its value', async () => {
  const root = makeRoot();
  try {
    for (const name of ['PYTHONHOME', 'npm_config_script_shell', 'LD_AUDIT']) {
      writeEnv(root, { FALLBACK_VALUE: FAKE.FALLBACK, [name]: 'CANARY_FALLBACK_DENIED' });
      const prepared = await prepareTargetEnvironment({ root, offline: true, env: isolatedEnv(), platform: 'linux' });
      assert.match(prepared.failure, new RegExp(name), name);
      assert.doesNotMatch(prepared.failure, /CANARY_FALLBACK_DENIED/, name);
      assert.equal(prepared.env, undefined, name);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the denylist is case-insensitive on Windows and exact on POSIX', () => {
  assert.equal(isDeniedName('Path', 'win32'), true);
  assert.equal(isDeniedName('node_options', 'win32'), true);
  assert.equal(isDeniedName('path', 'linux'), false);
  assert.equal(isDeniedName('PATH', 'linux'), true);
  assert.equal(isDeniedName('GIT_DIR', 'darwin'), true);
  assert.equal(isDeniedName('DYLD_LIBRARY_PATH', 'darwin'), true);
  assert.equal(isDeniedName('INFISICAL_TOKEN', 'linux'), true);
  assert.equal(isDeniedName('FALLBACK_KEY', 'linux'), false);
});

test('a DEV_SETUP_ROOT override is named once per run', () => {
  const root = makeRoot();
  try {
    writeEnv(root, { FALLBACK_VALUE: FAKE.FALLBACK });
    const result = guardedSpawnSync(process.execPath, [join(HERE, 'agent-vault', 'with-secrets.mjs'), '--offline', process.execPath, '-e', 'process.exit(0)'], {
      env: isolatedEnv({ DEV_SETUP_ROOT: root }),
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr.split('\n').filter((line) => line.includes('DEV_SETUP_ROOT')).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function waitForFile(path, ms = 5000) {
  return new Promise((resolvePromise, rejectPromise) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (existsSync(path)) {
        clearInterval(timer);
        resolvePromise();
      } else if (Date.now() - started > ms) {
        clearInterval(timer);
        rejectPromise(new Error(`timed out waiting for ${path}`));
      }
    }, 25);
  });
}

test('the default login and export timeout is 30 seconds', () => {
  assert.equal(CHILD_TIMEOUT_MS, 30 * 1000);
});

// Rejects if the promise has not settled within ms, and clears its timer either way.
function withDeadline(promise, ms, message) {
  let timer;
  const deadline = new Promise((_, rejectPromise) => { timer = setTimeout(() => rejectPromise(new Error(message)), ms); });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

test('a timed-out CLI tree is killed, and the wrapper returns when a grandchild holds the stdout pipe', { timeout: 20000 }, async () => {
  const root = makeRoot();
  const pidFiles = ['hang.pid', 'grandchild.pid'];
  try {
    writeEnv(root);
    const started = Date.now();
    const result = await withDeadline(callTarget(root, [], { mode: 'grandchild', childTimeoutMs: 300 }), 10000, 'the wrapper did not return after the timeout');
    const elapsed = Date.now() - started;
    assert.notEqual(result.status, 0);
    assert.equal(result.targetStarted, false);
    assert.match(result.diagnostics, /did not finish within 0\.3 seconds/);
    assert.ok(elapsed < 6000, `the wrapper took ${elapsed} ms after a 300 ms bound`);
    const [stub, grandchild] = pidFiles.map((name) => Number(readFileSync(join(root, name), 'utf8')));
    assert.throws(() => process.kill(stub, 0), { code: 'ESRCH' });
    assert.throws(() => process.kill(grandchild, 0), { code: 'ESRCH' });
  } finally {
    for (const name of pidFiles) {
      try { process.kill(Number(readFileSync(join(root, name), 'utf8')), 'SIGKILL'); } catch { /* Already gone, or never started. */ }
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('a Windows tree kill names the system taskkill with /T /F /PID, and POSIX has none', () => {
  const command = treeKillCommand('win32', 4321);
  assert.match(command.file, /System32[\\/]taskkill\.exe$/i);
  assert.deepEqual(command.args, ['/T', '/F', '/PID', '4321']);
  assert.equal(treeKillCommand('linux', 4321), null);
  assert.equal(treeKillCommand('win32', undefined), null);
});

test('a child that exits while a grandchild holds its stdout is reported after the grace period', { timeout: 10000 }, async () => {
  const root = makeRoot();
  const pidFile = join(root, 'grandchild.pid');
  try {
    const script = join(root, 'exit-with-grandchild.mjs');
    writeFileSync(script, [
      "import { spawn } from 'node:child_process';",
      "import { writeFileSync } from 'node:fs';",
      `const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'inherit' });`,
      `writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid));`,
      'process.exit(5);',
    ].join('\n'));
    const started = Date.now();
    const result = await withDeadline(runChild(process.execPath, [script], process.env, { capture: true, exitGraceMs: 300 }), 8000, 'the exit was not reported');
    assert.equal(result.status, 5);
    assert.ok(Date.now() - started < 6000);
  } finally {
    try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch { /* Not started, or already gone. */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test('a login or export that exceeds the timeout is killed and the run fails without starting the target', { timeout: 10000 }, async () => {
  const root = makeRoot();
  try {
    writeEnv(root);
    const result = await callTarget(root, [], { mode: 'hang', childTimeoutMs: 300 });
    assert.notEqual(result.status, 0);
    assert.equal(result.targetStarted, false);
    assert.match(result.diagnostics, /did not finish within 0\.3 seconds/);
    const pid = Number(readFileSync(join(root, 'hang.pid'), 'utf8'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SIGTERM or SIGINT during retrieval kills the CLI child and exits 128 plus the signal', { skip: SIGNAL_SKIP, timeout: 15000 }, async () => {
  for (const [signal, status] of [['SIGTERM', 143], ['SIGINT', 130]]) {
    const root = makeRoot();
    try {
      writeEnv(root);
      const harness = join(root, 'harness.mjs');
      writeFileSync(harness, [
        `import { runWithSecrets } from ${JSON.stringify(pathToFileURL(join(HERE, 'agent-vault', 'with-secrets.mjs')).href)};`,
        `const result = await runWithSecrets({`,
        `  root: ${JSON.stringify(root)},`,
        `  command: process.execPath,`,
        `  args: ['-e', 'process.exit(0)'],`,
        `  cli: { file: process.execPath, args: [${JSON.stringify(join(root, 'fake-infisical.mjs'))}, 'hang', ${JSON.stringify(root)}] },`,
        `  captureTarget: true,`,
        `  forwardTargetOutput: false,`,
        `  diagnostic: () => {},`,
        `});`,
        `process.exit(result.status);`,
      ].join('\n'));
      const child = guardedSpawn(process.execPath, [harness], { env: isolatedEnv(), cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      await waitForFile(join(root, 'hang.pid'));
      child.kill(signal);
      assert.deepEqual(await waitForClose(child), { code: status, signal: null }, signal);
      const pid = Number(readFileSync(join(root, 'hang.pid'), 'utf8'));
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, signal);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('a target that cannot be started exits 127 with a clear message and starts nothing', async () => {
  const root = makeRoot();
  try {
    writeEnv(root, { FALLBACK_VALUE: FAKE.FALLBACK });
    const result = await callTarget(root, [], { command: join(root, 'no-such-command-zz'), args: [], offline: true });
    assert.equal(result.status, 127);
    assert.equal(result.targetStarted, false);
    assert.match(result.diagnostics, /cannot start the requested command/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a signal status is 128 plus the signal number, and an unknown name maps to 1', () => {
  assert.equal(signalStatus('SIGINT'), 130);
  assert.equal(signalStatus('SIGTERM'), 143);
  assert.equal(signalStatus('SIGHUP'), 129);
  assert.equal(signalStatus('SIGNOTREAL'), 1);
});

test('a target killed by a signal other than INT or TERM exits 128 plus that signal', { skip: SIGNAL_SKIP, timeout: 8000 }, async () => {
  const root = makeRoot();
  try {
    writeEnv(root, { FALLBACK_VALUE: FAKE.FALLBACK });
    const result = await callTarget(root, [], { command: process.execPath, args: ['-e', "process.kill(process.pid, 'SIGUSR2'); setTimeout(() => {}, 5000);"], offline: true });
    assert.equal(result.status, 128 + 12);
    assert.equal(result.targetStarted, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a bare target name never runs a file from the current directory, and exits 127', { timeout: 15000 }, () => {
  const root = makeRoot();
  const planted = mkdtempSync(join(tmpdir(), 'dev-setup-secrets-target-'));
  const marker = join(planted, 'planted-ran');
  try {
    writeEnv(root, { FALLBACK_VALUE: FAKE.FALLBACK });
    // Windows searches the current directory before PATH, so a copy of node.exe named like a tool is a real plant.
    if (process.platform === 'win32') {
      copyFileSync(process.execPath, join(planted, 'zzz-planted.exe'));
    } else {
      writeFileSync(join(planted, 'zzz-planted'), '#!/bin/sh\necho ran > planted-ran\n');
      chmodSync(join(planted, 'zzz-planted'), 0o755);
    }
    const result = guardedSpawnSync(process.execPath, [join(HERE, 'agent-vault', 'with-secrets.mjs'), '--offline', 'zzz-planted', '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`], {
      env: isolatedEnv({ DEV_SETUP_ROOT: root }),
      cwd: planted,
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(result.status, 127, result.stderr);
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(join(planted, 'planted-ran')), false);
    assert.match(result.stderr, /cannot start the requested command/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(planted, { recursive: true, force: true });
  }
});

// The resolver takes the platform as a parameter, so the Windows rules run on any host.
test('target resolution searches absolute PATH entries only, with PATHEXT order on Windows', () => {
  const seen = [];
  const exists = (path) => { seen.push(path); return path === 'C:\\bin\\tool.EXE'; };
  const env = { PATH: '.;relative;C:\\bin', PATHEXT: '.COM;.EXE' };
  assert.equal(resolveModule.resolveTarget('tool', 'win32', env, exists), 'C:\\bin\\tool.EXE');
  assert.deepEqual(seen.filter((path) => !/^[A-Za-z]:\\/.test(path)), [], 'only drive-letter folders are searched');
  assert.equal(resolveModule.resolveTarget('tool', 'win32', { PATH: '.;relative', PATHEXT: '.COM;.EXE' }, () => true), null);
  assert.equal(resolveModule.resolveTarget('tool', 'win32', { PATH: 'C:\\bin', PATHEXT: '.COM' }, exists), null);
  assert.equal(resolveModule.resolveTarget('tool.EXE', 'win32', { PATH: 'C:\\bin', PATHEXT: '.COM;.EXE' }, (path) => path === 'C:\\bin\\tool.EXE'), 'C:\\bin\\tool.EXE');
});

test('target resolution on POSIX never checks the current directory and returns a slash path', () => {
  const seen = [];
  const found = resolveModule.resolveTarget('tool', 'linux', { PATH: '.:/usr/local/bin:/usr/bin' }, (path) => { seen.push(path); return path === '/usr/bin/tool'; });
  assert.equal(found, '/usr/bin/tool');
  assert.deepEqual(seen, ['/usr/local/bin/tool', '/usr/bin/tool']);
});

test('a target with a path separator is made absolute and used as written; nothing else resolves to null', () => {
  assert.equal(resolveModule.resolveTarget(`.${sep}tool`, process.platform, {}, () => false), resolve(`.${sep}tool`));
  assert.equal(resolveModule.resolveTarget('no-such-tool-zz', process.platform, { PATH: '' }), null);
});

test('captured target output over the capture limit fails with that reason, not the cannot-start status', async () => {
  const root = makeRoot();
  try {
    writeEnv(root, { FALLBACK_VALUE: FAKE.FALLBACK });
    const result = await callTarget(root, [], { command: process.execPath, args: ['-e', "process.stdout.write('x'.repeat(1100000))"], offline: true });
    assert.equal(result.status, 1);
    assert.match(result.diagnostics, /capture limit/);
    assert.doesNotMatch(result.diagnostics, /cannot start/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the target environment comes from a helper that returns only the final env', async () => {
  const root = makeRoot();
  try {
    writeEnv(root);
    const prepared = await prepareTargetEnvironment({
      root,
      offline: false,
      env: isolatedEnv(),
      platform: process.platform,
      injectedCli: { file: process.execPath, args: [join(root, 'fake-infisical.mjs'), 'ok', root] },
      childTimeoutMs: CHILD_TIMEOUT_MS,
    });
    assert.deepEqual(Object.keys(prepared), ['env']);
    assert.equal(prepared.env.FALLBACK_VALUE, FAKE.EXPORT);
    assert.equal(prepared.env.INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET, undefined);
    assert.doesNotMatch(JSON.stringify(prepared), new RegExp(`${FAKE.CLIENT}|${FAKE.TOKEN}`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('dotenv parser strips a BOM, rejects Windows case variants, keeps quotes and comments literal, and stays data-only', () => {
  assert.deepEqual({ ...parseEnvFile('﻿A=one\n') }, { A: 'one' });
  assert.throws(() => parseEnvFile('Path=a\nPATH=b\n', 'win32'), /duplicate/);
  assert.deepEqual({ ...parseEnvFile('Path=a\nPATH=b\n', 'linux') }, { Path: 'a', PATH: 'b' });
  assert.deepEqual({ ...parseEnvFile('QUOTED="quoted"\nSINGLE=\'x\'\n') }, { QUOTED: '"quoted"', SINGLE: "'x'" });
  assert.deepEqual({ ...parseEnvFile('TRAIL=val # x\n') }, { TRAIL: 'val # x' });
  // The dollar-brace text is literal data here, so these are plain strings, not template literals.
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the dollar-brace text is data to parse, not a template
  assert.deepEqual({ ...parseEnvFile('SUB=$(echo hi)\nTICK=`id`\nDEF=${X:-y}\n') }, { SUB: '$(echo hi)', TICK: '`id`', DEF: '${X:-y}' });
  assert.throws(() => parseEnvFile('export A=1\n'), /invalid/);
  assert.throws(() => parseEnvFile('A=x\ry\n'), /invalid/);
  assert.throws(() => parseEnvFile(`A=x${String.fromCharCode(0)}y\n`), /invalid/);
});

test('settings/.env that is a directory, a junction, or a symlink is refused without reading it', async (t) => {
  const root = makeRoot();
  try {
    const envPath = join(root, 'settings', '.env');
    mkdirSync(envPath);
    const onDirectory = await callTarget(root, [], { offline: true });
    assert.equal(onDirectory.status, 1);
    assert.match(onDirectory.diagnostics, /must be a regular file, not a link or directory/);
    rmSync(envPath, { recursive: true });
    const victimDir = join(root, 'victim-dir');
    mkdirSync(victimDir);
    symlinkSync(victimDir, envPath, 'junction');
    const onJunction = await callTarget(root, [], { offline: true });
    assert.equal(onJunction.status, 1);
    assert.match(onJunction.diagnostics, /must be a regular file, not a link or directory/);
    rmSync(envPath);
    const victim = join(root, 'victim.env');
    writeEnv(root, { FALLBACK_VALUE: FAKE.FALLBACK });
    renameSync(envPath, victim);
    try {
      symlinkSync(victim, envPath, 'file');
    } catch (error) {
      t.skip(`cannot create a file symlink here: ${error.code}`);
      return;
    }
    const onLink = await callTarget(root, [], { offline: true });
    assert.equal(onLink.status, 1);
    assert.match(onLink.diagnostics, /must be a regular file, not a link or directory/);
    assert.doesNotMatch(`${onLink.stdout}${onLink.stderr}${onLink.diagnostics}`, new RegExp(FAKE.FALLBACK));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a junction named as DEV_SETUP_INFISICAL_PATH is refused: it resolves to a directory, which is never a CLI', () => {
  const root = mkdtempSync(join(TEMP, 'dev-setup-secrets-junction-cli-'));
  try {
    const target = join(root, 'real-dir');
    mkdirSync(target);
    const name = process.platform === 'win32' ? 'infisical.exe' : 'infisical';
    const link = join(root, name);
    symlinkSync(target, link, 'junction');
    assert.equal(resolveInfisical(process.platform, { DEV_SETUP_INFISICAL_PATH: link }), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a hard link at settings/.env is read as the file it links to, and secrets-init never replaces it', async () => {
  const root = makeRoot();
  try {
    const victim = join(root, 'victim.env');
    writeFileSync(victim, `FALLBACK_VALUE=${FAKE.FALLBACK}\n`);
    linkSync(victim, join(root, 'settings', '.env'));
    const offline = await callTarget(root, [], { offline: true });
    assert.equal(offline.status, 23, offline.diagnostics);
    assert.equal(JSON.parse(offline.stdout.split('\n')[1]).offlineFallback, true);
    const init = guardedSpawnSync(process.execPath, [join(HERE, 'agent-vault', 'with-secrets.mjs'), 'secrets-init'], { env: isolatedEnv({ DEV_SETUP_ROOT: root }), cwd: root, encoding: 'utf8', windowsHide: true });
    // An existing regular file, a hard link included, is left alone: secrets-init returns 0 without writing.
    assert.equal(init.status, 0, init.stderr);
    assert.equal(readFileSync(victim, 'utf8'), `FALLBACK_VALUE=${FAKE.FALLBACK}\n`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('settings/.env is capped at 64 KiB: one byte over fails, exactly 64 KiB is read', async () => {
  const root = makeRoot();
  try {
    const head = `FALLBACK_VALUE=${FAKE.FALLBACK}\n`;
    const exact = `${head}#${'x'.repeat(64 * 1024 - head.length - 2)}\n`;
    assert.equal(Buffer.byteLength(exact), 64 * 1024);
    writeFileSync(join(root, 'settings', '.env'), exact);
    const accepted = await callTarget(root, [], { offline: true });
    assert.equal(accepted.status, 23, accepted.diagnostics);
    writeFileSync(join(root, 'settings', '.env'), `${exact}#`);
    const rejected = await callTarget(root, [], { offline: true });
    assert.equal(rejected.status, 1);
    assert.equal(rejected.targetStarted, false);
    assert.match(rejected.diagnostics, /larger than 64 KiB/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The cap tests call prepareTargetEnvironment, so an accepted value never reaches
// a target spawn where the Windows environment-block limit would intervene.
function prepareWith(root, mode, extra = {}) {
  return prepareTargetEnvironment({
    root,
    offline: false,
    env: isolatedEnv(),
    platform: process.platform,
    injectedCli: { file: process.execPath, args: [join(root, 'fake-infisical.mjs'), mode, root] },
    childTimeoutMs: CHILD_TIMEOUT_MS,
    ...extra,
  });
}

test('the per-value cap accepts exactly 64 KiB', async () => {
  const root = makeRoot();
  try {
    writeEnv(root);
    const prepared = await prepareWith(root, 'value-exact');
    assert.equal(prepared.failure, undefined);
    assert.equal(Buffer.byteLength(prepared.env.EXACT), 64 * 1024);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the total cap accepts exactly 256 KiB and refuses one byte more', async () => {
  const root = makeRoot();
  try {
    writeEnv(root);
    const exact = await prepareWith(root, 'total-exact');
    assert.equal(exact.failure, undefined);
    assert.equal(exact.env.K4.length, 64 * 1024 - 18);
    const over = await prepareWith(root, 'total-over');
    assert.match(over.failure, /exceeds 256 KiB in total/);
    assert.equal(over.env, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('captured CLI output over 1 MiB fails the export; it is not parsed into values', async () => {
  const root = makeRoot();
  try {
    writeEnv(root);
    const prepared = await prepareWith(root, 'huge-export');
    assert.match(prepared.failure, /login or a required folder export failed/);
    assert.doesNotMatch(prepared.failure, /256 KiB/);
    assert.equal(prepared.env, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('case-variant keys in one store export are refused on Windows, both within a folder and across folders, and stay distinct elsewhere', async () => {
  const root = makeRoot();
  try {
    writeEnv(root);
    const within = await prepareWith(root, 'case-variant', { platform: 'win32' });
    assert.match(within.failure, /differ only by case: Mixed_Case and MIXED_CASE/);
    assert.equal(within.env, undefined);
    const across = await prepareWith(root, 'case-across', { platform: 'win32' });
    assert.match(across.failure, /differ only by case: Mixed_Case and MIXED_CASE/);
    const posix = await prepareWith(root, 'case-variant', { platform: 'linux' });
    assert.equal(posix.failure, undefined);
    assert.equal(posix.env.Mixed_Case, 'a');
    assert.equal(posix.env.MIXED_CASE, 'b');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a key exported by both /secrets and /pii is refused', async () => {
  const root = makeRoot();
  try {
    writeEnv(root);
    const prepared = await prepareWith(root, 'dup-across');
    assert.match(prepared.failure, /repeats a key/);
    assert.equal(prepared.env, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('offline is enabled only by a first argument of --offline, never by a later one', () => {
  const root = makeRoot();
  try {
    writeEnv(root);
    const env = isolatedEnv({ DEV_SETUP_ROOT: root, PATH: '' });
    const later = guardedSpawnSync(process.execPath, [join(HERE, 'agent-vault', 'with-secrets.mjs'), process.execPath, '-e', 'process.exit(0)', '--offline'], { env, cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(later.status, 1);
    assert.doesNotMatch(later.stderr, /offline mode enabled/);
    assert.match(later.stderr, /login or a required folder export failed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('offline is never enabled by an environment variable', () => {
  const root = makeRoot();
  try {
    writeEnv(root);
    const env = isolatedEnv({ DEV_SETUP_ROOT: root, PATH: '', DEV_SETUP_OFFLINE: '1', WITH_SECRETS_OFFLINE: '1', OFFLINE: '1' });
    const result = guardedSpawnSync(process.execPath, [join(HERE, 'agent-vault', 'with-secrets.mjs'), process.execPath, '-e', 'process.exit(0)'], { env, cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stderr, /offline mode enabled/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The grammar module is loaded lazily so a missing module fails only the tests that use it.
async function loadArgs() {
  return import('./agent-vault/with-secrets-args.mjs');
}

test('argument grammar reads options only before the tool and keeps the tool argv unchanged', async () => {
  const { parseArguments } = await loadArgs();
  assert.deepEqual(parseArguments(['--offline', '--require', 'A,B', '--require', 'C', 'node', '-v', '--require', 'X']), {
    offline: true,
    required: ['A', 'B', 'C'],
    only: [],
    command: 'node',
    args: ['-v', '--require', 'X'],
  });
  assert.deepEqual(parseArguments(['node', '--offline']), { offline: false, required: [], only: [], command: 'node', args: ['--offline'] });
  assert.deepEqual(parseArguments(['--only', 'A,B', '--only', 'C', 'node']), { offline: false, required: [], only: ['A', 'B', 'C'], command: 'node', args: [] });
  assert.match(parseArguments(['--require']).error, /needs a comma-separated list of names/);
  assert.match(parseArguments(['--require', 'A-B', 'node']).error, /needs a comma-separated list of names/);
  assert.match(parseArguments(['--require', '', 'node']).error, /needs a comma-separated list of names/);
  assert.match(parseArguments(['--bogus', 'node']).error, /unknown option --bogus/);
  assert.match(parseArguments(['--offline']).error, /usage: with-secrets/);
  // After one --, a token that looks like an option is the tool itself.
  assert.deepEqual(parseArguments(['--', '--offline', 'x']), { offline: false, required: [], only: [], command: '--offline', args: ['x'] });
});

test('one -- ends the options, so a tool whose name follows it still runs, and nothing after it is read as an option', () => {
  const root = makeRoot();
  try {
    writeEnv(root, { FALLBACK_VALUE: FAKE.FALLBACK });
    const result = guardedSpawnSync(process.execPath, [join(HERE, 'agent-vault', 'with-secrets.mjs'), '--offline', '--', process.execPath, join(root, 'secret-target.mjs'), '--offline'], { env: isolatedEnv({ DEV_SETUP_ROOT: root }), cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 23, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.split('\n')[1]).args, ['--offline']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--only restricts the target to the named keys, after the denylist, and the default passes everything', async () => {
  const root = makeRoot();
  try {
    writeEnv(root, { ...baseEnv(), FALLBACK_VALUE: FAKE.FALLBACK });
    // Online, so /pii is fetched: the restriction is what keeps PII_TEST out of the target.
    const restricted = await callTarget(root, [], { only: ['FALLBACK_VALUE'] });
    assert.equal(restricted.status, 23, restricted.diagnostics);
    const seen = JSON.parse(restricted.stdout.split('\n')[1]);
    assert.equal(seen.fallback, true);
    assert.equal(seen.pii, false);
    const open = await callTarget(root, []);
    assert.equal(JSON.parse(open.stdout.split('\n')[1]).pii, true);
    writeEnv(root, { FALLBACK_VALUE: FAKE.FALLBACK, NODE_OPTIONS: 'CANARY_DENIED_OPTIONS' });
    const denied = await callTarget(root, [], { offline: true, only: ['FALLBACK_VALUE'] });
    assert.equal(denied.targetStarted, false);
    assert.match(denied.diagnostics, /NODE_OPTIONS/);
    assert.doesNotMatch(denied.diagnostics, /CANARY_DENIED_OPTIONS/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--require fails closed for an absent name, naming the key and never a value', () => {
  const root = makeRoot();
  const marker = join(root, 'target-ran');
  try {
    writeEnv(root, { FALLBACK_VALUE: FAKE.FALLBACK });
    const env = isolatedEnv({ DEV_SETUP_ROOT: root });
    const script = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`;
    const absent = guardedSpawnSync(process.execPath, [join(HERE, 'agent-vault', 'with-secrets.mjs'), '--offline', '--require', 'MISSING_NAME', process.execPath, '-e', script], { env, cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(absent.status, 1);
    assert.match(absent.stderr, /required name\(s\) are missing or empty: MISSING_NAME/);
    assert.equal(existsSync(marker), false);
    assert.doesNotMatch(`${absent.stdout}${absent.stderr}`, new RegExp(FAKE.FALLBACK));
    const present = guardedSpawnSync(process.execPath, [join(HERE, 'agent-vault', 'with-secrets.mjs'), '--offline', '--require', 'FALLBACK_VALUE', process.execPath, '-e', script], { env, cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(present.status, 0, present.stderr);
    assert.equal(existsSync(marker), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('offline mode with no non-empty fallback value fails with its own message, before any required check', async () => {
  const root = makeRoot();
  try {
    writeFileSync(join(root, 'settings', '.env'), 'FALLBACK_EMPTY=\n');
    const prepared = await prepareTargetEnvironment({ root, offline: true, env: isolatedEnv(), platform: 'linux' });
    assert.match(prepared.failure, /offline mode has no fallback values in settings\/\.env/);
    assert.equal(prepared.env, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('template-derived names are required offline too, and an empty fallback value counts as missing', async () => {
  const root = makeRoot();
  try {
    writeFileSync(join(root, 'settings', '.env.example'), 'INFISICAL_ENV=dev\nTEMPLATE_NAME=\n');
    writeEnv(root, { FALLBACK_VALUE: FAKE.FALLBACK });
    const offline = await prepareTargetEnvironment({ root, offline: true, env: isolatedEnv(), platform: 'linux' });
    assert.match(offline.failure, /required name\(s\) are missing or empty: TEMPLATE_NAME/);
    assert.equal(offline.env, undefined);
    writeEnv(root, { FALLBACK_VALUE: FAKE.FALLBACK, TEMPLATE_NAME: '' });
    const empty = await prepareTargetEnvironment({ root, offline: true, env: isolatedEnv(), platform: 'linux', required: ['FALLBACK_VALUE'] });
    assert.match(empty.failure, /TEMPLATE_NAME/);
    assert.doesNotMatch(empty.failure, new RegExp(FAKE.FALLBACK));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a run with nothing required prints one warning line that names --require', () => {
  const root = makeRoot();
  try {
    writeEnv(root, { FALLBACK_VALUE: FAKE.FALLBACK });
    const result = guardedSpawnSync(process.execPath, [join(HERE, 'agent-vault', 'with-secrets.mjs'), '--offline', process.execPath, '-e', 'process.exit(0)'], { env: isolatedEnv({ DEV_SETUP_ROOT: root }), cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr.split('\n').filter((line) => line.includes('--require')).length, 1);
    assert.match(result.stderr, /partial store results cannot be detected/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unknown option before the tool is a usage error with exit 2 and starts nothing', () => {
  const root = makeRoot();
  try {
    writeEnv(root, { FALLBACK_VALUE: FAKE.FALLBACK });
    const result = guardedSpawnSync(process.execPath, [join(HERE, 'agent-vault', 'with-secrets.mjs'), '--bogus', process.execPath, '-e', 'process.exit(0)'], { env: isolatedEnv({ DEV_SETUP_ROOT: root }), cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unknown option --bogus/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the POSIX entry passes the tool argv through sh byte for byte, including spaces, empties, quotes, and --', { skip: spawnSync('sh', ['-c', 'exit 0'], { windowsHide: true }).error ? 'sh is not available' : false }, () => {
  const root = makeRoot();
  try {
    writeEnv(root, { FALLBACK_VALUE: FAKE.FALLBACK });
    const entry = join(HERE, 'agent-vault', 'with-secrets').replaceAll('\\', '/');
    const argv = ['a b', '', 'q"x', '-v', '--'];
    const nodeDir = dirname(process.execPath);
    const result = guardedSpawnSync('sh', [entry, '--offline', process.execPath, join(root, 'secret-target.mjs'), ...argv], {
      env: isolatedEnv({ DEV_SETUP_ROOT: root, PATH: `${nodeDir}${delimiter}${process.env.PATH ?? ''}` }),
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(result.status, 23, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.split('\n')[1]).args, argv);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the PowerShell entry carries --require and --offline before the tool and the tool argv after it', { skip: process.platform !== 'win32' }, () => {
  const root = makeRoot();
  try {
    writeEnv(root, { FALLBACK_VALUE: FAKE.FALLBACK });
    const argv = ['-v', '--', 'a"b', ''];
    const result = guardedSpawnSync('pwsh', [
      '-NoLogo', '-NoProfile', '-File', join(HERE, 'agent-vault', 'with-secrets.ps1'),
      '--offline', '--require', 'FALLBACK_VALUE', process.execPath, join(root, 'secret-target.mjs'), ...argv,
    ], { env: isolatedEnv({ DEV_SETUP_ROOT: root }), cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 23, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.split('\n')[1]).args, argv);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the default root is the script location, not the current directory', () => {
  const layout = mkdtempSync(join(tmpdir(), 'dev-setup-secrets-layout-'));
  const elsewhere = mkdtempSync(join(tmpdir(), 'dev-setup-secrets-cwd-'));
  try {
    mkdirSync(join(layout, 'scripts', 'agent-vault'), { recursive: true });
    mkdirSync(join(layout, 'settings'));
    mkdirSync(join(elsewhere, 'settings'));
    for (const name of readdirSync(join(HERE, 'agent-vault')).filter((file) => file.endsWith('.mjs'))) {
      copyFileSync(join(HERE, 'agent-vault', name), join(layout, 'scripts', 'agent-vault', name));
    }
    writeFileSync(join(layout, 'settings', '.env.example'), 'INFISICAL_ENV=dev\n');
    writeFileSync(join(layout, 'settings', '.env'), 'FALLBACK_VALUE=from-script-root\n');
    writeFileSync(join(elsewhere, 'settings', '.env'), 'FALLBACK_VALUE=from-cwd\n');
    const env = isolatedEnv();
    delete env.DEV_SETUP_ROOT;
    const result = guardedSpawnSync(process.execPath, [join(layout, 'scripts', 'agent-vault', 'with-secrets.mjs'), '--offline', process.execPath, '-e', 'process.stdout.write(String(process.env.FALLBACK_VALUE))'], { env, cwd: elsewhere, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'from-script-root');
  } finally {
    rmSync(layout, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

// The text of one call, from its opening parenthesis to the matching close.
function callText(source, openAt) {
  let depth = 0;
  for (let index = openAt; index < source.length; index += 1) {
    if (source[index] === '(') depth += 1;
    else if (source[index] === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(openAt, index + 1);
    }
  }
  return source.slice(openAt);
}

test('every spawn call site in the wrapper modules passes a literal windowsHide: true, read from the source', () => {
  const dir = join(HERE, 'agent-vault');
  let calls = 0;
  for (const name of readdirSync(dir).filter((file) => file.endsWith('.mjs'))) {
    const source = readFileSync(join(dir, name), 'utf8');
    // A bare call only: a method such as regex.exec(...) is not a child process.
    for (const match of source.matchAll(/(?<![.\w])(spawn|spawnSync|exec|execSync|execFile|execFileSync)\(/g)) {
      calls += 1;
      const call = callText(source, match.index + match[0].length - 1);
      assert.match(call, /windowsHide:\s*true/, `${name} calls ${match[1]} without a literal windowsHide: true`);
    }
  }
  assert.equal(calls, 2, `the scan found ${calls} spawn call sites; the runner and the tree kill are the two`);
});

test('CLI and target spawns use the module options: windowsHide true, no shell, and the expected stdio', () => {
  const captured = childSpawnOptions({ env: { A: '1' }, cwd: process.cwd(), capture: true });
  assert.equal(captured.windowsHide, true);
  assert.equal(captured.shell, false);
  assert.deepEqual(captured.stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal(childSpawnOptions({ env: {}, capture: false }).stdio, 'inherit');
});
