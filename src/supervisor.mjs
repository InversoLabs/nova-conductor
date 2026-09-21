// Each worker/test has a tiny independent guardian. If Director is killed rather
// than stopped, the guardian kills its own process tree before the next resume.
import { spawn } from 'node:child_process';
import { killTree } from './runtime.mjs';
const owner = Number(process.argv[2]);
let input = '';
for await (const chunk of process.stdin) input += chunk;
const { command, args, cwd } = JSON.parse(input);
const child = spawn(command, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
const stop = () => {
  if (process.platform === 'win32') killTree(child);
  else { try { process.kill(-process.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
};
process.on('SIGTERM', stop); process.on('SIGINT', stop);
const timer = setInterval(() => {
  try { process.kill(owner, 0); } catch (error) { if (error.code !== 'EPERM') stop(); }
}, 500);
child.once('error', error => { console.error(error.message); clearInterval(timer); process.exitCode = 1; });
child.once('close', code => { clearInterval(timer); process.exitCode = code ?? 1; });
