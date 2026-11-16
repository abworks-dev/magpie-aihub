import http from 'node:http';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { startMonitor } from '../src/monitor.mjs';

// Actual browser + service implementation, synthetic snapshot. Proxy mirrors Magpie's
// Host rewrite, Origin:null/CORS and full-prefix CSP expansion; never calls AIHub.
const profile = path.join(process.cwd(), '.local-validation', 'browser-monitor', randomUUID());
await mkdir(profile, { recursive: true });
let reads = 0;
const backend = await startMonitor({ port: 0, getSnapshot: async () => {
  reads++;
  return { schemaVersion: 1, generatedAt: Date.now(), accounts: [{
    label: 'PRIVATE@example.invalid', mode: 'managed', sourceUpdatedAt: Date.now(), stale: false,
    groups: [{ groupId: 7, name: 'Fixture group', platform: 'openai', multiplier: 0.08, available: true, passed: true, latency: 250,
      metrics: { successRate: 0.99, cacheHitRate: 0.5, tps: 42, realPrice: null }, models: ['exact-fixture'], eligible: true, reasons: [], hasKey: true, selectedCount: 1 }],
    routes: [{ platform: 'openai', model: 'exact-fixture', groupId: 7, at: Date.now(), outcome: 'selected' }], keyState: { ready: 1, pending: 0, autoCreateKeys: false },
  }] };
} });
const prefix = '/_magpie/plugin/00000000000000000000000000000000/_magpie/service/';
let finish;
const result = new Promise(resolve => { finish = resolve; });
const driver = `void (async () => {
  for(let i=0;i<100 && document.getElementById('groups').children.length===0;i++) await new Promise(r=>setTimeout(r,50));
  parent.postMessage({fixture:'monitor', rows:document.getElementById('groups').children.length,
    tabs:document.getElementById('platforms').children.length,
    text:document.body.textContent, error:!document.getElementById('failure').hidden}, '*');
})();`;
const proxy = http.createServer(async (req, res) => {
  if (req.url === '/result' && req.method === 'POST') {
    let text = ''; for await(const chunk of req) { text += chunk; if(text.length > 20000) return res.writeHead(413).end(); }
    try { finish(JSON.parse(text)); res.writeHead(204).end(); } catch { res.writeHead(400).end(); } return;
  }
  if (req.url === '/') {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><iframe id="p" sandbox="allow-scripts" src="${prefix}"></iframe><script>
      addEventListener('message', e=>{if(e.source!==document.getElementById('p').contentWindow||e.data?.fixture!=='monitor')return;
      fetch('/result',{method:'POST',body:JSON.stringify(e.data)});});</script>`); return;
  }
  if (!req.url?.startsWith(prefix)) return res.writeHead(404).end();
  const own = `http://127.0.0.1:${proxy.address().port}${prefix}`;
  if (req.url === `${prefix}fixture.js`) {
    res.setHeader('Content-Type', 'text/javascript'); res.end(driver); return;
  }
  try {
    const headers = { ...req.headers, host: `127.0.0.1:${backend.address().port}` }; delete headers.cookie;
    const upstream = await fetch(`http://127.0.0.1:${backend.address().port}/${req.url.slice(prefix.length)}`, { method: req.method, headers, redirect: 'error' });
    for (const [key, value] of upstream.headers) if (!['content-length','transfer-encoding','connection','set-cookie'].includes(key))
      res.setHeader(key, key === 'content-security-policy' ? `${value.replaceAll("'self'", `'self' ${own}`)}; sandbox allow-scripts` : value);
    res.statusCode = upstream.status;
    let body = await upstream.text();
    if (req.url === prefix) body = body.replace('</head>', '<script src="./fixture.js" defer></script></head>');
    res.end(body);
  } catch { res.writeHead(502).end(); }
});
await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
const browser = process.env.MAGPIE_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const child = spawn(browser, ['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-extensions','--disable-background-networking','--disable-component-update',`--user-data-dir=${profile}`,`http://127.0.0.1:${proxy.address().port}/`], {stdio:'ignore'});
child.on('error', () => finish({error:'browser-start-failed'}));
let timeout;
try {
  const report = await Promise.race([result, new Promise(resolve => { timeout=setTimeout(()=>resolve({error:'timeout'}),20000); })]);
  const passed = report.rows===1 && report.tabs===6 && report.error===false && reads===1 && report.text.includes('exact-fixture') && report.text.includes('99%') && !report.text.includes('PRIVATE@');
  console.log(JSON.stringify({passed,rows:report.rows,tabs:report.tabs,reads,error:report.error, text: passed ? undefined : report.text}));
  if(!passed) process.exitCode=1;
} finally {
  clearTimeout(timeout);
  if(child.pid) { const kill=spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore'}); await once(kill,'exit'); }
  proxy.closeAllConnections(); backend.closeAllConnections();
  await Promise.all([new Promise(r=>proxy.close(r)),new Promise(r=>backend.close(r))]);
}
