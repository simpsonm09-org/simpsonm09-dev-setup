#!/usr/bin/env node
// Render and check the per-platform tool artifacts from tools.yaml.
//
//   node scripts/tools.mjs render   write every generated artifact
//   node scripts/tools.mjs check    validate tools.yaml and that artifacts are current
//   node scripts/tools.mjs plan     print this host's install plan, change nothing
//
// tools.yaml is the single hand-edited source of the tool data. The generator
// reads a small, block-only YAML subset (mappings, sequences, scalars) so it runs
// with plain node and no dependencies. See docs/apps.md.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..');

export const MANIFEST_FILE = 'tools.yaml';
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

// --- YAML subset ------------------------------------------------------------

function stripComment(line) {
  let inSingle = false;
  let inDouble = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "'" && !inDouble) inSingle = !inSingle;
    else if (char === '"' && !inSingle) inDouble = !inDouble;
    else if (char === '#' && !inSingle && !inDouble && (index === 0 || /\s/.test(line[index - 1]))) {
      return line.slice(0, index);
    }
  }
  return line;
}

function keyColon(text) {
  let inSingle = false;
  let inDouble = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "'" && !inDouble) inSingle = !inSingle;
    else if (char === '"' && !inSingle) inDouble = !inDouble;
    else if (char === ':' && !inSingle && !inDouble) {
      if (index === text.length - 1 || text[index + 1] === ' ') return index;
    }
  }
  return -1;
}

function splitKey(text) {
  const index = keyColon(text);
  if (index === -1) throw new Error(`not a mapping entry: ${text}`);
  return { key: text.slice(0, index).trim(), rest: text.slice(index + 1).trim() };
}

function parseScalar(text) {
  const value = text.trim();
  if (value === '' || value === 'null' || value === '~') return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value.startsWith('"')) return JSON.parse(value);
  if (value.startsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  if (/^-?\d+$/.test(value)) return Number(value);
  if (/^-?\d+\.\d+$/.test(value)) return Number(value);
  return value;
}

function parseMapping(lines, index, indent) {
  const result = {};
  let cursor = index;
  while (cursor < lines.length) {
    const line = lines[cursor];
    if (line.indent !== indent) break;
    if (line.text.startsWith('- ') || line.text === '-') break;
    const { key, rest } = splitKey(line.text);
    cursor += 1;
    if (rest !== '') {
      result[key] = parseScalar(rest);
    } else if (cursor < lines.length && lines[cursor].indent > indent) {
      [result[key], cursor] = parseNode(lines, cursor, lines[cursor].indent);
    } else if (cursor < lines.length && lines[cursor].indent === indent && lines[cursor].text.startsWith('- ')) {
      [result[key], cursor] = parseSequence(lines, cursor, indent);
    } else {
      result[key] = null;
    }
  }
  return [result, cursor];
}

function parseSequence(lines, index, indent) {
  const result = [];
  let cursor = index;
  while (cursor < lines.length) {
    const line = lines[cursor];
    if (line.indent !== indent) break;
    if (!(line.text.startsWith('- ') || line.text === '-')) break;
    const rest = line.text === '-' ? '' : line.text.slice(2).trim();
    if (rest === '') {
      cursor += 1;
      if (cursor < lines.length && lines[cursor].indent > indent) {
        let value;
        [value, cursor] = parseNode(lines, cursor, lines[cursor].indent);
        result.push(value);
      } else {
        result.push(null);
      }
    } else if (keyColon(rest) !== -1) {
      lines[cursor] = { indent: indent + 2, text: rest };
      let value;
      [value, cursor] = parseMapping(lines, cursor, indent + 2);
      result.push(value);
    } else {
      result.push(parseScalar(rest));
      cursor += 1;
    }
  }
  return [result, cursor];
}

function parseNode(lines, index, indent) {
  if (index >= lines.length) return [null, index];
  if (lines[index].text.startsWith('- ') || lines[index].text === '-') {
    return parseSequence(lines, index, indent);
  }
  return parseMapping(lines, index, indent);
}

export function parseYaml(text) {
  const lines = [];
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const stripped = stripComment(raw);
    if (stripped.trim() === '') continue;
    lines.push({ indent: stripped.length - stripped.trimStart().length, text: stripped.trim() });
  }
  if (lines.length === 0) return null;
  return parseNode(lines, 0, lines[0].indent)[0];
}

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
    const platforms = PLATFORMS.filter((platform) => tool[platform] !== undefined);
    if (platforms.length === 0) errors.push(`${tool.id}: needs at least one platform section`);
    for (const platform of platforms) sectionErrors(tool, platform, tool[platform], errors);
  }
  return errors;
}

// --- Renderers --------------------------------------------------------------

function toolWindowsSection(tool) {
  return tool.windows ?? null;
}

function renderWindowsApps(manifest) {
  const apps = [];
  for (const tool of manifest.tools) {
    const section = toolWindowsSection(tool);
    if (!section || (section.manager !== 'winget' && section.manager !== 'msstore')) continue;
    if (typeof section.id !== 'string' || section.id === '') continue;
    const entry = {
      name: section.name ?? tool.name,
      id: section.id,
      source: section.manager,
      role: tool.role,
      installByDefault: section.installByDefault ?? tool.installByDefault ?? true,
    };
    if (section.requiresExplicitOptIn ?? tool.requiresExplicitOptIn) entry.requiresExplicitOptIn = true;
    entry.version = section.version ?? null;
    entry.versionPolicy = section.policy ?? tool.policy ?? 'latest';
    if (Array.isArray(section.installedAliases)) entry.installedAliases = section.installedAliases;
    apps.push(entry);
  }
  return apps;
}

function renderWindowsManual(manifest) {
  const apps = [];
  for (const tool of manifest.tools) {
    const section = toolWindowsSection(tool);
    if (!section || section.manager !== 'manual' || tool.kind !== 'app') continue;
    apps.push({
      name: section.name ?? tool.name,
      publisher: section.publisher ?? tool.name,
      source: section.url,
      role: tool.role,
      observedVersion: section.observedVersion ?? null,
      installPolicy: section.installPolicy ?? 'manual-official-release',
    });
  }
  return apps;
}

function sectionPackages(section) {
  if (Array.isArray(section.packages) && section.packages.length > 0) return section.packages;
  return [section.package];
}

function renderWslPackages(manifest) {
  const aptPackages = [];
  const optionalAptProfiles = {};
  const snapPackages = [];
  const manualTools = {};
  for (const tool of manifest.tools) {
    const section = tool.wsl;
    if (!section) continue;
    if (section.manager === 'apt') {
      if (section.profile) (optionalAptProfiles[section.profile] ??= []).push(...sectionPackages(section));
      else aptPackages.push(...sectionPackages(section));
    } else if (section.manager === 'snap') {
      snapPackages.push(...sectionPackages(section));
    } else if (section.manager === 'manual') {
      manualTools[tool.id] = {
        observedVersion: section.observedVersion ?? null,
        updateCommand: section.updateCommand ?? null,
        managedByBootstrap: section.managedByBootstrap ?? false,
      };
    }
  }
  const data = { ubuntuRelease: manifest.ubuntuRelease, aptPackages };
  if (Object.keys(optionalAptProfiles).length > 0) data.optionalAptProfiles = optionalAptProfiles;
  if (snapPackages.length > 0) data.snapPackages = snapPackages;
  data.packagePolicy = manifest.packagePolicy;
  data.manualTools = manualTools;
  return data;
}

function renderBrewfile(manifest) {
  const lines = ['# Generated from tools.yaml by scripts/tools.mjs. Do not edit by hand.'];
  for (const tool of manifest.tools) {
    const section = tool.macos;
    if (!section || section.manager !== 'brew') continue;
    if (section.formula) lines.push(`brew "${section.formula}"`);
    else if (section.cask) lines.push(`cask "${section.cask}"`);
  }
  return `${lines.join('\n')}\n`;
}

function renderPlan(manifest) {
  return `${JSON.stringify({ generatedBy: 'scripts/tools.mjs', ...manifest }, null, 2)}\n`;
}

function installLabel(section) {
  const packages = Array.isArray(section.packages) ? section.packages.join(', ') : section.package;
  switch (section.manager) {
    case 'winget': return `winget \`${section.id}\``;
    case 'msstore': return `msstore \`${section.id}\``;
    case 'scoop': return `scoop \`${packages}\``;
    case 'apt': return `apt \`${packages}\``;
    case 'snap': return `snap \`${packages}\``;
    case 'npm': return `npm \`${packages}\``;
    case 'brew': return section.formula ? `brew \`${section.formula}\`` : `cask \`${section.cask}\``;
    case 'manual': return section.url ? `manual (${section.url})` : 'manual';
    default: return section.manager;
  }
}

function platformInstall(tool) {
  return PLATFORMS
    .filter((platform) => tool[platform])
    .map((platform) => `${platform}: ${installLabel(tool[platform])}`)
    .join('; ');
}

function renderDocs(manifest) {
  const rows = (kind, header) => {
    const lines = [`| ${header} | Role | Install |`, '| --- | --- | --- |'];
    for (const tool of manifest.tools) {
      if (tool.kind !== kind) continue;
      const role = tool.equivalents ? `${tool.role} (equivalents: ${tool.equivalents.join(', ')})` : tool.role;
      lines.push(`| ${tool.name} | ${role} | ${platformInstall(tool)} |`);
    }
    return lines.join('\n');
  };
  return `# Apps and roles

Generated from [\`../tools.yaml\`](../tools.yaml). Do not edit this file by hand; edit
\`tools.yaml\` and run \`just tools-render\`. The Windows list also lands in
[\`../windows/apps.json\`](../windows/apps.json) and
[\`../windows/manual-apps.json\`](../windows/manual-apps.json), the WSL list in
[\`../wsl/packages.json\`](../wsl/packages.json), and the macOS list in
[\`../Brewfile\`](../Brewfile).

## Apps

${rows('app', 'App')}

## Developer CLI tools

${rows('cli', 'Tool')}

## Installation-source policy

Prefer package managers. winget is the first choice for Windows apps, apt and snap for
WSL packages, and brew for macOS. Scoop is the approved Windows fallback when winget has
no entry. Use an official publisher installer only when no supported package manager
entry exists, and never an unofficial mirror. Microsoft Store apps need interactive
review of their terms, so the apply scripts leave them for a manual install. Existing
installations are detected and left unchanged; a version pin applies only to a new
install.
`;
}

export function renderArtifacts(manifest) {
  return {
    'Brewfile': renderBrewfile(manifest),
    'windows/apps.json': `${JSON.stringify(renderWindowsApps(manifest), null, 2)}\n`,
    'windows/manual-apps.json': `${JSON.stringify(renderWindowsManual(manifest), null, 2)}\n`,
    'wsl/packages.json': `${JSON.stringify(renderWslPackages(manifest), null, 2)}\n`,
    'tools.generated.json': renderPlan(manifest),
    'docs/apps.md': renderDocs(manifest),
  };
}

// --- Commands ---------------------------------------------------------------

export function checkArtifacts(root, manifest) {
  const errors = validateManifest(manifest);
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
  if (section.manager === 'manual') return 'manual';
  if (section.manager === 'winget' || section.manager === 'msstore') {
    const result = run('winget', ['list', '--id', section.id, '--exact', '--source', section.manager, '--disable-interactivity']);
    if (result.status === null) return 'unknown';
    return (result.stdout ?? '').includes(section.id) ? 'present' : 'missing';
  }
  if (section.manager === 'apt') {
    const result = run('dpkg-query', ['-W', '-f=${Version}', section.package]);
    return result.status === 0 ? 'present' : 'missing';
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

function printPlan(manifest, platform) {
  process.stdout.write(`host platform: ${platform}\n`);
  for (const tool of manifest.tools) {
    const section = tool[platform];
    if (!section) {
      process.stdout.write(`  skip     ${tool.id} (not claimed on ${platform})\n`);
      continue;
    }
    const optIn = section.requiresExplicitOptIn ?? tool.requiresExplicitOptIn;
    const byDefault = section.installByDefault ?? tool.installByDefault ?? true;
    let action = 'install';
    if (optIn) action = 'opt-in';
    else if (!byDefault) action = 'skip';
    else if (detect(section) === 'present') action = 'present';
    process.stdout.write(`  ${action.padEnd(8)} ${tool.id}\t${installLabel(section)}\n`);
  }
}

function fail(errors) {
  for (const error of errors) process.stderr.write(`error: ${error}\n`);
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
