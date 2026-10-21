import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SETTING_NAMES = ['LITELLM_BIND_ADDRESS', 'LITELLM_PORT', 'LOCAL_LLAMA_BASE_URL',
  'LITELLM_IMAGE', 'POSTGRES_IMAGE'];

export function validateSettings(text, inherited = {}) {
  const settings = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = /^([A-Z_]+)=([^\s$'"`]+)$/.exec(line);
    if (!match || !SETTING_NAMES.includes(match[1]) || Object.hasOwn(settings, match[1])) {
      throw new Error('Settings must contain unique, non-secret allowlisted assignments only');
    }
    settings[match[1]] = match[2];
  }
  for (const name of SETTING_NAMES) {
    if (inherited[name]) settings[name] = inherited[name];
  }
  const ip = settings.LITELLM_BIND_ADDRESS?.split('.').map(Number);
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(settings.LITELLM_BIND_ADDRESS ?? '')
    || ip.some((part) => part < 0 || part > 255)
    || !(ip[0] === 10 || (ip[0] === 172 && ip[1] >= 16 && ip[1] <= 31)
      || (ip[0] === 192 && ip[1] === 168))) {
    throw new Error('Set LITELLM_BIND_ADDRESS to the homelab RFC1918 IPv4 interface');
  }
  if (!/^\d+$/.test(settings.LITELLM_PORT ?? '')
    || Number(settings.LITELLM_PORT) < 1 || Number(settings.LITELLM_PORT) > 65535) {
    throw new Error('Set LITELLM_PORT to a valid port');
  }
  const base = new URL(settings.LOCAL_LLAMA_BASE_URL);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password
    || base.search || base.hash || !base.pathname.endsWith('/v1')) {
    throw new Error('Set LOCAL_LLAMA_BASE_URL to a credential-free /v1 endpoint');
  }
  for (const name of ['LITELLM_IMAGE', 'POSTGRES_IMAGE']) {
    if (!/^[\w./-]+:[\w.-]+@sha256:[a-f0-9]{64}$/.test(settings[name] ?? '')
      || settings[name].includes(':latest@')) {
      throw new Error('Both images must have an exact tag and SHA256 digest');
    }
  }
  return settings;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    validateSettings(readFileSync(process.argv[2], 'utf8'), process.env);
  } catch {
    process.stderr.write('gateway: invalid or missing non-secret settings; see README.md\n');
    process.exitCode = 1;
  }
}
