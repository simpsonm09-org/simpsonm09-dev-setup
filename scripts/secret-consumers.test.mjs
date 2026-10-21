import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { validateConsumers } from './check-secret-consumers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures', 'secret-consumers');
const SENTINEL = 'SENTINEL-NOT-A-SECRET-1234';

function run(file) {
  return spawnSync(process.execPath, [join(HERE, 'check-secret-consumers.mjs'), ...(file ? [file] : [])], {
    encoding: 'utf8', windowsHide: true, timeout: 10000, env: {}, cwd: HERE,
  });
}

function valid() {
  return JSON.parse(readFileSync(join(FIXTURES, 'valid.json'), 'utf8'));
}

test('repository declarations and valid synthetic fixture pass without a secret store', () => {
  for (const file of [undefined, join(FIXTURES, 'valid.json')]) {
    const result = run(file);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  }
  const declarations = JSON.parse(readFileSync(join(HERE, '..', 'settings', 'secret-consumers.json'), 'utf8'));
  assert.deepEqual(declarations.consumers.map((entry) => entry.consumer), [
    'agent-discord', 'human-discord', 'agent-postman', 'human-postman',
    'notifications', 'sms', 'mail', 'github', 'signing', 'model-gateway',
  ]);
  const gateway = declarations.consumers.at(-1);
  assert.deepEqual(gateway.credentialNames, ['DEEPSEEK_API_KEY', 'LITELLM_MASTER_KEY', 'POSTGRES_PASSWORD']);
  assert.deepEqual(gateway.operations, ['gateway-start']);
});

for (const [file, field] of [
  ['token-field.json', '$.consumers[0].token'],
  ['credential-value.json', '$.consumers[0].bundle'],
  ['unknown-operation.json', '$.consumers[0].operations[0]'],
  ['duplicate-consumer.json', '$.consumers[1].consumer'],
]) {
  test(`${file} fails with a field path and no matched value`, () => {
    const result = run(join(FIXTURES, file));
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, `secret-consumers: ${field}\n`);
    assert.ok(!`${result.stdout}${result.stderr}`.includes(SENTINEL));
  });
}

test('all value-bearing field names are rejected recursively, regardless of case', () => {
  for (const field of ['token', 'password', 'secret', 'clientSecret', 'apiKey', 'key', 'authorization', 'headers', 'env', 'TOKEN', 'Authorization']) {
    const data = valid();
    data.consumers[0][field] = { nested: SENTINEL };
    assert.throws(() => validateConsumers(data), { message: `$.consumers[0].${field}` });
  }
});

test('credential prefixes, embedded bearer auth, long hex and base64 strings fail without values', () => {
  for (const value of [`sk-${SENTINEL}`, `ghp_${SENTINEL}`, `github_pat_${SENTINEL}`,
    `prefix Bearer ${SENTINEL}`, 'a'.repeat(32), 'Ab9/'.repeat(12)]) {
    const data = valid();
    data.consumers[0].credentialNames[0] = value;
    assert.throws(() => validateConsumers(data), { message: '$.consumers[0].credentialNames[0]' });
  }
});

test('unknown fields, caller executables, missing fields, bad types, and credential environment names fail', () => {
  const cases = [
    [(data) => { data.extra = SENTINEL; }, '$.extra'],
    [(data) => { data.consumers[0].executable = SENTINEL; }, '$.consumers[0].executable'],
    [(data) => { delete data.consumers[0].bundle; }, '$.consumers[0].bundle'],
    [(data) => { data.consumers[0].operations = 'sign'; }, '$.consumers[0].operations'],
    [(data) => { data.consumers[0].credentialNames = []; }, '$.consumers[0].credentialNames'],
    [(data) => { data.consumers[0].credentialNames = ['BAD NAME']; }, '$.consumers[0].credentialNames[0]'],
    [(data) => { data.agentEnvironmentAllowlist = ['GH_TOKEN']; }, '$.agentEnvironmentAllowlist[0]'],
    [(data) => { data.agentEnvironmentAllowlist = ['PATH']; }, '$.agentEnvironmentAllowlist[0]'],
    [(data) => { data.agentEnvironmentAllowlist = ['LANG', 'LANG']; }, '$.agentEnvironmentAllowlist'],
  ];
  for (const [mutate, path] of cases) {
    const data = valid();
    mutate(data);
    assert.throws(() => validateConsumers(data), { message: path });
  }
});

test('malformed JSON and hostile property names cannot leak input through CLI errors', (t) => {
  // Keep all test writes inside this worktree.
  const root = mkdtempSync(join(FIXTURES, 'generated-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'synthetic.json');
  for (const text of [`{"token":"${SENTINEL}"`, JSON.stringify({ ...valid(), [`Bearer ${SENTINEL}`]: SENTINEL })]) {
    writeFileSync(file, text);
    const result = run(file);
    assert.equal(result.status, 1);
    assert.ok(!`${result.stdout}${result.stderr}`.includes(SENTINEL));
    assert.match(result.stderr, /^secret-consumers: \$(?:\.\[field\])?\n$/);
  }
});
