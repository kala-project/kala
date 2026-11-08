import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { createConfig } from '@agent-kernel/kernel'
import type { ContextUsageSnapshot } from '@agent-kernel/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ToolDispatcher } from '../loop-types.js'
import { SessionStore } from '../store/session.js'
import { SqliteSessionAuthority } from '../store/sqlite-session-authority.js'
import { findSessionOperation, readSessionLog, snapshotSidecarPath } from '../store/log.js'
import { messageOperationFingerprint } from '../message-operation-fingerprint.js'
import { CopilotAgentRuntime } from './copilot-runtime.js'
import { MessageAttachmentStore } from '../message-attachment-store.js'
import { createBuiltinTools } from '../builtin-tools.js'
import { runSessionAttachmentTool } from '../extensions/session-attachment.js'

type CapturedTool = {
  name: string
  overridesBuiltInTool?: boolean
  handler(
    args: unknown,
    invocation: { toolCallId: string },
  ): Promise<{ textResultForLlm: string; resultType: string; error?: string }>
}

const sdk = vi.hoisted(() => ({
  clientOptions: [] as Array<{ baseDirectory?: string; connection?: { kind: string; args?: readonly string[]; path?: string } }>,
  startError: undefined as Error | undefined,
  createError: undefined as Error | undefined,
  configs: [] as Array<{
    tools: CapturedTool[]
    streaming?: boolean
    workingDirectory?: string
    systemMessage?: { mode: string; content: string }
    availableTools?: readonly string[]
    excludedTools?: readonly string[]
    additionalDirectories?: readonly string[]
    onPermissionRequest?: (request: { kind: string; path?: string; managedApprovalRequired?: boolean }) => unknown
    remoteSession?: string
    infiniteSessions?: {
      enabled?: boolean
      backgroundCompactionThreshold?: number
      bufferExhaustionThreshold?: number
    }
    skipEmbeddingRetrieval?: boolean
    embeddingCacheStorage?: string
    enableOnDemandInstructionDiscovery?: boolean
    enableFileHooks?: boolean
    enableHostGitOperations?: boolean
    enableSessionStore?: boolean
    enableSkills?: boolean
  }>,
  resumeConfigs: [] as Array<{
    tools: CapturedTool[]
    streaming?: boolean
    workingDirectory?: string
    systemMessage?: { mode: string; content: string }
    availableTools?: readonly string[]
    excludedTools?: readonly string[]
    additionalDirectories?: readonly string[]
    onPermissionRequest?: (request: { kind: string; path?: string; managedApprovalRequired?: boolean }) => unknown
    remoteSession?: string
    infiniteSessions?: {
      enabled?: boolean
      backgroundCompactionThreshold?: number
      bufferExhaustionThreshold?: number
    }
    skipEmbeddingRetrieval?: boolean
    embeddingCacheStorage?: string
    enableOnDemandInstructionDiscovery?: boolean
    enableFileHooks?: boolean
    enableHostGitOperations?: boolean
    enableSessionStore?: boolean
    enableSkills?: boolean
  }>,
  resumeSucceeds: false,
  resumeBarrier: undefined as Promise<void> | undefined,
  listeners: [] as Array<(event: unknown) => void>,
  historyEvents: [] as Array<unknown>,
  getEvents: vi.fn(async () => sdk.historyEvents),
  responses: [] as Array<unknown>,
  sentMessages: [] as Array<unknown>,
  currentModel: { modelId: 'gpt-5.4-mini', contextTier: 'long_context' },
  abort: vi.fn(async () => {}),
  disconnect: vi.fn(async () => {}),
  deleteSession: vi.fn(async () => {}),
  setModel: vi.fn(async () => {}),
  compact: vi.fn(async () => ({
    success: true,
    tokensRemoved: 80_000,
    messagesRemoved: 40,
    summaryContent: '# Compacted Context\n\nKeep the active implementation constraints.',
    contextWindow: {
      currentTokens: 40_000,
      tokenLimit: 128_000,
      messagesLength: 10,
      systemTokens: 1_000,
      conversationTokens: 35_000,
      toolDefinitionsTokens: 4_000,
    },
  })),
}))
const nativeMount = vi.hoisted(() => ({ mount: vi.fn(), close: vi.fn(async () => {}), assertReady: vi.fn(async () => {}) }))
vi.mock('./native-posix-mount.js', () => ({ mountNativePosixSession: nativeMount.mount }))

vi.mock('@github/copilot-sdk', () => ({
  RuntimeConnection: {
    forStdio(options: { args?: readonly string[] } = {}) {
      return { kind: 'stdio', ...options }
    },
  },
  ToolSet: class {
    private readonly items: string[] = []
    addBuiltIn(name: string) {
      this.items.push(`builtin:${name}`)
      return this
    }
    toArray() {
      return [...this.items]
    }
  },
  CopilotClient: class {
    constructor(options: { connection?: { kind: string; args?: readonly string[]; path?: string } }) {
      sdk.clientOptions.push(options)
    }
    async start() {
      if (sdk.startError) throw sdk.startError
    }
    async stop() {}
    async getAuthStatus() {
      return { isAuthenticated: true }
    }
    async listModels() {
      return [{
        id: 'gpt-5.4-mini',
        name: 'GPT-5.4 mini',
        capabilities: { limits: { max_context_window_tokens: 128_000 } },
      }]
    }
    async resumeSession(_sessionId: string, config: { tools: CapturedTool[]; streaming?: boolean; workingDirectory?: string; remoteSession?: string }) {
      sdk.resumeConfigs.push(config)
      await sdk.resumeBarrier
      if (!sdk.resumeSucceeds) throw new Error('not found')
      return this.session()
    }
    async createSession(config: { tools: CapturedTool[]; streaming?: boolean; workingDirectory?: string; remoteSession?: string }) {
      sdk.configs.push(config)
      if (sdk.createError) throw sdk.createError
      return this.session()
    }
    session() {
      return {
        rpc: {
          history: { compact: sdk.compact },
          model: { async getCurrent() { return sdk.currentModel } },
        },
        getEvents: sdk.getEvents,
        async send() {},
        async sendAndWait(options: unknown) {
          sdk.sentMessages.push(options)
          if (sdk.responses.length > 0) {
            const response = sdk.responses.shift()
            if (response instanceof Error) throw response
            return response
          }
          return await new Promise(() => {})
        },
        on(listener: (event: unknown) => void) {
          sdk.listeners.push(listener)
          return () => {
            const index = sdk.listeners.indexOf(listener)
            if (index >= 0) sdk.listeners.splice(index, 1)
          }
        },
        abort: sdk.abort,
        setModel: sdk.setModel,
        disconnect: sdk.disconnect,
      }
    }
    async deleteSession() { await sdk.deleteSession() }
  },
}))

describe('Copilot runtime custom tools', () => {
  let dir: string
  let store: SessionStore

  beforeEach(() => {
    nativeMount.mount.mockReset()
    nativeMount.close.mockClear()
    nativeMount.assertReady.mockReset()
    nativeMount.assertReady.mockResolvedValue()
    sdk.configs.length = 0
    sdk.clientOptions.length = 0
    sdk.resumeConfigs.length = 0
    sdk.resumeSucceeds = false
    sdk.resumeBarrier = undefined
    sdk.startError = undefined
    sdk.createError = undefined
    sdk.listeners.length = 0
    sdk.historyEvents.length = 0
    sdk.responses.length = 0
    sdk.sentMessages.length = 0
    sdk.currentModel = { modelId: 'gpt-5.4-mini', contextTier: 'long_context' }
    sdk.abort.mockClear()
    sdk.disconnect.mockClear()
    sdk.deleteSession.mockClear()
    sdk.setModel.mockClear()
    sdk.compact.mockClear()
    sdk.getEvents.mockReset()
    sdk.getEvents.mockImplementation(async () => sdk.historyEvents)
    dir = mkdtempSync(join(tmpdir(), 'copilot-runtime-tools-'))
    store = new SessionStore(dir)
  })

  it.each(['completed', 'failed', 'cancelled'] as const)('reports committed Copilot turn lifecycle without message content for %s turns', async (outcome) => {
    const onTurn = vi.fn()
    const runtime = new CopilotAgentRuntime({
      store, tools: { async callTool() { return { ok: true, content: 'unused' } }, cancelPending() {} },
      broadcast: { onState() {}, onTokenDelta() {}, onApprovalRequired() {}, onError() {}, onTurn },
    }, { enabled: true, sessionsDir: dir })
    const record = await store.create({ sessionId: `observed-${outcome}`, agentRuntime: 'copilot', config: createConfig({ tools: [] }) })
    if (outcome === 'completed') sdk.responses.push({ type: 'assistant.message', id: 'observed-response', data: { content: 'private answer' } })
    if (outcome === 'failed') sdk.responses.push(new Error('private SDK error'))
    await runtime.start()
    await runtime.send(record, { text: 'private prompt', operationId: 'observed-operation' })
    if (outcome === 'cancelled') await runtime.cancel(record)
    await vi.waitFor(() => expect(onTurn).toHaveBeenCalledTimes(2))
    expect(onTurn.mock.calls[0]).toEqual([record.sessionId, {
      turnId: 'observed-operation', startedAt: expect.any(String), status: 'running',
    }])
    expect(onTurn.mock.calls[1]).toEqual([record.sessionId, {
      turnId: 'observed-operation', startedAt: onTurn.mock.calls[0]![1].startedAt,
      completedAt: expect.any(String), status: outcome,
    }])
    expect(JSON.stringify(onTurn.mock.calls)).not.toMatch(/private prompt|private answer|private SDK error/u)
    await runtime.close()
  })

  it('observes cold resume and only the first root activity without recording content', async () => {
    const observeCopilotStage = vi.fn()
    const runtime = new CopilotAgentRuntime({
      store, tools: { async callTool() { return { ok: true, content: 'unused' } }, cancelPending() {} },
      observeCopilotStage,
      broadcast: { onState() {}, onTokenDelta() {}, onApprovalRequired() {}, onError() {} },
    }, { enabled: true, sessionsDir: dir })
    const record = await store.create({ sessionId: 'stage-observation', agentRuntime: 'copilot', config: createConfig({ tools: [] }) })
    let finish!: (value: unknown) => void
    sdk.responses.push(new Promise(resolve => { finish = resolve }))
    await runtime.start()
    await runtime.send(record, { text: 'private prompt' })
    await vi.waitFor(() => expect(sdk.sentMessages).toHaveLength(1))
    expect(observeCopilotStage).toHaveBeenCalledWith('sdk_resume', expect.any(Number), 'failed')
    for (const listener of [...sdk.listeners]) {
      listener({ type: 'assistant.message_delta', id: 'child', agentId: 'child', timestamp: new Date().toISOString(), parentId: null, data: { deltaContent: 'private child text' } })
      listener({ type: 'assistant.message_delta', id: 'root', timestamp: new Date().toISOString(), parentId: null, data: { deltaContent: 'private answer' } })
      listener({ type: 'assistant.message_delta', id: 'root-again', timestamp: new Date().toISOString(), parentId: null, data: { deltaContent: 'more private text' } })
    }
    expect(observeCopilotStage.mock.calls.filter(([stage]) => stage === 'first_activity')).toEqual([
      ['first_activity', expect.any(Number), 'succeeded'],
    ])
    expect(JSON.stringify(observeCopilotStage.mock.calls)).not.toMatch(/private/u)
    finish({ type: 'assistant.message', id: 'response', data: { content: 'private answer' } })
    await vi.waitFor(() => expect(store.get(record.sessionId)?.state.status).toBe('done'))
    await runtime.close()
  })

  it('counts unique persisted SDK model-turn endings for the named child command, not assistant messages', async () => {
    const runtime = new CopilotAgentRuntime({
      store, tools: { async callTool() { return { ok: true, content: 'unused' } }, cancelPending() {} },
      broadcast: { onState() {}, onTokenDelta() {}, onApprovalRequired() {}, onError() {} },
    }, { enabled: true, sessionsDir: dir })
    const record = await store.create({ sessionId: 'counted-child', agentRuntime: 'copilot', config: createConfig({ tools: [] }) })
    let resolveResponse!: (value: unknown) => void
    sdk.responses.push(new Promise((resolve) => { resolveResponse = resolve }))
    await runtime.start()
    await runtime.send(record, { text: 'one prompt', operationId: 'initial-command' })
    await vi.waitFor(() => expect(sdk.sentMessages).toHaveLength(1))
    for (const listener of [...sdk.listeners]) {
      listener({ type: 'assistant.turn_end', id: 'terminal-a', parentId: null,
        timestamp: new Date().toISOString(), data: { turnId: 'sdk-turn-a' } })
      listener({ type: 'assistant.turn_end', id: 'terminal-a', parentId: null,
        timestamp: new Date().toISOString(), data: { turnId: 'sdk-turn-a' } })
      listener({ type: 'assistant.turn_end', id: 'terminal-b', parentId: null,
        timestamp: new Date().toISOString(), data: { turnId: 'sdk-turn-b' } })
    }
    resolveResponse({ type: 'assistant.message', id: 'answer', data: { content: 'done' } })
    await vi.waitFor(() => expect(record.state.status).toBe('done'))
    expect(await store.countCompletedChildModelTurns(record.sessionId, 'initial-command')).toBe(2)
    await expect(store.countCompletedChildModelTurns(record.sessionId, 'different-command'))
      .rejects.toThrow('no durable user marker')
    await runtime.close()
  })

  it('only acknowledges a child Stop from the process holding its SDK handle', async () => {
    const context = {
      store, tools: { async callTool() { return { ok: true, content: 'unused' } }, cancelPending() {} },
      broadcast: { onState() {}, onTokenDelta() {}, onApprovalRequired() {}, onError() {} },
    }
    const original = new CopilotAgentRuntime(context, { enabled: true, sessionsDir: dir })
    const successor = new CopilotAgentRuntime(context, { enabled: true, sessionsDir: dir })
    const record = await store.create({ sessionId: 'stopped-child', agentRuntime: 'copilot', config: createConfig({ tools: [] }) })
    await original.start()
    await original.send(record, { text: 'first child message', operationId: 'durable-child-command' })
    await vi.waitFor(() => expect(sdk.sentMessages).toContainEqual(expect.objectContaining({
      prompt: 'first child message',
    })))
    expect(await findSessionOperation(record.logPath, 'durable-child-command')).toMatchObject({
      kind: 'runtime_metadata', action: 'copilot.user_message',
    })
    expect(await successor.cancelForChildStop(record)).toBe(false)
    expect(sdk.abort).not.toHaveBeenCalled()
    expect(record.state.status).toBe('thinking')
    expect(await original.cancelForChildStop(record)).toBe(true)
    expect(sdk.abort).toHaveBeenCalledOnce()
    await original.close()
  })

  it('does not report a started turn when its durable projection fails', async () => {
    const onTurn = vi.fn()
    const runtime = new CopilotAgentRuntime({
      store, tools: { async callTool() { return { ok: true, content: 'unused' } }, cancelPending() {} },
      broadcast: { onState() {}, onTokenDelta() {}, onApprovalRequired() {}, onError() {}, onTurn },
    }, { enabled: true, sessionsDir: dir })
    const record = await store.create({ sessionId: 'uncommitted-observation', agentRuntime: 'copilot', config: createConfig({ tools: [] }) })
    vi.spyOn(store, 'recordRuntimeProjection').mockRejectedValueOnce(new Error('projection unavailable'))
    await runtime.start()
    await expect(runtime.send(record, { text: 'must not be reported' })).rejects.toThrow('projection unavailable')
    expect(onTurn).not.toHaveBeenCalled()
    await runtime.close()
  })

  it.each(['assistant.usage', 'session.error'] as const)(
    'stops a turn without an unhandled rejection when %s cannot be persisted',
    async (type) => {
      const onError = vi.fn()
      const cancelPending = vi.fn()
      const runtime = new CopilotAgentRuntime({
        store, tools: { async callTool() { return { ok: true, content: 'unused' } }, cancelPending },
        broadcast: { onState() {}, onTokenDelta() {}, onApprovalRequired() {}, onError },
      }, { enabled: true, sessionsDir: dir })
      const record = await store.create({
        sessionId: `unpersisted-${type.replace('.', '-')}`,
        agentRuntime: 'copilot',
        config: createConfig({ tools: [] }),
      })
      await runtime.start()
      await runtime.send(record, { text: 'one turn' })
      vi.spyOn(store, 'recordRuntimeProjection').mockRejectedValueOnce(new Error('resource fenced'))
      for (const listener of [...sdk.listeners]) {
        listener({
          type, id: 'fenced-event', timestamp: new Date().toISOString(), parentId: null,
          data: type === 'assistant.usage'
            ? { inputTokens: 1, outputTokens: 1 }
            : { message: 'SDK failed' },
        })
      }
      await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(
        record.sessionId,
        'Session persistence failed; the turn was stopped without replay. Inspect durable state before continuing.',
      ))
      expect(sdk.abort).toHaveBeenCalledOnce()
      expect(cancelPending).toHaveBeenCalledWith(record.sessionId)
      expect(record.state.status).toBe('thinking')
      await runtime.close()
    },
  )

  it('uses an admitted POSIX mount and dedicated SDK client without the whole-file string transport', async () => {
    store = new SessionStore(join(dir, 'sessions'), { authority: new SqliteSessionAuthority(join(dir, 'state.sqlite')) })
    await store.initialize()
    vi.spyOn(store, 'initializeEmptyCopilotNativePosixSession').mockResolvedValue()
    vi.spyOn(store, 'copilotNativePosixSessionFs').mockReturnValue({
      stat: async () => ({ kind: 'directory', bytes: 0, mode: 0o700, modifiedAt: 0, createdAt: 0 }),
      readdir: async () => [], create: async () => {}, mkdir: async () => {}, read: async () => Buffer.alloc(0),
      write: async () => {}, truncate: async () => {}, remove: async () => {}, rename: async () => {},
      chmod: async () => {}, touch: async () => {}, sync: async () => {},
    })
    nativeMount.mount.mockResolvedValue({ baseDirectory: join(dir, 'mounted-home'), close: nativeMount.close,
      assertReady: nativeMount.assertReady })
    const runtime = new CopilotAgentRuntime({
      store, tools: { async callTool() { return { ok: true, content: 'unused' } }, cancelPending() {} },
      broadcast: { onState() {}, onTokenDelta() {}, onApprovalRequired() {}, onError() {} },
    }, { enabled: true, sessionsDir: join(dir, 'sessions'), nativePosixRoot: join(dir, 'operator-mounts') })
    const record = await store.create({ sessionId: 'native-posix-sdk', agentRuntime: 'copilot', config: createConfig({ tools: [] }) })
    sdk.resumeSucceeds = true
    sdk.responses.push({ type: 'assistant.message', id: 'mounted-one', data: { content: 'mounted answer' } })
    await runtime.start()
    await runtime.send(record, { text: 'one', operationId: 'native-posix-one' })
    await vi.waitFor(() => expect(record.state.status).toBe('done'))
    expect(sdk.clientOptions).toHaveLength(2)
    expect(sdk.clientOptions[1]?.baseDirectory).toBe(join(dir, 'mounted-home'))
    expect(sdk.clientOptions.every(options => !('sessionFs' in options))).toBe(true)
    expect(sdk.resumeConfigs[0]).not.toHaveProperty('createSessionFsProvider')
    const sent = sdk.sentMessages.length
    nativeMount.assertReady.mockRejectedValueOnce(new Error('Native POSIX mount is unavailable'))
    await runtime.send(record, { text: 'must not use a disconnected mount', operationId: 'native-posix-lost' })
    expect(record.state.status).toBe('error')
    expect(sdk.sentMessages).toHaveLength(sent)
    await runtime.close()
    expect(nativeMount.close).toHaveBeenCalledOnce()
  })

  it('does not fall back to text or local storage when the POSIX mount broker fails', async () => {
    store = new SessionStore(join(dir, 'sessions'), { authority: new SqliteSessionAuthority(join(dir, 'state.sqlite')) })
    await store.initialize()
    vi.spyOn(store, 'initializeEmptyCopilotNativePosixSession').mockResolvedValue()
    const native = vi.spyOn(store, 'copilotNativePosixSessionFs')
    native.mockImplementation(() => { throw new Error('native authority not admitted') })
    const onError = vi.fn()
    const runtime = new CopilotAgentRuntime({
      store, tools: { async callTool() { return { ok: true, content: 'unused' } }, cancelPending() {} },
      broadcast: { onState() {}, onTokenDelta() {}, onApprovalRequired() {}, onError },
    }, { enabled: true, sessionsDir: join(dir, 'sessions'), nativePosixRoot: join(dir, 'operator-mounts') })
    const record = await store.create({ sessionId: 'native-posix-failed', agentRuntime: 'copilot', config: createConfig({ tools: [] }) })
    await runtime.start()
    await runtime.send(record, { text: 'must not run', operationId: 'native-posix-failed' })
    expect(record.state.status).toBe('error')
    expect(sdk.sentMessages).toHaveLength(0)
    expect(sdk.configs).toHaveLength(0)
    expect(sdk.resumeConfigs).toHaveLength(0)
    expect(onError).toHaveBeenCalledWith(record.sessionId, 'native authority not admitted')
    await runtime.close()
  })

  it('uses native SessionFs for durable authority and preserves the user request when native resume fails', async () => {
    store = new SessionStore(join(dir, 'sessions'), { authority: new SqliteSessionAuthority(join(dir, 'state.sqlite')) })
    await store.initialize()
    const onError = vi.fn()
    const runtime = new CopilotAgentRuntime({
      store,
      tools: { async callTool() { return { ok: true, content: 'unused' } }, cancelPending() {} },
      broadcast: { onState() {}, onTokenDelta() {}, onApprovalRequired() {}, onError },
    }, { enabled: true, sessionsDir: join(dir, 'sessions') })
    const record = await store.create({ sessionId: 'native-sdk', agentRuntime: 'copilot', config: createConfig({ tools: [] }) })
    await runtime.start()
    expect(sdk.clientOptions[0]).toMatchObject({ sessionFs: { sessionStatePath: '/session-state', conventions: 'posix' } })
    sdk.responses.push({ type: 'assistant.message', id: 'native-one', data: { content: 'first answer' } })
    await runtime.send(record, { text: 'keep this conversation', operationId: 'native-first' })
    await vi.waitFor(() => expect(record.state.status).toBe('done'))
    expect(sdk.configs[0]).toHaveProperty('createSessionFsProvider')
    expect(sdk.configs[0]?.workingDirectory).toBe(dir)
    await runtime.close()
    const created = sdk.configs.length
    const sent = sdk.sentMessages.length
    await runtime.start()
    await runtime.send(record, { text: 'continue safely', operationId: 'native-retry' })
    expect(record.state.status).toBe('error')
    expect(record.state.messages.some((message) => message.role === 'user' && JSON.stringify(message).includes('continue safely'))).toBe(true)
    expect(sdk.configs).toHaveLength(created)
    expect(sdk.sentMessages).toHaveLength(sent)
    expect(onError).toHaveBeenCalledWith(record.sessionId, expect.stringContaining('refusing to replace'))
    const persisted = await new SqliteSessionAuthority(join(dir, 'state.sqlite'))
    await persisted.initialize()
    expect((await persisted.load(record.sessionId))?.state).toMatchObject({ status: 'error' })
    await runtime.close()
  })

  it('does not overwrite cancellation when native Session setup subsequently fails', async () => {
    const onError = vi.fn()
    store = new SessionStore(join(dir, 'sessions'), { authority: new SqliteSessionAuthority(join(dir, 'state.sqlite')) })
    await store.initialize()
    const runtime = new CopilotAgentRuntime({
      store, tools: { async callTool() { return { ok: true, content: 'unused' } }, cancelPending() {} },
      broadcast: { onState() {}, onTokenDelta() {}, onApprovalRequired() {}, onError },
    }, { enabled: true, sessionsDir: join(dir, 'sessions') })
    const record = await store.create({ sessionId: 'native-cancel', agentRuntime: 'copilot', config: createConfig({ tools: [] }) })
    await store.recordRuntimeProjection(record.sessionId, {
      ...record.state, cursor: 1,
      messages: [...record.state.messages, { role: 'user', content: [{ type: 'text', text: 'existing conversation' }] }],
    }, 'copilot.user_message', { text: 'existing conversation' })
    await runtime.start()
    let release!: () => void
    sdk.resumeBarrier = new Promise<void>((resolve) => { release = resolve })
    const sending = runtime.send(record, { text: 'cancel before setup', operationId: 'native-cancel-turn' })
    await vi.waitFor(() => expect(sdk.resumeConfigs).toHaveLength(1))
    await runtime.cancel(record)
    release()
    await sending
    expect(record.state.status).toBe('done')
    expect(onError).not.toHaveBeenCalled()
    expect(sdk.sentMessages).toHaveLength(0)
    await runtime.close()
  })

  it('publishes and configures effective low thresholds for inexpensive compaction tests', async () => {
    const runtime = new CopilotAgentRuntime({
      store,
      tools: { async callTool() { return { ok: true, content: 'unused' } }, cancelPending() {} },
      broadcast: {
        onState() {},
        onTokenDelta() {},
        onApprovalRequired() {},
        onError() {},
      },
    }, {
      enabled: true,
      sessionsDir: dir,
      backgroundCompactionThreshold: 0.1,
      bufferExhaustionThreshold: 0.2,
    })

    expect(runtime.descriptor().compactionPolicy).toMatchObject({
      authority: 'runtime',
      automatic: {
        mode: 'background',
        startThreshold: 0.1,
        blockingThreshold: 0.2,
      },
    })

    const record = await store.create({
      sessionId: 'copilot-low-compaction-thresholds',
      agentRuntime: 'copilot',
      config: createConfig({ tools: [] }),
    })
    sdk.responses.push({
      type: 'assistant.message',
      id: 'low-threshold-response',
      timestamp: '2026-08-30T00:00:00.000Z',
      data: { content: 'done', messageId: 'low-threshold-message' },
    })
    await runtime.start()
    await runtime.send(record, { text: 'Use a small synthetic context.' })
    expect(sdk.configs.at(-1)?.infiniteSessions).toEqual({
      enabled: true,
      backgroundCompactionThreshold: 0.1,
      bufferExhaustionThreshold: 0.2,
    })
    await runtime.close()
  })

  it.each([
    [0, 0.2],
    [0.2, 0.2],
    [0.3, 0.2],
    [0.1, 1.1],
  ])('rejects invalid compaction thresholds %s/%s', (background, blocking) => {
    expect(() => new CopilotAgentRuntime({
      store,
      tools: { async callTool() { return { ok: true, content: 'unused' } }, cancelPending() {} },
      broadcast: {
        onState() {},
        onTokenDelta() {},
        onApprovalRequired() {},
        onError() {},
      },
    }, {
      enabled: false,
      sessionsDir: dir,
      backgroundCompactionThreshold: background,
      bufferExhaustionThreshold: blocking,
    })).toThrow(/compaction thresholds/i)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  async function waitForUsage(sessionId: string, inputTokens: number): Promise<void> {
    const deadline = Date.now() + 1000
    while (Date.now() < deadline) {
      if ((store.get(sessionId)?.state.usage.inputTokens ?? 0) >= inputTokens) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`usage projection did not reach ${inputTokens}`)
  }

  it('uses SDK platform-package discovery unless COPILOT_CLI_PATH is supplied', async () => {
    const previous = process.env.COPILOT_CLI_PATH
    try {
      delete process.env.COPILOT_CLI_PATH
      const discovered = new CopilotAgentRuntime({
        store,
        tools: { async callTool() { return { ok: true, content: '' } }, cancelPending() {} },
        broadcast: { onState() {}, onTokenDelta() {}, onApprovalRequired() {}, onError() {} },
      }, { enabled: true, sessionsDir: dir })
      await discovered.start()
      expect(sdk.clientOptions.at(-1)?.connection).toEqual({
        kind: 'stdio',
        args: ['--no-remote-export'],
      })
      await discovered.close()

      process.env.COPILOT_CLI_PATH = '/opt/copilot/bin/copilot'
      const unitRoot = join(dir, 'new-pg-unit')
      const baseDirectory = join(unitRoot, 'copilot-runtime')
      expect(existsSync(unitRoot)).toBe(false)
      const overridden = new CopilotAgentRuntime({
        store,
        tools: { async callTool() { return { ok: true, content: '' } }, cancelPending() {} },
        broadcast: { onState() {}, onTokenDelta() {}, onApprovalRequired() {}, onError() {} },
      }, { enabled: true, sessionsDir: join(unitRoot, 'sessions') })
      await overridden.start()
      expect(sdk.clientOptions.at(-1)?.connection?.path).toBe('/opt/copilot/bin/copilot')
      expect(sdk.clientOptions.at(-1)?.baseDirectory).toBe(baseDirectory)
      expect(readdirSync(baseDirectory)).toEqual([])
      if (process.platform !== 'win32') expect(statSync(baseDirectory).mode & 0o777).toBe(0o700)
      await overridden.close()
    } finally {
      if (previous === undefined) delete process.env.COPILOT_CLI_PATH
      else process.env.COPILOT_CLI_PATH = previous
    }
  })

  it('materializes the packaged Copilot runtime beside writable session storage', async () => {
    const releaseDir = join(dir, 'release')
    const sessionsDir = join(dir, 'state', 'sessions')
    const target = `${process.platform}-${process.arch}`
    mkdirSync(releaseDir, { recursive: true })
    writeFileSync(join(releaseDir, `kala-copilot-runtime-${target}`), 'runtime-wrapper')
    writeFileSync(join(releaseDir, `kala-copilot-runtime-node-${target}.node`), 'runtime-library')
    const runtime = new CopilotAgentRuntime({
      store,
      tools: { async callTool() { return { ok: true, content: '' } }, cancelPending() {} },
      broadcast: { onState() {}, onTokenDelta() {}, onApprovalRequired() {}, onError() {} },
    }, {
      enabled: true,
      sessionsDir,
      runtimeEntryPath: join(releaseDir, 'kala-runtime.cjs'),
    })

    await runtime.start()

    const materialized = sdk.clientOptions.at(-1)?.connection?.path
    expect(materialized).toBe(join(dir, 'state', 'copilot-runtime', `sdk-1.0.14-${target}`, 'copilot-runtime'))
    expect(existsSync(materialized!)).toBe(true)
    expect(readFileSync(join(dirname(materialized!), 'runtime.node'), 'utf8')).toBe('runtime-library')
    await runtime.close()
  })

  it('stops only the local turn when even its asynchronous error projection is rejected', async () => {
    const onError = vi.fn()
    const runtime = new CopilotAgentRuntime({
      store, tools: { async callTool() { return { ok: true, content: '' } }, cancelPending() {} },
      broadcast: { onState() {}, onTokenDelta() {}, onApprovalRequired() {}, onError },
    }, { enabled: true, sessionsDir: dir })
    const record = await store.create({ sessionId: 'projection-failure', agentRuntime: 'copilot', config: createConfig({ tools: [] }) })
    const original = store.recordRuntimeProjection.bind(store)
    vi.spyOn(store, 'recordRuntimeProjection').mockImplementation(async (...args) => {
      if (args[2] === 'copilot.session_error') throw new Error('storage rejected error projection')
      await original(...args)
    })
    sdk.responses.push(new Error('provider turn failed'))
    await runtime.start()
    await runtime.send(record, { text: 'one accepted input', operationId: 'accepted-before-projection-failure' })
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(record.sessionId, expect.stringContaining('without replay')))
    expect(record.state.cursor).toBe(1)
    expect(record.state.status).toBe('thinking')
    expect(sdk.abort).toHaveBeenCalled()
    await runtime.close()
  })

  it('reports a missing SDK CLI clearly instead of silently disabling Copilot', async () => {
    sdk.startError = new Error('Could not resolve a @github/copilot platform package')
    const runtime = new CopilotAgentRuntime({
      store,
      tools: { async callTool() { return { ok: true, content: '' } }, cancelPending() {} },
      broadcast: { onState() {}, onTokenDelta() {}, onApprovalRequired() {}, onError() {} },
    }, { enabled: true, sessionsDir: dir })

    await runtime.start()

    expect(runtime.descriptor()).toMatchObject({
      available: false,
      status: 'unavailable',
      reason: expect.stringContaining('set COPILOT_CLI_PATH'),
    })
  })

  it('persists a model-change notice only after the SDK accepts the model', async () => {
    const runtime = new CopilotAgentRuntime({
      store,
      tools: { async callTool() { return { ok: true, content: '' } }, cancelPending() {} },
      broadcast: {
        onState() {},
        onTokenDelta() {},
        onApprovalRequired() {},
        onError() {},
      },
    }, {
      enabled: true,
      sessionsDir: dir,
    })
    const record = await store.create({
      sessionId: 'copilot-model-session',
      agentRuntime: 'copilot',
      config: createConfig({ tools: [] }),
    })
    await store.updatePreferences(record.sessionId, { selectedModel: 'gpt-old' })

    await runtime.start()
    await runtime.setModel(record, 'gpt-new')
    await runtime.confirmModelChange(record, 'gpt-old', 'gpt-new')

    expect(sdk.setModel).toHaveBeenCalledWith('gpt-new')
    expect(store.get(record.sessionId)?.state.messages.at(-1)).toMatchObject({
      role: 'system',
      metadata: { kind: 'model_changed', from: 'gpt-old', to: 'gpt-new' },
    })

    sdk.setModel.mockRejectedValueOnce(new Error('model unavailable'))
    await expect(runtime.setModel(record, 'gpt-broken')).rejects.toThrow('model unavailable')
    expect(store.get(record.sessionId)?.state.messages).toHaveLength(1)
  })

  it.each(['partial', 'unconfirmed'])('gives the SDK model actionable failure text rather than only a code: %s', async (kind) => {
    const name = kind === 'partial' ? 'read_files' : 'shell'
    const failure = { code: kind === 'partial' ? 'EPARTIAL' : 'transport_lost', category: 'execution', outcome: kind === 'partial' ? 'failed' : 'indeterminate', retryable: false, responsibility: 'system' } as const
    const content = kind === 'partial' ? 'ERROR: EPARTIAL: .' : 'acknowledgement missing'
    const runtime = new CopilotAgentRuntime({
      store,
      tools: { callTool: async () => ({ ok: false, content, failure }), cancelPending() {} },
      broadcast: { onState() {}, onTokenDelta() {}, onApprovalRequired() {}, onError() {} },
    }, { enabled: true, sessionsDir: dir })
    const record = await store.create({
      sessionId: 'copilot-error-feedback', agentRuntime: 'copilot',
      config: createConfig({ tools: [{ name, description: 'Test failure feedback', inputSchema: { type: 'object' }, requiresApproval: false }] }),
    })
    await runtime.start()
    await runtime.send(record, { text: 'Inspect the result.', model: 'gpt-5.4-mini' })
    const result = await sdk.configs.at(-1)?.tools.find((tool) => tool.name === name)?.handler({}, { toolCallId: 'error-feedback-call' })
    expect(result?.resultType).toBe('failure')
    expect(result?.textResultForLlm).toContain('What happened:')
    expect(result?.textResultForLlm).toContain('Next step:')
    expect(result?.textResultForLlm).toContain(content)
    expect(result?.error).toBe(result?.textResultForLlm)
    expect(result?.textResultForLlm).toContain(kind === 'partial' ? 'details are missing or truncated' : 'side effects are unknown')
    const stored = store.get(record.sessionId)?.state.messages.flatMap((message) => message.content).find((item) => item.type === 'tool_result' && item.callId === 'error-feedback-call')
    expect(stored?.type === 'tool_result' ? stored.content : undefined).toBe(result?.textResultForLlm)
  })

  it('delegates an SDK custom tool call to the configured runtime dispatcher', async () => {
    const callTool = vi.fn(async () => ({ ok: true, content: 'host tool result' }))
    const tools: ToolDispatcher = {
      callTool,
      cancelPending() {},
    }
    const runtime = new CopilotAgentRuntime({
      store,
      tools,
      broadcast: {
        onState() {},
        onTokenDelta() {},
        onApprovalRequired() {},
        onError() {},
      },
    }, {
      enabled: true,
      sessionsDir: dir,
    })
    const record = await store.create({
      sessionId: 'copilot-tool-session',
      agentRuntime: 'copilot',
      initialCwd: '/workspace/only-on-the-executor',
      config: createConfig({
        systemPrompt: 'This is the saved Kala session prompt.',
        tools: [{
          name: 'todo_graph',
          description: 'Update the task graph',
          inputSchema: { type: 'object' },
          requiresApproval: false,
          executionKind: 'host',
          executionHandler: 'todo_graph',
        }],
      }),
    })

    await runtime.start()
    await runtime.send(record, { text: 'Use todo_graph.', model: 'gpt-5.4-mini' })
    const tool = sdk.configs.at(-1)?.tools.find((candidate) => candidate.name === 'todo_graph')
    expect(tool).toBeDefined()
    expect(tool?.overridesBuiltInTool).toBe(true)
    expect(sdk.clientOptions).toHaveLength(1)
    expect(sdk.clientOptions[0]?.connection).toEqual({
      kind: 'stdio',
      args: ['--no-remote-export'],
    })
    expect(sdk.configs.at(-1)?.workingDirectory).toBe(join(dir, '..'))
    expect(sdk.configs.at(-1)?.remoteSession).toBe('off')
    expect(sdk.configs.at(-1)?.systemMessage).toEqual({ mode: 'replace', content: 'This is the saved Kala session prompt.' })
    expect(sdk.configs.at(-1)).toMatchObject({
      streaming: true,
      additionalDirectories: [],
      skipEmbeddingRetrieval: true,
      embeddingCacheStorage: 'in-memory',
      enableOnDemandInstructionDiscovery: false,
      enableFileHooks: false,
      enableHostGitOperations: false,
      enableSessionStore: false,
      enableSkills: false,
    })
    expect(sdk.configs.at(-1)?.infiniteSessions).toEqual({
      enabled: true,
      backgroundCompactionThreshold: 0.8,
      bufferExhaustionThreshold: 0.95,
    })
    expect(runtime.descriptor()).toMatchObject({
      capabilities: { queue: true, modelSelection: true, attachments: true },
      models: [{
        ref: 'gpt-5.4-mini',
        id: 'gpt-5.4-mini',
        label: 'GPT-5.4 mini',
        providerId: 'github-copilot',
        contextWindow: 128_000,
      }],
    })

    expect(sdk.setModel).toHaveBeenCalledWith('gpt-5.4-mini')

    const result = await tool?.handler(
      { operations: [{ op: 'clear' }] },
      { toolCallId: 'copilot-call-1' },
    )

    expect(callTool).toHaveBeenCalledWith('copilot-tool-session', {
      kind: 'call_tool',
      callId: 'copilot-call-1',
      name: 'todo_graph',
      input: { operations: [{ op: 'clear' }] },
      cwd: '/workspace/only-on-the-executor',
    })
    expect(result).toEqual({
      textResultForLlm: 'host tool result',
      resultType: 'success',
    })
    const state = store.get(record.sessionId)?.state
    expect(state?.messages.flatMap((message) => message.content)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'tool_call',
        callId: 'copilot-call-1',
        name: 'todo_graph',
      }),
      expect.objectContaining({
        type: 'tool_result',
        callId: 'copilot-call-1',
        ok: true,
        content: 'host tool result',
      }),
    ]))
    await runtime.close()
  })

  it('forwards pasted images to the Copilot SDK as blob attachments', async () => {
    const runtime = new CopilotAgentRuntime({
      store,
      tools: { async callTool() { return { ok: true, content: 'unused' } }, cancelPending() {} },
      broadcast: {
        onState() {},
        onTokenDelta() {},
        onApprovalRequired() {},
        onError() {},
      },
    }, { enabled: true, sessionsDir: dir })
    const record = await store.create({
      sessionId: 'copilot-image-session',
      agentRuntime: 'copilot',
      config: createConfig({ tools: [] }),
    })
    await runtime.start()
    sdk.responses.push({
      type: 'assistant.message',
      data: { content: 'I can see it.', messageId: 'message-image' },
      id: 'event-image',
      timestamp: new Date().toISOString(),
    })

    await runtime.send(record, {
      operationId: 'fingerprinted-image',
      text: 'Describe this screenshot.',
      content: [
        { type: 'text', text: 'Describe this screenshot.' },
        {
          type: 'image',
          source: {
            kind: 'base64',
            mediaType: 'image/png',
            data: 'iVBORw0KGgo=',
          },
        },
      ],
    })
    await vi.waitFor(() => expect(store.get(record.sessionId)?.state.status).toBe('done'))
    const lookup = await findSessionOperation(record.logPath, 'fingerprinted-image')
    expect(lookup).toMatchObject({
      kind: 'runtime_metadata',
      action: 'copilot.user_message',
      requestFingerprint: messageOperationFingerprint('Describe this screenshot.', [
        { type: 'text', text: 'Describe this screenshot.' },
        { type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: 'iVBORw0KGgo=' } },
      ]),
    })
    const history = await readSessionLog(record.logPath, { allowExternalRuntime: true })
    const userProjection = history.runtimeMetadata.find((entry) => entry.action === 'copilot.user_message')
    expect(JSON.stringify(userProjection?.payload)).not.toContain('iVBORw0KGgo=')

    expect(sdk.sentMessages).toContainEqual(expect.objectContaining({
      prompt: 'Describe this screenshot.',
      attachments: [{
        type: 'blob',
        data: 'iVBORw0KGgo=',
        mimeType: 'image/png',
      }],
    }))
    expect(store.get(record.sessionId)?.state.messages[0]).toMatchObject({
      role: 'user',
      content: expect.arrayContaining([
        expect.objectContaining({ type: 'image' }),
      ]),
    })
    await runtime.close()
  })

  it('forwards stored WebP images as inline SDK blobs without filesystem-like names', async () => {
    const messageAttachments = new MessageAttachmentStore(join(dir, 'message-attachments'))
    const imageData = Buffer.from('RIFF\\x04\\x00\\x00\\x00WEBP', 'binary')
    const reference = await messageAttachments.register({
      sessionId: 'copilot-reference-image',
      name: 'pasted-image-1.webp',
      mediaType: 'image/webp',
      data: imageData,
    })
    const runtime = new CopilotAgentRuntime({
      store,
      messageAttachments,
      tools: { async callTool() { return { ok: true, content: 'unused' } }, cancelPending() {} },
      broadcast: {
        onState() {},
        onTokenDelta() {},
        onApprovalRequired() {},
        onError() {},
      },
    }, { enabled: true, sessionsDir: dir })
    const record = await store.create({
      sessionId: 'copilot-reference-image',
      agentRuntime: 'copilot',
      config: createConfig({ tools: [] }),
    })
    await runtime.start()
    sdk.responses.push({
      type: 'assistant.message',
      data: { content: 'Reviewed.', messageId: 'message-reference-image' },
      id: 'event-reference-image',
      timestamp: new Date().toISOString(),
    })

    await runtime.send(record, {
      text: 'Review this screenshot.',
      content: [{ type: 'text', text: 'Review this screenshot.' }, reference],
    })
    await vi.waitFor(() => expect(store.get(record.sessionId)?.state.status).toBe('done'))

    expect(sdk.sentMessages.at(-1)?.attachments).toEqual([{
      type: 'blob',
      data: imageData.toString('base64'),
      mimeType: 'image/webp',
    }])
    await runtime.close()
  })

  it('forwards generic files to the Copilot SDK as named blob attachments', async () => {
    const runtime = new CopilotAgentRuntime({
      store,
      tools: { async callTool() { return { ok: true, content: 'unused' } }, cancelPending() {} },
      broadcast: {
        onState() {},
        onTokenDelta() {},
        onApprovalRequired() {},
        onError() {},
      },
    }, { enabled: true, sessionsDir: dir })
    const record = await store.create({
      sessionId: 'copilot-file-session',
      agentRuntime: 'copilot',
      config: createConfig({ tools: [] }),
    })
    await runtime.start()
    sdk.responses.push({
      type: 'assistant.message',
      data: { content: 'Reviewed.', messageId: 'message-file' },
      id: 'event-file',
      timestamp: new Date().toISOString(),
    })

    await runtime.send(record, {
      text: 'Review this file.',
      content: [
        { type: 'text', text: 'Review this file.' },
        {
          type: 'file',
          name: 'config.json',
          mediaType: 'application/json',
          data: 'eyJvayI6dHJ1ZX0=',
        },
      ],
    })
    await vi.waitFor(() => expect(store.get(record.sessionId)?.state.status).toBe('done'))

    expect(sdk.sentMessages).toContainEqual(expect.objectContaining({
      prompt: 'Review this file.',
      attachments: [{
        type: 'blob',
        data: 'eyJvayI6dHJ1ZX0=',
        mimeType: 'application/json',
        displayName: 'config.json',
      }],
    }))
    await runtime.close()
  })

  it('resolves Host file references to SDK blobs without exposing Host-only paths or persisting base64', async () => {
    const messageAttachments = new MessageAttachmentStore(join(dir, 'message-attachments'))
    const reference = await messageAttachments.register({
      sessionId: 'copilot-reference-session',
      name: '../config.json',
      mediaType: 'application/json',
      data: Buffer.from('{"ok":true}', 'utf8'),
    })
    const runtime = new CopilotAgentRuntime({
      store,
      messageAttachments,
      tools: { async callTool() { return { ok: true, content: 'unused' } }, cancelPending() {} },
      broadcast: {
        onState() {},
        onTokenDelta() {},
        onApprovalRequired() {},
        onError() {},
      },
    }, { enabled: true, sessionsDir: dir })
    const record = await store.create({
      sessionId: 'copilot-reference-session',
      agentRuntime: 'copilot',
      config: createConfig({ tools: [] }),
    })
    await runtime.start()
    sdk.responses.push({
      type: 'assistant.message',
      data: { content: 'Reviewed.', messageId: 'message-reference-file' },
      id: 'event-reference-file',
      timestamp: new Date().toISOString(),
    })

    await runtime.send(record, {
      text: 'Review this file.',
      content: [{ type: 'text', text: 'Review this file.' }, reference],
    })
    await vi.waitFor(() => expect(store.get(record.sessionId)?.state.status).toBe('done'))

    expect(sdk.sentMessages).toContainEqual(expect.objectContaining({
      prompt: 'Review this file.',
      attachments: [{
        type: 'blob',
        data: Buffer.from('{"ok":true}', 'utf8').toString('base64'),
        mimeType: 'application/json',
        displayName: 'config.json',
      }],
    }))
    expect(JSON.stringify(sdk.sentMessages)).not.toContain(messageAttachments.resolve(record.sessionId, reference).path)
    const config = sdk.configs.at(-1)
    expect(config?.workingDirectory).toBe(join(dir, '..'))
    expect(config?.availableTools).toContain('builtin:view')
    expect(config?.excludedTools).toEqual(['mcp:*'])
    const path = messageAttachments.resolve(record.sessionId, reference).path
    expect(config?.onPermissionRequest?.({ kind: 'read', path })).toEqual({ kind: 'approve-once' })
    expect(config?.onPermissionRequest?.({ kind: 'read', path: join(dir, 'secret.txt') })).toMatchObject({ kind: 'reject' })
    expect(config?.onPermissionRequest?.({ kind: 'read', path, managedApprovalRequired: true })).toMatchObject({ kind: 'reject' })
    const persisted = readFileSync(snapshotSidecarPath(record.logPath), 'utf8')
    expect(persisted).toContain(reference.source.attachmentId)
    expect(persisted).not.toContain(Buffer.from('{"ok":true}', 'utf8').toString('base64'))
    await runtime.close()
  })

  it('lets Copilot read oversized text attachments in bounded chunks without sending an omitted SDK blob', async () => {
    const messageAttachments = new MessageAttachmentStore(join(dir, 'message-attachments'))
    const savedChunks: Buffer[] = []
    let executorAvailable = true
    const executorTools: ToolDispatcher = {
      async callTool() {
        throw new Error('internal transfers must not use the model tool dispatch entry')
      },
      async callHostAttachmentTransfer(_sessionId, effect) {
        if (!executorAvailable) return { ok: false, content: 'Update the Executor for this workspace to save Session attachments.',
          failure: { code: 'executor_update_required', category: 'precondition', outcome: 'blocked', retryable: true, responsibility: 'workspace' } }
        expect(effect.name).toBe('__workspace_attachment_transfer')
        const { action, offset, data, path, bytes, sha256 } = effect.input
        if (action === 'chunk') {
          expect(offset).toBe(savedChunks.reduce((total, chunk) => total + chunk.length, 0))
          const chunk = Buffer.from(String(data), 'base64')
          expect(chunk.length).toBeLessThanOrEqual(128 * 1024)
          savedChunks.push(chunk)
          return { ok: true, content: JSON.stringify({ ok: true, nextOffset: Number(offset) + chunk.length }) }
        }
        if (action === 'finish') {
          expect(Buffer.concat(savedChunks).equals(Buffer.from(text))).toBe(true)
          return { ok: true, content: JSON.stringify({ ok: true, state: 'completed', path, bytes, sha256 }) }
        }
        return { ok: true, content: JSON.stringify({ ok: true, state: 'active', nextOffset: 0 }) }
      },
      cancelPending() {},
    }
    const runtime = new CopilotAgentRuntime({
      store,
      messageAttachments,
      tools: {
        async callTool(sessionId, effect) {
          return await runSessionAttachmentTool({ store, messageAttachments, tools: executorTools }, sessionId, effect)
        },
        cancelPending() {},
      },
      broadcast: {
        onState() {},
        onTokenDelta() {},
        onApprovalRequired() {},
        onError() {},
      },
    }, { enabled: true, sessionsDir: dir })
    const record = await store.create({
      sessionId: 'oversized-attachment-session',
      agentRuntime: 'copilot',
      config: createConfig({ tools: [createBuiltinTools().find((tool) => tool.name === 'session_attachment')!] }),
    })
    const text = '{"payload":"' + 'x'.repeat(9 * 1024 * 1024) + '"}'
    const reference = await messageAttachments.register({
      sessionId: record.sessionId, name: 'snapshot.json', mediaType: 'application/json', data: Buffer.from(text),
    })
    await runtime.start()
    sdk.responses.push({
      type: 'assistant.message',
      data: { content: 'I can read the attached file.', messageId: 'oversized-reply' },
      id: 'oversized-event',
      timestamp: new Date().toISOString(),
    })
    await runtime.send(record, {
      text: 'Read my snapshot.',
      content: [{ type: 'text', text: 'Read my snapshot.' }, reference],
    })
    await vi.waitFor(() => expect(store.get(record.sessionId)?.state.status).toBe('done'))

    expect(sdk.sentMessages.at(-1)).toMatchObject({
      prompt: expect.stringContaining(reference.source.attachmentId),
    })
    expect(sdk.sentMessages.at(-1)).not.toHaveProperty('attachments')
    const tool = sdk.configs.at(-1)?.tools.find((item) => item.name === 'session_attachment')
    expect(tool).toBeDefined()
    const excerpt = await tool!.handler({ action: 'read_text', attachmentId: reference.source.attachmentId, offset: text.length - 4, maxChars: 4 }, { toolCallId: 'read-tail' })
    expect(excerpt.textResultForLlm).toContain(`characters ${text.length - 4}-${text.length} of ${text.length}`)
    expect(excerpt.textResultForLlm).toContain('x"}')
    const search = await tool!.handler({ action: 'search_text', attachmentId: reference.source.attachmentId, query: 'PAYLOAD' }, { toolCallId: 'search-key' })
    expect(search.textResultForLlm).toContain('1 match(es)')
    expect(search.textResultForLlm).toContain('2: ')
    const foreign = await messageAttachments.register({
      sessionId: 'another-session', name: 'private.json', mediaType: 'application/json', data: Buffer.from('{"private":true}'),
    })
    const denied = await tool!.handler({ action: 'read_text', attachmentId: foreign.source.attachmentId }, { toolCallId: 'read-foreign' })
    expect(denied.textResultForLlm).toContain('not referenced by a user message')
    const saved = await runSessionAttachmentTool(
      { store, messageAttachments, tools: executorTools },
      record.sessionId,
      { kind: 'call_tool', callId: 'save-original', name: 'session_attachment', input: {
        action: 'save', attachmentId: reference.source.attachmentId, path: '/workspace/snapshot.json',
      } },
    )
    expect(saved).toMatchObject({ ok: true, content: expect.stringContaining('/workspace/snapshot.json') })
    expect(savedChunks.length).toBeGreaterThan(1)
    savedChunks.length = 0
    const pendingSave = tool!.handler({
      action: 'save', attachmentId: reference.source.attachmentId, path: '/workspace/snapshot.json',
    }, { toolCallId: 'save-awaiting-approval' })
    await vi.waitFor(() => expect(store.get(record.sessionId)?.state.pendingCalls)
      .toEqual(expect.arrayContaining([expect.objectContaining({ callId: 'save-awaiting-approval', status: 'awaiting_approval' })])))
    expect(savedChunks).toHaveLength(0)
    await runtime.reject(record, 'save-awaiting-approval')
    expect((await pendingSave).textResultForLlm).toContain('rejected')
    expect(savedChunks).toHaveLength(0)
    executorAvailable = false
    const failedSave = tool!.handler({
      action: 'save', attachmentId: reference.source.attachmentId, path: '/workspace/snapshot.json',
    }, { toolCallId: 'save-outdated-executor' })
    await vi.waitFor(() => expect(store.get(record.sessionId)?.state.pendingCalls)
      .toEqual(expect.arrayContaining([expect.objectContaining({ callId: 'save-outdated-executor', status: 'awaiting_approval' })])))
    await runtime.approve(record, 'save-outdated-executor')
    expect((await failedSave).textResultForLlm).toContain('Update the Executor')
    expect(store.get(record.sessionId)?.state.pendingCalls).toHaveLength(0)
    await runtime.close()
  })

  it('externalizes inline user images before persisting an external Runtime snapshot', async () => {
    const messageAttachments = new MessageAttachmentStore(join(dir, 'message-attachments'))
    const runtime = new CopilotAgentRuntime({
      store,
      messageAttachments,
      tools: { async callTool() { return { ok: true, content: 'unused' } }, cancelPending() {} },
      broadcast: { onState() {}, onTokenDelta() {}, onApprovalRequired() {}, onError() {} },
    }, { enabled: true, sessionsDir: dir })
    const record = await store.create({
      sessionId: 'copilot-inline-image', agentRuntime: 'copilot', config: createConfig({ tools: [] }),
    })
    await runtime.start()
    const imageData = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64')
    sdk.responses.push({
      type: 'assistant.message', data: { content: 'Seen.', messageId: 'message-image-seen' },
      id: 'event-image-seen', timestamp: new Date().toISOString(),
    })
    await runtime.send(record, {
      text: 'Inspect this image.',
      content: [{ type: 'text', text: 'Inspect this image.' }, { type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: imageData } }],
    })
    await vi.waitFor(() => expect(store.get(record.sessionId)?.state.status).toBe('done'))
    const userImage = store.get(record.sessionId)?.state.messages[0]?.content[1]
    expect(userImage).toMatchObject({ type: 'file', mediaType: 'image/png', source: { kind: 'host_ref' } })
    const persisted = readFileSync(snapshotSidecarPath(record.logPath), 'utf8')
    expect(persisted).not.toContain(imageData)
    expect(sdk.sentMessages.at(-1)?.attachments).toEqual([expect.objectContaining({ type: 'blob', data: imageData, mimeType: 'image/png' })])
    await runtime.close()
  })

  it('projects native Copilot usage and compaction lifecycle events', async () => {
    const onState = vi.fn()
    const onCompactStatus = vi.fn()
    const runtime = new CopilotAgentRuntime({
      store,
      tools: { async callTool() { return { ok: true, content: 'unused' } }, cancelPending() {} },
      broadcast: {
        onState,
        onTokenDelta() {},
        onApprovalRequired() {},
        onError() {},
        onCompactStatus,
      },
    }, { enabled: true, sessionsDir: dir })
    const record = await store.create({
      sessionId: 'copilot-native-compaction',
      agentRuntime: 'copilot',
      config: createConfig({ tools: [] }),
    })
    await store.updatePreferences(record.sessionId, { selectedModel: 'gpt-5.4-mini' })
    await runtime.start()
    await runtime.send(record, { text: 'Observe context.', model: 'gpt-5.4-mini' })

    expect(sdk.listeners.length).toBeGreaterThanOrEqual(1)
    const emit = (event: unknown): void => {
      for (const listener of sdk.listeners) listener(event)
    }
    emit({
      type: 'session.usage_info',
      id: 'usage-1',
      parentId: null,
      timestamp: '2026-08-30T00:00:00.000Z',
      ephemeral: true,
      data: {
        currentTokens: 100_000,
        tokenLimit: 128_000,
        messagesLength: 20,
        systemTokens: 2_000,
        conversationTokens: 94_000,
        toolDefinitionsTokens: 4_000,
      },
    })
    emit({
      type: 'assistant.usage',
      id: 'assistant-usage-1',
      parentId: null,
      timestamp: '2026-08-30T00:00:00.500Z',
      data: {
        model: 'gpt-5.4-mini',
        inputTokens: 91_000,
        outputTokens: 1_700,
        cacheReadTokens: 20_000,
        cacheWriteTokens: 3_000,
        apiCallId: 'api-usage-1',
      },
    })
    await vi.waitFor(() => expect(onState.mock.calls.some((call) =>
      (call[2] as ContextUsageSnapshot | undefined)?.usage.inputTokens === 100_000
    )).toBe(true))
    await waitForUsage(record.sessionId, 91_000)
    expect(store.get(record.sessionId)?.state.usage).toMatchObject({
      inputTokens: 91_000,
      outputTokens: 1_700,
      cacheReadTokens: 20_000,
      cacheCreationTokens: 3_000,
    })
    emit({
      type: 'session.compaction_start',
      id: 'compact-start-1',
      parentId: null,
      timestamp: '2026-08-30T00:00:01.000Z',
      data: { currentTokens: 104_000, tokenLimit: 128_000, trigger: 'threshold' },
    })
    await vi.waitFor(() => expect(record.state.messages.some((message) =>
      message.metadata?.kind === 'context_compaction' && message.metadata.phase === 'running'
    )).toBe(true))
    emit({
      type: 'session.compaction_start',
      id: 'subagent-compact-start',
      parentId: null,
      timestamp: '2026-08-30T00:00:01.500Z',
      agentId: 'research-agent',
      data: { currentTokens: 90_000, tokenLimit: 128_000, trigger: 'threshold' },
    })
    await store.recordRuntimeProjection(record.sessionId, {
      ...record.state,
      cursor: record.state.cursor + 1,
      messages: [...record.state.messages, {
        role: 'assistant',
        content: [{ type: 'text', text: 'Output completed while compaction was active.' }],
      }],
    }, 'copilot.assistant_message', { concurrentWithCompaction: true })
    emit({
      type: 'session.compaction_complete',
      id: 'compact-complete-1',
      parentId: 'compact-start-1',
      timestamp: '2026-08-30T00:00:02.000Z',
      data: {
        success: true,
        preCompactionTokens: 104_000,
        postCompactionTokens: 32_000,
        systemTokens: 2_000,
        conversationTokens: 32_000,
        tokenLimit: 128_000,
        messagesRemoved: 30,
        summaryContent: '# Compacted Context\n\nPreserve the current task.',
      },
    })
    await vi.waitFor(() => expect(onCompactStatus).toHaveBeenCalledTimes(3))

    expect(onState).toHaveBeenCalledWith(expect.objectContaining({ sessionId: record.sessionId }), expect.any(Object), expect.objectContaining({
      contextWindow: { tokens: 128_000, source: 'api_reported' },
      usage: { inputTokens: 100_000, totalTokens: 100_000 },
      estimator: expect.objectContaining({
        total: { kind: 'provider_reported', confidence: 'exact' },
      }),
    }))
    expect(onState).toHaveBeenCalledWith(expect.objectContaining({ sessionId: record.sessionId }), expect.any(Object), expect.objectContaining({
      contextWindow: { tokens: 128_000, source: 'api_reported' },
      usage: { inputTokens: 104_000, totalTokens: 104_000 },
    }))
    expect(onCompactStatus).toHaveBeenNthCalledWith(1, expect.objectContaining({
      sessionId: record.sessionId,
      kind: 'running',
      trigger: 'auto',
      tokensBefore: 104_000,
      attemptId: 'compact-start-1',
      startedAt: '2026-08-30T00:00:01.000Z',
      authority: 'runtime',
      scope: { kind: 'root' },
      startSnapshot: expect.objectContaining({ usage: { inputTokens: 104_000, totalTokens: 104_000 } }),
    }))
    expect(onCompactStatus).toHaveBeenNthCalledWith(3, expect.objectContaining({
      sessionId: record.sessionId,
      kind: 'done',
      attemptId: 'compact-start-1',
      tokensBefore: 104_000,
      tokensAfter: 32_000,
      trigger: 'auto',
      replacedCount: 30,
      summary: '# Compacted Context\n\nPreserve the current task.',
      endedAt: '2026-08-30T00:00:02.000Z',
      authority: 'runtime',
      scope: { kind: 'root' },
      summaryValidation: 'runtime_reported',
      completionSnapshot: expect.objectContaining({ usage: { inputTokens: 32_000, totalTokens: 32_000 } }),
    }))
    const compactMarkerIndex = record.state.messages.findIndex((message) =>
      message.metadata?.kind === 'context_compaction'
    )
    const concurrentOutputIndex = record.state.messages.findIndex((message) =>
      message.content.some((content) => content.type === 'text' && content.text === 'Output completed while compaction was active.')
    )
    expect(compactMarkerIndex).toBeGreaterThanOrEqual(0)
    expect(concurrentOutputIndex).toBeGreaterThan(compactMarkerIndex)
    expect(record.state.messages[compactMarkerIndex]?.metadata).toMatchObject({
      kind: 'context_compaction',
      phase: 'done',
      summary: '# Compacted Context\n\nPreserve the current task.',
    })
    expect(onState).toHaveBeenCalledWith(expect.objectContaining({ sessionId: record.sessionId }), expect.any(Object), expect.objectContaining({
      usage: { inputTokens: 32_000, totalTokens: 32_000 },
    }))

    const rootMessageCount = record.state.messages.length
    emit({
      type: 'session.usage_info',
      id: 'subagent-usage',
      parentId: null,
      timestamp: '2026-08-30T00:00:02.500Z',
      ephemeral: true,
      agentId: 'research-agent',
      data: { currentTokens: 90_000, tokenLimit: 128_000, messagesLength: 12 },
    })
    expect(onState.mock.calls.some((call) =>
      (call[2] as ContextUsageSnapshot | undefined)?.usage.inputTokens === 90_000
    )).toBe(false)
    emit({
      type: 'session.compaction_complete',
      id: 'subagent-compact-complete',
      parentId: 'subagent-compact-start',
      timestamp: '2026-08-30T00:00:04.000Z',
      agentId: 'research-agent',
      data: {
        success: true,
        preCompactionTokens: 90_000,
        postCompactionTokens: 20_000,
        tokenLimit: 128_000,
        trigger: 'threshold',
      },
    })
    await vi.waitFor(() => expect(onCompactStatus).toHaveBeenCalledTimes(4))
    expect(onCompactStatus).toHaveBeenNthCalledWith(2, expect.objectContaining({
      kind: 'running',
      scope: { kind: 'subagent', agentId: 'research-agent' },
    }))
    expect(onCompactStatus).toHaveBeenNthCalledWith(4, expect.objectContaining({
      kind: 'done',
      scope: { kind: 'subagent', agentId: 'research-agent' },
    }))
    expect(record.state.messages).toHaveLength(rootMessageCount)
    await runtime.close()
  })

  it('keeps per-call usage separate from current context and ignores stale snapshots', async () => {
    const snapshots: ContextUsageSnapshot[] = []
    const runtime = new CopilotAgentRuntime({
      store,
      tools: { async callTool() { return { ok: true, content: 'tool output' } }, cancelPending() {} },
      broadcast: {
        onState(record, _state, snapshot) {
          if (!snapshot) return
          snapshots.push(snapshot)
          void store.updateRuntimeContextSnapshot(record, snapshot)
        },
        onTokenDelta() {},
        onApprovalRequired() {},
        onError() {},
      },
    }, { enabled: true, sessionsDir: dir })
    const record = await store.create({
      sessionId: 'copilot-autonomous-context',
      agentRuntime: 'copilot',
      config: createConfig({
        tools: [{
          name: 'inspect',
          description: 'Inspect something',
          inputSchema: { type: 'object' },
          requiresApproval: false,
          executionKind: 'host',
          executionHandler: 'inspect',
        }],
      }),
    })
    await store.updatePreferences(record.sessionId, { selectedModel: 'gpt-5.4-mini' })
    sdk.responses.push({
      type: 'assistant.message', id: 'first-response', timestamp: '2026-09-26T14:00:00.000Z',
      data: { content: 'Working.', messageId: 'first-message' },
    })
    await runtime.start()
    await runtime.send(record, { text: 'Inspect twice.', model: 'gpt-5.4-mini' })
    await vi.waitFor(() => expect(store.get(record.sessionId)?.state.status).toBe('done'))

    const emit = (event: unknown): void => {
      for (const listener of sdk.listeners) listener(event)
    }
    emit({
      type: 'session.usage_info', id: 'initial-context', parentId: null,
      timestamp: '2026-09-26T14:00:01.000Z', ephemeral: true,
      data: { currentTokens: 70_000, tokenLimit: 272_000, messagesLength: 10 },
    })
    const tool = sdk.configs.at(-1)?.tools.find((candidate) => candidate.name === 'inspect')
    await tool?.handler({ step: 1 }, { toolCallId: 'tool-1' })
    emit({
      type: 'assistant.usage', id: 'tool-usage-1', parentId: null,
      timestamp: '2026-09-26T14:00:02.000Z',
      data: { model: 'gpt-5.4-mini', inputTokens: 75_000, outputTokens: 100, apiCallId: 'api-tool-1' },
    })
    await tool?.handler({ step: 2 }, { toolCallId: 'tool-2' })
    emit({
      type: 'assistant.usage', id: 'tool-usage-2', parentId: null,
      timestamp: '2026-09-26T14:00:03.000Z',
      data: { model: 'gpt-5.4-mini', inputTokens: 80_000, outputTokens: 100, apiCallId: 'api-tool-2' },
    })
    await vi.waitFor(() => expect(record.state.usage.inputTokens).toBe(155_000))
    expect(record.runtimeContextSnapshot).toMatchObject({
      contextWindow: { tokens: 272_000, source: 'api_reported' },
      usage: { inputTokens: 70_000, totalTokens: 70_000 },
      estimator: { total: { kind: 'provider_reported', confidence: 'exact' } },
    })

    emit({
      type: 'session.usage_info', id: 'current-context', parentId: null,
      timestamp: '2026-09-26T14:00:03.500Z', ephemeral: true,
      data: { currentTokens: 80_000, tokenLimit: 272_000, messagesLength: 14 },
    })
    await vi.waitFor(() => expect(record.runtimeContextSnapshot?.usage.inputTokens).toBe(80_000))
    emit({
      type: 'session.usage_info', id: 'late-stale-context', parentId: null,
      timestamp: '2026-09-26T14:00:01.500Z', ephemeral: true,
      data: { currentTokens: 71_000, tokenLimit: 272_000, messagesLength: 11 },
    })
    expect(record.runtimeContextSnapshot?.usage.inputTokens).toBe(80_000)
    const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => {})
    emit({
      type: 'session.usage_info', id: 'unexplained-regression', parentId: null,
      timestamp: '2026-09-26T14:00:03.750Z', ephemeral: true,
      data: { currentTokens: 60_000, tokenLimit: 272_000, messagesLength: 13 },
    })
    expect(record.runtimeContextSnapshot?.usage.inputTokens).toBe(80_000)
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('80000 -> 60000'),
      { code: 'KALA_CONTEXT_USAGE_REGRESSION' },
    )
    warning.mockRestore()

    sdk.responses.push({
      type: 'assistant.message', id: 'second-response', timestamp: '2026-09-26T14:00:04.000Z',
      data: { content: 'Continuing.', messageId: 'second-message' },
    })
    await runtime.send(record, { text: 'Continue.', model: 'gpt-5.4-mini' })
    emit({
      type: 'assistant.usage', id: 'next-turn-usage', parentId: null,
      timestamp: '2026-09-26T14:00:05.000Z',
      data: { model: 'gpt-5.4-mini', inputTokens: 30_000, outputTokens: 50, apiCallId: 'api-next-turn' },
    })
    await vi.waitFor(() => expect(store.get(record.sessionId)?.state.usage.inputTokens).toBe(185_000))
    expect(record.runtimeContextSnapshot?.usage.inputTokens).toBe(80_000)
    expect(store.get(record.sessionId)?.state.usage.inputTokens).toBe(185_000)
    expect(snapshots.at(-1)?.estimator.version).toBe('copilot-sdk-usage-info-v1')
    await vi.waitFor(async () => {
      const reloaded = await new SessionStore(dir).load(record.sessionId)
      expect(reloaded.runtimeContextSnapshot?.usage.inputTokens).toBe(80_000)
    })
    await runtime.close()
  })

  it('ignores late cancelled-turn messages and tools without suppressing the next turn', async () => {
    const callTool = vi.fn(async () => ({ ok: true, content: 'should not run' }))
    const runtime = new CopilotAgentRuntime({
      store,
      tools: { callTool, cancelPending() {} },
      broadcast: {
        onState() {},
        onTokenDelta() {},
        onApprovalRequired() {},
        onError() {},
      },
    }, { enabled: true, sessionsDir: dir })
    const record = await store.create({
      sessionId: 'copilot-cancelled-generation',
      agentRuntime: 'copilot',
      config: createConfig({
        tools: [{
          name: 'inspect',
          description: 'Inspect something',
          inputSchema: { type: 'object' },
          requiresApproval: false,
          executionKind: 'host',
          executionHandler: 'inspect',
        }],
      }),
    })
    let resolveOld!: (value: unknown) => void
    let resolveNew!: (value: unknown) => void
    sdk.responses.push(
      new Promise((resolve) => { resolveOld = resolve }),
      new Promise((resolve) => { resolveNew = resolve }),
    )
    const emit = (event: unknown): void => {
      for (const listener of [...sdk.listeners]) listener(event)
    }

    await runtime.start()
    await runtime.send(record, { text: 'old turn' })
    await vi.waitFor(() => expect(sdk.sentMessages).toHaveLength(1))
    const oldRequestId = (sdk.sentMessages[0] as { requestHeaders: Record<string, string> }).requestHeaders['x-request-id']
    await runtime.cancel(record)
    expect(record.state.status).toBe('done')
    expect(record.state.messages.at(-1)).toMatchObject({
      role: 'user',
      metadata: {
        kind: 'temporal',
        turnStatus: 'cancelled',
        turnCompletedAt: expect.any(String),
        turnDurationMs: expect.any(Number),
      },
    })

    emit({
      type: 'assistant.message', id: 'late-before-new', parentId: null,
      timestamp: '2026-09-26T15:00:00.000Z',
      data: { content: 'stale before new', messageId: 'late-1', clientRequestId: oldRequestId, turnId: 'old-turn' },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(record.state.status).toBe('done')
    expect(record.state.messages.some((message) => message.content.some((content) => content.type === 'text' && content.text === 'stale before new'))).toBe(false)

    await runtime.send(record, { text: 'new turn' })
    await vi.waitFor(() => expect(sdk.sentMessages).toHaveLength(2))
    const newRequestId = (sdk.sentMessages[1] as { requestHeaders: Record<string, string> }).requestHeaders['x-request-id']
    emit({
      type: 'assistant.message', id: 'late-after-new', parentId: 'late-before-new',
      timestamp: '2026-09-26T15:00:01.000Z',
      data: {
        content: 'stale after new', messageId: 'late-2', clientRequestId: oldRequestId, turnId: 'old-turn',
        toolRequests: [{ toolCallId: 'late-tool', name: 'inspect', arguments: {} }],
      },
    })
    const tool = sdk.configs.at(-1)?.tools.find((candidate) => candidate.name === 'inspect')
    await expect(tool?.handler({}, { toolCallId: 'late-tool' })).resolves.toMatchObject({
      error: expect.stringContaining('The operation was cancelled.'),
      textResultForLlm: expect.stringContaining('Do not restart automatically.'),
    })
    expect(callTool).not.toHaveBeenCalled()

    const newResponse = {
      type: 'assistant.message', id: 'new-response', parentId: null,
      timestamp: '2026-09-26T15:00:02.000Z',
      data: { content: 'fresh response', messageId: 'new-message', clientRequestId: newRequestId, turnId: 'new-turn' },
    }
    emit(newResponse)
    resolveNew(newResponse)
    resolveOld({
      type: 'assistant.message', id: 'old-response', parentId: null,
      timestamp: '2026-09-26T15:00:03.000Z',
      data: { content: 'stale resolved response', messageId: 'old-message', clientRequestId: oldRequestId, turnId: 'old-turn' },
    })
    await vi.waitFor(() => expect(record.state.status).toBe('done'))
    emit({
      type: 'assistant.message', id: 'late-after-new-done', parentId: 'late-after-new',
      timestamp: '2026-09-26T15:00:04.000Z',
      data: { content: 'stale status reset', messageId: 'late-3', clientRequestId: oldRequestId, turnId: 'old-turn' },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(record.state.status).toBe('done')

    const text = record.state.messages.flatMap((message) => message.content)
      .filter((content) => content.type === 'text')
      .map((content) => content.text)
    expect(text).toContain('fresh response')
    expect(text).not.toContain('stale after new')
    expect(text).not.toContain('stale resolved response')
    expect(text).not.toContain('stale status reset')
    await runtime.close()
  })

  it('does not inherit a stale generation when a new interaction follows a session event', async () => {
    const callTool = vi.fn(async () => ({ ok: true, content: 'ok' }))
    const runtime = new CopilotAgentRuntime({
      store,
      tools: { callTool, cancelPending() {} },
      broadcast: {
        onState() {},
        onTokenDelta() {},
        onApprovalRequired() {},
        onError() {},
      },
    }, { enabled: true, sessionsDir: dir })
    const record = await store.create({
      sessionId: 'copilot-reused-sdk-turn-id',
      agentRuntime: 'copilot',
      config: createConfig({
        tools: [{
          name: 'inspect',
          description: 'Inspect something',
          inputSchema: { type: 'object' },
          requiresApproval: false,
          executionKind: 'host',
          executionHandler: 'inspect',
        }],
      }),
    })
    let resolveFirst!: (value: unknown) => void
    let resolveSecond!: (value: unknown) => void
    sdk.responses.push(
      new Promise((resolve) => { resolveFirst = resolve }),
      new Promise((resolve) => { resolveSecond = resolve }),
    )
    const emit = (event: unknown): void => {
      for (const listener of [...sdk.listeners]) listener(event)
    }
    await runtime.start()
    await runtime.start()
    await runtime.send(record, { text: 'first turn' })
    await vi.waitFor(() => expect(sdk.sentMessages).toHaveLength(1))
    const tool = sdk.configs.at(-1)?.tools.find((candidate) => candidate.name === 'inspect')
    emit({
      type: 'user.message', id: 'first-user', parentId: null,
      timestamp: '2026-09-27T15:00:00.000Z',
      data: { turnId: '0', interactionId: 'first-interaction' },
    })
    emit({
      type: 'assistant.turn_start', id: 'first-start', parentId: 'first-user',
      timestamp: '2026-09-27T15:00:00.000Z',
      data: { turnId: '0', interactionId: 'first-interaction' },
    })
    const firstResponse = {
      type: 'assistant.message', id: 'first-response', parentId: 'first-start',
      timestamp: '2026-09-27T15:00:01.000Z',
      data: {
        content: '', messageId: 'first-message', turnId: '0', interactionId: 'first-interaction',
        toolRequests: [{ toolCallId: 'first-tool', name: 'inspect', arguments: {} }],
      },
    }
    emit(firstResponse)
    await expect(tool?.handler({}, { toolCallId: 'first-tool' })).resolves.toMatchObject({ resultType: 'success' })
    resolveFirst(firstResponse)
    await vi.waitFor(() => expect(record.state.status).toBe('done'))

    emit({
      type: 'session.model_change', id: 'between-interactions', parentId: 'first-response',
      timestamp: '2026-09-27T15:00:01.500Z', data: {},
    })
    await runtime.send(record, { text: 'second turn' })
    await vi.waitFor(() => expect(sdk.sentMessages).toHaveLength(2))
    emit({
      type: 'user.message', id: 'second-user', parentId: 'between-interactions',
      timestamp: '2026-09-27T15:00:02.000Z',
      data: { turnId: '0', interactionId: 'second-interaction' },
    })
    emit({
      type: 'assistant.turn_start', id: 'second-start', parentId: 'second-user',
      timestamp: '2026-09-27T15:00:02.000Z',
      data: { turnId: '0', interactionId: 'second-interaction' },
    })
    const secondResponse = {
      type: 'assistant.message', id: 'second-response', parentId: 'second-start',
      timestamp: '2026-09-27T15:00:03.000Z',
      data: {
        content: '', messageId: 'second-message', turnId: '0', interactionId: 'second-interaction',
        toolRequests: [{ toolCallId: 'second-tool', name: 'inspect', arguments: {} }],
      },
    }
    emit(secondResponse)
    await expect(tool?.handler({}, { toolCallId: 'second-tool' })).resolves.toMatchObject({ resultType: 'success' })
    resolveSecond(secondResponse)
    await vi.waitFor(() => expect(record.state.status).toBe('done'))

    expect(callTool).toHaveBeenCalledTimes(2)
    expect(record.state.messages.some((message) => message.content.some((content) =>
      content.type === 'tool_call' && content.callId === 'second-tool'
    ))).toBe(true)
    await runtime.close()
  })

  it('runs manual compaction through the Copilot history RPC', async () => {
    const onState = vi.fn()
    const onCompactStatus = vi.fn()
    const runtime = new CopilotAgentRuntime({
      store,
      tools: { async callTool() { return { ok: true, content: 'unused' } }, cancelPending() {} },
      broadcast: {
        onState,
        onTokenDelta() {},
        onApprovalRequired() {},
        onError() {},
        onCompactStatus,
      },
    }, { enabled: true, sessionsDir: dir })
    const record = await store.create({
      sessionId: 'copilot-manual-compaction',
      agentRuntime: 'copilot',
      config: createConfig({ tools: [] }),
    })
    await runtime.start()

    await runtime.compact(record)

    expect(sdk.compact).toHaveBeenCalledWith({ trigger: 'manual' })
    expect(onState.mock.calls.map((call) => call[2])).toContainEqual(expect.objectContaining({
      contextWindow: { tokens: 128_000, source: 'api_reported' },
      usage: { inputTokens: 40_000, totalTokens: 40_000 },
    }))
    expect(record.state.messages).toContainEqual(expect.objectContaining({
      metadata: expect.objectContaining({
        kind: 'context_compaction',
        phase: 'done',
        summary: '# Compacted Context\n\nKeep the active implementation constraints.',
      }),
    }))
    expect(onCompactStatus).toHaveBeenCalledTimes(2)
    expect(onCompactStatus.mock.calls[0]?.[0]).toMatchObject({
      sessionId: record.sessionId,
      kind: 'running',
      trigger: 'manual',
    })
    expect(onCompactStatus.mock.calls[1]?.[0]).toMatchObject({
      sessionId: record.sessionId,
      kind: 'done',
      tokensAfter: 40_000,
      trigger: 'manual',
      replacedCount: 40,
      summary: '# Compacted Context\n\nKeep the active implementation constraints.',
    })
    await runtime.close()
  })

  it('broadcasts manual progress before SDK resume and keeps it running until the RPC finishes', async () => {
    let resume!: () => void
    sdk.resumeBarrier = new Promise<void>((resolve) => { resume = resolve })
    let finish!: (value: Awaited<ReturnType<typeof sdk.compact>>) => void
    sdk.compact.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const onCompactStatus = vi.fn()
    const runtime = new CopilotAgentRuntime({
      store,
      tools: { async callTool() { return { ok: true, content: 'unused' } }, cancelPending() {} },
      broadcast: { onState() {}, onTokenDelta() {}, onApprovalRequired() {}, onError() {}, onCompactStatus },
    }, { enabled: true, sessionsDir: dir })
    const record = await store.create({
      sessionId: 'copilot-delayed-compact',
      agentRuntime: 'copilot',
      config: createConfig({ tools: [] }),
    })
    await runtime.start()
    const pending = runtime.compact(record)
    expect(onCompactStatus).toHaveBeenCalledWith(expect.objectContaining({ kind: 'running', sessionId: record.sessionId }))
    expect(runtime.currentCompactStatus(record.sessionId)).toMatchObject({ kind: 'running' })
    await vi.waitFor(() => expect(record.state.messages.some((message) =>
      message.metadata?.kind === 'context_compaction' && message.metadata.phase === 'running')).toBe(true))
    expect(sdk.compact).not.toHaveBeenCalled()
    resume()
    await vi.waitFor(() => expect(sdk.compact).toHaveBeenCalledTimes(1))
    expect(onCompactStatus).toHaveBeenCalledTimes(1)
    await expect(runtime.compact(record)).rejects.toThrow('already in progress')
    finish({
      success: true, tokensRemoved: 100, messagesRemoved: 1, summaryContent: 'Compacted.',
      contextWindow: {
        currentTokens: 40_000, tokenLimit: 128_000, messagesLength: 10,
        systemTokens: 1_000, conversationTokens: 35_000, toolDefinitionsTokens: 4_000,
      },
    })
    await pending
    expect(onCompactStatus.mock.calls.at(-1)?.[0]).toMatchObject({ kind: 'done' })
    expect(runtime.currentCompactStatus(record.sessionId)).toBeUndefined()
    await runtime.close()
  })

  it('reports the real SDK compaction failure after broadcasting progress', async () => {
    sdk.compact.mockRejectedValueOnce(new Error('SDK compaction failed'))
    const onCompactStatus = vi.fn()
    const runtime = new CopilotAgentRuntime({
      store,
      tools: { async callTool() { return { ok: true, content: 'unused' } }, cancelPending() {} },
      broadcast: { onState() {}, onTokenDelta() {}, onApprovalRequired() {}, onError() {}, onCompactStatus },
    }, { enabled: true, sessionsDir: dir })
    const record = await store.create({
      sessionId: 'copilot-failed-compact',
      agentRuntime: 'copilot',
      config: createConfig({ tools: [] }),
    })
    await runtime.start()
    await expect(runtime.compact(record)).rejects.toThrow('SDK compaction failed')
    expect(onCompactStatus.mock.calls.map(([event]) => event.kind)).toEqual(['running', 'error'])
    expect(onCompactStatus.mock.calls[1]?.[0]).toMatchObject({ message: 'SDK compaction failed' })
    expect(record.state.messages).toContainEqual(expect.objectContaining({
      metadata: expect.objectContaining({ kind: 'context_compaction', phase: 'error', error: 'SDK compaction failed' }),
    }))
    expect(runtime.currentCompactStatus(record.sessionId)).toBeUndefined()
    await runtime.close()
  })

  it('reports SDK session startup failure as a terminal compact error without invoking history', async () => {
    sdk.createError = new Error('SDK session could not be created')
    const onCompactStatus = vi.fn()
    const runtime = new CopilotAgentRuntime({
      store,
      tools: { async callTool() { return { ok: true, content: 'unused' } }, cancelPending() {} },
      broadcast: { onState() {}, onTokenDelta() {}, onApprovalRequired() {}, onError() {}, onCompactStatus },
    }, { enabled: true, sessionsDir: dir })
    const record = await store.create({
      sessionId: 'copilot-compact-startup-error',
      agentRuntime: 'copilot',
      config: createConfig({ tools: [] }),
    })
    await runtime.start()
    await expect(runtime.compact(record)).rejects.toThrow('SDK session could not be created')
    expect(sdk.compact).not.toHaveBeenCalled()
    expect(onCompactStatus.mock.calls.map(([event]) => event.kind)).toEqual(['running', 'error'])
    expect(record.state.messages).toContainEqual(expect.objectContaining({
      metadata: expect.objectContaining({ kind: 'context_compaction', phase: 'error' }),
    }))
    await runtime.close()
  })

  it('restores provider context and model from the bounded Host context snapshot', async () => {
    sdk.resumeSucceeds = true
    sdk.getEvents.mockRejectedValue(new Error('full SDK history must not be loaded'))
    const onState = vi.fn()
    const runtime = new CopilotAgentRuntime({
      store,
      tools: { async callTool() { return { ok: true, content: 'unused' } }, cancelPending() {} },
      broadcast: {
        onState,
        onTokenDelta() {},
        onApprovalRequired() {},
        onError() {},
      },
    }, { enabled: true, sessionsDir: dir })
    const record = await store.create({
      sessionId: 'copilot-restored-context',
      agentRuntime: 'copilot',
      config: createConfig({ tools: [] }),
    })
    await store.updateRuntimeContextSnapshot(record, {
      model: { ref: 'previous-model', provider: 'github-copilot', id: 'previous-model' },
      contextWindow: { tokens: 272_000, source: 'api_reported' },
      usage: { inputTokens: 9_263, totalTokens: 9_263 },
      breakdown: {
        system: 245,
        transcript: 2_299,
        tools: 6_719,
        memory: 0,
        attachments: 0,
        pendingUserInput: 0,
      },
      estimator: {
        total: { kind: 'provider_reported', confidence: 'exact' },
        breakdown: { kind: 'heuristic', confidence: 'estimated' },
        version: 'copilot-sdk-usage-info-v1',
      },
      updatedAt: Date.now(),
    })
    await runtime.start()

    await runtime.compact(record)

    expect(record.preferences?.selectedModel).toBe('gpt-5.4-mini')
    expect(onState.mock.calls.map((call) => call[2])).toContainEqual(expect.objectContaining({
      model: { ref: 'gpt-5.4-mini', provider: 'github-copilot', id: 'gpt-5.4-mini' },
      contextWindow: { tokens: 272_000, source: 'api_reported' },
      usage: { inputTokens: 9_263, totalTokens: 9_263 },
    }))
    expect(sdk.getEvents).not.toHaveBeenCalled()
    await runtime.close()
  })

  it('resumes with the saved system prompt in replace mode and streaming enabled', async () => {
    sdk.resumeSucceeds = true
    const runtime = new CopilotAgentRuntime({
      store,
      tools: { async callTool() { return { ok: true, content: '' } }, cancelPending() {} },
      broadcast: {
        onState() {},
        onTokenDelta() {},
        onApprovalRequired() {},
        onError() {},
      },
    }, {
      enabled: true,
      sessionsDir: dir,
    })
    const record = await store.create({
      sessionId: 'copilot-resume-private',
      agentRuntime: 'copilot',
      config: createConfig({ tools: [], systemPrompt: 'Original session instructions.' }),
    })

    await runtime.start()
    await runtime.send(record, { text: 'Continue privately.' })

    expect(sdk.resumeConfigs).toHaveLength(1)
    expect(sdk.resumeConfigs[0]?.remoteSession).toBe('off')
    expect(sdk.resumeConfigs[0]?.streaming).toBe(true)
    expect(sdk.resumeConfigs[0]?.systemMessage).toEqual({ mode: 'replace', content: 'Original session instructions.' })
    expect(sdk.configs).toHaveLength(0)
    expect(sdk.clientOptions[0]?.connection?.args).toEqual(['--no-remote-export'])
    await runtime.close()
  })

  it('re-resumes with replace after a persisted prompt change without deleting the SDK Session', async () => {
    sdk.resumeSucceeds = true
    const runtime = new CopilotAgentRuntime({
      store,
      tools: { async callTool() { return { ok: true, content: '' } }, cancelPending() {} },
      broadcast: { onState() {}, onTokenDelta() {}, onApprovalRequired() {}, onError() {} },
    }, { enabled: true, sessionsDir: dir })
    const record = await store.create({
      sessionId: 'copilot-prompt-refresh',
      agentRuntime: 'copilot',
      config: createConfig({ tools: [], systemPrompt: 'old prompt' }),
    })

    sdk.responses.push(
      { type: 'assistant.message', id: 'first', timestamp: '2026-10-03T00:00:00.000Z', data: { content: 'first', messageId: 'first-message' } },
      { type: 'assistant.message', id: 'second', timestamp: '2026-10-03T00:00:01.000Z', data: { content: 'second', messageId: 'second-message' } },
    )

    await runtime.start()
    await runtime.send(record, { text: 'first turn' })
    await vi.waitFor(() => expect(record.state.status).toBe('done'))
    await store.applySystemPrompt(record.sessionId, 'new prompt')
    await runtime.send(record, { text: 'second turn' })

    expect(sdk.resumeConfigs).toHaveLength(2)
    expect(sdk.resumeConfigs[1]?.systemMessage).toEqual({ mode: 'replace', content: 'new prompt' })
    expect(sdk.disconnect).toHaveBeenCalledOnce()
    expect(sdk.deleteSession).not.toHaveBeenCalled()
    await runtime.close()
  })

  it('re-resumes an existing SDK Session with an explicitly upgraded tool lock', async () => {
    sdk.resumeSucceeds = true
    const runtime = new CopilotAgentRuntime({
      store,
      tools: { async callTool() { return { ok: true, content: '' } }, cancelPending() {} },
      broadcast: { onState() {}, onTokenDelta() {}, onApprovalRequired() {}, onError() {} },
    }, { enabled: true, sessionsDir: dir })
    const record = await store.create({
      sessionId: 'copilot-new-tool',
      agentRuntime: 'copilot',
      config: createConfig({ tools: [], systemPrompt: 'original' }),
    })
    sdk.responses.push(
      { type: 'assistant.message', id: 'one', timestamp: '2026-10-03T00:00:00.000Z', data: { content: 'first', messageId: 'one' } },
      { type: 'assistant.message', id: 'two', timestamp: '2026-10-03T00:00:01.000Z', data: { content: 'second', messageId: 'two' } },
    )
    await runtime.start()
    await runtime.send(record, { text: 'first turn' })
    await vi.waitFor(() => expect(record.state.status).toBe('done'))
    const upgraded = createConfig({
      tools: [{ name: 'scheduled_task', description: 'Manage scheduled tasks', inputSchema: { type: 'object' }, requiresApproval: false }],
      systemPrompt: 'original',
    })
    Object.assign(record, { config: upgraded, toolLock: { scheduled_task: { version: '1', schemaHash: null } } })
    await runtime.send(record, { text: 'second turn' })
    expect(sdk.resumeConfigs).toHaveLength(2)
    expect(sdk.resumeConfigs[1]?.tools.map((tool) => tool.name)).toContain('scheduled_task')
    expect(sdk.disconnect).toHaveBeenCalledOnce()
    expect(sdk.deleteSession).not.toHaveBeenCalled()
    await runtime.close()
  })

  it('fences late old-prompt output immediately at durable prompt replacement', async () => {
    sdk.resumeSucceeds = true
    const runtime = new CopilotAgentRuntime({
      store,
      tools: { async callTool() { return { ok: true, content: '' } }, cancelPending() {} },
      broadcast: { onState() {}, onTokenDelta() {}, onApprovalRequired() {}, onError() {} },
    }, { enabled: true, sessionsDir: dir })
    const record = await store.create({
      sessionId: 'copilot-prompt-generation-fence',
      agentRuntime: 'copilot',
      config: createConfig({ tools: [], systemPrompt: 'old prompt' }),
    })

    await runtime.start()
    await runtime.send(record, { text: 'old-prompt turn' })
    await store.applySystemPrompt(record.sessionId, 'new prompt')
    sdk.listeners[0]?.({
      type: 'assistant.message',
      id: 'late-old-output',
      timestamp: '2026-10-03T00:00:00.000Z',
      data: { content: 'must not persist', messageId: 'late-old-output' },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(record.state.messages.some((message) => message.content.some((content) => content.type === 'text' && content.text === 'must not persist'))).toBe(false)
    await runtime.cancel(record)
    sdk.responses.push({
      type: 'assistant.message',
      id: 'new-output',
      timestamp: '2026-10-03T00:00:01.000Z',
      data: { content: 'new prompt output', messageId: 'new-output' },
    })
    await runtime.send(record, { text: 'new-prompt turn' })
    await vi.waitFor(() => expect(record.state.status).toBe('done'))

    expect(sdk.abort).toHaveBeenCalledOnce()
    expect(sdk.resumeConfigs.at(-1)?.systemMessage).toEqual({ mode: 'replace', content: 'new prompt' })
    expect(sdk.disconnect).toHaveBeenCalledOnce()
    expect(sdk.deleteSession).not.toHaveBeenCalled()
    await runtime.close()
  })

  it('aborts SDK work and cancels pending tools after an SDK timeout', async () => {
    const cancelPending = vi.fn()
    const runtime = new CopilotAgentRuntime({
      store,
      tools: { async callTool() { return { ok: true, content: '' } }, cancelPending },
      broadcast: {
        onState() {},
        onTokenDelta() {},
        onApprovalRequired() {},
        onError() {},
      },
    }, {
      enabled: true,
      sessionsDir: dir,
    })
    const record = await store.create({
      sessionId: 'copilot-timeout',
      agentRuntime: 'copilot',
      config: createConfig({ tools: [] }),
    })
    sdk.responses.push(new Error('Timeout after 1800000ms waiting for session.idle'))

    await runtime.start()
    await runtime.send(record, { text: 'Continue.' })
    await vi.waitFor(() => expect(store.get(record.sessionId)?.state.status).toBe('error'))

    expect(sdk.abort).toHaveBeenCalledOnce()
    expect(cancelPending).toHaveBeenCalledWith(record.sessionId)
  })

  it('aborts a Copilot turn that never produces initial activity', async () => {
    vi.useFakeTimers()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const cancelPending = vi.fn()
      const runtime = new CopilotAgentRuntime({
        store,
        tools: { async callTool() { return { ok: true, content: '' } }, cancelPending },
        broadcast: {
          onState() {},
          onTokenDelta() {},
          onApprovalRequired() {},
          onError() {},
        },
      }, {
        enabled: true,
        sessionsDir: dir,
      })
      const record = await store.create({
        sessionId: 'copilot-initial-activity-timeout',
        agentRuntime: 'copilot',
        config: createConfig({ tools: [] }),
      })

      await runtime.start()
      await runtime.send(record, { text: 'Start the task.' })
      await vi.advanceTimersByTimeAsync(4 * 60_000)
      for (const listener of [...sdk.listeners]) {
        listener({ type: 'assistant.turn_start', id: 'non-progress', timestamp: new Date().toISOString(), parentId: null, data: { turnId: '1' } })
      }
      await vi.advanceTimersByTimeAsync(1 * 60_000)
      await vi.waitFor(() => expect(store.get(record.sessionId)?.state.status).toBe('error'))
      expect(store.get(record.sessionId)?.state.error).toContain('without initial Copilot session activity')
      expect(sdk.abort).toHaveBeenCalledOnce()
      expect(cancelPending).toHaveBeenCalledWith(record.sessionId)
      const ioWarning = warning.mock.calls.find(([message]) => message === '[copilot] native IO during SDK send')
      expect(ioWarning?.[1]).toMatchObject({ reads: 0, writes: 0, durationMs: expect.any(Number) })
      expect(JSON.stringify(ioWarning)).not.toContain(record.sessionId)
      await runtime.close()
    } finally {
      warning.mockRestore()
      vi.useRealTimers()
    }
  })

  it('keeps an active Copilot turn alive and aborts only after prolonged inactivity', async () => {
    vi.useFakeTimers()
    try {
      const cancelPending = vi.fn()
      const runtime = new CopilotAgentRuntime({
        store,
        tools: { async callTool() { return { ok: true, content: '' } }, cancelPending },
        broadcast: {
          onState() {},
          onTokenDelta() {},
          onApprovalRequired() {},
          onError() {},
        },
      }, {
        enabled: true,
        sessionsDir: dir,
      })
      const record = await store.create({
        sessionId: 'copilot-active-timeout',
        agentRuntime: 'copilot',
        config: createConfig({ tools: [] }),
      })

      await runtime.start()
      await runtime.send(record, { text: 'Run a long task.' })
      await vi.advanceTimersByTimeAsync(4 * 60_000)
      for (const listener of [...sdk.listeners]) {
        listener({ type: 'assistant.message_delta', id: 'activity', timestamp: new Date().toISOString(), parentId: null, data: { deltaContent: 'Working' } })
      }
      await vi.advanceTimersByTimeAsync(29 * 60_000)
      expect(store.get(record.sessionId)?.state.status).toBe('thinking')
      expect(sdk.abort).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1 * 60_000)
      await vi.waitFor(() => expect(store.get(record.sessionId)?.state.status).toBe('error'))
      expect(sdk.abort).toHaveBeenCalledOnce()
      expect(cancelPending).toHaveBeenCalledWith(record.sessionId)
    } finally {
      vi.useRealTimers()
    }
  })

  it('settles an unresumable approval instead of reporting an expired runtime error', async () => {
    const runtime = new CopilotAgentRuntime({
      store,
      tools: {
        async callTool() {
          return { ok: true, content: 'unused' }
        },
        cancelPending() {},
      },
      broadcast: {
        onState() {},
        onTokenDelta() {},
        onApprovalRequired() {},
        onError() {},
      },
    }, {
      enabled: false,
      sessionsDir: dir,
    })
    const record = await store.create({
      sessionId: 'copilot-expired-approval',
      agentRuntime: 'copilot',
      config: createConfig({ tools: [] }),
    })
    await store.recordRuntimeProjection(record.sessionId, {
      ...record.state,
      cursor: record.state.cursor + 1,
      status: 'awaiting_approval',
      pendingCalls: [{
        callId: 'call-expired',
        name: 'shell',
        input: { command: 'true' },
        status: 'awaiting_approval',
      }],
      messages: [...record.state.messages, {
        role: 'assistant',
        content: [{
          type: 'tool_call',
          callId: 'call-expired',
          name: 'shell',
          input: { command: 'true' },
        }],
      }],
    }, 'copilot.tool_call', { callId: 'call-expired' })

    await expect(runtime.approve(record, 'call-expired')).resolves.toBeUndefined()
    await expect(runtime.approve(record, 'call-expired')).resolves.toBeUndefined()

    const state = store.get(record.sessionId)?.state
    expect(state?.status).toBe('error')
    expect(state?.pendingCalls).toEqual([])
    expect(state?.error).toBe('Copilot approval could not be resumed after host restart')
    expect(state?.messages.flatMap((message) => message.content)).toContainEqual({
      type: 'tool_result',
      callId: 'call-expired',
      ok: false,
      content: 'Copilot approval could not be resumed after host restart',
    })
  })

  it('registers a live approval before broadcasting its pending state', async () => {
    const callTool = vi.fn(async () => ({ ok: true, content: 'approved result' }))
    let runtime!: CopilotAgentRuntime
    let approvalTriggered = false
    const record = await store.create({
      sessionId: 'copilot-live-approval',
      agentRuntime: 'copilot',
      config: createConfig({
        tools: [{
          name: 'shell',
          description: 'Run a command',
          inputSchema: { type: 'object' },
          requiresApproval: true,
          executionKind: 'executor',
          executionHandler: 'shell',
        }],
      }),
    })

    runtime = new CopilotAgentRuntime({
      store,
      tools: { callTool, cancelPending() {} },
      broadcast: {
        onState(_record, state) {
          if (approvalTriggered || state.status !== 'awaiting_approval') return
          approvalTriggered = true
          void runtime.approve(record, 'call-live')
        },
        onTokenDelta() {},
        onApprovalRequired() {},
        onError() {},
      },
    }, { enabled: true, sessionsDir: dir })

    await runtime.start()
    await runtime.send(record, { text: 'Run the command.' })
    const tool = sdk.configs.at(-1)?.tools.find((candidate) => candidate.name === 'shell')
    const result = await tool?.handler({ command: 'true' }, { toolCallId: 'call-live' })

    expect(result).toEqual({
      textResultForLlm: 'approved result',
      resultType: 'success',
    })
    const results = store.get(record.sessionId)?.state.messages
      .flatMap((message) => message.content)
      .filter((content) => content.type === 'tool_result' && content.callId === 'call-live')
    expect(results).toEqual([{
      type: 'tool_result',
      callId: 'call-live',
      ok: true,
      content: 'approved result',
    }])
    expect(callTool).toHaveBeenCalledOnce()
    await runtime.close()
  })

  it('does not request approval for high-risk shell calls in an allow-all Session', async () => {
    const callTool = vi.fn(async () => ({ ok: true, content: 'validation complete' }))
    const onApprovalRequired = vi.fn()
    const record = await store.create({
      sessionId: 'copilot-allow-all-shell',
      agentRuntime: 'copilot',
      initialApprovalMode: 'allow_all',
      config: createConfig({
        tools: [{
          name: 'shell',
          description: 'Run a command',
          inputSchema: { type: 'object' },
          requiresApproval: true,
          executionKind: 'executor',
          executionHandler: 'shell',
        }],
      }),
    })
    const runtime = new CopilotAgentRuntime({
      store,
      tools: { callTool, cancelPending() {} },
      broadcast: {
        onState() {},
        onTokenDelta() {},
        onApprovalRequired,
        onError() {},
      },
    }, { enabled: true, sessionsDir: dir })

    await runtime.start()
    await runtime.send(record, { text: 'Run the tests.' })
    const tool = sdk.configs.at(-1)?.tools.find((candidate) => candidate.name === 'shell')
    const result = await tool?.handler({
      command: 'python3 -m unittest discover -v && python3 -m py_compile server.py test_server.py',
    }, { toolCallId: 'call-validate' })

    expect(result).toMatchObject({ resultType: 'success', textResultForLlm: 'validation complete' })
    expect(callTool).toHaveBeenCalledOnce()
    expect(onApprovalRequired).not.toHaveBeenCalled()
    expect(record.state.pendingCalls).toEqual([])
    await runtime.close()
  })

  it('does not dispatch a tool when Stop arrives during the durable tool-call projection', async () => {
    const callTool = vi.fn(async () => ({ ok: true, content: 'must not run' }))
    const record = await store.create({
      sessionId: 'copilot-stop-during-tool-projection',
      agentRuntime: 'copilot',
      config: createConfig({
        tools: [{
          name: 'inspect',
          description: 'Inspect something',
          inputSchema: { type: 'object' },
          requiresApproval: false,
          executionKind: 'host',
          executionHandler: 'inspect',
        }],
      }),
    })
    let runtime!: CopilotAgentRuntime
    let cancelPromise: Promise<void> | undefined
    runtime = new CopilotAgentRuntime({
      store,
      tools: { callTool, cancelPending() {} },
      broadcast: {
        onState(_record, state) {
          if (cancelPromise || state.status !== 'executing_tools' || !state.pendingCalls.length) return
          cancelPromise = runtime.cancel(record)
        },
        onTokenDelta() {},
        onApprovalRequired() {},
        onError() {},
      },
    }, { enabled: true, sessionsDir: dir })
    await runtime.start()
    await runtime.send(record, { text: 'Inspect.' })
    const tool = sdk.configs.at(-1)?.tools.find((candidate) => candidate.name === 'inspect')
    await expect(tool?.handler({}, { toolCallId: 'call-stop-race' })).resolves.toMatchObject({
      error: expect.stringContaining('cancelled'),
    })
    await cancelPromise
    expect(callTool).not.toHaveBeenCalled()
    await runtime.close()
  })

  it('remains executing while another concurrent Copilot tool call is pending', async () => {
    const releases = new Map<string, (result: { ok: boolean; content: string }) => void>()
    const callTool: ToolDispatcher['callTool'] = async (_sessionId, effect) =>
      await new Promise<{ ok: boolean; content: string }>((resolve) => {
        releases.set(effect.callId, resolve)
      })
    const runtime = new CopilotAgentRuntime({
      store,
      tools: { callTool, cancelPending() {} },
      broadcast: {
        onState() {},
        onTokenDelta() {},
        onApprovalRequired() {},
        onError() {},
      },
    }, { enabled: true, sessionsDir: dir })
    const record = await store.create({
      sessionId: 'copilot-concurrent-tools',
      agentRuntime: 'copilot',
      config: createConfig({
        tools: [{
          name: 'inspect',
          description: 'Inspect a resource',
          inputSchema: { type: 'object' },
          requiresApproval: false,
          executionKind: 'host',
          executionHandler: 'inspect',
        }],
      }),
    })

    await runtime.start()
    await runtime.send(record, { text: 'Inspect both resources.' })
    const tool = sdk.configs.at(-1)?.tools.find((candidate) => candidate.name === 'inspect')
    const first = tool!.handler({}, { toolCallId: 'call-a' })
    const second = tool!.handler({}, { toolCallId: 'call-b' })
    await vi.waitFor(() => expect(store.get(record.sessionId)?.state.pendingCalls).toHaveLength(2))

    releases.get('call-a')!({ ok: true, content: 'first done' })
    await first
    expect(store.get(record.sessionId)?.state).toMatchObject({
      status: 'executing_tools',
      pendingCalls: [{ callId: 'call-b' }],
    })

    releases.get('call-b')!({ ok: true, content: 'second done' })
    await second
    expect(store.get(record.sessionId)?.state).toMatchObject({
      status: 'thinking',
      pendingCalls: [],
    })
    await runtime.close()
  })

  it('keeps a human-input tool visible when Copilot reports idle before its result', async () => {
    let resolveResponse!: (value: unknown) => void
    let releaseChoice!: (result: { ok: boolean; content: string }) => void
    const callTool: ToolDispatcher['callTool'] = async () =>
      await new Promise<{ ok: boolean; content: string }>((resolve) => {
        releaseChoice = resolve
      })
    const runtime = new CopilotAgentRuntime({
      store,
      tools: { callTool, cancelPending() {} },
      broadcast: {
        onState() {},
        onTokenDelta() {},
        onApprovalRequired() {},
        onError() {},
      },
    }, { enabled: true, sessionsDir: dir })
    const record = await store.create({
      sessionId: 'copilot-idle-during-human-input',
      agentRuntime: 'copilot',
      config: createConfig({
        tools: [{
          name: 'ask_user_choice',
          description: 'Ask the user to choose.',
          inputSchema: { type: 'object' },
          requiresApproval: false,
          executionKind: 'host',
          executionHandler: 'ask_user_choice',
        }],
      }),
    })

    sdk.responses.push(new Promise((resolve) => { resolveResponse = resolve }))
    await runtime.start()
    await runtime.send(record, { text: 'Ask me to choose.' })
    const tool = sdk.configs.at(-1)?.tools.find((candidate) => candidate.name === 'ask_user_choice')
    const result = tool!.handler({
      message: 'Choose one.',
      choices: [{ value: 'safe', label: 'Safe' }],
    }, { toolCallId: 'call-choice' })
    await vi.waitFor(() => expect(store.get(record.sessionId)?.state.pendingCalls).toHaveLength(1))
    await vi.waitFor(() => expect(store.get(record.sessionId)?.state.status).toBe('executing_tools'))

    const cursorBeforeIdle = store.get(record.sessionId)!.state.cursor
    resolveResponse({
      type: 'assistant.message',
      data: { content: '', messageId: 'message-before-choice' },
      id: 'event-before-choice',
      timestamp: new Date().toISOString(),
    })
    await vi.waitFor(() => expect(store.get(record.sessionId)?.state.cursor).toBeGreaterThan(cursorBeforeIdle))
    expect(store.get(record.sessionId)?.state).toMatchObject({
      status: 'executing_tools',
      pendingCalls: [{ callId: 'call-choice', name: 'ask_user_choice' }],
    })

    releaseChoice({ ok: true, content: 'safe' })
    await expect(result).resolves.toMatchObject({ resultType: 'success' })
    for (const listener of [...sdk.listeners]) {
      listener({
        type: 'session.idle',
        id: 'final-idle',
        timestamp: new Date().toISOString(),
        parentId: null,
        data: {},
      })
    }
    await vi.waitFor(() => expect(store.get(record.sessionId)?.state.status).toBe('done'))
    expect(store.get(record.sessionId)?.state.pendingCalls).toEqual([])
    await runtime.close()
  })

  it('persists the final assistant response before marking the Session done', async () => {
    const runtime = new CopilotAgentRuntime({
      store,
      tools: { async callTool() { return { ok: true, content: 'unused' } }, cancelPending() {} },
      broadcast: {
        onState() {},
        onTokenDelta() {},
        onApprovalRequired() {},
        onError() {},
      },
    }, { enabled: true, sessionsDir: dir })
    const record = await store.create({
      sessionId: 'copilot-streamed-message',
      agentRuntime: 'copilot',
      config: createConfig({ tools: [] }),
    })
    await runtime.start()
    sdk.responses.push({
      type: 'assistant.message',
      data: { content: 'OK', messageId: 'message-1' },
      id: 'event-1',
      timestamp: new Date().toISOString(),
    })
    await runtime.send(record, { text: 'Reply with OK.' })
    await vi.waitFor(() => expect(store.get(record.sessionId)?.state.status).toBe('done'))

    expect(store.get(record.sessionId)?.state.messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'OK' }],
      metadata: {
        kind: 'temporal',
        turnStatus: 'completed',
        createdAt: expect.any(String),
        turnStartedAt: expect.any(String),
        turnCompletedAt: expect.any(String),
        turnDurationMs: expect.any(Number),
      },
    })
    await runtime.close()
  })

  it('publishes local images before persisting a final assistant response', async () => {
    const publishLocalImages = vi.fn(async (_sessionId, _record, message) => ({
      ...message,
      content: message.content.map((part) => part.type === 'text'
        ? { ...part, text: part.text.replace('/repo/design.png', 'artifact://published-image?mediaType=image%2Fpng') }
        : part),
    }))
    const runtime = new CopilotAgentRuntime({
      store,
      tools: { async callTool() { return { ok: true, content: 'unused' } }, cancelPending() {} },
      publishLocalImages,
      broadcast: {
        onState() {},
        onTokenDelta() {},
        onApprovalRequired() {},
        onError() {},
      },
    }, { enabled: true, sessionsDir: dir })
    const record = await store.create({
      sessionId: 'copilot-local-image',
      agentRuntime: 'copilot',
      config: createConfig({ tools: [] }),
    })
    await runtime.start()
    sdk.responses.push({
      type: 'assistant.message',
      data: { content: '![Design](/repo/design.png)', messageId: 'message-image' },
      id: 'event-image',
      timestamp: new Date().toISOString(),
    })

    await runtime.send(record, { text: 'Show the image.' })
    await vi.waitFor(() => expect(store.get(record.sessionId)?.state.status).toBe('done'))

    expect(publishLocalImages).toHaveBeenCalledOnce()
    expect(store.get(record.sessionId)?.state.messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: '![Design](artifact://published-image?mediaType=image%2Fpng)' }],
      metadata: { kind: 'temporal', turnStatus: 'completed' },
    })
    await runtime.close()
  })

  it('persists ordered reasoning and every complete assistant chunk instead of only sendAndWait final content', async () => {
    let resolveResponse!: (value: unknown) => void
    const response = new Promise((resolve) => { resolveResponse = resolve })
    sdk.responses.push(response)
    const runtime = new CopilotAgentRuntime({
      store,
      tools: { async callTool() { return { ok: true, content: 'unused' } }, cancelPending() {} },
      broadcast: { onState() {}, onTokenDelta() {}, onApprovalRequired() {}, onError() {} },
    }, { enabled: true, sessionsDir: dir })
    const record = await store.create({
      sessionId: 'copilot-complete-events',
      agentRuntime: 'copilot',
      config: createConfig({ tools: [] }),
    })
    await runtime.start()
    await runtime.send(record, { text: 'Investigate then answer.' })
    await vi.waitFor(() => expect(sdk.sentMessages).toHaveLength(1))
    const emit = (event: unknown) => [...sdk.listeners].forEach((listener) => listener(event))
    const timestamp = new Date().toISOString()
    emit({ type: 'assistant.reasoning', id: 'reasoning-1', parentId: null, timestamp, data: { reasoningId: 'r1', content: 'First inspect the state.' } })
    emit({ type: 'assistant.message', id: 'message-1', parentId: 'reasoning-1', timestamp, data: { messageId: 'm1', apiCallId: 'api-1', chunkIndex: 0, chunkCount: 2, content: 'I will inspect it.' } })
    emit({ type: 'assistant.message', id: 'message-2', parentId: 'message-1', timestamp, data: { messageId: 'm2', apiCallId: 'api-1', chunkIndex: 1, chunkCount: 2, content: 'The final answer is preserved.', outputTokens: 12 } })
    resolveResponse({ type: 'assistant.message', id: 'message-2', parentId: 'message-1', timestamp, data: { messageId: 'm2', apiCallId: 'api-1', content: 'The final answer is preserved.', outputTokens: 12 } })
    await vi.waitFor(() => expect(store.get(record.sessionId)?.state.status).toBe('done'))

    const assistantContent = store.get(record.sessionId)?.state.messages
      .filter((message) => message.role === 'assistant')
      .flatMap((message) => message.content) ?? []
    expect(assistantContent).toEqual([
      expect.objectContaining({ type: 'thinking', text: 'First inspect the state.' }),
      expect.objectContaining({ type: 'text', text: 'I will inspect it.' }),
      expect.objectContaining({ type: 'text', text: 'The final answer is preserved.' }),
    ])
    expect(store.get(record.sessionId)?.state.usage.outputTokens).toBe(12)
    await runtime.close()
  })

  it('persists a distinct sendAndWait final event even when its text equals an intermediate event', async () => {
    let resolveResponse!: (value: unknown) => void
    sdk.responses.push(new Promise((resolve) => { resolveResponse = resolve }))
    const runtime = new CopilotAgentRuntime({
      store,
      tools: { async callTool() { return { ok: true, content: 'unused' } }, cancelPending() {} },
      broadcast: { onState() {}, onTokenDelta() {}, onApprovalRequired() {}, onError() {} },
    }, { enabled: true, sessionsDir: dir })
    const record = await store.create({
      sessionId: 'copilot-final-fallback', agentRuntime: 'copilot', config: createConfig({ tools: [] }),
    })
    await runtime.start()
    await runtime.send(record, { text: 'Narrate then answer.' })
    await vi.waitFor(() => expect(sdk.sentMessages).toHaveLength(1))
    const timestamp = new Date().toISOString()
    for (const listener of sdk.listeners) listener({
      type: 'assistant.message', id: 'message-intermediate', parentId: null, timestamp,
      data: { messageId: 'm-intermediate', content: 'I will inspect it.' },
    })
    resolveResponse({
      type: 'assistant.message', id: 'message-final', parentId: 'message-intermediate', timestamp,
      data: { messageId: 'm-final', content: 'I will inspect it.' },
    })
    await vi.waitFor(() => expect(store.get(record.sessionId)?.state.status).toBe('done'))
    expect(store.get(record.sessionId)?.state.messages
      .filter((message) => message.role === 'assistant')
      .flatMap((message) => message.content)
      .filter((content) => content.type === 'text')
      .map((content) => content.text)).toEqual(['I will inspect it.', 'I will inspect it.'])
    await runtime.close()
  })
})
