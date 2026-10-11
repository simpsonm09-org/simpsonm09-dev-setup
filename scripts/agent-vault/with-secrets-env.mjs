import { closeSync, lstatSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

export const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_ENV_FILE_BYTES = 64 * 1024;

// The one line reader for settings/.env and the template. A leading UTF-8 BOM is
// dropped, lines end at LF or CRLF, and a lone CR inside a line is refused.
export function readEnvLines(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  lines.forEach((line, index) => {
    if (line.includes('\r')) throw new Error(`invalid line ${index + 1}`);
  });
  return lines;
}

// Data only: values are literal text to the end of the line. Quotes are not
// removed, and "A=val # x" keeps " # x". On Windows, keys that differ only by case
// are duplicates.
export function parseEnvFile(text, platform = process.platform) {
  const values = Object.create(null);
  const seen = new Set();
  const lines = readEnvLines(text);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match || !KEY_PATTERN.test(match[1]) || /[\0\r]/.test(match[2])) {
      throw new Error(`invalid line ${index + 1}`);
    }
    const [, key, value] = match;
    const id = platform === 'win32' ? key.toUpperCase() : key;
    if (seen.has(id)) throw new Error(`duplicate key on line ${index + 1}`);
    seen.add(id);
    values[key] = value;
  }
  return values;
}

// Refuses a link, junction, or directory before reading, and caps the size.
class EnvFileError extends Error {}

export function readEnvFile(root) {
  const path = join(root, 'settings', '.env');
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new EnvFileError('settings/.env must be a regular file, not a link or directory');
  if (info.size > MAX_ENV_FILE_BYTES) throw new EnvFileError('settings/.env is larger than 64 KiB');
  return readFileSync(path, 'utf8');
}

export { EnvFileError };

// Creates settings/.env from the template with mode 0600 and no overwrite. The
// "wx" flag fails on any existing entry, including a symlink, and does not follow
// it. Windows ignores the mode; the file inherits the settings folder ACL.
export function initializeEnvFile(root) {
  const target = join(root, 'settings', '.env');
  let template;
  try {
    template = readFileSync(join(root, 'settings', '.env.example'));
  } catch {
    throw new Error('cannot initialize settings/.env; verify settings/.env.example is present');
  }
  // lstat first: it sees a dangling junction or link, which 'wx' can open through and create beyond.
  const existing = entryInfo(target);
  if (existing) {
    if (existing.isFile()) return 0;
    throw new Error('settings/.env exists and is not a regular file; move it aside');
  }
  let fd;
  try {
    fd = openSync(target, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST' && isRegularFile(target)) return 0;
    throw new Error('cannot create settings/.env; move any entry at that path aside');
  }
  try {
    writeSync(fd, template);
  } catch {
    closeSync(fd);
    unlinkSync(target);
    throw new Error('cannot write settings/.env');
  }
  closeSync(fd);
  return 0;
}

function entryInfo(path) {
  try { return lstatSync(path); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function isRegularFile(path) {
  try { return lstatSync(path).isFile(); } catch { return false; }
}

// Expected store names are the uncommented KEY= lines of settings/.env.example,
// except INFISICAL_* bootstrap fields and lines marked `# optional`.
export function expectedStoreNames(templateText) {
  const names = [];
  for (const line of readEnvLines(templateText)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match || match[1].toUpperCase().startsWith('INFISICAL_') || /#\s*optional\b/i.test(match[2])) continue;
    names.push(match[1]);
  }
  return names;
}
