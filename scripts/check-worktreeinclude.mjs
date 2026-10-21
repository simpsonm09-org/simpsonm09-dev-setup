import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CREDENTIAL_NAME = /(^\.env($|[.*])|^\.envrc$|\.(key|pem)$|token|secret|^auth\.json$|^credentials)/i;

// Inspect inclusion rules only. Never expand them or open their targets.
export function credentialRules(text) {
  return text.split(/\r?\n/).map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .filter((line) => line.split(/[\\/]/).some((name) => CREDENTIAL_NAME.test(name)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rules = credentialRules(readFileSync(process.argv[2] ?? '.worktreeinclude', 'utf8'));
  if (rules.length) {
    process.stderr.write('worktreeinclude: credential file rules are forbidden\n');
    process.exitCode = 1;
  }
}
