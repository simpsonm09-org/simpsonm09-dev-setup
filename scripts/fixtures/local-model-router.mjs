import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import http from 'node:http';

const args = process.argv.slice(2);
const valueAfter = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index < 0 ? fallback : args[index + 1];
};
const port = Number(valueAfter('--port', '18080'));
const modelDirectory = valueAfter('--models-dir', '');
if (modelDirectory) writeFileSync(join(modelDirectory, 'argv.json'), JSON.stringify(args));
if (modelDirectory) writeFileSync(join(modelDirectory, 'pid.txt'), String(process.pid));
let loaded = args.includes('--fixture-loaded');
let child;

if (modelDirectory) {
  process.stdout.on('error', (error) => {
    if (error.code === 'EPIPE') writeFileSync(join(modelDirectory, 'stdout-epipe.txt'), 'EPIPE');
  });
  setInterval(() => process.stdout.write(`fixture tick ${Date.now()}\n`), 300).unref();
}

if (process.env.FIXTURE_SPAWN_CHILD_ON_BOOT === '1' && modelDirectory) {
  const orphan = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, windowsHide: true, stdio: 'ignore' });
  orphan.unref();
  writeFileSync(join(modelDirectory, 'child-pid.txt'), String(orphan.pid));
  if (process.env.FIXTURE_SPAWN_CHILD_THEN_EXIT === '1') process.exit(17);
}

const server = http.createServer((request, response) => {
  if (request.url === '/health' && modelDirectory && existsSync(join(modelDirectory, 'no-health.txt'))) {
    response.writeHead(503).end('not ready');
    return;
  }
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
    return;
  }
  if (request.url?.startsWith('/models?')) {
    const requested = new URL(request.url, 'http://127.0.0.1').searchParams.get('model');
    if (requested !== 'synthetic-model') { response.writeHead(400).end('model query required'); return; }
    const failed = modelDirectory && existsSync(join(modelDirectory, 'load-fails.txt'));
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'synthetic-model', status: { value: loaded ? 'loaded' : 'unloaded' }, failed: Boolean(failed) }] }));
    return;
  }
  if (request.url?.startsWith('/props')) {
    let context = 98304;
    try { context = Number(readFileSync(join(modelDirectory, 'context.txt'), 'utf8')); } catch {}
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ default_generation_settings: { n_ctx: context } }));
    return;
  }
  if (request.url === '/models/load' || request.url === '/models/unload') {
    if (request.url === '/models/load' && modelDirectory) {
      const recordLoadCancellation = () => {
        let count = 0;
        try { count = Number(readFileSync(join(modelDirectory, 'load-abort-count.txt'), 'utf8')); } catch {}
        writeFileSync(join(modelDirectory, 'load-abort-count.txt'), String(count + 1));
      };
      request.on('aborted', recordLoadCancellation);
      response.on('close', () => { if (!response.writableEnded) recordLoadCancellation(); });
    }
    request.resume();
    if (request.url.endsWith('/unload') && modelDirectory && existsSync(join(modelDirectory, 'unload-fails.txt'))) {
      response.writeHead(503).end('synthetic unload failure');
      return;
    }
    loaded = request.url.endsWith('/load');
    if (loaded && modelDirectory) {
      let count = 0;
      try { count = Number(readFileSync(join(modelDirectory, 'load-count.txt'), 'utf8')); } catch {}
      writeFileSync(join(modelDirectory, 'load-count.txt'), String(count + 1));
    }
    if (!loaded && modelDirectory) {
      let count = 0;
      try { count = Number(readFileSync(join(modelDirectory, 'unload-count.txt'), 'utf8')); } catch {}
      writeFileSync(join(modelDirectory, 'unload-count.txt'), String(count + 1));
    }
    if (loaded && !child) {
      child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, windowsHide: true, stdio: 'ignore' });
      child.unref();
      if (modelDirectory) writeFileSync(join(modelDirectory, 'child-pid.txt'), String(child.pid));
    }
    // Keep the model child alive after unload. The helper must discover and stop its owned process.
    const sendResponse = () => response.writeHead(200, { 'content-type': 'application/json' }).end('{"success":true}');
    if (loaded && modelDirectory && existsSync(join(modelDirectory, 'load-delay.txt'))) {
      setTimeout(sendResponse, Number(readFileSync(join(modelDirectory, 'load-delay.txt'), 'utf8')));
    } else sendResponse();
    return;
  }
  if (request.url === '/fixture/set-loaded') {
    loaded = true;
    response.writeHead(200).end('ok');
    return;
  }
  if (request.url === '/fixture/set-unloaded') {
    loaded = false;
    response.writeHead(200).end('ok');
    return;
  }
  response.writeHead(404).end('not found');
});

if (process.env.FIXTURE_EXIT_WITH_LOG_HOLDER === '1') {
  console.error('fixture exited during startup');
  child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, windowsHide: true, stdio: 'inherit' });
  child.unref();
  if (modelDirectory) writeFileSync(join(modelDirectory, 'child-pid.txt'), String(child.pid));
  setTimeout(() => process.exit(1), 750);
} else server.listen(port, '127.0.0.1');
