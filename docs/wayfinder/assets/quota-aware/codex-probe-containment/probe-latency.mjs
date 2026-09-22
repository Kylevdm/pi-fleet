// Prototype: measure spawn -> account/rateLimits/read -> exit for a throwaway codex app-server.
import { spawn } from 'node:child_process';

const RUNS = Number(process.argv[2] ?? 5);

function once() {
  return new Promise((resolve) => {
    const marks = {};
    const t0 = process.hrtime.bigint();
    const ms = () => Number(process.hrtime.bigint() - t0) / 1e6;

    const child = spawn('codex', ['app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    marks.spawned = ms();
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));

    let buf = '';
    let phase = 'init';
    let result = null;
    let err = null;

    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1 && phase === 'init') {
          marks.initialized = ms();
          phase = 'probe';
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'initialized' }).replace(/$/, '\n'));
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'account/rateLimits/read', params: null }) + '\n');
          marks.probeSent = ms();
        } else if (msg.id === 3) {
          marks.probeAnswered = ms();
          if (msg.error) err = msg.error; else result = msg.result;
          child.kill('SIGTERM');
        }
      }
    });

    child.on('exit', (code, signal) => {
      marks.exited = ms();
      resolve({ marks, result, err, code, signal, stderr: stderr.slice(0, 400), pid: child.pid });
    });

    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { clientInfo: { name: 'fleet-probe', version: '0.0.0' } },
    }) + '\n');
    marks.initSent = ms();

    setTimeout(() => { if (child.exitCode === null) { child.kill('SIGKILL'); } }, 30000);
  });
}

const rows = [];
for (let i = 0; i < RUNS; i++) rows.push(await once());
console.log(JSON.stringify(rows, null, 2));
