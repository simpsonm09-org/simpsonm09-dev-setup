// Environment policy: what the Infisical CLI may inherit, and which names a
// command may never take from the store or settings/.env.

// Variables the Infisical CLI needs. Proxy and CA settings are not here: a
// caller's HTTPS_PROXY or NODE_OPTIONS must not reach a process that holds the
// store credentials. DEV_SETUP_INFISICAL_PASSTHROUGH is the documented opt-in.
const CLI_BASE_NAMES = {
  posix: ['HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME'],
  win32: ['SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'TEMP', 'TMP', 'USERNAME', 'COMPUTERNAME', 'PROGRAMDATA'],
};
const PASSTHROUGH_NAMES = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR'];

// Names that change how a command loads, finds, or trusts its code. Store and
// fallback values may not set them. Exact names compare case-insensitively on
// Windows and exactly elsewhere. Prefixes compare case-insensitively everywhere,
// because npm and the loaders accept either case.
export const DENIED_NAMES = [
  // Command search and shell startup.
  'PATH', 'PATHEXT', 'COMSPEC', 'SHELL', 'BASH_ENV', 'ENV', 'PROMPT_COMMAND', 'PSModulePath',
  // Interpreter and runtime loading.
  'NODE_OPTIONS', 'NODE_PATH', 'PYTHONPATH', 'PYTHONHOME', 'PYTHONSTARTUP', 'PERL5OPT', 'PERL5LIB', 'RUBYOPT', 'RUBYLIB',
  // Native loader preloads.
  'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT',
  // Certificate trust and TLS verification.
  'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'CURL_CA_BUNDLE', 'REQUESTS_CA_BUNDLE', 'GIT_SSL_NO_VERIFY',
  // Package-manager hooks.
  'npm_config_script_shell',
];
export const DENIED_PREFIXES = ['DYLD_', 'LD_', 'GIT_', 'DEV_SETUP_', 'INFISICAL_', 'npm_config_'];

export function foldName(name, platform) {
  return platform === 'win32' ? name.toUpperCase() : name;
}

// The opt-in names an allowed proxy or CA variable, in either case. Anything else fails closed.
export function parsePassthrough(value, platform) {
  if (!value) return [];
  const allowed = new Set(PASSTHROUGH_NAMES.map((name) => foldName(name, platform)));
  return value.split(',').map((name) => name.trim()).filter(Boolean).map((name) => {
    if (!allowed.has(foldName(name, platform))) throw new Error(`DEV_SETUP_INFISICAL_PASSTHROUGH names an unsupported variable: ${name}`);
    return name;
  });
}

export function cliEnvironment(sourceEnv, platform, passthrough) {
  const wanted = new Set([...CLI_BASE_NAMES[platform === 'win32' ? 'win32' : 'posix'], ...passthrough].map((name) => foldName(name, platform)));
  const env = Object.create(null);
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (value !== undefined && wanted.has(foldName(key, platform))) env[key] = value;
  }
  return env;
}

export function cleanEnvironment(source) {
  const env = Object.create(null);
  for (const [key, value] of Object.entries(source)) {
    if (!key.toUpperCase().startsWith('INFISICAL_') && value !== undefined) env[key] = value;
  }
  return env;
}

export function isDeniedName(name, platform = process.platform) {
  const upper = name.toUpperCase();
  const exact = platform === 'win32' ? upper : name;
  if (DENIED_NAMES.some((denied) => (platform === 'win32' ? denied.toUpperCase() : denied) === exact)) return true;
  return DENIED_PREFIXES.some((prefix) => upper.startsWith(prefix.toUpperCase()));
}
