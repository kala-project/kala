import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

import { SessionStore } from '../store/session.js'
import { CopilotAgentRuntime } from './copilot-runtime.js'

vi.mock('@github/copilot-sdk', () => {
  throw new Error("Cannot find package '@github/copilot-sdk'")
})

const dir = mkdtempSync(join(tmpdir(), 'kala-copilot-sdk-missing-'))
afterEach(() => rmSync(dir, { recursive: true, force: true }))

it('keeps the Host runtime available for diagnostics when the SDK package is missing', async () => {
  const runtime = new CopilotAgentRuntime({
    store: new SessionStore(dir),
    tools: { async callTool() { return { ok: true, content: '' } }, cancelPending() {} },
    broadcast: { onState() {}, onTokenDelta() {}, onApprovalRequired() {}, onError() {} },
  }, { enabled: true, sessionsDir: dir })

  await expect(runtime.start()).resolves.toBeUndefined()
  expect(runtime.descriptor()).toMatchObject({
    status: 'unavailable', available: false,
    reason: expect.stringContaining('Copilot SDK unavailable:'),
  })
})
