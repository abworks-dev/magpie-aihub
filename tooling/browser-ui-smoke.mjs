import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';

// Windows Edge fixture: no real Magpie/AIHub credentials or inference traffic.
// The UI is unchanged; only the local bridge and click driver are fixture code.
const root = process.cwd();
const browser = process.env.MAGPIE_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = path.join(root, '.local-validation', 'browser-ui', randomUUID());
await mkdir(profile, { recursive: true });
const files = new Map(await Promise.all(['index.html', 'app.js', 'style.css'].map(async name => [name, await readFile(path.join(root, 'ui', name), 'utf8')])));
let done;
const result = new Promise(resolve => { done = resolve; });
const bridge = `(() => {
  let options = { maxMultiplier: 0.16, models: [{id: 'offline-model', api: 'chat'}] };
  window.magpie = { ready: Promise.resolve({}), read: async () => [], options: {
    get: async () => options,
    set: async value => { options = value; parent.postMessage({fixture: 'saved', multiplier: value.maxMultiplier, models: value.models.length}, '*'); }
  }};
})();`;
const driver = `void (async () => {
  for (let i = 0; i < 100 && document.getElementById('controls').disabled; i++) await new Promise(r => setTimeout(r, 20));
  document.getElementById('maxMultiplier').value = '0.15';
  document.getElementById('maxMultiplier').dispatchEvent(new Event('input', {bubbles: true}));
  document.getElementById('save-button').click();
  await new Promise(r => setTimeout(r, 350));
  parent.postMessage({fixture: 'finished', text: document.getElementById('status').textContent, disabled: document.getElementById('controls').disabled}, '*');
})();`;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/result' && req.method === 'POST') {
    let text = ''; for await (const chunk of req) { text += chunk; if (text.length > 8192) { res.writeHead(413).end(); return; } }
    try { done(JSON.parse(text)); res.writeHead(204).end(); } catch { res.writeHead(400).end(); }
    return;
  }
  if (url.pathname === '/') {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><iframe id="frame" sandbox="allow-scripts" src="/plugin/index.html"></iframe><script>
let saves = 0, last;
window.addEventListener('message', event => {
  if (event.source !== document.getElementById('frame').contentWindow) return;
  const data = event.data;
  if (data?.fixture === 'saved') { saves++; last = data; }
  if (data?.fixture === 'finished') fetch('/result', {method: 'POST', body: JSON.stringify({saves, last, ...data})});
});</script>`); return;
  }
  const base = `http://127.0.0.1:${server.address().port}/plugin/`;
  res.setHeader('Content-Security-Policy', `sandbox allow-scripts; default-src 'none'; script-src ${base}; style-src ${base} 'unsafe-inline'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  const name = url.pathname.replace(/^\/plugin\//, '');
  if (name === '_magpie/bridge.js' || name === 'fixture-driver.js') {
    res.setHeader('content-type', 'text/javascript; charset=utf-8'); res.end(name === 'fixture-driver.js' ? driver : bridge); return;
  }
  if (files.has(name)) {
    res.setHeader('content-type', name.endsWith('.html') ? 'text/html; charset=utf-8' : name.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8');
    let text = files.get(name);
    if (name === 'index.html') text = text.replace('</head>', '<script src="fixture-driver.js" defer></script></head>');
    res.end(text); return;
  }
  res.writeHead(404).end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const child = spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', '--disable-component-update', `--user-data-dir=${profile}`, `http://127.0.0.1:${server.address().port}/`], { stdio: 'ignore' });
child.on('error', error => done({ error: error.message }));
let timer;
try {
  const report = await Promise.race([result, new Promise(resolve => { timer = setTimeout(() => resolve({error: 'Browser fixture timed out'}), 20000); })]);
  console.log(JSON.stringify(report));
  if (report.saves !== 1 || report.last?.multiplier !== 0.15 || report.last?.models !== 1 || report.disabled || !report.text?.includes('设置已保存')) process.exitCode = 1;
} finally {
  clearTimeout(timer);
  if (child.pid) {
    const kill = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    await once(kill, 'exit');
  }
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
