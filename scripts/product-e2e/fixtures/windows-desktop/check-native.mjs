// Build the Executor first: pnpm --filter @agent-kernel/executor build
// Run ONLY on an explicitly pinned isolated Windows VM, using a private root created by manage-fixture.ps1.
// Modes: status, keyboard, pointer, ipc (Medium token), session0, locked (after console lock).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { actions } from './physical-actions.mjs';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i];
  if (key === '--allow-isolated-desktop-test') args.allow = true;
  else if (['--root', '--expected-computer', '--mode'].includes(key) && process.argv[i + 1]) args[key.slice(2)] = process.argv[++i];
  else throw Error('Unknown or incomplete isolated acceptance argument');
}
if (process.platform !== 'win32' || !args.allow || !args.root || !args['expected-computer'] ||
    args['expected-computer'].toLowerCase() !== process.env.COMPUTERNAME?.toLowerCase()) {
  throw Error('Explicitly confirm an isolated Windows target with --allow-isolated-desktop-test --expected-computer NAME --root PRIVATE_DIRECTORY');
}
const mode = args.mode ?? 'status';
assert.ok(['status', 'keyboard', 'pointer', 'ipc', 'session0', 'locked'].includes(mode));
assert.ok(path.isAbsolute(args.root));
const root = path.resolve(args.root);
assert.notEqual(root, path.parse(root).root);
const marker = JSON.parse(await fs.readFile(path.join(root, '.kala-desktop-acceptance.json'), 'utf8'));
assert.equal(marker.purpose, 'kala-isolated-desktop-v1');
assert.equal(marker.computer.toLowerCase(), args['expected-computer'].toLowerCase());
assert.match(marker.ownerSid, /^S-1-5-21-[0-9-]+$/);
const execFile = promisify(execFileCallback);
async function ps(source, request = {}) {
  const exe = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  source = '[Console]::InputEncoding=New-Object Text.UTF8Encoding($false);[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false);\n' + source;
  const pending = execFile(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], {
    timeout: 20_000, windowsHide: true, maxBuffer: 64 * 1024,
  });
  pending.child.stdin.on('error', () => {});
  pending.child.stdin.end(JSON.stringify(request));
  return (await pending).stdout.trim();
}
await ps(`
$ErrorActionPreference='Stop'
$r=[Console]::In.ReadToEnd()|ConvertFrom-Json
for($p=[string]$r.path;$p;$p=[IO.Path]::GetDirectoryName($p)){
 if((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Reparse point evidence ancestry'}
 if($p -eq [IO.Path]::GetPathRoot($p)){break}
}
$a=Get-Acl -LiteralPath ([string]$r.path)
if($a.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne [string]$r.owner){throw 'Unexpected evidence owner'}
foreach($rule in $a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){
 if($rule.IdentityReference.Value -cne [string]$r.owner -and $rule.IdentityReference.Value -cne 'S-1-5-18'){throw 'Evidence root is not private'}
}`, { path: root, owner: marker.ownerSid });
const native = await import('../../../../packages/executor/dist/src/computer-use/desktop-driver.js');
const companion = await import('../../../../packages/executor/dist/src/computer-use/companion.js');
const { createDesktopDriver } = native;
const { createConfiguredDesktopDriver, serveDesktopCompanion } = companion;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const evidence = suffix => path.join(root, 'cu-win-native.' + suffix);
const result = { mode, startedAt: new Date().toISOString(), assertions: [] };
let shutdown = async () => {};
async function progress(phase) {
  result.phase = phase;
  await fs.writeFile(evidence(mode + '-progress.json'), JSON.stringify(result), { mode: 0o600 });
}
const deadline = setTimeout(() => {
  result.error = 'Bounded isolated acceptance work deadline reached';
  const force = setTimeout(() => process.exit(124), 15_000);
  shutdown().finally(async () => {
    await progress('deadline-cleanup-complete').catch(() => {});
    clearTimeout(force);
    process.exit(124);
  });
}, 140_000);
deadline.unref();
async function state(expected) {
  const until = Date.now() + 10_000;
  do {
    const value = await fs.readFile(evidence('state'), 'utf8');
    if (value.includes(expected)) return value;
    await sleep(100);
  } while (Date.now() < until);
  throw Error('Real GUI state did not reach ' + expected);
}
async function image(driver) {
  const began = performance.now();
  const shot = await driver.screenshot(), bytes = Buffer.from(shot.base64, 'base64');
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(bytes.readUInt32BE(16), shot.width);
  assert.equal(bytes.readUInt32BE(20), shot.height);
  return { width: shot.width, height: shot.height, originX: shot.originX, originY: shot.originY,
    bytes: bytes.length, durationMs: Math.round(performance.now() - began), sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}
async function physical(driver) {
  result.actions = [];
  for (const [index, action] of actions.entries()) {
    if (mode === 'keyboard' && index >= 9 || mode === 'pointer' && index < 9) continue;
    const entry = { index, type: action.kind ?? action.type };
    result.actions.push(entry);
    const began = performance.now();
    if (action.kind === 'assert-file') {
      assert.equal(path.basename(action.path), action.path);
      const until = Date.now() + 30_000;
      let matched = false;
      do {
        const bytes = await fs.readFile(path.join(root, action.path)).catch(() => Buffer.alloc(0));
        matched = action.base64 !== undefined ? bytes.toString('base64') === action.base64 : action.contains.every(part => bytes.toString('utf8').includes(part));
        if (!matched) await sleep(100);
      } while (!matched && Date.now() < until);
      assert.ok(matched, 'Real GUI assertion: ' + action.path);
    } else await driver.input(action);
    entry.durationMs = Math.round(performance.now() - began);
    await progress('action-' + index);
  }
  await driver.releaseInputs();
  result.releaseState = await state('buttons=None modifiers=None keys=None');
}
async function ipc() {
  assert.equal(result.integritySid, 'S-1-16-8192', 'Run IPC with the normal Limited / Interactive user token');
  const configPath = path.join(root, 'desktop-companion', 'bridge.json');
  const server = await serveDesktopCompanion(configPath);
  const proxy = () => createConfiguredDesktopDriver({ env: { ...process.env, KALA_COMPUTER_USE_COMPANION_CONFIG: configPath } });
  const first = proxy(), second = proxy();
  let third;
  shutdown = async () => {
    await first.close().catch(() => {});
    await second.close().catch(() => {});
    await third?.close().catch(() => {});
    await server.close();
  };
  await progress('companion-started');
  await first.acquire();
  await assert.rejects(second.acquire(), /claimed/);
  assert.equal((await second.status()).available, false);
  result.image = await image(first);
  await first.releaseInputs();
  await assert.rejects(second.acquire(), /claimed/);
  result.assertions.push('exclusive claim; releaseInputs retains ownership');
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.match(config.endpoint, /^tcp:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/);
  const port = Number(config.endpoint.slice(config.endpoint.lastIndexOf(':') + 1));
  assert.ok(port > 0 && port <= 65535);
  await new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const timeout = setTimeout(() => { socket.destroy(); reject(Error('Incorrect auth token was not rejected')); }, 5000);
    socket.once('connect', () => socket.write(JSON.stringify({ version: 1, id: crypto.randomUUID(), owner: crypto.randomUUID(), token: '0'.repeat(64), operation: 'status' }) + '\n'));
    socket.once('close', () => { clearTimeout(timeout); resolve(); });
    socket.once('error', () => {});
  });
  result.assertions.push('real IPv4 loopback TCP rejected incorrect authentication');
  result.acls = JSON.parse(await ps(`
$ErrorActionPreference='Stop'
$r=[Console]::In.ReadToEnd()|ConvertFrom-Json
$a=Get-Acl -LiteralPath ([string]$r.path)
$owner=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value
$rules=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|ForEach-Object{@{sid=$_.IdentityReference.Value;rights=$_.FileSystemRights.ToString()}})
if(@($rules|Where-Object{$_.sid -ne $owner -and $_.sid -ne 'S-1-5-18'}).Count){throw 'Unexpected config ACL principal'}
$listeners=@(Get-NetTCPConnection -OwningProcess ([int]$r.pid) -State Listen|Where-Object{$_.LocalPort -eq [int]$r.port})
if($listeners.Count -ne 1 -or $listeners[0].LocalAddress -cne '127.0.0.1'){throw 'Companion listener is not exclusively IPv4 loopback'}
@{configOwner=$owner;configRules=$rules;listenerAddress=$listeners[0].LocalAddress;listenerPort=$listeners[0].LocalPort}|ConvertTo-Json -Depth 6 -Compress
`, { path: configPath, pid: process.pid, port }));
  await first.releaseInputs();
  await first.input({ type: 'button', x: 250, y: 430, button: 'left', down: true });
  await state('buttons=Left');
  const controller = new AbortController();
  const rejected = assert.rejects(first.screenshot(controller.signal), error => error.name === 'AbortError');
  setTimeout(() => controller.abort(), 100);
  await rejected;
  await first.releaseInputs();
  await state('buttons=None modifiers=None');
  await assert.rejects(second.acquire(), /claimed/);
  result.assertions.push('cancelled native capture releases actual held input and retains claim');
  await progress('cancellation-complete');
  await first.releaseClaim();
  await second.acquire();
  await second.close();
  third = proxy();
  await third.acquire();
  result.assertions.push('proxy close does not stop companion');
  await third.input({ type: 'button', x: 250, y: 430, button: 'left', down: true });
  await state('buttons=Left');
  await progress('awaiting-default-idle-expiry');
  await sleep(31_000);
  await state('buttons=None modifiers=None');
  await first.acquire();
  await first.releaseClaim();
  result.assertions.push('default30s idle expiry releases physical input and permits a new owner');
}
try {
  result.sessionId = Number(await ps('[Diagnostics.Process]::GetCurrentProcess().SessionId'));
  const groups = await execFile('whoami.exe', ['/groups', '/fo', 'csv', '/nh'], { timeout: 5000, windowsHide: true, maxBuffer: 32 * 1024 });
  result.integritySid = groups.stdout.match(/S-1-16-\d+/)?.[0];
  assert.ok(result.integritySid);
  if (mode === 'ipc') await ipc();
  else {
    const driver = createDesktopDriver();
    shutdown = () => driver.close();
    result.status = await driver.status();
    if (mode === 'session0' || mode === 'locked') {
      if (mode === 'session0') assert.equal(result.sessionId, 0);
      else assert.ok(result.sessionId > 0);
      const reason = mode === 'session0' ? /Session 0/ : /locked/i;
      assert.equal(result.status.available, false);
      assert.match(result.status.reason, reason);
      await assert.rejects(driver.screenshot(), reason);
      await assert.rejects(driver.input({ type: 'move', x: 250, y: 430 }), reason);
    } else {
      assert.ok(result.sessionId > 0);
      assert.equal(result.status.available, true, result.status.reason);
      if (mode === 'status') result.image = await image(driver);
      else await physical(driver);
    }
  }
  result.ok = true;
} catch (error) {
  result.ok = false;
  result.error = error.message;
  process.exitCode = 1;
} finally {
  try { await shutdown(); } catch (error) { result.ok = false; result.cleanupError = error.message; process.exitCode = 1; }
  clearTimeout(deadline);
  result.finishedAt = new Date().toISOString();
  await fs.writeFile(evidence(mode + '.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(result));
}
