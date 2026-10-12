import { spawn } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import { join } from 'node:path';

export const CHILD_TIMEOUT_MS = 30 * 1000;
// After a child exits, its stdio may stay open through a grandchild. The wrapper
// waits this long for a normal close, then destroys the pipes and reports the exit.
const EXIT_GRACE_MS = 1000;
const MAX_CAPTURE_BYTES = 1024 * 1024;
export const NO_SIGNALS = Object.freeze({ forward: [], absorb: [] });
const POSIX_SIGNAL_PLANS = Object.freeze({
  retrieval: Object.freeze({ forward: ['SIGINT', 'SIGTERM', 'SIGHUP'], absorb: [] }),
  // The terminal already sends SIGINT to the target's process group, so SIGINT
  // is absorbed here: the wrapper keeps waiting for the target to clean up.
  target: Object.freeze({ forward: ['SIGTERM', 'SIGHUP'], absorb: ['SIGINT'] }),
});

// Signals the wrapper listens for while a child runs. Windows registers none:
// child.kill() there is TerminateProcess, which skips the target's cleanup, and
// the console already delivers Ctrl+C to the foreground child.
export function signalPlan(platform, phase) {
  return platform === 'win32' ? NO_SIGNALS : POSIX_SIGNAL_PLANS[phase];
}

// Shell convention: a process killed by signal n reports 128 + n.
export function signalStatus(signal) {
  const number = osConstants.signals[signal];
  return number === undefined ? 1 : 128 + number;
}

// The command that ends a Windows process tree, or null on POSIX. It names the
// system copy of taskkill, so a taskkill planted in the working folder never runs.
export function treeKillCommand(platform, pid) {
  if (platform !== 'win32' || pid === undefined) return null;
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
  return { file: join(systemRoot, 'System32', 'taskkill.exe'), args: ['/T', '/F', '/PID', String(pid)] };
}

// Signals the child, or on POSIX its whole process group when it leads one.
function signalChild(child, signal, grouped) {
  if (grouped) {
    try { process.kill(-child.pid, signal); return; } catch { /* Not a group leader any more; fall back to the child. */ }
  }
  try { child.kill(signal); } catch { /* The child may already have exited. */ }
}

// Forwards each planned signal to the child and records the last one forwarded,
// so a retrieval that the human interrupted reports the signal's status.
function registerSignals(child, plan, onForward, grouped) {
  const forward = (signal) => {
    onForward(signal);
    signalChild(child, signal, grouped);
  };
  const absorb = () => {};
  const listeners = [
    ...plan.forward.map((signal) => [signal, forward]),
    ...plan.absorb.map((signal) => [signal, absorb]),
  ];
  for (const [signal, listener] of listeners) process.on(signal, listener);
  return () => { for (const [signal, listener] of listeners) process.removeListener(signal, listener); };
}

// Ends the child and its descendants. Resolves when the Windows kill command has finished.
function killTree(child, platform, grouped) {
  const command = treeKillCommand(platform, child.pid);
  if (!command) {
    signalChild(child, 'SIGKILL', grouped);
    return Promise.resolve();
  }
  return new Promise((resolvePromise) => {
    try {
      // windowsHide is repeated as a literal here because the repo subprocess rule reads the call site.
      const killer = spawn(command.file, command.args, { stdio: 'ignore', windowsHide: true });
      killer.on('error', () => resolvePromise());
      killer.on('close', () => resolvePromise());
    } catch {
      resolvePromise();
    }
  });
}

// The one place that builds child spawn options. windowsHide keeps a console
// window from opening for a console CLI started by a GUI-hosted process. shell
// stays off, so arguments are never parsed by a shell. A detached child leads its
// own process group on POSIX, so a kill can reach its grandchildren.
export function childSpawnOptions({ env, cwd, capture, detached = false }) {
  return { shell: false, windowsHide: true, detached, env, cwd, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' };
}

// Resolves once the child has exited and its output is settled. A child that
// exceeds timeoutMs has its tree killed and is reported as timedOut; an
// interrupted one reports the signal in `interrupted`. Pass group for a CLI child.
export function runChild(file, args, env, { capture = false, plan = NO_SIGNALS, cwd, timeoutMs = Infinity, platform = process.platform, group = false, exitGraceMs = EXIT_GRACE_MS } = {}) {
  return new Promise((resolvePromise) => {
    const grouped = group && platform !== 'win32';
    let child;
    try {
      child = spawn(file, args, { ...childSpawnOptions({ env, cwd, capture, detached: grouped }), windowsHide: true });
    } catch {
      resolvePromise({ status: 127, error: true, spawnFailed: true, overflowed: false, timedOut: false, interrupted: null, stdout: '', stderr: '' });
      return;
    }
    const stdout = [];
    const stderr = [];
    let capturedBytes = 0;
    let spawnFailed = false;
    let overflowed = false;
    let timedOut = false;
    let interrupted = null;
    let finished = false;
    let pendingKill = Promise.resolve();
    let timer = null;
    let graceTimer = null;
    const unregister = registerSignals(child, plan, (signal) => { interrupted = signal; }, grouped);
    const finish = async (code, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      unregister();
      await pendingKill;
      if (capture) {
        child.stdout?.destroy();
        child.stderr?.destroy();
      }
      resolvePromise({
        status: spawnFailed ? 127 : overflowed ? 1 : code ?? signalStatus(signal),
        error: spawnFailed || overflowed,
        spawnFailed,
        overflowed,
        timedOut,
        interrupted,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    };
    if (Number.isFinite(timeoutMs)) {
      timer = setTimeout(() => {
        timedOut = true;
        pendingKill = killTree(child, platform, grouped);
      }, timeoutMs);
    }
    child.on('error', () => {
      spawnFailed = true;
      if (child.pid === undefined) finish(null, null);
    });
    if (capture) {
      const collect = (target, chunk) => {
        capturedBytes += chunk.length;
        if (capturedBytes > MAX_CAPTURE_BYTES) {
          overflowed = true;
          pendingKill = killTree(child, platform, grouped);
          return;
        }
        target.push(chunk);
      };
      child.stdout.on('data', (chunk) => collect(stdout, chunk));
      child.stderr.on('data', (chunk) => collect(stderr, chunk));
    }
    // A grandchild that inherited the pipes can hold 'close' open after the child
    // exits, so the exit starts a short grace period instead of waiting forever.
    child.on('exit', (code, signal) => {
      graceTimer = setTimeout(() => finish(code, signal), exitGraceMs);
    });
    child.on('close', (code, signal) => finish(code, signal));
  });
}
