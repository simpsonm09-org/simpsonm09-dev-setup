import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

const helper = resolve('scripts/local-model.ps1');
const fixture = resolve('scripts/fixtures/local-model-router.mjs');
const identityFixture = resolve('scripts/fixtures/process-identity-capture.test.ps1');
const pwshCheck = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { windowsHide: true, encoding: 'utf8' });
if (pwshCheck.error?.code !== 'ENOENT') assertCompleted(pwshCheck, 'PowerShell version check');
const hasPwsh = pwshCheck.error?.code !== 'ENOENT' && pwshCheck.status === 0;
const isWindows = process.platform === 'win32';
const canRunLifecycle = hasPwsh && isWindows;
if (!canRunLifecycle) console.warn(`SKIP local-model lifecycle tests: requires Windows and PowerShell 7 (platform=${process.platform}, pwsh=${hasPwsh}).`);
test('process identity capture rejects blank paths, retries transient queries, and cleans lost identity by launch handle', { skip: !canRunLifecycle }, () => {
  const result = assertCompleted(spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-File', identityFixture, '-HelperPath', helper], { windowsHide: true, encoding: 'utf8', timeout: 10_000 }), 'process identity fixture');
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.match(result.stdout, /PASS blank CIM image, transient query recovery, and lost-identity cleanup/);
});

test('PowerShell availability gates the lifecycle suite and identifies a missing executable', () => {
  if (pwshCheck.error?.code === 'ENOENT') {
    assert.equal(hasPwsh, false);
    assert.equal(canRunLifecycle, false);
    return;
  }
  assert.equal(pwshCheck.status, 0, 'PowerShell version probe completed successfully');
  assert.ok(Number(pwshCheck.stdout.trim()) >= 7, 'PowerShell 7 or newer is required');
});

test('identity failure cleans the router and its unrecorded child', { skip: !canRunLifecycle }, () => {
  const port = 19180;
  const env = { ...process.env, FIXTURE_SPAWN_CHILD_ON_BOOT: '1', FIXTURE_SPAWN_CHILD_THEN_EXIT: '1' };
  const result = run(['-Action', 'Start', ...fixtureArgs(port)], 15_000, env);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /identity could not be captured|before ownership identity could be recorded/);
  const routerPid = Number(readFileSync(join(root, 'models', 'pid.txt'), 'utf8'));
  const childPid = Number(readFileSync(join(root, 'models', 'child-pid.txt'), 'utf8'));
  try {
    assert.equal(requireAlive(routerPid), false, 'failed router is gone');
    assert.equal(requireAlive(childPid), false, 'unrecorded child is gone');
    assert.equal(existsSync(join(state, 'server.json')), false, 'no ownership record was written');
  } finally {
    if (requireAlive(childPid)) process.kill(childPid, 'SIGKILL');
  }
});

test('record write failure aborts the contained router and child', { skip: !canRunLifecycle }, () => {
  const port = 19181;
  mkdirSync(state, { recursive: true });
  mkdirSync(join(state, 'server.json'));
  const env = { ...process.env, FIXTURE_SPAWN_CHILD_ON_BOOT: '1' };
  const result = run(['-Action', 'Start', ...fixtureArgs(port)], 15_000, env);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /before ownership identity could be recorded or transferred/);
  const routerPid = Number(readFileSync(join(root, 'models', 'pid.txt'), 'utf8'));
  const childPid = Number(readFileSync(join(root, 'models', 'child-pid.txt'), 'utf8'));
  assert.equal(requireAlive(routerPid), false, 'router is gone after the record write failed');
  assert.equal(requireAlive(childPid), false, 'child is gone after the record write failed');
  assert.equal(statSync(join(state, 'server.json')).isDirectory(), true, 'the deliberate record-path obstruction remains');
  assert.deepEqual(readdirSync(state).filter((name) => name.endsWith('.tmp')), [], 'no temporary owner record remains');
});

function assertCompleted(result, label = 'child process') {
  assert.equal(result.error, undefined, `${label} spawn error: ${result.error}`);
  assert.equal(result.signal, null, `${label} was terminated by ${result.signal}`);
  assert.notEqual(result.status, null, `${label} has no exit status`);
  return result;
}

function run(args, timeout = 20_000, env = process.env) {
  return assertCompleted(spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-File', helper, ...args], { windowsHide: true, encoding: 'utf8', timeout, env }), 'local-model helper');
}

function fixtureArgs(port) {
  const relativeModels = relative(process.cwd(), join(root, 'models')) + sep;
  return ['-ServerPath', process.execPath, '-ServerArgumentPrefix', fixture,
    '-ModelsDirectory', relativeModels, '-ModelId', 'synthetic-model', '-Port', String(port),
    '-ContextTokens', '98304', '-MaxOutputTokens', '8192', '-StateDirectory', state];
}

let root;
let state;
test.beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'local-model-test-'));
  mkdirSync(join(root, 'models'));
  state = join(root, 'state');
});
test.afterEach(() => {
  const recordPath = join(state, 'server.json');
  if (existsSync(recordPath)) {
    let record;
    try {
      record = JSON.parse(readFileSync(recordPath, 'utf8'));
    } catch {}
    if (record?.startedAtUtc) {
      const stopped = run(['-Action', 'Stop', '-StateDirectory', state], 20_000);
      if (stopped.status !== 0) {
        console.error(`Preserving synthetic fixture state after failed cleanup: ${state}`);
        return;
      }
    }
  }
  rmSync(root, { recursive: true, force: true });
});

test('Plan reports existing paths, explicit router arguments, and budget without launching', { skip: !canRunLifecycle }, () => {
  const result = run(['-Action', 'Plan', ...fixtureArgs(19180)]);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}\n${result.error}`);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.bind, '127.0.0.1');
  assert.equal(plan.serverExists, true);
  assert.equal(plan.modelsDirectoryExists, true);
  assert.equal(plan.arguments[2], resolve(relative(process.cwd(), join(root, 'models'))) + sep);
  assert.equal(plan.portInUse, false);
  assert.equal(plan.contextTokens, 98_304);
  assert.equal(plan.maxOutputTokens, 8_192);
  assert.equal(plan.promptBudgetTokens, 90_112);
  assert.deepEqual(plan.arguments.slice(0, 1), [fixture]);
  assert.deepEqual(plan.arguments.slice(-6), ['-c', '98304', '-np', '1', '--models-max', '1']);
});

test('Start preserves spaced and trailing-separator paths as distinct argv and Stop removes router and child', { skip: !canRunLifecycle }, async () => {
  const port = 19181;
  const result = run(['-Action', 'Start', ...fixtureArgs(port)]);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}\n${result.error}`);
  const recordPath = join(state, 'server.json');
  const record = JSON.parse(readFileSync(recordPath, 'utf8'));
  const received = JSON.parse(readFileSync(join(root, 'models', 'argv.json'), 'utf8'));
  const modelDirIndex = received.indexOf('--models-dir');
  assert.equal(received[modelDirIndex + 1], resolve(relative(process.cwd(), join(root, 'models'))) + sep);
  assert.deepEqual(received.slice(-8, -2), ['-c', '98304', '-np', '1', '--models-max', '1']);
  assert.equal(record.actualContextTokens, 98_304);
  assert.ok(record.children.length >= 1, 'model process child is recorded after load');
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  const durableStdout = readdirSync(state).map((name) => join(state, name)).find((path) => path.endsWith('.stdout.log'));
  assert.ok(durableStdout);
  assert.match(readFileSync(durableStdout, 'utf8'), /fixture tick/);
  assert.equal(existsSync(join(root, 'models', 'stdout-epipe.txt')), false, 'server stdout remains connected to a file after Start exits');
  assert.equal(existsSync(join(state, 'response.load.json')), true);
  assert.equal(existsSync(join(state, 'response.models.json')), true);
  assert.equal(existsSync(join(state, 'response.props.json')), true);

  const repeated = run(['-Action', 'Start', ...fixtureArgs(port)]);
  assert.notEqual(repeated.status, 0);
  assert.match(repeated.stderr, /already recorded/);
  assert.equal(JSON.parse(readFileSync(recordPath, 'utf8')).pid, record.pid);
  assert.equal(JSON.parse(run(['-Action', 'Plan', ...fixtureArgs(port)]).stdout).existingRecord, 'live-owned');

  const stopped = run(['-Action', 'Stop', '-StateDirectory', state]);
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.equal(JSON.parse(stopped.stdout).stopped, true);
  assert.equal(Number(readFileSync(join(root, 'models', 'unload-count.txt'), 'utf8')), 1);
  assert.equal(requireAlive(record.pid), false);
  for (const child of record.children) assert.equal(requireAlive(child.pid), false);
});

test('Start caller closes promptly while the owned router stays alive', { skip: !canRunLifecycle }, async () => {
  const port = 19197;
  const child = spawn('pwsh', ['-NoLogo', '-NoProfile', '-File', helper, '-Action', 'Start', ...fixtureArgs(port)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  let helperExit;
  const exitPromise = once(child, 'exit');
  const closePromise = once(child, 'close');
  try {
    helperExit = await Promise.race([exitPromise, timeoutAfter(15_000, 'Start helper did not exit within 15 seconds')]);
    const record = JSON.parse(readFileSync(join(state, 'server.json'), 'utf8'));
    assert.equal(requireAlive(record.pid), true, 'router is alive after Start helper exits');
    const close = await Promise.race([closePromise, timeoutAfter(5_000,
      `Start caller pipes stayed open after helper exit (router=${record.pid}, stdoutEnded=${child.stdout.readableEnded}, stderrEnded=${child.stderr.readableEnded})`)]);
    assert.equal(close[0], helperExit[0]);
    assert.equal(close[1], helperExit[1]);
    assert.equal(helperExit[0], 0, `${stderr}\n${stdout}`);
    assert.equal(helperExit[1], null);
    assert.equal(requireAlive(record.pid), true, 'router remains alive after caller pipes close');
    assert.equal(JSON.parse(stdout).ready, true);
  } finally {
    if (existsSync(join(state, 'server.json'))) run(['-Action', 'Stop', '-StateDirectory', state]);
    if (child.exitCode === null) child.kill();
  }
});

test('Status reads only the recorded custom port and denies a loaded model on the default port', { skip: !canRunLifecycle }, async (t) => {
  const defaultPortCheck = assertCompleted(spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-Command',
    "if (Get-NetTCPConnection -State Listen -LocalPort 18080 -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"], { windowsHide: true, encoding: 'utf8' }), 'default port check');
  const defaultPortBusy = defaultPortCheck.status === 0;
  if (defaultPortBusy) { t.skip('Port 18080 is already occupied; isolated foreign-listener probe cannot run.'); return; }
  const port = 19182;
  const started = run(['-Action', 'Start', ...fixtureArgs(port)], 45_000);
  assert.equal(started.status, 0, started.stderr);
  assert.equal(JSON.parse(started.stdout).ready, true);
  const ownedReady = run(['-Action', 'Status', '-StateDirectory', state]);
  assert.equal(ownedReady.status, 0, ownedReady.stderr);
  assert.equal(JSON.parse(ownedReady.stdout).ready, true);
  await fetch(`http://127.0.0.1:${port}/fixture/set-unloaded`);
  const foreign = spawn(process.execPath, [fixture, '--host', '127.0.0.1', '--port', '18080', '--fixture-loaded'], { windowsHide: true, stdio: 'ignore' });
  try {
    await waitForPort(18080);
    const status = run(['-Action', 'Status', '-StateDirectory', state]);
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).ready, false);
  } finally {
    foreign.kill();
    run(['-Action', 'Stop', '-StateDirectory', state]);
  }
});

test('Start rejects a context that the router does not report and cleans its owned child', { skip: !canRunLifecycle }, () => {
  const port = 19185;
  writeFileSync(join(root, 'models', 'context.txt'), '65536');
  const result = run(['-Action', 'Start', ...fixtureArgs(port)]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /n_ctx 65536, expected 98304/);
  assert.equal(requireAlive(Number(readFileSync(join(root, 'models', 'pid.txt'), 'utf8'))), false);
  assert.equal(requireAlive(Number(readFileSync(join(root, 'models', 'child-pid.txt'), 'utf8'))), false);
  assert.equal(existsSync(join(state, 'server.json')), false);
});

test('Stop refuses a reused PID identity and preserves its ownership metadata', { skip: !canRunLifecycle }, () => {
  mkdirSync(state, { recursive: true });
  const badRecord = { pid: process.pid, image: process.execPath, startTimeUtcTicks: 1, parentPid: process.ppid,
    port: 19183, modelId: 'synthetic-model', contextTokens: 98304, maxOutputTokens: 8192, children: [], unloadAttempted: false };
  const recordPath = join(state, 'server.json');
  writeFileSync(recordPath, JSON.stringify(badRecord));
  const result = run(['-Action', 'Stop', '-StateDirectory', state]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /router PID has been reused/);
  assert.deepEqual(JSON.parse(readFileSync(recordPath, 'utf8')), badRecord);
});

test('Start refuses a foreign listener without creating or replacing owner state', { skip: !canRunLifecycle }, async () => {
  const port = 19186;
  const foreign = spawn(process.execPath, [fixture, '--host', '127.0.0.1', '--port', String(port)], { windowsHide: true, stdio: 'ignore' });
  try {
    await waitForPort(port);
    const result = run(['-Action', 'Start', ...fixtureArgs(port)]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /already has a listener/);
    assert.equal(existsSync(join(state, 'server.json')), false);
  } finally {
    foreign.kill('SIGKILL');
    await once(foreign, 'exit');
  }
});

test('Start timeout is bounded, cleans its owned router, and leaves no state after verified exit', { skip: !canRunLifecycle }, () => {
  const port = 19184;
  writeFileSync(join(root, 'models', 'no-health.txt'), 'yes');
  const result = run(['-Action', 'Start', ...fixtureArgs(port), '-ReadyTimeoutSeconds', '1'], 15_000);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /readiness deadline/);
  assert.equal(readFileSync(join(root, 'models', 'argv.json'), 'utf8').length > 0, true);
  assert.equal(requireAlive(Number(readFileSync(join(root, 'models', 'pid.txt'), 'utf8'))), false);
  assert.equal(existsSync(join(state, 'server.json')), false);
});

test('a slow load POST is cancelled at the deadline and is never retried', { skip: !canRunLifecycle }, () => {
  const port = 19194;
  writeFileSync(join(root, 'models', 'load-delay.txt'), '5000');
  const result = run(['-Action', 'Start', ...fixtureArgs(port), '-ReadyTimeoutSeconds', '2'], 15_000);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Model load exceeded the readiness deadline/);
  assert.equal(Number(readFileSync(join(root, 'models', 'load-count.txt'), 'utf8')), 1);
  assert.equal(existsSync(join(state, 'server.json')), false);
});

test('Stop cleans an identity-verified recorded child even after router death', { skip: !canRunLifecycle }, () => {
  const port = 19187;
  const started = run(['-Action', 'Start', ...fixtureArgs(port)], 45_000);
  assert.equal(started.status, 0, `${started.stderr}\n${started.stdout}\n${started.error}`);
  const recordPath = join(state, 'server.json');
  const record = JSON.parse(readFileSync(recordPath, 'utf8'));
  const killed = assertCompleted(spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-Command', `Stop-Process -Id ${record.pid} -Force`], { windowsHide: true, encoding: 'utf8' }), 'router kill');
  assert.equal(killed.status, 0, killed.stderr);
  const result = run(['-Action', 'Stop', '-StateDirectory', state]);
  assert.equal(result.status, 0, result.stderr);
  for (const child of record.children) assert.equal(requireAlive(child.pid), false);
  assert.equal(existsSync(recordPath), false);
});

test('unload failure is a warning when all recorded processes are gone', { skip: !canRunLifecycle }, () => {
  const port = 19188;
  assert.equal(run(['-Action', 'Start', ...fixtureArgs(port)]).status, 0);
  writeFileSync(join(root, 'models', 'unload-fails.txt'), 'yes');
  const result = run(['-Action', 'Stop', '-StateDirectory', state]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(JSON.parse(result.stdout).unloadWarning, /synthetic unload failure/);
  assert.equal(existsSync(join(state, 'server.json')), false);
});

test('Stop refuses a reused child PID and preserves ownership metadata', { skip: !canRunLifecycle }, () => {
  mkdirSync(state, { recursive: true });
  const record = { pid: 999999999, image: process.execPath, startTimeUtcTicks: 1, parentPid: 999999998,
    port: 19192, modelId: 'synthetic-model', contextTokens: 98304, maxOutputTokens: 8192,
    children: [{ pid: process.pid, image: process.execPath, startTimeUtcTicks: 1, parentPid: process.ppid,
      depth: 1, parentStartTimeUtcTicks: 1 }], unloadAttempted: false };
  const recordPath = join(state, 'server.json');
  writeFileSync(recordPath, JSON.stringify(record));
  const result = run(['-Action', 'Stop', '-StateDirectory', state]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /changed identity or ancestry/);
  assert.deepEqual(JSON.parse(readFileSync(recordPath, 'utf8')), record);
});

test('Stop is safe to repeat after ownership state was finalized', { skip: !canRunLifecycle }, () => {
  const result = run(['-Action', 'Stop', '-StateDirectory', join(state, 'missing')]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).alreadyStopped, true);
});

test('Plan resolves relative paths against the PowerShell location', { skip: !canRunLifecycle }, () => {
  const modelsPath = relative(root, join(root, 'models'));
  const result = assertCompleted(spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-Command',
    `Set-Location -LiteralPath '${root.replaceAll("'", "''")}'; & '${helper.replaceAll("'", "''")}' -Action Plan -ServerPath '${process.execPath.replaceAll("'", "''")}' -ModelsDirectory '${modelsPath.replaceAll("'", "''")}' -ModelId synthetic-model -StateDirectory '${state.replaceAll("'", "''")}'`], { windowsHide: true, encoding: 'utf8' }), 'relative path Plan');
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.modelsDirectory, resolve(root, modelsPath));
});

test('Start and Stop resolve a relative StateDirectory against the same PowerShell location', { skip: !canRunLifecycle }, () => {
  const port = 19193;
  const relativeState = 'relative-state';
  const startCommand = `Set-Location -LiteralPath '${root.replaceAll("'", "''")}'; & '${helper.replaceAll("'", "''")}' -Action Start -ServerPath '${process.execPath.replaceAll("'", "''")}' -ServerArgumentPrefix '${fixture.replaceAll("'", "''")}' -ModelsDirectory 'models' -ModelId synthetic-model -Port ${port} -StateDirectory '${relativeState}'`;
  const started = assertCompleted(spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-Command', startCommand], { windowsHide: true, encoding: 'utf8', timeout: 45_000 }), 'relative path Start');
  assert.equal(started.status, 0, started.stderr);
  assert.equal(existsSync(join(root, relativeState, 'server.json')), true);
  const statusCommand = `Set-Location -LiteralPath '${root.replaceAll("'", "''")}'; & '${helper.replaceAll("'", "''")}' -Action Status -StateDirectory '${relativeState}'`;
  const status = assertCompleted(spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-Command', statusCommand], { windowsHide: true, encoding: 'utf8', timeout: 20_000 }), 'relative path Status');
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).ready, true);
  const stopCommand = `Set-Location -LiteralPath '${root.replaceAll("'", "''")}'; & '${helper.replaceAll("'", "''")}' -Action Stop -StateDirectory '${relativeState}'`;
  const stopped = assertCompleted(spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-Command', stopCommand], { windowsHide: true, encoding: 'utf8' }), 'relative path Stop');
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.equal(JSON.parse(stopped.stdout).stopped, true);
});

test('fast startup failure captures stderr and removes the failed router', { skip: !canRunLifecycle }, () => {
  const port = 19189;
  const args = fixtureArgs(port);
  args[args.indexOf(fixture)] = join(root, 'missing-server-script.mjs');
  const result = run(['-Action', 'Start', ...args]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing-server-script|Cannot find module/i);
  const stderrLog = readdirSync(state).find((name) => name.endsWith('.stderr.log'));
  assert.ok(stderrLog);
  assert.match(readFileSync(join(state, stderrLog), 'utf8'), /missing-server-script|Cannot find module/i);
  assert.equal(existsSync(join(state, 'server.json')), false);
});

test('immediate router exit returns its diagnostic and cleans a child holding log files', { skip: !canRunLifecycle }, () => {
  const port = 19199;
  const args = fixtureArgs(port);
  const env = { ...process.env, FIXTURE_EXIT_WITH_LOG_HOLDER: '1' };
  const result = run(['-Action', 'Start', ...args], 10_000, env);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /fixture exited during startup/);
  const routerPid = Number(readFileSync(join(root, 'models', 'pid.txt'), 'utf8'));
  const childPid = Number(readFileSync(join(root, 'models', 'child-pid.txt'), 'utf8'));
  assert.equal(requireAlive(routerPid), false, 'failed router exited');
  assert.equal(requireAlive(childPid), false, 'log-file holder child was cleaned up');
  assert.equal(portIsListening(port), false);
  assert.equal(existsSync(join(state, 'server.json')), false);
});

test('Plan reports live, stale, and invalid ownership records', { skip: !canRunLifecycle }, () => {
  const args = ['-Action', 'Plan', ...fixtureArgs(19190)];
  assert.equal(JSON.parse(run(args).stdout).existingRecord, 'none');
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, 'server.json'), JSON.stringify({ pid: process.pid, image: process.execPath,
    startTimeUtcTicks: 1, parentPid: process.ppid, children: [] }));
  assert.equal(JSON.parse(run(args).stdout).existingRecord, 'stale-or-changed-refuse');
  writeFileSync(join(state, 'server.json'), '{');
  assert.equal(JSON.parse(run(args).stdout).existingRecord, 'invalid-refuse');
});

test('failed load status object aborts promptly and cleans its model child', { skip: !canRunLifecycle }, () => {
  const port = 19191;
  writeFileSync(join(root, 'models', 'load-fails.txt'), 'yes');
  const result = run(['-Action', 'Start', ...fixtureArgs(port), '-ReadyTimeoutSeconds', '30']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /model load failed/);
  assert.equal(requireAlive(Number(readFileSync(join(root, 'models', 'child-pid.txt'), 'utf8'))), false);
  assert.equal(existsSync(join(state, 'server.json')), false);
});

test('minimum free RAM guard aborts and cleans the owned router', { skip: !canRunLifecycle }, () => {
  const port = 19196;
  const result = run(['-Action', 'Start', ...fixtureArgs(port), '-MinFreeRamMiB', '1048576']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /below MinFreeRamMiB/);
  assert.equal(portIsListening(port), false, 'the owned router listener is gone after the memory guard abort');
  assert.equal(existsSync(join(state, 'server.json')), false);
});

test('optional NVIDIA guard uses the documented query and aborts below its floor', { skip: !canRunLifecycle }, () => {
  const port = 19195;
  const argsFile = join(root, 'nvidia-smi-args.txt');
  const fakeNvidiaSmi = join(root, 'nvidia-smi.cmd');
  writeFileSync(fakeNvidiaSmi, `@echo off\r\necho %* > "${argsFile}"\r\necho 999\r\n`);
  const env = { ...process.env, PATH: `${root};${process.env.PATH}` };
  const result = run(['-Action', 'Start', ...fixtureArgs(port), '-MinFreeGpuMiB', '1000'], 20_000, env);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /below MinFreeGpuMiB 1000/);
  assert.equal(readFileSync(argsFile, 'utf8').trim(), '--query-gpu=memory.free --format=csv,noheader,nounits');
  assert.equal(existsSync(join(root, 'models', 'load-count.txt')), false, 'GPU guard aborts before the load POST');
  assert.equal(portIsListening(port), false);
  assert.equal(existsSync(join(state, 'server.json')), false);
});

test('GPU floor breach during the single load POST cancels it and stops the owned tree', { skip: !canRunLifecycle }, () => {
  const port = 19198;
  writeFileSync(join(root, 'models', 'load-delay.txt'), '30000');
  const argsFile = join(root, 'nvidia-smi-args.txt');
  const countFile = join(root, 'nvidia-smi-count.txt');
  const fakeNvidiaSmi = join(root, 'nvidia-smi.cmd');
  writeFileSync(fakeNvidiaSmi, `@echo off\r\nsetlocal EnableDelayedExpansion\r\necho %* > "${argsFile}"\r\nset /a count=0\r\nif exist "${countFile}" set /p count=<"${countFile}"\r\nset /a count+=1\r\necho !count!>"${countFile}"\r\nif !count! GEQ 3 (echo 500) else (echo 9000)\r\n`);
  const env = { ...process.env, PATH: `${root};${process.env.PATH}` };
  const result = run(['-Action', 'Start', ...fixtureArgs(port), '-MinFreeGpuMiB', '1000', '-ReadyTimeoutSeconds', '60'], 15_000, env);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /below MinFreeGpuMiB 1000/);
  assert.equal(readFileSync(argsFile, 'utf8').trim(), '--query-gpu=memory.free --format=csv,noheader,nounits');
  assert.ok(Number(readFileSync(countFile, 'utf8')) >= 3, 'GPU was sampled during the active load POST');
  assert.equal(Number(readFileSync(join(root, 'models', 'load-count.txt'), 'utf8')), 1, 'one load POST was issued');
  assert.equal(Number(readFileSync(join(root, 'models', 'load-abort-count.txt'), 'utf8')), 1, 'the in-flight POST was cancelled');
  assert.equal(requireAlive(Number(readFileSync(join(root, 'models', 'pid.txt'), 'utf8'))), false, 'owned router exited');
  assert.equal(requireAlive(Number(readFileSync(join(root, 'models', 'child-pid.txt'), 'utf8'))), false, 'owned model child exited');
  assert.equal(portIsListening(port), false, 'owned router listener is gone');
  assert.equal(existsSync(join(state, 'server.json')), false, 'ownership record was finalized');
});

function requireAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function timeoutAfter(timeoutMs, message) {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref();
  });
}

function portIsListening(port) {
  const result = assertCompleted(spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-Command',
    `if (Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }`], { windowsHide: true, encoding: 'utf8' }), `listener check for ${port}`);
  return result.status === 0;
}

async function waitForPort(port) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try { await fetch(`http://127.0.0.1:${port}/health`); return; } catch { await new Promise((resolvePromise) => setTimeout(resolvePromise, 50)); }
  }
  throw new Error(`Fixture did not listen on ${port}`);
}
