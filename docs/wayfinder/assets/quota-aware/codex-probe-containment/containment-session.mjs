import { Codex } from '@openai/codex-sdk';
import { writeFileSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const SP = process.env.SP;
const PID_FILE = `${SP}/fleet.pid`;
writeFileSync(PID_FILE, '');

const tree = (pid) => {
  try { return execSync(`ps -eo pid,ppid,pgid,stat,comm,args --no-headers | awk '$1==${pid}||$2==${pid}'`).toString().trim(); }
  catch { return ''; }
};
const descendants = (root) => {
  const out = [];
  const all = execSync('ps -eo pid,ppid,pgid,sid,args --no-headers').toString().trim().split('\n')
    .map(l => { const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/); return m && { pid: +m[1], ppid: +m[2], pgid: +m[3], sid: +m[4], args: m[5] }; }).filter(Boolean);
  const walk = (p) => { for (const r of all) if (r.ppid === p) { out.push(r); walk(r.pid); } };
  walk(root);
  return out;
};
const sidOf = (pid) => { try { return Number(execSync(`ps -o sid= -p ${pid}`).toString().trim()); } catch { return null; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

const codex = new Codex({
  codexPathOverride: `${SP}/shimdir/codex-setsid`,
  env: { ...process.env, FLEET_PID_FILE: PID_FILE },
});
const thread = codex.startThread({
  sandboxMode: 'danger-full-access',
  approvalPolicy: 'never',
  workingDirectory: `${SP}/work`,
  skipGitRepoCheck: true,
});

const ac = new AbortController();
const events = [];
let aborted = false;

const run = (async () => {
  const streamed = await thread.runStreamed(
    'Run exactly this shell command and nothing else: `sleep 400 & sleep 400`. Do not explain, do not stop it.',
    { signal: ac.signal },
  );
  for await (const ev of streamed.events) {
    events.push(ev.type + (ev.item?.type ? ':' + ev.item.type : ''));
    if (!aborted && ev.type === 'item.started' && ev.item?.type === 'command_execution') {
      aborted = true;
      const shimPid = Number(readFileSync(PID_FILE, 'utf8').trim().split('\n')[0]);
      await new Promise(r => setTimeout(r, 2500));
      const before = descendants(shimPid);
      console.log('SHIM PID (as Fleet would record it):', shimPid, 'alive:', alive(shimPid));
      console.log('--- descendants BEFORE abort ---');
      console.log(before.map(d => `  pid ${d.pid} ppid ${d.ppid} pgid ${d.pgid} sid ${d.sid}  ${d.args.slice(0, 60)}`).join('\n'));
      console.log('--- calling AbortController.abort() ---');
      console.log('distinct pgids in tree:', [...new Set(before.map(d => d.pgid))].join(', '), '| distinct sids:', [...new Set(before.map(d => d.sid))].join(', '), '| shim sid:', sidOf(shimPid));
      ac.abort();
      // Fleet's termination ladder, steps 2 and 3: sweep the SESSION.
      const sid = sidOf(shimPid);
      const sweep = (sig) => {
        const rows = execSync('ps -eo pid,sid --no-headers').toString().trim().split('\n')
          .map(l => l.trim().split(/\s+/).map(Number)).filter(([pid, s]) => s === sid && pid !== process.pid);
        for (const [pid] of rows) { try { process.kill(pid, sig); } catch {} }
        return rows.length;
      };
      await new Promise(r => setTimeout(r, 1000));
      console.log('session SIGTERM sent to', sweep('SIGTERM'), 'processes');
      await new Promise(r => setTimeout(r, 1000));
      const left = sweep('SIGKILL');
      console.log(left ? `session SIGKILL sent to ${left} survivors` : 'SIGTERM sweep cleared the session; no SIGKILL needed');
      global.__before = before;
      global.__shimPid = shimPid;
    }
  }
})().catch(e => console.log('run rejected:', String(e).slice(0, 200)));

await run;
await new Promise(r => setTimeout(r, 2000));
const shimPid = global.__shimPid;
console.log('\n--- AFTER abort (+2s) ---');
console.log('recorded pid alive:', alive(shimPid));
const survivors = (global.__before ?? []).filter(d => alive(d.pid));
console.log('survivors from the pre-abort tree:', survivors.length);
for (const s of survivors) console.log(`  ORPHAN ${s.pid} (was child of ${s.ppid}) ${s.args.slice(0, 70)}`);
console.log('stray sleeps anywhere:', execSync("ps -eo pid,ppid,args --no-headers | grep 'sleep 400' | grep -v grep || true").toString().trim() || '(none)');
console.log('events:', events.join(', '));
