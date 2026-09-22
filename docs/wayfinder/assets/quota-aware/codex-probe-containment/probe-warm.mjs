// Warm server: how much of the cost is spawn vs the network read?
import { spawn } from 'node:child_process';
const child = spawn('codex', ['app-server', '--listen', 'stdio://'], { stdio: ['pipe','pipe','pipe'] });
const pending = new Map();
let buf = '';
child.stdout.on('data', d => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  }
});
let id = 0;
const call = (method, params) => new Promise(res => {
  const myId = ++id; pending.set(myId, res);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
});
await call('initialize', { clientInfo: { name: 'fleet-probe', version: '0.0.0' } });
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }) + '\n');
const times = [];
for (let i = 0; i < 6; i++) {
  const t = process.hrtime.bigint();
  const r = await call('account/rateLimits/read', null);
  times.push(Number(process.hrtime.bigint() - t) / 1e6);
  if (r.error) console.log('ERR', r.error);
}
console.log('warm read ms:', times.map(t => t.toFixed(1)).join(', '));
child.kill('SIGTERM');
