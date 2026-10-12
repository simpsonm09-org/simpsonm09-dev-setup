// Grammar: with-secrets [--offline] [--require NAMES]... [--only NAMES]... [--] <tool> [args...]
// Options are read only before the tool. Everything from the tool onward is the
// tool's argv, unchanged, so a tool's own --offline or --require is not ours.

export const USAGE = 'usage: with-secrets [--offline] [--require NAMES]... [--only NAMES]... [--] <tool> [args...]';
const NAME_LIST = /^[A-Za-z_][A-Za-z0-9_]*(,[A-Za-z_][A-Za-z0-9_]*)*$/;
const LIST_OPTIONS = { '--require': 'required', '--only': 'only' };

// Reads the option at index into options. Returns the next index, or { error }.
// '--' is returned with `end` set, because it ends the options.
function readOption(argv, index, options) {
  const token = argv[index];
  if (token === '--') return { next: index + 1, end: true };
  if (token === '--offline') {
    options.offline = true;
    return { next: index + 1 };
  }
  const list = LIST_OPTIONS[token];
  if (!list) return { error: `unknown option ${token}` };
  const value = argv[index + 1];
  if (value === undefined || !NAME_LIST.test(value)) return { error: `${token} needs a comma-separated list of names` };
  options[list].push(...value.split(','));
  return { next: index + 2 };
}

// Returns { offline, required, only, command, args }, or { error } with a value-free reason.
export function parseArguments(argv) {
  const options = { offline: false, required: [], only: [] };
  let index = 0;
  while (index < argv.length && argv[index].startsWith('-')) {
    const step = readOption(argv, index, options);
    if (step.error) return { error: step.error };
    index = step.next;
    if (step.end) break;
  }
  if (index >= argv.length) return { error: USAGE };
  return { ...options, command: argv[index], args: argv.slice(index + 1) };
}
