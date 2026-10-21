import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseYaml } from './lib/yaml.mjs';
import { forbiddenRules } from './check-worktreeinclude.mjs';
import { validateSettings } from '../services/litellm/validate-settings.mjs';

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
