import { Codex } from '@openai/codex-sdk';
import { writeFileSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const SP = process.env.SP;
const PID_FILE = `${SP}/fleet.pid`;
const SCOPE = `fleet-probe-${process.pid}.scope`;
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
  codexPathOverride: `${SP}/shimdir/codex-scope`,
  env: { ...process.env, FLEET_PID_FILE: PID_FILE, FLEET_SCOPE: SCOPE },
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
      const cgPath = `/sys/fs/cgroup/user.slice/user-${process.getuid()}.slice/user@${process.getuid()}.service/app.slice/${SCOPE}/cgroup.procs`;
      const inScope = () => { try { const p = readFileSync(cgPath, 'utf8').trim(); return p ? p.split('\n').length + ' procs: ' + p.split('\n').join(',') : '0 procs'; } catch { return 'cgroup gone'; } };
      console.log('tasks in scope before abort:', inScope());
      ac.abort();
      await new Promise(r => setTimeout(r, 1000));
      console.log('tasks in scope after SDK abort:', inScope());
      try { execSync(`systemctl --user kill --signal=SIGTERM ${SCOPE}`); console.log('scope SIGTERM sent'); } catch (e) { console.log('scope SIGTERM:', String(e).slice(0,120)); }
      await new Promise(r => setTimeout(r, 1500));
      console.log('tasks in scope after SIGTERM:', inScope());
      try { execSync(`systemctl --user kill --signal=SIGKILL ${SCOPE}`); console.log('scope SIGKILL sent'); } catch (e) { console.log('scope SIGKILL:', String(e).slice(0,120)); }
      await new Promise(r => setTimeout(r, 1000));
      console.log('tasks in scope after SIGKILL:', inScope());
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
