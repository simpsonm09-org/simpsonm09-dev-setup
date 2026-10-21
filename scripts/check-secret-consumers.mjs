import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_FILE = fileURLToPath(new URL('../settings/secret-consumers.json', import.meta.url));
const SCHEMA_FILE = new URL('../settings/secret-consumers.schema.json', import.meta.url);
const VALUE_FIELD = /^(token|password|secret|clientsecret|apikey|key|authorization|headers|env)$/i;
const CREDENTIAL = /sk-|ghp_|github_pat_|Bearer |[a-f0-9]{32,}|[A-Za-z0-9+/]{40,}={0,2}/i;

function fieldPath(path, name) {
  // Unknown property names are untrusted too. Never echo arbitrary input keys.
  return `${path}.${/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(name) && !CREDENTIAL.test(name) ? name : '[field]'}`;
}

function rejectValues(value, path) {
  if (typeof value === 'string' && CREDENTIAL.test(value)) throw new Error(path);
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectValues(item, `${path}[${index}]`));
  } else if (value && typeof value === 'object') {
    for (const [name, item] of Object.entries(value)) {
      const child = fieldPath(path, name);
      if (VALUE_FIELD.test(name)) throw new Error(child);
      rejectValues(item, child);
    }
  }
}

// Implements the keywords used by the adjacent schema without a runtime dependency.
function validateSchema(value, schema, path) {
  const type = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  if (type !== schema.type) throw new Error(path);
  if (schema.enum && !schema.enum.includes(value)) throw new Error(path);
  if (schema.pattern && !new RegExp(schema.pattern).test(value)) throw new Error(path);
  if (type === 'object') {
    for (const name of schema.required ?? []) {
      if (!Object.hasOwn(value, name)) throw new Error(fieldPath(path, name));
    }
    for (const [name, item] of Object.entries(value)) {
      const child = fieldPath(path, name);
      if (!Object.hasOwn(schema.properties, name)) {
        if (schema.additionalProperties === false) throw new Error(child);
      } else {
        validateSchema(item, schema.properties[name], child);
      }
    }
  } else if (type === 'array') {
    if (value.length < (schema.minItems ?? 0)) throw new Error(path);
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) {
      throw new Error(path);
    }
    value.forEach((item, index) => validateSchema(item, schema.items, `${path}[${index}]`));
  }
}

export function validateConsumers(value) {
  rejectValues(value, '$');
  validateSchema(value, JSON.parse(readFileSync(SCHEMA_FILE, 'utf8')), '$');
  const seen = new Set();
  for (const [index, entry] of value.consumers.entries()) {
    if (seen.has(entry.consumer)) throw new Error(`$.consumers[${index}].consumer`);
    seen.add(entry.consumer);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let field = '$';
  let parsed;
  try {
    // Parse errors can contain input excerpts, so discard their messages.
    parsed = JSON.parse(readFileSync(process.argv[2] ?? DEFAULT_FILE, 'utf8'));
  } catch {
    process.stderr.write('secret-consumers: $\n');
    process.exitCode = 1;
  }
  if (!process.exitCode) {
    try {
      validateConsumers(parsed);
    } catch (error) {
      field = /^\$(?:\.[A-Za-z][A-Za-z0-9_]*|\.\[field\]|\[\d+\])*$/.test(error.message) ? error.message : '$';
      process.stderr.write(`secret-consumers: ${field}\n`);
      process.exitCode = 1;
    }
  }
}
