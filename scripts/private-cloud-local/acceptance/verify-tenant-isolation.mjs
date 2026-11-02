#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import puppeteer from 'puppeteer-core'
import { io } from 'socket.io-client'
import { loginWithPassword } from '../../product-e2e/harness.mjs'

const origin = 'http://localhost:13001'
const credentialsFile = required('PRIVATE_CLOUD_EFFECTIVE_CREDENTIALS_FILE')
const users = [
  { name: 'alice', email: required('PRIVATE_CLOUD_TEST_ALICE_EMAIL'), password: required('PRIVATE_CLOUD_TEST_ALICE_PASSWORD') },
  { name: 'bob', email: required('PRIVATE_CLOUD_TEST_BOB_EMAIL'), password: required('PRIVATE_CLOUD_TEST_BOB_PASSWORD') },
]
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? '/snap/bin/chromium', headless: true, args: ['--no-sandbox'] })
const actors = []
try {
  for (const user of users) {
    const context = await browser.createBrowserContext()
    const page = await context.newPage()
    const password = await loginWithPassword(page, { productOrigin: origin, loginName: user.email, password: user.password })
    const me = await page.evaluate(() => fetch('/auth/me').then((response) => response.json()))
    const capabilities = await page.evaluate(() => fetch('/runtime/capabilities').then((response) => response.json()))
    const cookie = (await page.cookies()).map((entry) => entry.name + '=' + entry.value).join('; ')
    const sessionId = `tenant-${user.name}-${randomUUID()}`
    const socket = io(origin + '/dashboard', { transports: ['websocket'], extraHeaders: { cookie }, auth: { role: 'dashboard', sessionId, clientVersion: '1' }, reconnection: false })
    await once(socket, 'session:ready', 15_000)
    actors.push({ ...user, password, context, socket, sessionId, organizationId: me.organization?.id, capabilities })
  }

  const organizations = actors.map((actor) => actor.organizationId)
  if (organizations.some((id) => !id) || new Set(organizations).size !== actors.length) throw new Error('acceptance identities are not bound to distinct organizations')
  if (actors.some((actor) => actor.capabilities.product !== 'private-cloud' || actor.capabilities.deployment?.tenancy !== 'multi-tenant')) throw new Error('tenant Runtime capabilities are incorrect')

  const aliceSession = actors[0].sessionId
  const bobSession = actors[1].sessionId
  assertAck(await ack(actors[0].socket, 'client:create_session', { operationId: 'operation-' + randomUUID(), sessionId: aliceSession }))
  assertAck(await ack(actors[1].socket, 'client:create_session', { operationId: 'operation-' + randomUUID(), sessionId: bobSession }))
  const aliceSessions = await listSessions(actors[0].socket)
  const bobSessions = await listSessions(actors[1].socket)
  if (!aliceSessions.has(aliceSession) || aliceSessions.has(bobSession) || !bobSessions.has(bobSession) || bobSessions.has(aliceSession)) throw new Error('Runtime Session catalog crossed the tenant boundary')

  assertAck(await ack(actors[0].socket, 'client:delete_session', { operationId: 'operation-' + randomUUID(), sessionId: aliceSession }))
  assertAck(await ack(actors[1].socket, 'client:delete_session', { operationId: 'operation-' + randomUUID(), sessionId: bobSession }))
  writeFileSync(credentialsFile, JSON.stringify(Object.fromEntries(actors.map((actor) => [actor.name, actor.password]))) + '\n', { flag: 'wx', mode: 0o600 })
  process.stdout.write(JSON.stringify({ ok: true, organizationsDistinct: true, sessionCatalogIsolated: true, tenants: actors.length }) + '\n')
} finally {
  for (const actor of actors) { actor.socket.close(); await actor.context.close().catch(() => undefined) }
  await browser.close()
}

function required(name) { const value = process.env[name]?.trim(); if (!value) throw new Error(name + ' is required'); return value }
function once(socket, event, timeout) { return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(event + ' timed out')), timeout); socket.once(event, (value) => { clearTimeout(timer); resolve(value) }); socket.once('connect_error', reject) }) }
function ack(socket, event, payload) { return socket.timeout(10_000).emitWithAck(event, payload) }
function assertAck(value) { if (!value?.ok) throw new Error('tenant Session operation failed: ' + String(value?.error)) }
function listSessions(socket) { return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('tenant Session list timed out')), 10_000); socket.once('server:sessions', (value) => { clearTimeout(timer); resolve(new Set((value.sessions ?? []).map((entry) => entry.sessionId))) }); socket.emit('client:list_sessions', {}) }) }
