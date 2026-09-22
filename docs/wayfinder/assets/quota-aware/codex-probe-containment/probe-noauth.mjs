import { spawn } from 'node:child_process';
const home = process.argv[2];
const child = spawn('codex', ['app-server'], { stdio: ['pipe','pipe','pipe'], env: { ...process.env, CODEX_HOME: home } });
let buf=''; let stderr='';
child.stderr.on('data', d => stderr += d);
child.stdout.on('data', d => { buf += d; let i;
  while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0,i).trim(); buf = buf.slice(i+1); if(!l) return;
    let m; try { m = JSON.parse(l); } catch { continue; }
    if (m.id === 1) { child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'initialized'})+'\n');
      child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:3,method:'account/rateLimits/read',params:null})+'\n'); }
    else if (m.id === 3) { console.log('rateLimits/read with CODEX_HOME=' + home + ':');
      console.log(JSON.stringify(m.error ?? m.result, null, 1).slice(0, 900)); child.kill('SIGTERM'); }
  }});
child.on('exit', (c,s) => { console.log('exit', c, s, '| stderr:', stderr.slice(0,200)); });
child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{clientInfo:{name:'fleet-probe',version:'0'}}})+'\n');
setTimeout(()=>child.kill('SIGKILL'), 20000);
