#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { io } from 'socket.io-client'
import { PROTOCOL_VERSION } from '../../packages/shared/dist/index.js'

if (process.env.PRODUCT_E2E_COMPUTER_ISOLATED !== '1') throw new Error('This acceptance requires an explicitly isolated target: PRODUCT_E2E_COMPUTER_ISOLATED=1')
const credentials = JSON.parse(readFileSync(resolve(process.env.PRODUCT_E2E_COMPUTER_CONFIG), 'utf8'))
const name = process.env.PRODUCT_E2E_COMPUTER_WORKSPACE ?? 'kala-clean-linux'
if (!name.startsWith('kala-clean-')) throw new Error('Use a specifically named disposable kala-clean-* Workspace, never production')
const output = resolve(process.env.PRODUCT_E2E_EVIDENCE_ROOT ?? '.artifacts/computer-use')
mkdirSync(output, { recursive: true, mode: 0o700 })
const sessionId = `computer-${randomUUID()}`
const sockets = []
const evidence = { target: name, sessionId, steps: [] }
let heartbeat
let leaseId
let controller
let workspaceId

function ack(socket, event, payload, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} timed out`)), timeoutMs)
    socket.emit(event, payload, (result) => { clearTimeout(timer); resolve(result) })
  })
}
async function connect() {
  const socket = io(`${credentials.origin}/dashboard`, { autoConnect: false, transports: ['websocket'], auth: { token: credentials.token, role: 'dashboard', sessionId, clientVersion: PROTOCOL_VERSION }, reconnection: false })
  sockets.push(socket)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Dashboard connection timed out')), 30_000)
    socket.once('session:ready', () => { clearTimeout(timer); resolve() })
    socket.once('connect_error', (error) => { clearTimeout(timer); reject(error) })
    socket.connect()
  })
  return socket
}
const desktop = (socket, operation) => ack(socket, 'computer:request', { requestId: randomUUID(), workspaceId, sessionId, ...operation })
async function expectTargetFile(expected) {
  const deadline = Date.now() + 10_000
  let response
  do {
    response = await ack(controller, 'workspace:read_binary', { requestId: randomUUID(), workspaceId, cwd: process.env.PRODUCT_E2E_COMPUTER_CWD, path: expected.path, maxBytes: 256 * 1024 })
    if (!response.error && (typeof expected.base64 === 'string'
      ? response.base64 === expected.base64
      : Array.isArray(expected.contains) && expected.contains.length > 0 && expected.contains.every((text) => Buffer.from(response.base64, 'base64').toString('utf8').includes(text)))) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  } while (Date.now() < deadline)
  assert.fail(`Real desktop application did not produce ${expected.path}: ${response?.error?.message ?? 'file contents differ'}`)
}
async function subscribe(socket) {
  const channels = [`session:${sessionId}`, `workspace:${workspaceId}`]
  const result = await ack(socket, 'client:subscribe_channels', { requestId: randomUUID(), generation: 1, channels })
  assert.deepEqual(result.rejected, [])
  assert.deepEqual(result.accepted.sort(), channels.sort())
}
async function step(name, run) {
  const began = Date.now()
  await run()
  evidence.steps.push({ name, ok: true, durationMs: Date.now() - began })
}
try {
  controller = await connect()
  const onlineDeadline = Date.now() + 15_000
  let workspace
  do {
    const listed = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Workspace directory timed out')), 15_000)
      controller.once('server:executors', (result) => { clearTimeout(timer); resolve(result) })
      controller.emit('client:list_executors', {})
    })
    workspace = listed.executors.find((candidate) => candidate.workspaceName === name)
    if (!workspace) await new Promise((resolve) => setTimeout(resolve, 250))
  } while (!workspace && Date.now() < onlineDeadline)
  assert.ok(workspace, `Isolated ${name} is not online`)
  workspaceId = workspace.workspaceId
  evidence.workspaceId = workspaceId
  const created = await ack(controller, 'client:create_session', { operationId: randomUUID(), sessionId, workspaceId, agentRuntime: 'kernel', ...(process.env.PRODUCT_E2E_COMPUTER_CWD ? { cwd: process.env.PRODUCT_E2E_COMPUTER_CWD } : {}) })
  assert.equal(created.ok, true, created.error)
  await subscribe(controller)
  await step('real desktop available; no implicit authorization', async () => {
    const status = await desktop(controller, { operation: 'status' })
    assert.equal(status.status?.available, true, status.error?.message ?? status.status?.reason)
    assert.equal(status.status.active, false)
    const denied = await desktop(controller, { operation: 'capture', leaseId: randomUUID() })
    assert.equal(denied.error?.code, 'denied')
  })
  await step('explicit user consent creates a socket-bound lease', async () => {
    const started = await desktop(controller, { operation: 'start', consent: true, allowAgent: false })
    assert.ok(started.leaseId, started.error?.message)
    leaseId = started.leaseId
    assert.equal(started.status.allowAgent, false)
    heartbeat = setInterval(() => { void desktop(controller, { operation: 'renew', leaseId }).catch((error) => { evidence.heartbeatError = error.message }) }, 10_000)
  })
  await step('native screenshot survives real Host/Executor transport', async () => {
    const response = await desktop(controller, { operation: 'capture', leaseId })
    assert.ok(response.screenshot, response.error?.message)
    const image = response.screenshot
    const bytes = Buffer.from(image.base64, 'base64')
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
    assert.equal(bytes.readUInt32BE(16), image.width)
    assert.equal(bytes.readUInt32BE(20), image.height)
    evidence.image = { width: image.width, height: image.height, originX: image.originX, originY: image.originY, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
    writeFileSync(join(output, 'native-desktop.png'), bytes, { mode: 0o600 })
  })
  await step('another socket cannot capture or take over the same session', async () => {
    const other = await connect()
    await subscribe(other)
    assert.equal((await desktop(other, { operation: 'capture', leaseId })).error?.code, 'denied')
    assert.equal((await desktop(other, { operation: 'start', consent: true, allowAgent: true })).error?.code, 'busy')
    other.disconnect()
  })
  if (process.env.PRODUCT_E2E_COMPUTER_ACTIONS) {
    await step('physical mouse, text and keyboard input on target applications', async () => {
      const actions = JSON.parse(readFileSync(resolve(process.env.PRODUCT_E2E_COMPUTER_ACTIONS), 'utf8'))
      evidence.actions = []
      for (const [index, action] of actions.entries()) {
        const actionEvidence = { index, type: action.kind ?? action.type, startedAt: Date.now() }
        evidence.actions.push(actionEvidence)
        if (action.kind === 'assert-file') {
          await expectTargetFile(action)
          actionEvidence.durationMs = Date.now() - actionEvidence.startedAt
          continue
        }
        const response = await desktop(controller, { operation: 'input', leaseId, action })
        assert.equal(response.error, undefined, response.error?.message)
        actionEvidence.durationMs = Date.now() - actionEvidence.startedAt
      }
    })
  }
  if (process.env.PRODUCT_E2E_COMPUTER_MODEL === '1') {
    await step('Agent screenshot reaches controlled model as an actual image', async () => {
      assert.equal((await desktop(controller, { operation: 'agent', leaseId, allowAgent: true })).error, undefined)
      assert.equal((await ack(controller, 'client:set_approval_mode', { operationId: randomUUID(), sessionId, mode: 'auto' })).ok, true)
      const received = []
      const onEvent = (event) => received.push(event)
      const approveScreenshot = (approval) => {
        if (approval.sessionId !== sessionId || approval.name !== 'computer_use' || approval.input.operation !== 'screenshot') return
        controller.emit('client:user_approve', { operationId: randomUUID(), sessionId, callId: approval.callId })
      }
      controller.on('event:appended', onEvent)
      controller.on('session:token_delta', onEvent)
      controller.on('approval:required', approveScreenshot)
      const submitted = await ack(controller, 'client:user_message', { operationId: randomUUID(), sessionId, intent: 'text', text: 'KALA_DESKTOP_IMAGE_ACCEPTANCE: observe the explicitly authorized desktop once.' })
      assert.equal(submitted.ok, true, submitted.error)
      const deadline = Date.now() + 40_000
      while (Date.now() < deadline && !/KALA_DESKTOP_IMAGE_(?:RECEIVED|FAILED)/u.test(JSON.stringify(received))) await new Promise((resolve) => setTimeout(resolve, 100))
      controller.off('event:appended', onEvent)
      controller.off('session:token_delta', onEvent)
      controller.off('approval:required', approveScreenshot)
      assert.ok(JSON.stringify(received).includes('KALA_DESKTOP_IMAGE_RECEIVED'), 'The controlled provider did not confirm native image receipt')
    })
  }
  await step('stop revokes capture immediately', async () => {
    clearInterval(heartbeat)
    assert.equal((await desktop(controller, { operation: 'stop', leaseId })).status.active, false)
    assert.equal((await desktop(controller, { operation: 'capture', leaseId })).error?.code, 'denied')
    leaseId = undefined
  })
  await step('socket disconnect revokes a new authorization', async () => {
    const started = await desktop(controller, { operation: 'start', consent: true, allowAgent: true })
    assert.ok(started.leaseId)
    controller.disconnect()
    controller = await connect()
    await subscribe(controller)
    const deadline = Date.now() + 5_000
    let status
    do { status = await desktop(controller, { operation: 'status' }); if (!status.status.active) break; await new Promise((resolve) => setTimeout(resolve, 100)) } while (Date.now() < deadline)
    assert.equal(status.status.active, false)
  })
  assert.equal(evidence.heartbeatError, undefined)
  evidence.ok = true
  console.log(JSON.stringify(evidence))
} catch (error) {
  evidence.ok = false
  evidence.error = error instanceof Error ? error.stack : String(error)
  console.error(evidence.error)
  process.exitCode = 1
} finally {
  clearInterval(heartbeat)
  if (controller?.connected && leaseId) await desktop(controller, { operation: 'stop', leaseId }).catch((error) => { evidence.cleanupError = error.message; process.exitCode = 1 })
  sockets.forEach((socket) => socket.disconnect())
  writeFileSync(join(output, 'transport-report.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 })
}
