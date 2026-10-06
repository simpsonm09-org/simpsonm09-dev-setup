#!/usr/bin/env node
// Runs one workstation setup operation named in setup-ops.json on the host
// platform. A wrong-platform call prints why and exits non-zero, and changes
// nothing. Arguments after the operation id pass through to the script.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

// The host platform an operation is resolved against. `posix` is not a host: it
// is a portable declaration that matches both `linux` and `macos`.
export function hostPlatform(platform = process.platform) {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'macos';
  return 'linux';
}

const PLATFORM = hostPlatform();

function fail(message, code = 1) {
  process.stderr.write(`setup-ops: ${message}\n`);
  process.exit(code);
}

// A declared platform matches the host. `posix` means any POSIX host, so it
// matches both `linux` and `macos`.
export function hostMatches(platforms, host) {
  if (platforms.includes(host)) return true;
  return host !== 'windows' && platforms.includes('posix');
}

// Validate the manifest shape before anything reads an id or a script. Returns
// every problem so a caller can report them together instead of throwing on a
// missing field.
export function validateOperations(operations) {
  const errors = [];
  for (const [index, op] of operations.entries()) {
    const id = op && typeof op.id === 'string' && op.id !== '' ? op.id : null;
    const label = id ? `"${id}"` : `operation ${index + 1}`;
    if (!id) errors.push(`${label}: id is required`);
    if (!Array.isArray(op?.platforms) || op.platforms.length === 0) errors.push(`${label}: platforms is required`);
    const hasScript = [op?.windows, op?.posix].some((value) => typeof value === 'string' && value !== '');
    if (!hasScript) errors.push(`${label}: a windows or posix script is required`);
  }
  return errors;
}

function loadOperations() {
  let data;
  try {
    data = JSON.parse(readFileSync(join(ROOT, 'setup-ops.json'), 'utf8'));
  } catch (error) {
    fail(`cannot read setup-ops.json: ${error.message}`);
  }
  if (!Array.isArray(data.operations)) fail('setup-ops.json has no operations array');
  const errors = validateOperations(data.operations);
  if (errors.length > 0) fail(`setup-ops.json is invalid: ${errors.join('; ')}`);
  return data.operations;
}

function printOperations(operations) {
  for (const op of operations) {
    const platforms = (op.platforms ?? []).join(', ');
    process.stdout.write(`${op.id.padEnd(24)} ${platforms.padEnd(8)} ${op.description ?? ''}\n`);
  }
}

function findOperation(operations, id) {
  const op = operations.find((entry) => entry.id === id);
  if (!op) fail(`unknown operation "${id}"`, 2);
  return op;
}

// Resolve the command for an operation on a host, or the reason it is refused.
// A host outside the operation's platforms never reaches a spawn.
export function commandFor(operation, host, args) {
  const platforms = operation.platforms ?? [];
  if (!hostMatches(platforms, host)) {
    const supported = platforms.join(', ') || 'no platform';
    return { error: `"${operation.id}" runs on ${supported}; this host is ${host}`, status: 3 };
  }
  const scriptKey = host === 'windows' ? 'windows' : 'posix';
  const script = operation[scriptKey];
  if (!script) return { error: `"${operation.id}" has no ${scriptKey} script`, status: 1 };
  const command = host === 'windows'
    ? ['pwsh', '-NoLogo', '-NoProfile', '-File', script, ...args]
    : ['bash', script, ...args];
  return { command, status: 0 };
}

// Run an operation. `spawn` is injectable so a test can prove a refused host
// never spawns.
export function dispatch(operation, args, { host = PLATFORM, spawn = spawnSync } = {}) {
  const { error, command, status } = commandFor(operation, host, args);
  if (error) return { status, error };
  const result = spawn(command[0], command.slice(1), { cwd: ROOT, stdio: 'inherit' });
  if (result.error) return { status: 1, error: `cannot run ${command[0]}: ${result.error.message}` };
  return { status: result.status ?? 1 };
}

function main() {
  const [id, ...args] = process.argv.slice(2);
  const operations = loadOperations();
  if (!id || id === 'list' || id === '--list') {
    printOperations(operations);
  } else if (id === 'help' || id === '--help' || id === '-h') {
    process.stdout.write('usage: node scripts/setup-ops.mjs <operation> [args...]\n');
    printOperations(operations);
  } else {
    const outcome = dispatch(findOperation(operations, id), args);
    if (outcome.error) fail(outcome.error, outcome.status);
    process.exit(outcome.status);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
