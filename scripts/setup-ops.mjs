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
const PLATFORM = process.platform === 'win32' ? 'windows' : 'posix';

function fail(message, code = 1) {
  process.stderr.write(`setup-ops: ${message}\n`);
  process.exit(code);
}

function loadOperations() {
  let data;
  try {
    data = JSON.parse(readFileSync(join(ROOT, 'setup-ops.json'), 'utf8'));
  } catch (error) {
    fail(`cannot read setup-ops.json: ${error.message}`);
  }
  if (!Array.isArray(data.operations)) fail('setup-ops.json has no operations array');
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

function run(operation, args) {
  const platforms = operation.platforms ?? [];
  if (!platforms.includes(PLATFORM)) {
    const supported = platforms.join(', ') || 'no platform';
    fail(`"${operation.id}" runs on ${supported}; this host is ${PLATFORM}`, 3);
  }
  const script = operation[PLATFORM];
  if (!script) fail(`"${operation.id}" has no ${PLATFORM} script`);
  const command = PLATFORM === 'windows'
    ? ['pwsh', '-NoLogo', '-NoProfile', '-File', script, ...args]
    : ['bash', script, ...args];
  const result = spawnSync(command[0], command.slice(1), { cwd: ROOT, stdio: 'inherit' });
  if (result.error) fail(`cannot run ${command[0]}: ${result.error.message}`);
  process.exit(result.status ?? 1);
}

const [id, ...args] = process.argv.slice(2);
const operations = loadOperations();
if (!id || id === 'list' || id === '--list') {
  printOperations(operations);
} else if (id === 'help' || id === '--help' || id === '-h') {
  process.stdout.write('usage: node scripts/setup-ops.mjs <operation> [args...]\n');
  printOperations(operations);
} else {
  run(findOperation(operations, id), args);
}
