import { Codex } from '@openai/codex-sdk';
const SP = process.env.SP;
const codex = new Codex({ env: { ...process.env, CODEX_HOME: `${SP}/emptyhome` } });
const t = codex.startThread({ sandboxMode: 'read-only', approvalPolicy: 'never', workingDirectory: `${SP}/work`, skipGitRepoCheck: true });
try {
  const s = await t.runStreamed('say hi');
  for await (const ev of s.events) console.log('EVENT', JSON.stringify(ev).slice(0, 400));
} catch (e) { console.log('THROWN:', String(e).slice(0, 500)); }
