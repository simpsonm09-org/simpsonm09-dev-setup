import { statSync } from 'node:fs';
import { extname, isAbsolute, posix, win32 } from 'node:path';

function isFile(path) {
  try { return statSync(path).isFile(); } catch { return false; }
}

// Only local absolute paths are trusted: a drive-letter path on Windows and a slash path on
// POSIX. UNC, device, root-relative, and drive-relative forms are refused by their text.
const WINDOWS_LOCAL = /^[A-Za-z]:[\\/]/;
export function isLocalAbsolute(platform, value) {
  if (typeof value !== 'string' || value === '') return false;
  return platform === 'win32' ? WINDOWS_LOCAL.test(value) : value.startsWith('/');
}

export function pathApiFor(platform) {
  return platform === 'win32' ? win32 : posix;
}

// Windows names are case-insensitive, so a lookup folds case there.
export function envValue(platform, env, name) {
  const wanted = platform === 'win32' ? name.toUpperCase() : name;
  const key = Object.keys(env).find((candidate) => (platform === 'win32' ? candidate.toUpperCase() : candidate) === wanted);
  return key === undefined ? undefined : env[key];
}

// The file names a bare command may resolve to. On Windows, the PATHEXT order
// applies unless the name already carries one of its extensions.
function executableNames(platform, name, env) {
  if (platform !== 'win32') return [name];
  const extensions = (envValue(platform, env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').map((ext) => ext.trim()).filter(Boolean);
  const suffix = extname(name).toUpperCase();
  if (suffix && extensions.some((ext) => ext.toUpperCase() === suffix)) return [name];
  return extensions.map((ext) => `${name}${ext}`);
}

// Searches the absolute PATH entries in order. Relative and empty entries, including
// "." and the current directory, are skipped: a planted file there must never run.
export function findOnPath(platform, env, names, exists = isFile) {
  const api = pathApiFor(platform);
  const entries = (envValue(platform, env, 'PATH') ?? '').split(api.delimiter);
  for (const folder of entries) {
    if (!isLocalAbsolute(platform, folder)) continue;
    for (const name of names) {
      const candidate = api.join(folder, name);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

// The absolute path of the command to run, or null when nothing resolves. A command
// with a path separator, or already absolute on this host, is used as written
// after being made absolute; a bare name is searched on PATH.
export function resolveTarget(command, platform, env, exists = isFile) {
  if (/[\\/]/.test(command)) return isAbsolute(command) ? command : pathApiFor(platform).resolve(command);
  return findOnPath(platform, env, executableNames(platform, command, env), exists);
}

// DEV_SETUP_INFISICAL_PATH is a trusted setting: the wrapper sends the store
// client secret to whatever file it names. It must be absolute and an existing
// file, and on Windows a .exe.
function validOverride(platform, override, exists) {
  if (!isLocalAbsolute(platform, override)) return null;
  if (platform === 'win32' && extname(override).toLowerCase() !== '.exe') return null;
  return exists(override) ? override : null;
}

export function resolveInfisical(platform, env, exists = isFile) {
  const override = env.DEV_SETUP_INFISICAL_PATH;
  if (override) return validOverride(platform, override, exists);
  const appData = envValue(platform, env, 'APPDATA');
  if (platform === 'win32' && isLocalAbsolute(platform, appData)) {
    const installed = pathApiFor(platform).join(appData, 'npm', 'node_modules', '@infisical', 'cli', 'bin', 'infisical.exe');
    if (exists(installed)) return installed;
  }
  return findOnPath(platform, env, [platform === 'win32' ? 'infisical.exe' : 'infisical'], exists);
}
