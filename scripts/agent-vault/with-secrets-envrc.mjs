import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// The retired .envrc template imported secrets with direnv. Detection reads a
// file only to match its marker text; the content is never printed or parsed.
const RETIRED_ENVRC_MARKERS = ['dotenv_if_exists', 'infisical export'];
const MAX_READ_BYTES = 64 * 1024;

// Reads at most MAX_READ_BYTES from a regular file. A FIFO, device, or directory
// is skipped before it is opened, so a read can never block on it.
function readHead(file) {
  let info;
  try { info = statSync(file); } catch { return null; }
  if (!info.isFile()) return null;
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(info.size, MAX_READ_BYTES));
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytes).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function importsRetiredSecrets(file) {
  let text;
  try { text = readHead(file); } catch { return false; }
  return text !== null && RETIRED_ENVRC_MARKERS.some((marker) => text.includes(marker));
}

// The nearest .envrc in startDir or an ancestor that still imports secrets, or null.
export function findRetiredEnvrc(startDir) {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, '.envrc');
    if (importsRetiredSecrets(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
