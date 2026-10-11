import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KEY_PATTERN, expectedStoreNames, parseEnvFile, readEnvFile, EnvFileError } from './with-secrets-env.mjs';
import { cleanEnvironment, cliEnvironment, foldName, isDeniedName, parsePassthrough } from './with-secrets-policy.mjs';
import { resolveInfisical } from './with-secrets-resolve.mjs';
import { CHILD_TIMEOUT_MS, runChild, signalPlan, signalStatus } from './with-secrets-run.mjs';

const REQUIRED = [
  'INFISICAL_DOMAIN',
  'INFISICAL_PROJECT_ID',
  'INFISICAL_UNIVERSAL_AUTH_CLIENT_ID',
  'INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET',
];
const STORE_FIELDS = new Set([...REQUIRED, 'INFISICAL_ENV']);
const LOGIN_FIELDS = ['INFISICAL_DOMAIN', 'INFISICAL_UNIVERSAL_AUTH_CLIENT_ID', 'INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET'];
const FOLDERS = ['/secrets', '/pii'];
const MAX_EXPORT_VALUE_BYTES = 64 * 1024;
const MAX_EXPORT_TOTAL_BYTES = 256 * 1024;
const LOGIN_FAILED = 'Infisical login or a required folder export failed; check the store and use --offline only when intended';
export const NO_REQUIRED_WARNING = 'with-secrets: no required names; partial store results cannot be detected, pass --require NAMES\n';

function parseRecords(stdout) {
  try {
    const records = JSON.parse(stdout);
    return Array.isArray(records) ? records : null;
  } catch {
    return null;
  }
}

// A child that was interrupted or timed out ends the retrieval with its own status.
function retrievalStop(result, timeoutMs) {
  if (result.interrupted) {
    return { failure: 'Infisical retrieval was interrupted; no command was started', status: signalStatus(result.interrupted) };
  }
  if (result.timedOut) return { failure: `Infisical login or export did not finish within ${timeoutMs / 1000} seconds; no command was started` };
  return null;
}

// Value-free reason an exported record cannot be used, or null.
function recordProblem(record) {
  if (!record || typeof record.key !== 'string' || !KEY_PATTERN.test(record.key) || typeof record.value !== 'string') {
    return 'the store export is not a list of valid key/value records';
  }
  if (record.value.includes('\0')) return 'an exported value contains a NUL byte';
  return null;
}

// Login alone gets the client identity. Returns { token } or { failure, status? }.
async function login(ctx) {
  const loginFields = Object.fromEntries(LOGIN_FIELDS.map((name) => [name, ctx.bootstrap[name]]));
  const result = await runChild(ctx.cli.file, [...(ctx.cli.args ?? []), 'login', '--method=universal-auth', '--plain', '--silent'], { ...ctx.base, ...loginFields }, { capture: true, plan: ctx.plan, cwd: ctx.root, timeoutMs: ctx.timeoutMs, platform: ctx.platform, group: true });
  const stop = retrievalStop(result, ctx.timeoutMs);
  if (stop) return stop;
  if (result.error || result.status !== 0 || !result.stdout.trim()) return { failure: LOGIN_FAILED };
  return { token: result.stdout.trim() };
}

// Export alone gets the session token. Returns { records } or { failure, status? }.
async function exportFolder(ctx, folder, token) {
  const exportEnv = { ...ctx.base, INFISICAL_DOMAIN: ctx.bootstrap.INFISICAL_DOMAIN, INFISICAL_TOKEN: token };
  const result = await runChild(ctx.cli.file, [
    ...(ctx.cli.args ?? []), 'export', '--projectId', ctx.bootstrap.INFISICAL_PROJECT_ID,
    '--env', ctx.bootstrap.INFISICAL_ENV ?? 'dev', '--path', folder, '--format', 'json', '--silent',
  ], exportEnv, { capture: true, plan: ctx.plan, cwd: ctx.root, timeoutMs: ctx.timeoutMs, platform: ctx.platform, group: true });
  const stop = retrievalStop(result, ctx.timeoutMs);
  if (stop) return stop;
  if (result.error || result.status !== 0) return { failure: LOGIN_FAILED };
  const records = parseRecords(result.stdout);
  if (!records) return { failure: LOGIN_FAILED };
  if (records.length === 0) return { failure: `store returned no records for ${folder}; check the store identity, project, and environment` };
  return { records };
}

// Adds one record to values, or returns a value-free failure. state carries the running
// byte total and the folded names seen so far. Keys that fold to one name are one variable
// on Windows, so they are refused together.
function addRecord(values, state, record, platform) {
  const problem = recordProblem(record);
  if (problem) return problem;
  const valueBytes = Buffer.byteLength(record.value, 'utf8');
  if (valueBytes > MAX_EXPORT_VALUE_BYTES) return 'an exported value exceeds 64 KiB';
  state.bytes += Buffer.byteLength(record.key, 'utf8') + valueBytes;
  if (state.bytes > MAX_EXPORT_TOTAL_BYTES) return 'the store export exceeds 256 KiB in total';
  const folded = foldName(record.key, platform);
  const prior = state.byFoldedName.get(folded);
  if (prior !== undefined) {
    return prior === record.key ? 'the store export repeats a key' : `the store export has keys that differ only by case: ${prior} and ${record.key}`;
  }
  state.byFoldedName.set(folded, record.key);
  values[record.key] = record.value;
  return null;
}

// Returns { values } for a complete export, or { failure, status? } with a value-free message.
async function readFolders({ cli, bootstrap, sourceEnv, platform, root, passthrough, timeoutMs }) {
  const ctx = { cli, bootstrap, platform, root, timeoutMs, plan: signalPlan(platform, 'retrieval'), base: cliEnvironment(sourceEnv, platform, passthrough) };
  const session = await login(ctx);
  if (session.failure) return session;
  const values = Object.create(null);
  const state = { bytes: 0, byFoldedName: new Map() };
  for (const folder of FOLDERS) {
    const exported = await exportFolder(ctx, folder, session.token);
    if (exported.failure) return exported;
    for (const record of exported.records) {
      const failure = addRecord(values, state, record, platform);
      if (failure) return { failure };
    }
  }
  return { values };
}

// Online values come from the store export only. Returns { values } or { failure }.
async function retrieveStoreValues({ root, fileValues, env, platform, injectedCli, childTimeoutMs }) {
  let passthrough;
  try {
    passthrough = parsePassthrough(env.DEV_SETUP_INFISICAL_PASSTHROUGH, platform);
  } catch (error) {
    return { failure: error.message };
  }
  const cliPath = injectedCli?.file ?? resolveInfisical(platform, env);
  if (!cliPath) {
    return { failure: env.DEV_SETUP_INFISICAL_PATH
      ? 'DEV_SETUP_INFISICAL_PATH must name an existing absolute native executable file'
      : 'Infisical native executable is unavailable; install it or use --offline with configured fallback values' };
  }
  const bootstrap = { ...fileValues, INFISICAL_ENV: fileValues.INFISICAL_ENV || 'dev' };
  try {
    return await readFolders({ cli: { file: cliPath, args: injectedCli?.args ?? [] }, bootstrap, sourceEnv: env, platform, root, passthrough, timeoutMs: childTimeoutMs });
  } catch {
    return { failure: LOGIN_FAILED };
  }
}

// Names the template expects in the store: its uncommented KEY= lines.
function templateNames(root) {
  let text;
  try {
    text = readFileSync(join(root, 'settings', '.env.example'), 'utf8');
  } catch {
    throw new Error('settings/.env.example is missing or unreadable');
  }
  try {
    return expectedStoreNames(text);
  } catch (error) {
    throw new Error(`settings/.env.example has an ${error.message}; correct the template`);
  }
}

// The value stored under a name, matched case-insensitively on Windows; '' when absent.
function valueNamed(values, name, platform) {
  const wanted = foldName(name, platform);
  const key = Object.keys(values).find((candidate) => foldName(candidate, platform) === wanted);
  return key === undefined ? '' : values[key];
}

// settings/.env as { fileValues } or { failure }.
function readFileValues(root, platform) {
  try {
    return { fileValues: parseEnvFile(readEnvFile(root), platform) };
  } catch (error) {
    if (error.code === 'ENOENT') return { failure: 'settings/.env is missing; run just secrets-init and fill in its store fields' };
    if (error instanceof EnvFileError) return { failure: error.message };
    return { failure: 'settings/.env is invalid; correct its key/value lines' };
  }
}

// The values that come from the store (online) or from settings/.env (offline).
async function sourceValues({ offline, root, fileValues, env, platform, injectedCli, childTimeoutMs }) {
  if (offline) {
    const fallback = Object.create(null);
    for (const [key, value] of Object.entries(fileValues)) {
      if (!key.toUpperCase().startsWith('INFISICAL_')) fallback[key] = value;
    }
    if (!Object.values(fallback).some((value) => value !== '')) return { failure: 'offline mode has no fallback values in settings/.env' };
    return { values: fallback };
  }
  if (REQUIRED.some((key) => !fileValues[key])) {
    return { failure: 'store configuration is incomplete; fill the required fields in settings/.env or use --offline with configured fallback values' };
  }
  const retrieved = await retrieveStoreValues({ root, fileValues, env, platform, injectedCli, childTimeoutMs });
  return retrieved.failure ? { failure: retrieved.failure, status: retrieved.status } : { values: retrieved.values };
}

// The target's environment: the caller's, minus INFISICAL_*, plus the non-empty values
// that --only selects. --only never changes what is required or refused.
function targetEnvironment(env, merged, platform, only) {
  const selected = (key) => only.length === 0 || only.some((name) => foldName(name, platform) === foldName(key, platform));
  const targetEnv = cleanEnvironment(env);
  for (const [key, value] of Object.entries(merged)) {
    if (!key.toUpperCase().startsWith('INFISICAL_') && value !== '' && selected(key)) targetEnv[key] = value;
  }
  return targetEnv;
}

// Builds the target environment and returns only that: { env } on success, or
// { failure, status } with a value-free message. The bootstrap values, client
// secret, session token, and raw exports exist only inside this call, so they are
// unreachable once it returns. The final env itself stays in the wrapper for the
// target's lifetime; that remaining limit is documented.
// Required names are the --require names plus the template's names, checked in both
// modes. A required name that is absent or empty fails the run, naming the key only.
export async function prepareTargetEnvironment({ root, offline, env, platform, injectedCli, childTimeoutMs = CHILD_TIMEOUT_MS, required: flagNames = [], only = [], diagnostic = () => {} }) {
  const read = readFileValues(root, platform);
  if (read.failure) return read;
  const { fileValues } = read;
  if (Object.keys(fileValues).some((key) => key.toUpperCase().startsWith('INFISICAL_') && !STORE_FIELDS.has(key))) {
    return { failure: 'settings/.env contains an unsupported store field' };
  }
  let required;
  try {
    required = [...new Set([...flagNames, ...templateNames(root)])];
  } catch (error) {
    return { failure: error.message };
  }
  if (required.length === 0) diagnostic(NO_REQUIRED_WARNING);

  const source = await sourceValues({ offline, root, fileValues, env, platform, injectedCli, childTimeoutMs });
  if (source.failure) return source;
  const merged = source.values;
  const absent = required.filter((name) => valueNamed(merged, name, platform) === '');
  if (absent.length) return { failure: `required name(s) are missing or empty: ${absent.join(', ')}` };
  if (!Object.values(merged).some((value) => value !== '')) return { failure: 'no usable values are configured for the requested command' };
  const denied = Object.keys(merged).find((key) => isDeniedName(key, platform));
  if (denied) return { failure: `${denied} changes how commands load and cannot come from the store or settings/.env; remove it` };
  return { env: targetEnvironment(env, merged, platform, only) };
}
