import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Worktree copies may hold only local config `.env` files. They are gitignored, never
// committed or uploaded, and hold non-secret settings with a tracked `.env.example`
// scaffold. Secrets belong in the broker, not in `.env`.
const LOCAL_CONFIG_ENV = /^\.env$/i;
// Path segments that name credentials. A `.env` under one of them is not local config.
const SECRET_NAME = /(^\.envrc?(\.|$)|\.(key|pem)$|token|secret|^auth\.json$|^credentials)/i;
// Known secret bootstrap and legacy secret files. They are named `.env`, but they hold
// unlock values or service secrets, so they stay blocked.
const KNOWN_SECRET_SOURCES = new Set(['settings/.env', 'services/infisical/.env']);

// Allowlist: a rule must name one exact local config `.env` file. Wildcards, directories,
// negations, absolute or drive-qualified paths (`C:/`, `C:`) and `..` cannot be checked by
// name, so they are rejected. Nothing is expanded or opened.
function allowedRule(rule) {
  const path = rule.replaceAll('\\', '/');
  if (/[*?[\]{}!:]/.test(path)) return false;
  // Drop `.` segments first so `settings/./.env` normalizes to the same file as `settings/.env`.
  const segments = path.split('/').filter((segment) => segment !== '.');
  if (!segments.length || segments.some((segment) => segment === '' || segment === '..')) return false;
  if (KNOWN_SECRET_SOURCES.has(segments.join('/').toLowerCase())) return false;
  if (segments.slice(0, -1).some((segment) => SECRET_NAME.test(segment))) return false;
  return LOCAL_CONFIG_ENV.test(segments.at(-1));
}

export function forbiddenRules(text) {
  return text.split(/\r?\n/).map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .filter((line) => !allowedRule(line));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rules = forbiddenRules(readFileSync(process.argv[2] ?? '.worktreeinclude', 'utf8'));
  if (rules.length) {
    process.stderr.write('worktreeinclude: only exact local config .env rules are allowed\n');
    process.exitCode = 1;
  }
}
