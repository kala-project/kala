// Opt-in real Linux UI gate. Uses only our dedicated disposable fixture;
// no model, production account, in-use service, browser profile or deployment.
import { createServer, type Server } from 'node:http'
import { createHash } from 'node:crypto'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { expect, it, vi } from 'vitest'
import { createConfig } from '@agent-kernel/kernel'
import { startHostServer, type HostServer } from '@agent-kernel/host'
import { PROTOCOL_VERSION } from '@agent-kernel/shared'
import { startExecutor } from './client.js'
import { ulid } from 'ulid'

const container = 'kala-app-debug-build-20261030'
const lxc = (...args: string[]) => execFileSync('lxc', args, { encoding: 'utf8', timeout: 15_000 })
const inside = (command: string) => lxc('exec', container, '--', 'bash', '-lc', command)
const listen = async (server: Server): Promise<number> => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture port')
  return address.port
}

it.runIf(process.env.KALA_NATIVE_DEBUG_SMOKE === '1')('real GTK controls bridge authenticated dual-port login/API/WS/streaming with isolated persistent app storage', async () => {
  const fixtureRequire = createRequire(import.meta.url)
  const socketRequire = createRequire(fixtureRequire.resolve('socket.io-client'))
  const { WebSocketServer } = createRequire(socketRequire.resolve('engine.io-client'))('ws')
  const root = mkdtempSync(join(tmpdir(), 'kala-desktop-debug-'))
  const run = `kala-debug-smoke-${process.pid}`; const fixtureRoot = `/tmp/${run}`
  const reports: Array<Record<string, unknown>> = []; const contexts: Array<Record<string, unknown>> = []
  const resources: Array<Record<string, unknown>> = []
  const assets = resolve('../dashboard/dist/assets')
  const lazyEntry = (name: string) => {
    const entry = readdirSync(join(assets, `lazy-${name}`)).find((file) => /^entry-.*\.js$/u.test(file))
    if (!entry) throw new Error(`Build Dashboard release assets before native smoke: missing ${name}`)
    return `/assets/lazy-${name}/${entry}`
  }
  const shikiEntry = lazyEntry('shiki'); const mermaidEntry = lazyEntry('mermaid')
  const workerEntry = `/assets/${readdirSync(assets).find((file) => /^monaco-editor\.worker-.*\.js$/u.test(file)) ?? 'missing-worker'}`
  let host: HostServer | undefined; let executor: ReturnType<typeof startExecutor> | undefined; let child: ChildProcess | undefined
  let output = ''; let proxy = false; let browserBundle = ''
  const token = 'isolated-desktop-fixture-token'; const workspaceId = ulid()
  const backend = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', `http://localhost:${frontendPort}`)
    res.setHeader('Access-Control-Allow-Credentials', 'true')
    if (req.url === '/login') { res.setHeader('Set-Cookie', 'debugLogin=app-only; Path=/; SameSite=Lax; Max-Age=3600'); res.end('logged-in'); return }
    if (req.url === '/api') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ loggedIn: req.headers.cookie?.includes('debugLogin=app-only') === true, platformCookieLeaked: req.headers.cookie?.includes('kalaFixture=') === true })); return }
    if (req.url === '/stream') { res.write('first-'); setTimeout(() => res.end('last'), 40); return }
    res.writeHead(404).end()
  })
  const ws = new WebSocketServer({ server: backend }); ws.on('connection', (socket) => socket.on('message', (message) => socket.send(`hmr:${message}`)))
  const frontend = createServer((req, res) => {
    if (req.url === '/report') {
      let body = ''; req.on('data', (data) => { body += String(data) }); req.on('end', () => { reports.push(JSON.parse(body)); res.end('ok') }); return
    }
    res.setHeader('Content-Type', 'text/html')
    res.end(`<!doctype html><title>Isolated fixture</title><script>
(async () => {
 const report = { bridge: typeof window.__KALA_DESKTOP_BRIDGE__, tauri: typeof window.__TAURI__, internal: typeof window.__TAURI_INTERNALS__, priorLogin: document.cookie.includes('debugLogin=app-only'), platformCookie: document.cookie.includes('kalaFixture=') };
 try {
  const base = 'http://localhost:${backendPort}';
  await fetch(base + '/login', { credentials: 'include' });
  report.api = await (await fetch(base + '/api', { credentials: 'include' })).json();
  report.stream = await (await fetch(base + '/stream')).text();
  report.ws = await new Promise((resolve, reject) => { const socket = new WebSocket('ws://localhost:${backendPort}/hmr'); socket.onopen = () => socket.send('update'); socket.onmessage = event => { resolve(event.data); socket.close() }; socket.onerror = () => reject(new Error('WebSocket failed')); setTimeout(() => reject(new Error('WebSocket timed out')), 5000) });
 } catch (error) { report.error = String(error) }
 document.body.textContent = JSON.stringify(report);
 await fetch('/report', { method: 'POST', body: JSON.stringify(report) });
})();</script>`)
  })
  let frontendPort = 0; let backendPort = 0
  try {
    frontendPort = await listen(frontend); backendPort = await listen(backend)
    const http = createServer(); const port = await listen(http)
    const config = createConfig({ tools: [], systemPrompt: 'isolated desktop fixture' })
    host = await startHostServer({ port, httpServer: http, sessionsDir: join(root, 'sessions'), authToken: token, defaultConfig: config,
      llm: { name: 'unused', async call() { throw new Error('Debugging must not call a model') } },
      dashboardHandler(req, res) {
        if (req.url?.startsWith('/assets/')) {
          const file = resolve(assets, req.url.slice('/assets/'.length))
          if (!file.startsWith(`${assets}/`)) { res.writeHead(403).end(); return }
          res.setHeader('Content-Type', 'text/javascript'); res.end(readFileSync(file)); return
        }
        if (req.url === '/fixture/resources') { let body = ''; req.on('data', (data) => { body += String(data) }); req.on('end', () => resources.push(JSON.parse(body))); res.end('ok'); return }
        if (req.url === '/fixture/context') { let body = ''; req.on('data', (chunk) => { body += String(chunk) }); req.on('end', () => contexts.push(JSON.parse(body))); res.end('ok'); return }
        if (req.url === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(browserBundle); return }
        res.setHeader('Set-Cookie', 'kalaFixture=platform-only; Path=/; SameSite=Lax')
        res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Kala fixture</title><body><main id="fixture-svg"></main><script src="/fixture.js"></script></body>')
      },
    })
    await host.store.ensure({ sessionId: 'native-debug-session', workspaceId, workspaceName: 'native fixture', defaultConfig: config })
    executor = startExecutor({ host: `http://127.0.0.1:${port}`, token, workspaceId, workspaceName: 'native fixture', sandboxRoots: [root] })
    await executor.ready
    await vi.waitFor(() => expect(host!.executorsSnapshot().some((entry) => entry.workspaceId === workspaceId)).toBe(true))
    const dashboardRequire = createRequire(new URL('../../dashboard/package.json', import.meta.url)); const viteRequire = createRequire(dashboardRequire.resolve('vite/package.json')); const { build } = viteRequire('esbuild')
    const built = await build({ stdin: { contents: `
import { io } from 'socket.io-client';
import { connectApplicationDebugging } from './src/lib/application-debugging.ts';
const nativeImport = path => import(path);
const resourcesReady = (async () => {
 const result = {};
 try {
  const shiki = await nativeImport(${JSON.stringify(shikiEntry)});
  const highlighter = await shiki.createHighlighter({ themes: ['github-dark'], langs: ['typescript'] });
  result.highlight = highlighter.codeToHtml('const x: number = 1', { lang: 'typescript', theme: 'github-dark' }).includes('class="shiki'); highlighter.dispose();
  const mermaid = (await nativeImport(${JSON.stringify(mermaidEntry)})).default;
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
  const { svg } = await mermaid.render('native-svg', 'flowchart LR; A-->B');
  document.getElementById('fixture-svg').innerHTML = svg; result.svg = !!document.querySelector('#fixture-svg svg .node');
  result.worker = await new Promise((resolve, reject) => {
   const worker = new Worker(${JSON.stringify(workerEntry)});
   const timer = setTimeout(() => { worker.terminate(); reject(new Error('Production Monaco RPC timed out')) }, 5000);
   worker.onerror = event => { clearTimeout(timer); worker.terminate(); reject(new Error(event.message)) };
   worker.onmessage = event => { if (event.data.seq === '1') { clearTimeout(timer); worker.terminate(); if (event.data.err) reject(new Error(JSON.stringify(event.data.err))); else resolve(event.data.type === 1) } };
   worker.postMessage(null); worker.postMessage({ vsWorker: 1, req: '1', channel: 'default', method: '$initialize', args: [1], type: 0 });
  });
 } catch (error) { result.error = String(error) }
 await fetch('/fixture/resources', { method: 'POST', body: JSON.stringify(result) });
})();
const debug = window.__KALA_DESKTOP_BRIDGE__.applicationDebugging;
const remoteStartDenied = window.__TAURI__.core.invoke('application_debug', { request: { op: 'start', ports: [65534] } }).then(() => false, () => true);
const bridge = { ...debug, setContext: async (generation, context) => { await debug.setContext(generation, context); await resourcesReady; await fetch('/fixture/context', { method: 'POST', body: JSON.stringify({ ...context, remoteStartDenied: await remoteStartDenied }) }); await debug.show() } };
window.__KALA_DESKTOP_CONNECTION__.confirmConnection();
const socket = io(location.origin + '/dashboard', { transports: ['websocket'], auth: { role: 'dashboard', clientVersion: ${JSON.stringify(PROTOCOL_VERSION)}, sessionId: 'native-debug-session', token: ${JSON.stringify(token)} }, reconnection: false, retries: 0 });
socket.once('session:ready', () => connectApplicationDebugging(bridge, socket, 'native-debug-session'));
`, resolveDir: resolve('../dashboard'), sourcefile: 'native-smoke.ts', loader: 'ts' }, alias: { '@agent-kernel/shared': resolve('../shared/src/browser.ts') }, write: false, bundle: true, format: 'iife', platform: 'browser', logLevel: 'silent' })
    browserBundle = built.outputFiles[0].text
    lxc('config', 'device', 'add', container, run, 'proxy', 'bind=container', `listen=tcp:127.0.0.1:${port}`, `connect=tcp:127.0.0.1:${port}`); proxy = true
    const origin = `http://localhost:${port}`
    const scope = { origin, principalKey: createHash('sha256').update('token').digest('hex'), workspaceId, executorId: executor.executorId }
    const key = createHash('sha256').update(JSON.stringify(scope)).digest('hex')
    const saved = { schemaVersion: 1, scope, config: { ports: [frontendPort, backendPort].sort((a, b) => a - b), entryPort: frontendPort, scheme: 'http' } }
    inside(`mkdir -p ${fixtureRoot}/config/io.github.xingsy97.akernel.desktop ${fixtureRoot}/data/io.github.xingsy97.akernel.desktop/application-debug/settings; chmod -R 700 ${fixtureRoot}`)
    const write = (path: string, value: unknown) => execFileSync('lxc', ['exec', container, '--', 'bash', '-lc', `umask 077; cat > ${path}`], { input: JSON.stringify(value), timeout: 10_000 })
    write(`${fixtureRoot}/config/io.github.xingsy97.akernel.desktop/desktop-state.json`, { origin, windows: {} })
    write(`${fixtureRoot}/data/io.github.xingsy97.akernel.desktop/application-debug/settings/${key}.json`, saved)
    const script = `
export XDG_CONFIG_HOME=${fixtureRoot}/config XDG_DATA_HOME=${fixtureRoot}/data XDG_CACHE_HOME=${fixtureRoot}/cache
/root/app-debug-target/debug/kala-desktop >${fixtureRoot}/desktop.log 2>&1 & app=$!
echo $app >${fixtureRoot}/pid
trap 'kill $app 2>/dev/null || true' EXIT
for n in $(seq 1 200); do win=$(xdotool search --name 'Application debugging$' 2>/dev/null | head -1); [ -n "$win" ] && break; sleep .1; done
[ -n "$win" ] || { cat ${fixtureRoot}/desktop.log; exit 2; }
xdotool windowfocus "$win" key alt+s
echo NATIVE_STARTED
for n in $(seq 1 400); do [ -f ${fixtureRoot}/restart ] && break; sleep .1; done
xdotool windowfocus "$win" key alt+p
sleep .3
xdotool windowfocus "$win" key alt+s
echo NATIVE_RESTARTED
for n in $(seq 1 400); do [ -f ${fixtureRoot}/stop ] && break; sleep .1; done
xdotool windowfocus "$win" key alt+p
echo NATIVE_STOPPED
sleep 10
`
    child = spawn('lxc', ['exec', container, '--', 'timeout', '110', 'dbus-run-session', '--', 'xvfb-run', '-a', 'bash', '-c', script], { stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout?.on('data', (data) => { output += String(data) }); child.stderr?.on('data', (data) => { output += String(data) })
    await vi.waitFor(() => expect(contexts).toHaveLength(1), { timeout: 25_000 })
    expect(resources).toEqual([{ highlight: true, svg: true, worker: true }])
    expect(contexts[0]).toMatchObject({ principalKey: scope.principalKey, workspaceId, executorId: scope.executorId, sessionId: 'native-debug-session', remoteStartDenied: true })
    await vi.waitFor(() => expect(reports.length, output).toBeGreaterThanOrEqual(1), { timeout: 20_000 })
    const expected = { bridge: 'undefined', tauri: 'undefined', internal: 'undefined', platformCookie: false, api: { loggedIn: true, platformCookieLeaked: false }, stream: 'first-last', ws: 'hmr:update' }
    expect(reports[0]).toMatchObject({ ...expected, priorLogin: false }); expect(reports[0]).not.toHaveProperty('error')
    inside(`touch ${fixtureRoot}/restart`)
    await vi.waitFor(() => expect(reports.length, output).toBeGreaterThanOrEqual(2), { timeout: 20_000 })
    expect(reports[1]).toMatchObject({ ...expected, priorLogin: true }); expect(reports[1]).not.toHaveProperty('error')
    inside(`touch ${fixtureRoot}/stop`)
    await vi.waitFor(() => expect(output).toContain('NATIVE_STOPPED'), { timeout: 5000 })
    inside(`python3 -c 'import socket,time; ports=${JSON.stringify([frontendPort, backendPort])}; deadline=time.monotonic()+3\nwhile True:\n closed=all(socket.socket().connect_ex(("127.0.0.1", p)) != 0 for p in ports)\n if closed: break\n assert time.monotonic()<deadline, "Listeners survived Stop deadline"\n time.sleep(.05)'`)
    const after = JSON.parse(inside(`cat ${fixtureRoot}/data/io.github.xingsy97.akernel.desktop/application-debug/settings/${key}.json`))
    expect(after).toEqual(saved)
    console.log('Native GTK/IPC/real authenticated relay: login, cross-port cookies/API, streaming, WS/HMR payload, storage isolation/persistence, explicit restart and listener cleanup passed.')
  } finally {
    try { if (child) inside(`test ! -f ${fixtureRoot}/pid || kill $(cat ${fixtureRoot}/pid) 2>/dev/null || true`) } catch {}
    child?.kill('SIGTERM')
    if (proxy) lxc('config', 'device', 'remove', container, run)
    await executor?.close(); await host?.close()
    for (const client of ws.clients) client.terminate(); ws.close()
    for (const service of [frontend, backend]) { service.closeAllConnections(); await new Promise<void>((done) => service.close(() => done())) }
    rmSync(root, { recursive: true, force: true })
  }
}, 100_000)
