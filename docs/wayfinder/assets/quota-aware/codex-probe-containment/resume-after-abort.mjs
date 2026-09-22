// Is a thread aborted mid-tool-call safely resumable?
import { Codex } from '@openai/codex-sdk';
const SP = process.env.SP;
const codex = new Codex({ codexPathOverride: `${SP}/shimdir/codex-scope`,
  env: { ...process.env, FLEET_PID_FILE: `${SP}/r.pid`, FLEET_SCOPE_PREFIX: `fleet-resume` } });
const t = codex.startThread({ sandboxMode: 'workspace-write', approvalPolicy: 'never',
  workingDirectory: `${SP}/work`, skipGitRepoCheck: true });
const ac = new AbortController();
let aborted = false;
try {
  const s = await t.runStreamed('Run this shell command: `sleep 45`. Then say DONE.', { signal: ac.signal });
  for await (const ev of s.events) {
    if (!aborted && ev.type === 'item.started' && ev.item?.type === 'command_execution') {
      aborted = true; console.log('thread id at abort:', t.id);
      setTimeout(() => ac.abort(), 1500);
    }
  }
} catch (e) { console.log('turn 1 ended:', String(e).slice(0, 120)); }
const id = t.id;
console.log('thread id after abort:', id);
if (!id) { console.log('NO THREAD ID -> not resumable'); process.exit(0); }
const t2 = codex.resumeThread(id, { sandboxMode: 'workspace-write', approvalPolicy: 'never',
  workingDirectory: `${SP}/work`, skipGitRepoCheck: true });
try {
  const r = await t2.run('What shell command did you just run? Answer in one short line.');
  console.log('RESUMED OK. items:', r.items.map(i => i.type).join(','));
  console.log('final:', r.finalResponse.slice(0, 200));
  console.log('usage:', JSON.stringify(r.usage));
} catch (e) { console.log('RESUME FAILED:', String(e).slice(0, 300)); }
