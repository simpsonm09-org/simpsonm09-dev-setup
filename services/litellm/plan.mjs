import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSettings } from './validate-settings.mjs';

export const REQUIRED_INFISICAL_VERSION = '0.44.6';
const VERSION_OPTIONS = {
  encoding: 'utf8', shell: false, windowsHide: true, timeout: 5000,
  maxBuffer: 4096, stdio: ['ignore', 'pipe', 'ignore'],
};

function version(output, pattern) {
  const line = String(output ?? '').split(/\r?\n/, 1)[0].trim();
  const match = pattern.exec(line);
  return match?.[1] ?? null;
}

function status(id, state, detail) {
  return detail ? { id, status: state, detail } : { id, status: state };
}

function parseSettings(settingsText, inherited) {
  if (typeof settingsText !== 'string') return { provided: false, valid: false };
  try {
    validateSettings(settingsText, inherited);
    return { provided: true, valid: true };
  } catch {
    return { provided: true, valid: false };
  }
}

function cliStatus(id, observed, required) {
  if (!observed?.found) return status(id, 'missing', 'not found');
  if (!observed.version) return status(id, 'invalid', 'version unknown');
  if (required && observed.version !== required) {
    return status(id, 'mismatch', `required ${required} observed ${observed.version}`);
  }
  return status(id, 'ok', observed.version);
}

// Pure planning from supplied settings, environment presence, and probe results.
export function buildPlan({ settingsText, inherited = {}, files = {}, probes = {} } = {}) {
  const settings = parseSettings(settingsText, inherited);
  const envFile = typeof files.env === 'object' ? files.env : { readable: files.env === true };
  const configured = settings.valid;
  const checks = [status('settings', configured ? 'ok' : settings.provided ? 'invalid' : 'missing',
    configured ? 'validated' : settings.provided ? 'validator rejected settings' : 'not provided; unverified')];
  const settingChecks = ['bind-address', 'port', 'local-endpoint', 'image-litellm', 'image-postgres'];
  for (const id of settingChecks) {
    checks.push(status(id, configured ? 'ok' : settings.provided ? 'invalid' : 'missing',
      configured ? undefined : settings.provided ? 'settings rejected' : 'settings unverified'));
  }
  checks.push(status('env-file', envFile.readable ? 'ok' : 'missing',
    envFile.readable ? 'explicit settings file'
      : envFile.provided ? 'file missing or unreadable' : 'no settings path; nothing read'));
  checks.push(cliStatus('cli-node', probes.node));
  checks.push(cliStatus('cli-infisical', probes.infisical, REQUIRED_INFISICAL_VERSION));
  checks.push(cliStatus('cli-docker', probes.docker));
  checks.push(cliStatus('cli-compose', probes.compose));
  checks.push(probes.token === true ? status('broker-token', 'ok', 'present') : status('broker-token', 'absent'));
  const lines = checks.map(({ id, status: state, detail }) => `${id}: ${state}${detail ? ` (${detail})` : ''}`);
  return { ready: checks.every(({ status: state }) => state === 'ok'), checks, lines };
}

function readExplicitSettings(path) {
  try {
    return { text: readFileSync(path, 'utf8'), readable: true };
  } catch {
    return { text: undefined, readable: false };
  }
}

export function collectProbes({ env = process.env, run = spawnSync } = {}) {
  const runProbe = (tool, args, parse) => {
    const result = run(tool, args, VERSION_OPTIONS);
    if (result.error) return { found: false, version: null };
    if (result.status !== 0) return { found: true, version: null };
    return { found: true, version: parse(result.stdout) };
  };
  return {
    node: runProbe('node', ['--version'], (out) => version(out, /^v?(\d+\.\d+\.\d+)$/)),
    infisical: runProbe('infisical', ['--version'], (out) => version(out, /^infisical version (\d+\.\d+\.\d+)$/)),
    docker: runProbe('docker', ['--version'], (out) => version(out, /^Docker version (\d+\.\d+\.\d+),/)),
    compose: runProbe('docker', ['compose', 'version', '--short'], (out) => version(out, /^v?(\d+\.\d+\.\d+)$/)),
    token: Boolean(String(env.INFISICAL_TOKEN ?? '').trim()),
  };
}

function parseArgs(args) {
  if (args.length === 0) return null;
  if (args.length === 2 && args[0] === '--settings' && args[1] && !args[1].startsWith('--')) return args[1];
  throw new Error('usage');
}

export function runPlan({ args = [], env = process.env, probes, runProbe = spawnSync } = {}) {
  let path;
  try { path = parseArgs(args); } catch {
    return { exitCode: 2, stdout: '', stderr: 'usage: node plan.mjs [--settings PATH]\n' };
  }
  const file = path ? readExplicitSettings(path) : { readable: false };
  const plan = buildPlan({
    settingsText: file.text,
    inherited: env,
    files: { env: { provided: Boolean(path), readable: file.readable } },
    probes: probes ?? collectProbes({ env, run: runProbe }),
  });
  const summary = plan.ready ? 'gateway plan: ready (local observations only)' : 'gateway plan: not ready';
  return { exitCode: plan.ready ? 0 : 1, stdout: `${[...plan.lines, summary].join('\n')}\n`, stderr: '' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = runPlan({ args: process.argv.slice(2) });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
