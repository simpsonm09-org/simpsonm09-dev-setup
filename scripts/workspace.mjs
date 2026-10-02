#!/usr/bin/env node
// Build the workspace from scratch. Clone every repository in the repo-catalog
// roster into projects/repos, point the organization at the upstream remote,
// and optionally run the maxstack workspace installer.
//
// Prints the plan by default. Writes only with --apply or --install.
// See docs/project-workflow.md.

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const OWNER = 'simpsonm09';
const UPSTREAM = 'simpsonm09-org';
const ROSTER_REPO = 'simpsonm09-repo-catalog';

function flag(name) {
  return args.includes(name);
}

function flagValue(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function defaultRoot() {
  return process.platform === 'win32' ? 'D:\\dev\\simpsonm09' : '/mnt/d/dev/simpsonm09';
}

const write = flag('--apply') || flag('--install');
const install = flag('--install');
const root = resolve(flagValue('--root') ?? process.env.WORKSPACE_ROOT ?? defaultRoot());
const reposDir = join(root, 'projects', 'repos');
const rosterFile = join(reposDir, ROSTER_REPO, 'repos.json');

let failures = 0;
let planned = 0;

function act(verb, target) {
  planned += 1;
  process.stdout.write(`${write ? 'do  ' : 'plan'}  ${verb}  ${target}\n`);
  return write;
}

function spawn(cmd, argv, cwd) {
  const result = spawnSync(cmd, argv, { cwd, stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    failures += 1;
    process.stderr.write(`fail  ${cmd} ${argv.join(' ')}\n`);
    return false;
  }
  return true;
}

function clone(name) {
  const dir = join(reposDir, name);
  if (existsSync(dir)) {
    return true;
  }
  const target = OWNER + '/' + name;
  if (!act('clone', target + ' -> ' + dir)) {
    return true;
  }
  return spawn('gh', ['repo', 'clone', target, dir]);
}

function hasRemote(dir, name) {
  const result = spawnSync('git', ['remote'], { cwd: dir, encoding: 'utf8' });
  return result.status === 0 && result.stdout.split('\n').includes(name);
}

function addUpstream(name) {
  const dir = join(reposDir, name);
  if (existsSync(dir) && hasRemote(dir, 'upstream')) {
    return true;
  }
  const url = 'https://github.com/' + UPSTREAM + '/' + name + '.git';
  if (!act('upstream', name + ' -> ' + UPSTREAM + '/' + name)) {
    return true;
  }
  return spawn('git', ['remote', 'add', 'upstream', url], dir);
}

function refExists(dir, ref) {
  return spawnSync('git', ['rev-parse', '--verify', '--quiet', ref], { cwd: dir }).status === 0;
}

// A history rewrite (filter-repo) or a rebuilt branch drops branch.main.*, which
// makes main look unpublished in GitHub Desktop. Re-establish it on every run.
function ensureTracking(name) {
  const dir = join(reposDir, name);
  if (!existsSync(join(dir, '.git'))) {
    return true;
  }
  if (!refExists(dir, 'refs/heads/main') || !refExists(dir, 'refs/remotes/origin/main')) {
    return true;
  }
  const result = spawnSync(
    'git',
    ['for-each-ref', '--format=%(upstream:short)', 'refs/heads/main'],
    { cwd: dir, encoding: 'utf8' },
  );
  if ((result.stdout ?? '').trim() === 'origin/main') {
    return true;
  }
  if (!act('track', `${name}  main -> origin/main`)) {
    return true;
  }
  return spawn('git', ['branch', '--set-upstream-to=origin/main', 'main'], dir);
}

function runInstaller() {
  const installer = join(reposDir, 'simpsonm09-maxstack', 'scripts', 'Install-Workspace.ps1');
  if (!act('install', installer)) {
    return true;
  }
  if (!existsSync(installer)) {
    failures += 1;
    process.stderr.write(`fail  cannot find ${installer}\n`);
    return false;
  }
  return spawn('pwsh', ['-NoLogo', '-NoProfile', '-File', installer, '-Apply'], root);
}

function main() {
  if (!existsSync(reposDir)) {
    if (write) {
      mkdirSync(reposDir, { recursive: true });
    } else {
      process.stdout.write(`plan  create  ${reposDir}\n`);
    }
  }

  clone(ROSTER_REPO);

  if (!existsSync(rosterFile)) {
    process.stdout.write(
      write ? `note  ${rosterFile} is still missing, cannot read the roster\n`
            : 'note  repo-catalog is not cloned yet, so the roster is unknown in this dry run\n',
    );
    return;
  }

  const roster = JSON.parse(readFileSync(rosterFile, 'utf8'));
  const names = roster.repos.map((entry) => entry.name).filter((name) => name !== ROSTER_REPO);
  for (const name of names) {
    clone(name);
    addUpstream(name);
    ensureTracking(name);
  }
  addUpstream(ROSTER_REPO);
  ensureTracking(ROSTER_REPO);

  if (install) {
    runInstaller();
  }
}

main();

process.stdout.write(
  `${write ? 'applied' : 'dry run'}  repositories=${planned === 0 ? 'up to date' : planned}\n`,
);
if (failures > 0) {
  process.stderr.write(`failures=${failures}\n`);
  process.exit(1);
}
process.exit(0);
