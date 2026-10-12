#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRetiredEnvrc } from './with-secrets-envrc.mjs';
import { initializeEnvFile } from './with-secrets-env.mjs';
import { parseArguments, USAGE } from './with-secrets-args.mjs';
import { resolveTarget } from './with-secrets-resolve.mjs';
import { CHILD_TIMEOUT_MS, NO_SIGNALS, runChild, signalPlan } from './with-secrets-run.mjs';
import { prepareTargetEnvironment } from './with-secrets-store.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, '..', '..');
const CANNOT_START = 'cannot start the requested command; check the name and that it is a native executable';

function fail(message, status = 1, diagnostic = (value) => process.stderr.write(value)) {
  diagnostic(`with-secrets: ${message}\n`);
  return { status, stdout: '', stderr: '', targetStarted: false };
}

export async function runWithSecrets({ root = DEFAULT_ROOT, command, args = [], offline = false, required = [], only = [], env = process.env, platform = process.platform, cli: injectedCli, captureTarget = false, forwardTargetOutput = true, childTimeoutMs = CHILD_TIMEOUT_MS, diagnostic = (message) => process.stderr.write(message) }) {
  if (!command) return fail(USAGE, 2, diagnostic);
  if (offline) diagnostic('with-secrets: offline mode enabled; using settings/.env fallback\n');
  const file = resolveTarget(command, platform, env);
  if (!file) return fail(CANNOT_START, 127, diagnostic);
  const prepared = await prepareTargetEnvironment({ root, offline, env, platform, injectedCli, childTimeoutMs, required, only, diagnostic });
  if (prepared.failure) return fail(prepared.failure, prepared.status ?? 1, diagnostic);
  let target;
  try {
    target = await runChild(file, args, prepared.env, { capture: captureTarget, plan: captureTarget ? NO_SIGNALS : signalPlan(platform, 'target'), platform });
  } catch {
    return fail(CANNOT_START, 127, diagnostic);
  }
  if (target.spawnFailed) return fail(CANNOT_START, 127, diagnostic);
  if (target.overflowed) return fail('the command output exceeded the 1 MiB capture limit', 1, diagnostic);
  if (captureTarget && forwardTargetOutput) {
    process.stdout.write(target.stdout);
    process.stderr.write(target.stderr);
  }
  return { status: target.status, stdout: target.stdout, stderr: target.stderr, targetStarted: true };
}

function main(argv = process.argv.slice(2)) {
  const root = process.env.DEV_SETUP_ROOT ? resolve(process.env.DEV_SETUP_ROOT) : DEFAULT_ROOT;
  // DEV_SETUP_ROOT redirects the whole settings file, so every run names it.
  if (process.env.DEV_SETUP_ROOT) process.stderr.write(`with-secrets: DEV_SETUP_ROOT redirects settings to ${root}\n`);
  const retired = findRetiredEnvrc(process.cwd());
  if (retired) process.stderr.write(`with-secrets: ${retired} still imports secrets through direnv; remove it. Secrets no longer load from .envrc.\n`);
  if (argv[0] === 'secrets-init') {
    try { initializeEnvFile(root); } catch (error) {
      fail(error.message);
      return 1;
    }
    return 0;
  }
  const parsed = parseArguments(argv);
  if (parsed.error) {
    fail(parsed.error === USAGE ? USAGE : `${parsed.error}; ${USAGE}`, 2);
    return 2;
  }
  return runWithSecrets({ root, command: parsed.command, args: parsed.args, offline: parsed.offline, required: parsed.required, only: parsed.only }).then((result) => result.status);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  Promise.resolve(main()).then((status) => process.exit(status)).catch(() => {
    fail('unexpected wrapper failure; no command was started');
    process.exit(1);
  });
}
