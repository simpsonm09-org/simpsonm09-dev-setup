import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseYaml } from './lib/yaml.mjs';
import { forbiddenRules } from './check-worktreeinclude.mjs';
import { validateSettings } from '../services/litellm/validate-settings.mjs';
import {
  buildPlan,
  collectProbes,
  runPlan,
  REQUIRED_INFISICAL_VERSION,
} from '../services/litellm/plan.mjs';

const read = (name) => readFileSync(new URL(`../services/litellm/${name}`, import.meta.url), 'utf8');
const config = parseYaml(read('config.yaml'));
const compose = parseYaml(read('docker-compose.yml'));
const credential = /^(api_key|master_key|database_url|password|DEEPSEEK_API_KEY|LITELLM_MASTER_KEY|POSTGRES_PASSWORD|DATABASE_URL)$/;

function checkCredentials(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (credential.test(key)) {
      assert.equal(typeof item, 'string');
      assert.match(item, /^(os\.environ\/[A-Z_]+$|.*\$\{[A-Z_]+:\?[^}]+\}.*$)/);
      assert.doesNotMatch(item, /\$\{[A-Z_]+:-/);
    }
    if (typeof item === 'string') {
      assert.doesNotMatch(item, /\bsk-[a-zA-Z0-9_-]{12,}|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/);
      assert.doesNotMatch(item, /:\/\/[^:/\s]+:[^$\s][^@\s]*@/);
    }
    checkCredentials(item);
  }
}

test('gateway YAML requires environment credentials and has no secret env_file', () => {
  checkCredentials(config);
  checkCredentials(compose);
  assert.deepEqual(config.model_list.map((entry) => entry.model_name), ['deepseek-chat', 'local-qwen']);
  assert.equal(config.model_list[0].litellm_params.api_key, 'os.environ/DEEPSEEK_API_KEY');
  assert.equal(config.model_list[1].litellm_params.api_base, 'os.environ/LOCAL_LLAMA_BASE_URL');
  assert.equal(config.model_list[1].litellm_params.api_key, undefined);
  assert.equal(config.general_settings.master_key, 'os.environ/LITELLM_MASTER_KEY');
  assert.equal(config.general_settings.database_url, 'os.environ/DATABASE_URL');
  for (const service of Object.values(compose.services)) assert.equal(service.env_file, undefined);
  for (const literal of ['literal-password', 'sk-fixtureonly00000000', '${KEY:-fallback}']) {
    assert.throws(() => checkCredentials({ api_key: literal }));
  }
});

test('gateway images are pinned and only the private proxy port is published', () => {
  for (const service of Object.values(compose.services)) {
    assert.match(service.image, /:[\w.-]+@sha256:[a-f0-9]{64}/);
    assert.doesNotMatch(service.image, /:latest\b/);
  }
  assert.match(compose.services.proxy.ports[0], /^\$\{LITELLM_BIND_ADDRESS:\?/);
  assert.equal(compose.services.db.ports, undefined);
  assert.deepEqual(Object.keys(compose.volumes), ['pg_data']);
  assert.deepEqual(compose.services.proxy.volumes, ['./config.yaml:/app/config.yaml:ro']);
});

test('gateway disables body storage, callbacks and telemetry', () => {
  assert.equal(config.general_settings.store_prompts_in_spend_logs, false);
  assert.equal(config.general_settings.disable_error_logs, true);
  assert.equal(config.general_settings.maximum_spend_logs_retention_period, '7d');
  assert.equal(config.litellm_settings.turn_off_message_logging, true);
  assert.equal(config.litellm_settings.set_verbose, false);
  assert.equal(config.litellm_settings.telemetry, false);
  // The block-only repository parser leaves empty flow lists as scalar strings.
  for (const key of ['callbacks', 'success_callback', 'failure_callback', 'service_callback']) {
    assert.equal(config.litellm_settings[key], '[]');
  }
  assert.equal(compose.services.proxy.environment.LITELLM_TELEMETRY_DISABLED, 'true');
});

test('non-secret settings reject credentials, expansions, public binds and floating images', () => {
  const example = read('.env.example');
  const valid = example.replace('=HOMELAB_PRIVATE_IPV4', '=192.168.50.10');
  assert.equal(validateSettings(valid).LITELLM_PORT, '4000');
  for (const addition of ['POSTGRES_PASSWORD=fixture', 'UNKNOWN=fixture', 'LITELLM_PORT=${PORT}']) {
    assert.throws(() => validateSettings(`${valid}\n${addition}\n`));
  }
  assert.throws(() => validateSettings(example));
  for (const address of ['0.0.0.0', '127.0.0.1', '8.8.8.8', '192.168.999.1']) {
    assert.throws(() => validateSettings(valid, { LITELLM_BIND_ADDRESS: address }));
  }
  assert.throws(() => validateSettings(valid, { LITELLM_IMAGE: 'ghcr.io/berriai/litellm:latest' }));
  assert.throws(() => validateSettings(valid, { LOCAL_LLAMA_BASE_URL: 'http://user:fixture@host/v1' }));
});

test('worktree copying accepts the gateway local config and rejects its secret neighbours', () => {
  assert.deepEqual(forbiddenRules('services/litellm/.env\nservices\\litellm\\.env\n'), []);
  for (const path of ['services/infisical/.env', 'services/litellm/.env.*',
    'services/litellm/.env.local', 'services/*/.env']) {
    assert.deepEqual(forbiddenRules(`${path}\n`), [path]);
  }
});

const PLAN_CHECKS = ['settings', 'bind-address', 'port', 'local-endpoint', 'image-litellm',
  'image-postgres', 'env-file', 'cli-node', 'cli-infisical', 'cli-docker', 'cli-compose',
  'broker-token'];
const syntheticSettings = read('.env.example').replace('HOMELAB_PRIVATE_IPV4', '192.168.50.10');

function observedPlan(overrides = {}) {
  return {
    settingsText: syntheticSettings,
    files: { env: true },
    inherited: {},
    probes: {
      node: { found: true, version: '24.20.0' },
      infisical: { found: true, version: REQUIRED_INFISICAL_VERSION },
      docker: { found: true, version: '28.1.1' },
      compose: { found: true, version: '2.39.4' },
      token: true,
      ...overrides,
    },
  };
}

function withSyntheticSettings(text, run) {
  const directory = mkdtempSync(join(tmpdir(), 'gateway-plan-'));
  const path = join(directory, 'settings.env');
  writeFileSync(path, text);
  try { return run(path); } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('plan is ready only when every local observation is ok', () => {
  const plan = buildPlan(observedPlan());
  assert.equal(plan.ready, true);
  assert.deepEqual(plan.checks.map((entry) => entry.id), PLAN_CHECKS);
  assert.ok(plan.checks.every((entry) => entry.status === 'ok'));
  const unknown = buildPlan({ probes: {} });
  assert.equal(unknown.ready, false);
  assert.ok(unknown.checks.every((entry) => ['missing', 'absent'].includes(entry.status)));
});

test('plan is deterministic and does not expose setting values', () => {
  const plan = buildPlan(observedPlan());
  assert.deepEqual(plan, buildPlan(observedPlan()));
  const result = runPlan({ args: [], env: {}, probes: observedPlan().probes });
  assert.equal(result.exitCode, 1);
  assert.match(result.stdout, /^settings: missing \(not provided; unverified\)$/m);
  assert.equal(result.stdout, runPlan({ args: [], env: {}, probes: observedPlan().probes }).stdout);
});

test('Infisical version mismatch is explicit and prevents readiness', () => {
  const plan = buildPlan(observedPlan({ infisical: { found: true, version: '0.45.1' } }));
  const check = plan.checks.find((entry) => entry.id === 'cli-infisical');
  assert.equal(check.status, 'mismatch');
  assert.match(check.detail, /required 0\.44\.6 observed 0\.45\.1/);
  assert.equal(plan.ready, false);
});

test('missing token is absent and its value is never printed', () => {
  const plan = buildPlan(observedPlan({ token: false }));
  assert.equal(plan.checks.find((entry) => entry.id === 'broker-token').status, 'absent');
  assert.equal(plan.ready, false);
  assert.doesNotMatch(JSON.stringify(plan), /INFISICAL_TOKEN|token=/);
});

test('explicit synthetic settings validate and output remains value-free', () => {
  withSyntheticSettings(syntheticSettings, (path) => {
    const result = runPlan({ args: ['--settings', path], env: {}, probes: observedPlan().probes });
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /^settings: ok \(validated\)$/m);
    for (const marker of ['192.168.50.10', 'host.docker.internal', '18080', 'http://']) {
      assert.ok(!result.stdout.includes(marker), marker);
    }
  });
});

test('invalid synthetic credential settings are rejected without echoing values', () => {
  const text = `${syntheticSettings}\nPOSTGRES_PASSWORD=sk-fixtureonly00000000\n`;
  withSyntheticSettings(text, (path) => {
    const result = runPlan({ args: ['--settings', path], env: {}, probes: observedPlan().probes });
    const plan = buildPlan({ settingsText: text, files: { env: true }, probes: observedPlan().probes });
    assert.equal(result.exitCode, 1);
    assert.match(result.stdout, /^settings: invalid \(validator rejected settings\)$/m);
    assert.doesNotMatch(JSON.stringify(plan), /fixture|sk-/);
    for (const marker of ['fixture', 'sk-', 'POSTGRES_PASSWORD', '192.168.50.10']) {
      assert.ok(!result.stdout.includes(marker), marker);
    }
  });
});

test('settings files are not read implicitly and usage errors are bounded', () => {
  const result = runPlan({ args: [], env: {}, probes: observedPlan().probes });
  assert.equal(result.exitCode, 1);
  assert.match(result.stdout, /^env-file: missing \(no settings path; nothing read\)$/m);
  for (const args of [['--settings'], ['--settings', 'a', '--settings', 'b'], ['--bad']]) {
    const usage = runPlan({ args, env: {}, probes: {} });
    assert.equal(usage.exitCode, 2);
    assert.equal(usage.stdout, '');
  }
});

test('version probes use only bounded non-shell argv', () => {
  const calls = [];
  const probes = collectProbes({ env: { INFISICAL_TOKEN: 'synthetic' }, run: (file, args, options) => {
    calls.push([file, args]);
    assert.equal(options.shell, false);
    assert.equal(options.timeout, 5000);
    if (file === 'node') return { status: 0, stdout: 'v24.20.0\n' };
    if (file === 'infisical') return { status: 0, stdout: `infisical version ${REQUIRED_INFISICAL_VERSION}\n` };
    if (args[0] === 'compose') return { status: 0, stdout: '2.39.4\n' };
    return { status: 0, stdout: 'Docker version 28.1.1, build fixture\n' };
  } });
  assert.deepEqual(calls, [
    ['node', ['--version']], ['infisical', ['--version']], ['docker', ['--version']],
    ['docker', ['compose', 'version', '--short']],
  ]);
  assert.equal(probes.token, true);
});

test('the local example endpoint port matches the llama-server instructions', () => {
  const endpoint = /^LOCAL_LLAMA_BASE_URL=(\S+)$/m.exec(read('.env.example'))?.[1];
  const url = new URL(endpoint);
  const docs = readFileSync(new URL('../docs/local-model.md', import.meta.url), 'utf8');
  const section = docs.split('## Other local servers')[0];
  const ports = [...section.matchAll(/--port (\d{1,5})\b/g)].map((match) => match[1]);
  assert.ok(ports.length > 0);
  assert.ok(ports.every((port) => port === url.port));
});

test('launchers route plan mode ahead of operator-only launch commands', () => {
  const shell = read('start-gateway.sh');
  const planAt = shell.indexOf("== '--plan'");
  const guardAt = shell.indexOf('[[ -n ${INFISICAL_TOKEN');
  assert.ok(planAt > 0 && planAt < guardAt);
  assert.match(shell.slice(planAt, guardAt), /exec node plan\.mjs "\$@"/);
  assert.ok(shell.includes("infisical version 0.44.6"));
  assert.ok(!shell.includes('infisical-version.txt'));
  const powershell = read('start-gateway.ps1');
  assert.ok(powershell.indexOf("ParameterSetName = 'Plan'") > 0);
  assert.ok(powershell.includes("$PSCmdlet.ParameterSetName -eq 'Plan'"));
  assert.ok(powershell.includes("infisical version 0.44.6"));
  assert.ok(!powershell.includes('infisical-version.txt'));
});

test('the gateway plan has a thin just recipe and version remains literal', () => {
  const just = readFileSync(new URL('../justfile', import.meta.url), 'utf8');
  assert.match(just, /^gateway-plan \*args:\n {4}node services\/litellm\/plan\.mjs \{\{args\}\}$/m);
  assert.equal(REQUIRED_INFISICAL_VERSION, '0.44.6');
});
