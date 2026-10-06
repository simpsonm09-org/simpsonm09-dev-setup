#!/usr/bin/env node
// Render and check the per-platform tool artifacts from tools.yaml.
//
//   node scripts/tools.mjs render   write every generated artifact
//   node scripts/tools.mjs check    validate tools.yaml and that artifacts are current
//   node scripts/tools.mjs plan     print this host's install plan, change nothing
//
// tools.yaml is the single hand-edited source of the tool data. The YAML parser
// lives in scripts/lib/yaml.mjs and the renderers in scripts/lib/render.mjs.
// See docs/apps.md.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseYaml } from './lib/yaml.mjs';
import { installLabel, renderArtifacts, sectionPackages } from './lib/render.mjs';

export { parseYaml, renderArtifacts };

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..');

export const MANIFEST_FILE = 'tools.yaml';

// Every generated artifact and its consumer:
//   Brewfile                  apply-tools.sh runs `brew bundle` on macOS
//   windows/apps.json         windows/Install-Apps.ps1 reads the winget/msstore list
//   windows/manual-apps.json  windows/README.md and the manual-install audit
//   wsl/packages.json         wsl/bootstrap.sh and wsl/install-docker-engine.sh
//   tools.generated.json      apply-tools.ps1 and apply-tools.sh read the full plan
//   docs/apps.md              humans read the rendered tables
export const GENERATED_FILES = [
  'Brewfile',
  'windows/apps.json',
  'windows/manual-apps.json',
  'wsl/packages.json',
  'tools.generated.json',
  'docs/apps.md',
];

export const MANAGERS = new Set(['winget', 'msstore', 'scoop', 'brew', 'apt', 'snap', 'npm', 'manual']);
export const KINDS = new Set(['app', 'cli']);
const PLATFORMS = ['windows', 'wsl', 'macos'];

const USAGE = `usage: node scripts/tools.mjs <command>

commands:
  render   regenerate every artifact from ${MANIFEST_FILE}
  check    validate ${MANIFEST_FILE} and fail on a stale artifact
  plan     print this host's install plan and change nothing
`;

// --- Manifest ---------------------------------------------------------------

export function loadManifest(root = REPO_ROOT) {
  const path = join(root, MANIFEST_FILE);
  if (!existsSync(path)) throw new Error(`${MANIFEST_FILE} is missing`);
  const manifest = parseYaml(readFileSync(path, 'utf8'));
  if (!manifest || typeof manifest !== 'object') throw new Error(`${MANIFEST_FILE} is empty`);
  return manifest;
}

function sectionErrors(tool, platform, section, errors) {
  const where = `${tool.id}.${platform}`;
  if (typeof section !== 'object' || section === null) {
    errors.push(`${where} must be a mapping`);
    return;
  }
  if (!MANAGERS.has(section.manager)) {
    errors.push(`${where}.manager "${section.manager}" is not one of ${[...MANAGERS].join(', ')}`);
    return;
  }
  const has = (field) => typeof section[field] === 'string' && section[field] !== '';
  switch (section.manager) {
    case 'winget':
    case 'msstore':
      if (!has('id') && !Array.isArray(section.fallback)) {
        errors.push(`${where} (${section.manager}) needs an id or a fallback chain`);
      }
      break;
    case 'brew':
      if (!has('formula') && !has('cask')) errors.push(`${where} (brew) needs a formula or a cask`);
      break;
    case 'manual':
      if (!has('url') && !has('note')) errors.push(`${where} (manual) needs a url or a note`);
      break;
    case 'snap':
      if (!has('package') && !(Array.isArray(section.packages) && section.packages.length > 0)) {
        errors.push(`${where} (snap) needs a package`);
      }
      if (section.classic !== undefined && typeof section.classic !== 'boolean') {
        errors.push(`${where}.classic must be a boolean`);
      }
      break;
    default:
      if (!has('package') && !(Array.isArray(section.packages) && section.packages.length > 0)) {
        errors.push(`${where} (${section.manager}) needs a package`);
      }
  }
  if (section.fallback !== undefined) {
    if (!Array.isArray(section.fallback)) errors.push(`${where}.fallback must be a list`);
    else section.fallback.forEach((entry, position) => sectionErrors(tool, `${platform}.fallback[${position}]`, entry, errors));
  }
}

export function validateManifest(manifest) {
  const errors = [];
  if (!Array.isArray(manifest.tools) || manifest.tools.length === 0) {
    errors.push('tools must be a non-empty list');
    return errors;
  }
  const seen = new Set();
  for (const tool of manifest.tools) {
    if (!tool || typeof tool !== 'object') {
      errors.push('every tool must be a mapping');
      continue;
    }
    if (typeof tool.id !== 'string' || tool.id === '') errors.push('a tool has no id');
    else if (seen.has(tool.id)) errors.push(`duplicate tool id "${tool.id}"`);
    else seen.add(tool.id);
    if (typeof tool.name !== 'string' || tool.name === '') errors.push(`${tool.id}: name is required`);
    if (typeof tool.role !== 'string' || tool.role === '') errors.push(`${tool.id}: role is required`);
    if (!KINDS.has(tool.kind)) errors.push(`${tool.id}: kind must be app or cli`);
    if (tool.equivalents !== undefined
      && (!Array.isArray(tool.equivalents) || tool.equivalents.some((entry) => typeof entry !== 'string'))) {
      errors.push(`${tool.id}: equivalents must be a list of strings`);
    }
    const platforms = PLATFORMS.filter((platform) => tool[platform] !== undefined);
    if (platforms.length === 0) errors.push(`${tool.id}: needs at least one platform section`);
    for (const platform of platforms) sectionErrors(tool, platform, tool[platform], errors);
  }
  return errors;
}

// --- Commands ---------------------------------------------------------------

// Validate first, then compare artifacts. Bad input returns schema errors and
// never reaches a renderer, so a null tool cannot throw a TypeError.
export function checkArtifacts(root, manifest) {
  const errors = validateManifest(manifest);
  if (errors.length > 0) return errors;
  const rendered = renderArtifacts(manifest);
  for (const [relative, expected] of Object.entries(rendered)) {
    const path = join(root, relative);
    if (!existsSync(path)) {
      errors.push(`${relative} is missing; run node scripts/tools.mjs render`);
      continue;
    }
    if (readFileSync(path, 'utf8').replace(/^\uFEFF/, '') !== expected) {
      errors.push(`${relative} is out of date; run node scripts/tools.mjs render`);
    }
  }
  return errors;
}

function hostPlatform() {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'linux') return 'wsl';
  return 'unknown';
}

// The plan-agreement contract is the action set: for every tool the plan names
// the tool id, the manager, and the action (install, opt-in, manual, or
// deferred). Presence is not part of it. The Node plan runs on the host and the
// shell plan runs on the target, which for WSL are different machines, so
// `present` versus `install` is a per-host convenience and may legitimately
// differ. scripts/tools.test.mjs encodes this contract.
export function planLines(manifest, platform) {
  const lines = [`host platform: ${platform}`];
  for (const tool of manifest.tools) {
    const section = tool[platform];
    if (!section) {
      lines.push(`  skip     ${tool.id} (not claimed on ${platform})`);
      continue;
    }
    const optIn = section.requiresExplicitOptIn ?? tool.requiresExplicitOptIn;
    const byDefault = section.installByDefault ?? tool.installByDefault ?? true;
    let action;
    if (optIn) action = 'opt-in';
    else if (!byDefault) action = 'deferred';
    else {
      // Match the verb the shell plans use for the same detect result.
      const state = detect(section);
      if (state === 'present') action = 'present';
      else if (state === 'manual') action = 'manual';
      else action = 'install';
    }
    lines.push(`  ${action.padEnd(8)} ${tool.id}\t${installLabel(section)}`);
  }
  return lines;
}

function printPlan(manifest, platform) {
  process.stdout.write(`${planLines(manifest, platform).join('\n')}\n`);
}

function main() {
  const command = process.argv[2] ?? 'help';
  if (command === 'help' || command === '-h' || command === '--help') {
    process.stdout.write(USAGE);
    return;
  }
  let manifest;
  try {
    manifest = loadManifest(REPO_ROOT);
  } catch (error) {
    process.stderr.write(`tools: ${error.message}\n`);
    process.exit(1);
  }
  if (command === 'render') {
    const errors = validateManifest(manifest);
    if (errors.length > 0) fail(errors);
    for (const [relative, content] of Object.entries(renderArtifacts(manifest))) {
      const path = join(REPO_ROOT, relative);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
      process.stdout.write(`wrote ${relative}\n`);
    }
    return;
  }
  if (command === 'check') {
    const errors = checkArtifacts(REPO_ROOT, manifest);
    if (errors.length > 0) fail(errors);
    process.stdout.write(`check: ok (${manifest.tools.length} tools, ${GENERATED_FILES.length} artifacts)\n`);
    return;
  }
  if (command === 'plan') {
    const errors = validateManifest(manifest);
    if (errors.length > 0) fail(errors);
    printPlan(manifest, hostPlatform());
    return;
  }
  process.stderr.write(`tools: unknown command "${command}"\n${USAGE}`);
  process.exit(2);
}

function run(command, args) {
  try {
    return spawnSync(command, args, { encoding: 'utf8', timeout: 15000 });
  } catch {
    return { status: null, stdout: '' };
  }
}

// Best-effort presence check. A missing manager is "unknown", never fatal.
function detect(section) {
  // A manual section and a Microsoft Store section are both installed by a
  // human, so the plan calls both "manual" instead of probing the machine.
  if (section.manager === 'manual' || section.manager === 'msstore') return 'manual';
  if (section.manager === 'winget') {
    const result = run('winget', ['list', '--id', section.id, '--exact', '--source', section.manager, '--disable-interactivity']);
    if (result.status === null) return 'unknown';
    return (result.stdout ?? '').includes(section.id) ? 'present' : 'missing';
  }
  if (section.manager === 'apt') {
    const present = sectionPackages(section)
      .every((pkg) => run('dpkg-query', ['-W', '-f=${Version}', String(pkg)]).status === 0);
    return present ? 'present' : 'missing';
  }
  if (section.manager === 'brew') {
    const result = run('brew', ['list', section.formula ?? section.cask]);
    return result.status === 0 ? 'present' : 'missing';
  }
  if (section.manager === 'scoop') {
    const result = run('scoop', ['list', section.package]);
    if (result.status === null) return 'unknown';
    return (result.stdout ?? '').includes(section.package) ? 'present' : 'missing';
  }
  return 'unknown';
}

function fail(errors) {
  for (const error of errors) process.stderr.write(`error: ${error}\n`);
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
