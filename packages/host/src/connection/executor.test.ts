/**
 * Executor registry unit tests.
 *
 * We use hand-rolled fake sockets rather than a live socket.io server so we
 * can precisely orchestrate the ordering that matters for reconnect
 * semantics (`tool:call` was emitted → old executor died → new executor
 * connected → who gets the retry?). Real socket.io round-trips add ~ms of
 * jitter that makes ordering-sensitive assertions flaky.
 */

import { describe, expect, it, vi } from 'vitest'
import { TERMINAL_CREATE_ACK_TIMEOUT_MS } from '@agent-kernel/shared'

import type { CallToolEffect } from '@agent-kernel/kernel'
import type {
  ExecutorAnnounce,
  ToolCallMessage,
  ToolResultAck,
} from '@agent-kernel/shared'

import {
  createExecutorRegistry,
  type WorkspaceResolver,
} from './executor.js'
import { authorizeExecutorShellCall, shellAuthorizationDenial } from './executor-ns.js'
import { executionRequestDigest } from '../../../executor/src/execution-receipts.js'

type EmittedCall = {
  event:
    | 'tool:call'
    | 'tool:receipt_query'
    | 'tool:cancel_ack'
    | 'tool:cancel'
    | 'session:error'
    | 'executor:host_reject'
    | 'executor:health_ping'
    | 'executor:mcp_config_status'
    | 'executor:mcp_configure'
    | 'terminal:create'
    | 'terminal:kill'
    | 'terminal:close_session'
  payload:
    | ToolCallMessage
    | { sessionId: string; callId: string }
    | Record<string, unknown>
  ack?: (r: ToolResultAck) => void
}

type FakeSocket = {
  id: string
  emitted: EmittedCall[]
  connected: boolean
  data: Record<string, unknown>
  emit: (event: string, payload: unknown, ack?: (r: ToolResultAck) => void) => void
  disconnect: (close?: boolean) => void
}

function makeFakeSocket(id: string): FakeSocket {
  const emitted: EmittedCall[] = []
  const sock: FakeSocket = {
    id,
    emitted,
    connected: true,
    data: {},
    emit(event, payload, ack) {
      emitted.push({
        event: event as EmittedCall['event'],
        payload: payload as EmittedCall['payload'],
        ...(ack ? { ack } : {}),
      })
    },
    disconnect() {
      sock.connected = false
    },
  }
  return sock
}

function fakeIo(): unknown {
  return {}
}

/**
 * Test-only resolver. Real deployments back this with `SessionStore.get`, but
 * that would drag the whole store into every unit test. This map lets each
 * test express the invariant it cares about (session S is bound to
 * workspace W) without file I/O.
 */
function makeResolver(bindings: Record<string, string | undefined> = {}): WorkspaceResolver {
  return {
    workspaceIdFor: (sid) => bindings[sid],
  }
}

function announceOf(
  executorId: string,
  workspaceId = 'ws-default',
  workspaceName = 'default-workspace',
): ExecutorAnnounce {
  return {
    executorId,
    workspaceId,
    workspaceName,
    tools: ['bash'],
    runtime: 'node',
    runtimeVersion: 'test',
  }
}

function callEffect(
  callId: string,
  name = 'bash',
  cwd?: string,
  input: Record<string, unknown> = { command: 'echo hi' },
): CallToolEffect {
  return {
    kind: 'call_tool',
    callId,
    name,
    input,
    ...(cwd !== undefined ? { cwd } : {}),
  }
}

describe('ExecutorRegistry', () => {
  it('sends attachment bytes only through the trusted Host transfer entry', async () => {
    const registry = createExecutorRegistry(fakeIo() as never, {
      ...makeResolver({ x: 'ws-default' }),
      assertSessionEffectOwner: async () => ({ ownerGeneration: '9' }),
    })
    const socket = makeFakeSocket('attachment-executor')
    registry.attach(socket as never, { ...announceOf('attachment-executor'), attachmentTransferVersion: 1 })
    const effect = callEffect('transfer-1', '__workspace_attachment_transfer', undefined, {
      action: 'begin', transferId: 'transfer-1', path: '/workspace/file.bin', bytes: 1,
      sha256: 'a'.repeat(64), ownerGeneration: '9',
    })
    await expect(registry.callTool('x', effect)).resolves.toMatchObject({ ok: false })
    expect(socket.emitted).toHaveLength(0)
    const pending = registry.callHostAttachmentTransfer('x', effect)
    await vi.waitFor(() => expect(socket.emitted).toHaveLength(1))
    expect(socket.emitted[0]?.payload).toMatchObject({
      name: '__workspace_attachment_transfer', origin: 'host', ownerGeneration: '9',
    })
    socket.emitted[0]!.ack!({ callId: effect.callId, ok: true, content: '{"ok":true}' })
    await expect(pending).resolves.toMatchObject({ ok: true })
  })

  it('rejects attachment import before dispatch when the workspace Executor is outdated', async () => {
    const registry = createExecutorRegistry(fakeIo() as never, makeResolver({ x: 'ws-default' }))
    const socket = makeFakeSocket('old-attachment-executor')
    registry.attach(socket as never, announceOf('old-attachment-executor'))
    const result = await registry.callHostAttachmentTransfer('x',
      callEffect('transfer-old', '__workspace_attachment_transfer', undefined, { action: 'begin' }))
    expect(result).toMatchObject({
      ok: false,
      failure: { code: 'executor_update_required', outcome: 'blocked' },
      content: expect.stringContaining('Update the Executor'),
    })
    expect(socket.emitted).toHaveLength(0)
  })

  it('does not send a named Arena effect to an old Executor without keeper enforcement', async () => {
    const reg = createExecutorRegistry(fakeIo() as never, {
      ...makeResolver({ x: 'ws-default' }),
      approvedArenaReadParent: () => true,
    })
    const old = makeFakeSocket('old-arena-executor')
    reg.attach(old as never, announceOf('old-arena-executor'))
    await expect(reg.callTool('x', callEffect('arena-init-123', 'arena_git_init', undefined,
      { parentCallId: 'approved', ownerGeneration: '1' }))).resolves.toMatchObject({
      ok: false, content: expect.stringContaining('independent PID-namespace keeper'),
    })
    expect(old.emitted).toHaveLength(0)
  })

  it('binds synthetic Arena shell authorization to the approved parent, exact command and workspace until receipt', async () => {
    let approved = false
    const reg = createExecutorRegistry(fakeIo() as never, {
      ...makeResolver({ x: 'ws-default' }),
      approvedArenaShellParent: (sid, parent) => approved && sid === 'x' && parent === 'parent',
    })
    const socket = makeFakeSocket('arena-shell')
    reg.attach(socket as never, announceOf('arena-shell'))
    const command = 'git reset --hard HEAD'
    const callId = 'arena-01J00000000000000000000000'
    const effect = callEffect(callId, 'bash', undefined, { command })
    await expect(reg.callArenaShell('x', 'parent', effect)).resolves.toMatchObject({ ok: false })
    await expect(reg.callArenaShell('x', 'other', effect)).resolves.toMatchObject({ ok: false })
    expect(socket.emitted).toHaveLength(0)
    approved = true
    const running = reg.callArenaShell('x', 'parent', effect)
    await vi.waitFor(() => expect(socket.emitted).toHaveLength(1))
    const record = { sessionId: 'x', workspaceId: 'ws-default', state: { pendingCalls: [] } } as never
    const authorization = (candidateCommand: string, candidateCallId = callId, workspace = 'ws-default') =>
      authorizeExecutorShellCall(record, workspace, {
        sessionId: 'x', callId: candidateCallId, name: 'bash', command: candidateCommand,
      }, reg.authorizeArenaShell('x', candidateCallId, candidateCommand, workspace))
    expect(authorization(command)).toBe(true)
    expect(authorization(command, 'arena-01J00000000000000000000000001')).toBe(false)
    expect(authorization('git reset --hard HEAD~1')).toBe(false)
    expect(authorization(command, callId, 'other-workspace')).toBe(false)
    expect(authorization('rm -rf /')).toBe(false)
    approved = false
    expect(authorization(command)).toBe(false)
    socket.emitted[0]!.ack!({ callId, ok: true, content: 'done' })
    await expect(running).resolves.toMatchObject({ ok: true })
    approved = true
    expect(authorization(command)).toBe(false)
  })

  it('authorizes only the exact dispatched Host-owned bang shell, never a similarly named model call', async () => {
    const reg = createExecutorRegistry(fakeIo() as never, makeResolver({ session: 'ws-default' }))
    const socket = makeFakeSocket('host-shell')
    reg.attach(socket as never, announceOf('host-shell'))
    const command = 'node -e "require(\'fs\').writeFileSync(\'marker\',\'ok\')"'
    const effect = callEffect(`bang-shell-call-${'a'.repeat(32)}`, 'bash', '/workspace', {
      command, capture_separate_streams: true,
    })
    const record = { sessionId: 'session', workspaceId: 'ws-default', state: { pendingCalls: [], approvalMode: 'ask' } } as never
    const authorization = (callId = effect.callId, requestedCommand = command, workspace = 'ws-default') =>
      authorizeExecutorShellCall(record, workspace, {
        sessionId: 'session', callId, name: 'bash', command: requestedCommand,
      }, reg.authorizeHostShell('session', callId, requestedCommand, workspace))
    expect(authorization()).toBe(false)
    const modelCall = reg.callTool('session', effect)
    await vi.waitFor(() => expect(socket.emitted).toHaveLength(1))
    expect(authorization()).toBe(false)
    socket.emitted[0]!.ack!({ callId: effect.callId, ok: true, content: 'model result' })
    await modelCall

    const hostCall = reg.callHostShell('session', effect)
    await vi.waitFor(() => expect(socket.emitted).toHaveLength(2))
    expect(socket.emitted[1]!.payload).toMatchObject({ origin: 'host', name: 'bash' })
    expect(authorization()).toBe(true)
    expect(authorization('forged')).toBe(false)
    expect(authorization(effect.callId, command + ' extra')).toBe(false)
    expect(authorization(effect.callId, command, 'other-workspace')).toBe(false)
    const replacement = makeFakeSocket('host-shell-reconnected')
    reg.attach(replacement as never, announceOf('host-shell'))
    await vi.waitFor(() => expect(replacement.emitted).toHaveLength(1))
    expect(replacement.emitted[0]!.payload).toMatchObject({ origin: 'host', name: 'bash' })
    expect(authorization()).toBe(true)
    replacement.emitted[0]!.ack!({ callId: effect.callId, ok: true, content: 'host result' })
    await hostCall
    expect(authorization()).toBe(false)
  })

  it('distinguishes a missing Session owner from a known unbound Session instead of dispatching to any Executor', async () => {
    const reg = createExecutorRegistry(fakeIo() as never, {
      workspaceIdFor: sid => sid === 'missing-owner' ? null : undefined,
    })
    const socket = makeFakeSocket('other-workspace')
    reg.attach(socket as never, announceOf('other-executor', 'other-workspace'))
    await expect(reg.callTool('missing-owner', callEffect('unsafe-fallback'))).resolves.toMatchObject({
      ok: false,
      content: expect.stringContaining('Session workspace binding is unavailable'),
    })
    expect(reg.executorForSession('missing-owner')).toBeUndefined()
    expect(await reg.waitForSessionExecutor('missing-owner', 1)).toBe(false)
    expect(socket.emitted).toHaveLength(0)

    const unbound = reg.callTool('known-unbound', callEffect('legacy-fallback'))
    expect(socket.emitted).toHaveLength(1)
    socket.emitted[0]!.ack!({ callId: 'legacy-fallback', ok: true, content: 'ok' })
    await expect(unbound).resolves.toMatchObject({ ok: true })
  })

  it('explains high-risk authorization failures without disclosing the command', () => {
    const command = 'git reset --hard HEAD'
    const request = { sessionId: 's', callId: 'call', name: 'shell' as const, command }
    const state = {
      approvalMode: 'allow_all',
      pendingCalls: [{ callId: 'call', name: 'shell', input: { command }, status: 'dispatched' }],
    }
    const record = { sessionId: 's', workspaceId: 'ws', state }
    expect(shellAuthorizationDenial(record as never, 'ws', request)).toBeNull()
    expect(authorizeExecutorShellCall(record as never, 'ws', request)).toBe(true)
    expect(shellAuthorizationDenial(record as never, 'other', request)).toBe('workspace_mismatch')
    expect(shellAuthorizationDenial(record as never, 'ws', { ...request, callId: 'other' })).toBe('call_not_dispatched')
    expect(shellAuthorizationDenial(record as never, 'ws', { ...request, command: 'git status' })).toBe('risk_mismatch')
    state.approvalMode = 'ask'
    expect(shellAuthorizationDenial(record as never, 'ws', request)).toBe('approval_required')
  })

  it('routes Stop to the authenticated child workspace, and never accepts a disconnected or fenced cancellation ACK', async () => {
    let owner = '5'
    const registry = createExecutorRegistry(fakeIo() as never, {
      ...makeResolver({ child: 'ws-child' }),
      assertSessionEffectOwner: async () => ({ ownerGeneration: owner }),
    }, 40, undefined, 5_000, async () => true)
    const wrongWorkspace = makeFakeSocket('other')
    const child = makeFakeSocket('child')
    registry.attach(wrongWorkspace as never, announceOf('other', 'ws-other'))
    registry.attach(child as never, announceOf('child', 'ws-child'))
    const request = { sessionId: 'child', callId: 'call', ownerGeneration: '4', requestDigest: 'a'.repeat(64), stopCommandId: 'stop' }
    const stopping = registry.cancelExecution(request)
    await vi.waitFor(() => expect(child.emitted.some((e) => e.event === 'tool:cancel_ack')).toBe(true))
    expect(wrongWorkspace.emitted.some((e) => e.event === 'tool:cancel_ack')).toBe(false)
    owner = '6'
    child.emitted.find((e) => e.event === 'tool:cancel_ack')!.ack?.({ status: 'cancel_requested' } as never)
    expect(await stopping).toEqual({ status: 'unavailable' })
    const lost = registry.cancelExecution(request)
    await vi.waitFor(() => expect(child.emitted.filter((e) => e.event === 'tool:cancel_ack')).toHaveLength(2))
    child.connected = false
    child.emitted.filter((e) => e.event === 'tool:cancel_ack')[1]!.ack?.({ status: 'completed', result: { callId: 'call', ok: true, content: 'stale' } } as never)
    expect(await lost).toEqual({ status: 'unavailable' })
    expect(await registry.cancelExecution({ ...request, sessionId: 'not-bound' })).toEqual({ status: 'unavailable' })
  })

  it('routes read-only receipt queries only to the authenticated session workspace and checks owner fencing across the ack', async () => {
    let generation = '6'
    let authorized = true
    const resolver = {
      ...makeResolver({ child: 'ws-child' }),
      assertSessionEffectOwner: vi.fn(async () => ({ ownerGeneration: generation })),
    }
    const registry = createExecutorRegistry(fakeIo() as never, resolver, 50, undefined, 5_000, async () => authorized)
    const other = makeFakeSocket('other')
    const child = makeFakeSocket('child')
    registry.attach(other as never, announceOf('other', 'ws-other'))
    registry.attach(child as never, announceOf('child', 'ws-child'))
    const query = { sessionId: 'child', callId: 'call', ownerGeneration: '5', requestDigest: 'a'.repeat(64) }
    const pending = registry.queryExecutionReceipt(query)
    await vi.waitFor(() => expect(child.emitted.some((e) => e.event === 'tool:receipt_query')).toBe(true))
    expect(other.emitted.some((e) => e.event === 'tool:receipt_query' || e.event === 'tool:call')).toBe(false)
    expect(child.emitted.some((e) => e.event === 'tool:call')).toBe(false)
    child.emitted.find((e) => e.event === 'tool:receipt_query')!.ack?.({ status: 'completed', result: { callId: 'call', ok: true, content: 'done' } } as never)
    expect(await pending).toEqual({ status: 'completed', result: { callId: 'call', ok: true, content: 'done' } })
    const changed = registry.queryExecutionReceipt(query)
    await vi.waitFor(() => expect(child.emitted.filter((e) => e.event === 'tool:receipt_query')).toHaveLength(2))
    generation = '7'
    child.emitted.filter((e) => e.event === 'tool:receipt_query')[1]!.ack?.({ status: 'completed', result: { callId: 'call', ok: true, content: 'done' } } as never)
    expect(await changed).toEqual({ status: 'unavailable' })
    authorized = false
    expect(await registry.queryExecutionReceipt(query)).toEqual({ status: 'unavailable' })
    expect(child.emitted.filter((e) => e.event === 'tool:receipt_query')).toHaveLength(2)
    expect(await registry.queryExecutionReceipt({ ...query, sessionId: 'unbound' })).toEqual({ status: 'unavailable' })
    expect(await registry.queryExecutionReceipt({ ...query, requestDigest: 'invalid' })).toEqual({ status: 'unavailable' })
  })

  it('fails closed on malformed receipt acknowledgements and disconnected executors', async () => {
    const registry = createExecutorRegistry(fakeIo() as never, {
      ...makeResolver({ child: 'ws-child' }),
      assertSessionEffectOwner: async () => ({ ownerGeneration: '3' }),
    }, 50)
    const socket = makeFakeSocket('child')
    registry.attach(socket as never, announceOf('child', 'ws-child'))
    const query = { sessionId: 'child', callId: 'call', ownerGeneration: '2', requestDigest: 'a'.repeat(64) }
    const pending = registry.queryExecutionReceipt(query)
    await vi.waitFor(() => expect(socket.emitted.some((e) => e.event === 'tool:receipt_query')).toBe(true))
    socket.emitted.find((e) => e.event === 'tool:receipt_query')!.ack?.({ status: 'completed', result: { callId: 'wrong', ok: true, content: 'not ours' } } as never)
    expect(await pending).toEqual({ status: 'unavailable' })
    socket.connected = false
    expect(await registry.queryExecutionReceipt(query)).toEqual({ status: 'unavailable' })
  })

  it('blocks dedicated desktop calls and preview while leaving shell dispatch available', async () => {
    const reg = createExecutorRegistry(fakeIo() as never, { ...makeResolver({ old: 'ws-default' }),
      desktopFeaturePolicy: () => ({ computerUseEnabled: false, desktopPreviewEnabled: false }) })
    const socket = makeFakeSocket('desktop-options')
    reg.attach(socket as never, { ...announceOf('desktop-options'), computerUseFeaturePolicyVersion: 1, tools: ['bash', '__computer_use', 'computer_use'] })
    expect((await reg.callTool('old', callEffect('desktop', 'computer_use'))).failure?.code).toBe('computer_use_disabled')
    const preview = await reg.computerRequest({ operation: 'status', requestId: 'status', sessionId: 'old', workspaceId: 'ws-default', policyStatusVersion: 2 }, 'owner')
    expect(preview.status).toMatchObject({ available: false, computerUseEnabled: false, desktopPreviewEnabled: false })
    expect((await reg.computerRequest({ operation: 'start', consent: true, allowAgent: true, requestId: 'start', sessionId: 'old', workspaceId: 'ws-default' }, 'owner')).error?.code).toBe('denied')
    const shell = reg.callTool('old', callEffect('shell'))
    await vi.waitFor(() => expect(socket.emitted.some((entry) => entry.event === 'tool:call')).toBe(true))
    const call = socket.emitted.find((entry) => entry.event === 'tool:call')!
    expect(call.payload).not.toHaveProperty('desktopComputerUseEnabled')
    call.ack?.({ callId: 'shell', ok: true, content: 'ok' })
    expect((await shell).ok).toBe(true)
  })

  it('discards a desktop result if its option was disabled while the call was in flight', async () => {
    let enabled = true
    const reg = createExecutorRegistry(fakeIo() as never, { ...makeResolver({ old: 'ws-default' }),
      desktopFeaturePolicy: () => ({ computerUseEnabled: enabled, desktopPreviewEnabled: false }) })
    const socket = makeFakeSocket('desktop-options')
    reg.attach(socket as never, { ...announceOf('desktop-options'), computerUseFeaturePolicyVersion: 1, tools: ['computer_use'] })
    const result = reg.callTool('old', callEffect('desktop', 'computer_use'))
    await vi.waitFor(() => expect(socket.emitted.some((entry) => entry.event === 'tool:call')).toBe(true))
    enabled = false
    socket.emitted.find((entry) => entry.event === 'tool:call')!.ack?.({ callId: 'desktop', ok: true, content: 'private desktop image' })
    expect(await result).toMatchObject({ ok: false, failure: { code: 'computer_use_disabled', outcome: 'indeterminate' } })
    expect((await result).content).not.toContain('private desktop image')
  })
  it('uses current trusted desktop policy for an existing Session and reconnect, not model arguments', async () => {
    let manual = false
    const reg = createExecutorRegistry(fakeIo() as never, {
      ...makeResolver({ old: 'ws-default' }),
      desktopManualAuthorizationRequired: () => manual,
    }, 5_000)
    const first = makeFakeSocket('desktop-original')
    reg.attach(first as never, { ...announceOf('desktop'), tools: ['computer_use'], computerUsePolicyVersion: 1 })
    const operation = reg.callTool('old', callEffect('desktop-call', 'computer_use', undefined, {
      operation: 'screenshot', desktopManualAuthorizationRequired: true,
    }))
    expect(first.emitted[0]?.payload).toMatchObject({ desktopManualAuthorizationRequired: false })
    manual = true
    const replacement = makeFakeSocket('desktop-reconnected')
    reg.attach(replacement as never, { ...announceOf('desktop'), tools: ['computer_use'], computerUsePolicyVersion: 1 })
    expect(replacement.emitted[0]?.payload).toMatchObject({ desktopManualAuthorizationRequired: true })
    replacement.emitted[0]!.ack!({ callId: 'desktop-call', ok: true, content: 'done' })
    await expect(operation).resolves.toMatchObject({ ok: true })
  })

  it('explicitly requires an in-place update rather than pretending an old Executor supports automatic desktop authorization', async () => {
    const reg = createExecutorRegistry(fakeIo() as never, {
      ...makeResolver({ old: 'ws-default' }), desktopManualAuthorizationRequired: () => false,
    }, 5_000)
    const socket = makeFakeSocket('old-desktop')
    reg.attach(socket as never, { ...announceOf('old-desktop'), tools: ['computer_use'] })
    await expect(reg.callTool('old', callEffect('blocked', 'computer_use'))).resolves.toMatchObject({
      ok: false, failure: { code: 'executor_update_required', outcome: 'blocked' },
    })
    expect(socket.emitted).toHaveLength(0)
  })

  it.each([false, true])('keeps same-callId results scoped to their Sessions (reconnect: %s)', async (reconnect) => {
    const reg = createExecutorRegistry(fakeIo() as never, makeResolver({ x: 'ws-default', y: 'ws-default' }), 5_000)
    const first = makeFakeSocket('shared-original')
    reg.attach(first as never, announceOf('shared-executor'))
    const x = reg.callTool('x', callEffect('same-provider-id'))
    const y = reg.callTool('y', callEffect('same-provider-id'))
    let active = first
    if (reconnect) {
      active = makeFakeSocket('shared-reconnected')
      reg.attach(active as never, announceOf('shared-executor'))
      expect(active.emitted).toHaveLength(2)
    }
    expect(reg.activeSessions().sort()).toEqual(['x', 'y'])
    active.emitted[1]!.ack!({ callId: 'same-provider-id', ok: true, content: 'result-y' })
    await expect(y).resolves.toEqual({ ok: true, content: 'result-y' })
    expect(reg.activeSessions()).toEqual(['x'])
    active.emitted[0]!.ack!({ callId: 'same-provider-id', ok: true, content: 'result-x' })
    await expect(x).resolves.toEqual({ ok: true, content: 'result-x' })
    expect(reg.activeSessions()).toEqual([])
  })

  it('rechecks the Session effect owner before initial dispatch and reconnect redispatch', async () => {
    let owned = true
    const assertSessionEffectOwner = vi.fn(async () => {
      if (!owned) throw new Error('owner generation fenced')
      return { ownerGeneration: '9' }
    })
    const reg = createExecutorRegistry(fakeIo() as never, {
      ...makeResolver({ x: 'ws-default' }), assertSessionEffectOwner,
    }, 5_000)
    const first = makeFakeSocket('owner-original')
    reg.attach(first as never, announceOf('owner-executor'))
    const pending = reg.callTool('x', callEffect('effect-started'))
    await vi.waitFor(() => expect(first.emitted).toHaveLength(1))
    expect(first.emitted[0]!.payload).toMatchObject({ ownerGeneration: '9' })
    owned = false
    const replacement = makeFakeSocket('owner-replacement')
    reg.attach(replacement as never, announceOf('owner-executor'))
    await expect(pending).resolves.toMatchObject({
      ok: false, failure: { outcome: 'indeterminate', retryable: false },
    })
    expect(replacement.emitted).toHaveLength(0)
    await expect(reg.callTool('x', callEffect('must-not-dispatch'))).rejects.toThrow('owner generation fenced')
    expect(replacement.emitted).toHaveLength(0)
    expect(assertSessionEffectOwner).toHaveBeenCalledTimes(3)
  })

  it('only emits named Arena actions with an approved parent and matching owner generation', async () => {
    const reg = createExecutorRegistry(fakeIo() as never, {
      ...makeResolver({ x: 'ws-default' }),
      assertSessionEffectOwner: async () => ({ ownerGeneration: '9' }),
      approvedArenaReadParent: (_sessionId, parentCallId, action, effectCallId) =>
        parentCallId === 'approved' && effectCallId.startsWith(`arena-${action}-`),
    }, 5_000)
    const socket = makeFakeSocket('arena-status')
    reg.attach(socket as never, { ...announceOf('arena-executor'), arenaKeeperVersion: 1 })
    const effect = { kind: 'call_tool' as const, callId: 'arena-status-123',
      name: 'arena_git_status', input: { parentCallId: 'approved', ownerGeneration: '9' } }
    await expect(reg.callTool('x', { ...effect, input: { ...effect.input, parentCallId: 'denied' } }))
      .resolves.toMatchObject({ ok: false })
    expect(socket.emitted).toHaveLength(0)
    const running = reg.callTool('x', effect)
    await vi.waitFor(() => expect(socket.emitted).toHaveLength(1))
    expect(socket.emitted[0]!.payload).toMatchObject({
      origin: 'host', ownerGeneration: '9', input: { parentCallId: 'approved', ownerGeneration: '9' },
    })

    socket.emitted[0]!.ack!({ callId: effect.callId, ok: true, content: '{}' })
    await expect(running).resolves.toMatchObject({ ok: true })
    const diff = { ...effect, name: 'arena_git_diff', callId: 'arena-diff-123' }
    const diffRunning = reg.callTool('x', diff)
    await vi.waitFor(() => expect(socket.emitted).toHaveLength(2))
    expect(socket.emitted[1]!.payload).toMatchObject({ name: 'arena_git_diff', origin: 'host', ownerGeneration: '9' })
    socket.emitted[1]!.ack!({ callId: diff.callId, ok: true, content: '{}' })
    await expect(diffRunning).resolves.toMatchObject({ ok: true })
    for (const action of ['init', 'apply', 'cleanup']) {
      const mutation = { ...effect, name: `arena_git_${action}`, callId: `arena-${action}-123` }
      await expect(reg.callTool('x', { ...mutation, callId: 'arena-status-123' }))
        .resolves.toMatchObject({ ok: false })
      const runningMutation = reg.callTool('x', mutation)
      await vi.waitFor(() => expect(socket.emitted).toHaveLength(action === 'init' ? 3 : action === 'apply' ? 4 : 5))
      const emitted = socket.emitted.at(-1)!
      expect(emitted.payload).toMatchObject({ name: mutation.name, origin: 'host', ownerGeneration: '9' })
      emitted.ack!({ callId: mutation.callId, ok: true, content: '{}' })
      await expect(runningMutation).resolves.toMatchObject({ ok: true })
    }
  })

  it('commits a fenced Arena dispatch intent before the first remote frame, never on a pre-dispatch refusal', async () => {
    let fence = false
    const beginArenaDispatch = vi.fn(async (_session: string, generation: string) => {
      expect(generation).toBe('9')
      if (fence) throw new Error('PG owner fenced before dispatch')
    })

    const registry = createExecutorRegistry(fakeIo() as never, {
      ...makeResolver({ x: 'ws-default' }),
      assertSessionEffectOwner: async () => ({ ownerGeneration: '9' }),
      approvedArenaReadParent: (_session, parent) => parent === 'approved',
      beginArenaDispatch,
    }, 5_000)
    const socket = makeFakeSocket('arena-dispatch-intent')
    registry.attach(socket as never, announceOf('arena-no-keeper'))
    const effect = { kind: 'call_tool' as const, callId: 'arena-probe-PREPARED',
      name: 'arena_git_probe', input: { parentCallId: 'approved', ownerGeneration: '9' } }
    await expect(registry.callTool('x', effect)).resolves.toMatchObject({
      ok: false, failure: { code: 'arena_pre_dispatch_rejected' },
    })
    expect(beginArenaDispatch).not.toHaveBeenCalled()
    expect(socket.emitted).toHaveLength(0)
    registry.attach(socket as never, { ...announceOf('arena-no-keeper'), arenaKeeperVersion: 1 })
    fence = true
    await expect(registry.callTool('x', effect)).rejects.toThrow('PG owner fenced')
    expect(socket.emitted).toHaveLength(0)
    fence = false
    const running = registry.callTool('x', effect)
    await vi.waitFor(() => expect(socket.emitted).toHaveLength(1))
    expect(beginArenaDispatch).toHaveBeenCalledWith('x', '9', effect.callId, executionRequestDigest({
      sessionId: 'x', callId: effect.callId, name: effect.name, input: effect.input, origin: 'host',
    }))
    socket.emitted[0]!.ack!({ callId: effect.callId, ok: true, content: '{}' })
    await expect(running).resolves.toMatchObject({ ok: true })
  })

  it('refuses old Executors and commits registered Skill intent before emitting a mutation', async () => {
    let admitted = true
    const socket = makeFakeSocket('skill-executor')
    const beginSkillDispatch = vi.fn(async () => {
      expect(socket.emitted).toHaveLength(0)
    })

    const registry = createExecutorRegistry(fakeIo() as never, {
      ...makeResolver({ x: 'ws-default' }),
      requireSkillEffectBarrier: true,
      approvedSkillEffect: () => admitted,
      beginSkillDispatch,
      assertSessionEffectOwner: async () => ({ ownerGeneration: '9' }),
    }, 5_000)
    registry.attach(socket as never, announceOf('skill-executor'))
    const effect = { kind: 'call_tool' as const, callId: 'skill-file-01ARZ3NDEKTSV4RRFFQ69G5FAV',
      name: 'skill_file', input: { action: 'create', name: 'procedure', content: 'body', ownerGeneration: '9' } }
    expect(await registry.callTool('x', effect)).toMatchObject({
      ok: false, failure: { code: 'skill_pre_dispatch_rejected' },
    })
    expect(beginSkillDispatch).not.toHaveBeenCalled()
    registry.attach(socket as never, { ...announceOf('skill-executor'), skillFileEffectVersion: 1, arenaKeeperVersion: 1 })
    expect(await registry.callTool('x', effect)).toMatchObject({
      ok: false, failure: { code: 'skill_pre_dispatch_rejected' },
    })
    registry.attach(socket as never, { ...announceOf('skill-executor'), skillFileEffectVersion: 2 })
    expect(await registry.callTool('x', effect)).toMatchObject({
      ok: false, failure: { code: 'skill_pre_dispatch_rejected' },
    })
    expect(beginSkillDispatch).not.toHaveBeenCalled()
    registry.attach(socket as never, { ...announceOf('skill-executor'), skillFileEffectVersion: 2, arenaKeeperVersion: 1 })
    admitted = false
    expect(await registry.callTool('x', effect)).toMatchObject({ ok: false })
    expect(beginSkillDispatch).not.toHaveBeenCalled()
    admitted = true
    const running = registry.callTool('x', effect)
    await vi.waitFor(() => expect(socket.emitted).toHaveLength(1))
    expect(beginSkillDispatch).toHaveBeenCalledWith('x', '9', effect.callId, executionRequestDigest({
      sessionId: 'x', callId: effect.callId, name: effect.name, input: effect.input, origin: 'host',
    }))
    expect(socket.emitted[0]!.payload).toMatchObject({
      name: 'skill_file', origin: 'host', ownerGeneration: '9',
    })
    socket.emitted[0]!.ack!({ callId: effect.callId, ok: true, content: '{}' })
    expect(await running).toMatchObject({ ok: true })
  })

  it('reports provably pre-dispatch Skill denial after async socket revoke or stale bind', async () => {
    let authorize!: (allowed: boolean) => void
    let ownerCheck!: () => void
    const authorizeSocket = vi.fn(async () => await new Promise<boolean>((resolve) => { authorize = resolve }))
    const beginSkillDispatch = vi.fn()
    const registry = createExecutorRegistry(fakeIo() as never, {
      ...makeResolver({ x: 'ws-default' }),
      requireSkillEffectBarrier: true,
      approvedSkillEffect: () => true,
      beginSkillDispatch,
      assertSessionEffectOwner: async () => await new Promise<{ ownerGeneration: string }>((resolve) => {
        ownerCheck = () => resolve({ ownerGeneration: '9' })
      }),
    }, 5_000, undefined, 0, authorizeSocket)
    const old = makeFakeSocket('old')
    registry.attach(old as never, { ...announceOf('old'), skillFileEffectVersion: 2, arenaKeeperVersion: 1 })
    const effect = { kind: 'call_tool' as const, callId: 'skill-file-01ARZ3NDEKTSV4RRFFQ69G5FAV',
      name: 'skill_file', input: { action: 'create', name: 'procedure', content: 'body', ownerGeneration: '9' } }
    const refused = registry.callTool('x', effect)
    await vi.waitFor(() => expect(authorizeSocket).toHaveBeenCalledTimes(1))
    authorize(false)
    await expect(refused).resolves.toMatchObject({ ok: false,
      failure: { code: 'skill_pre_dispatch_rejected' } })
    const stale = registry.callTool('x', effect)
    await vi.waitFor(() => expect(authorizeSocket).toHaveBeenCalledTimes(2))
    authorize(true)
    await vi.waitFor(() => expect(ownerCheck).toBeTypeOf('function'))
    registry.revoke(old as never, 'credential_revoked')
    const replacement = makeFakeSocket('new')
    registry.attach(replacement as never, { ...announceOf('new'), skillFileEffectVersion: 2, arenaKeeperVersion: 1 })
    ownerCheck()
    await expect(stale).resolves.toMatchObject({ ok: false,
      failure: { code: 'skill_pre_dispatch_rejected' } })
    expect(beginSkillDispatch).not.toHaveBeenCalled()
    expect(old.emitted.filter((event) => event.event === 'tool:call')).toEqual([])
    expect(replacement.emitted.filter((event) => event.event === 'tool:call')).toEqual([])
  })

  it('blocks unfenced shared-owner workspace/global memory writes without blocking reads', async () => {
    const registry = createExecutorRegistry(fakeIo() as never, {
      ...makeResolver({ x: 'ws-default' }), requireSkillEffectBarrier: true,
    }, 5_000)
    const socket = makeFakeSocket('shared-memory')
    registry.attach(socket as never, announceOf('shared-memory'))
    for (const scope of ['workspace', 'global']) {
      expect(await registry.callTool('x', callEffect(`memory-${scope}`, 'memory', undefined,
        { operation: 'write', scope, key: 'note', content: 'must not write' }))).toMatchObject({
        ok: false, failure: { code: scope === 'global' ? 'memory_effect_unavailable' : 'memory_pre_dispatch_rejected' },
      })

    }
    expect(socket.emitted).toHaveLength(0)
    const reading = registry.callTool('x', callEffect('memory-read', 'memory', undefined,
      { operation: 'read', scope: 'workspace', key: 'note' }))
    await vi.waitFor(() => expect(socket.emitted).toHaveLength(1))
    socket.emitted[0]!.ack!({ callId: 'memory-read', ok: true, content: 'read' })
    expect(await reading).toMatchObject({ ok: true })
  })

  it('releases a registered workspace memory effect only on an exact durable final receipt', async () => {
    let completed = 0
    let receiptStatus: 'completed' | 'started_unknown' | 'denied' = 'completed'
    const registerMemoryEffect = vi.fn(async () => async () => { completed++ })
    const beginMemoryDispatch = vi.fn(async () => { expect(completed).toBe(0) })
    const registry = createExecutorRegistry(fakeIo() as never, {
      ...makeResolver({ x: 'ws-default' }), requireSkillEffectBarrier: true,
      assertSessionEffectOwner: async () => ({ ownerGeneration: '9' }),
      registerMemoryEffect, beginMemoryDispatch,
    }, 5_000)
    const socket = makeFakeSocket('fenced-memory')
    const emit = socket.emit
    socket.emit = (event, payload, ack) => {
      emit(event, payload, ack)
      if (event === 'tool:call') ack?.(receiptStatus === 'denied'
        ? { callId: (payload as ToolCallMessage).callId, ok: false,
          content: 'no tool ran', failure: { code: 'learning_not_admitted', category: 'precondition',
            outcome: 'blocked', retryable: false, responsibility: 'workspace' } } as never
        : { callId: (payload as ToolCallMessage).callId, ok: true, content: 'written' })
      if (event === 'tool:receipt_query') {
        const query = payload as { callId: string }
        ack?.(receiptStatus === 'completed'
          ? { status: 'completed', result: { callId: query.callId, ok: true, content: 'written' } } as never
          : { status: receiptStatus } as never)
      }
    }
    registry.attach(socket as never, { ...announceOf('fenced-memory'), memoryEffectVersion: 2, arenaKeeperVersion: 1 })
    const input = { operation: 'write', scope: 'workspace', key: 'note', content: 'written' }
    expect(await registry.callTool('x', callEffect('memory-parent-1', 'memory', undefined, input)))
      .toMatchObject({ ok: true })
    expect(completed).toBe(1)
    const frame = socket.emitted.find((entry) => entry.event === 'tool:call')!.payload as ToolCallMessage
    expect(frame).toMatchObject({ origin: 'host', ownerGeneration: '9',
      input: { ownerGeneration: '9' } })
    expect(frame.callId).toMatch(/^memory-file-[a-f0-9]{64}$/u)
    expect(beginMemoryDispatch).toHaveBeenCalledWith('x', '9', frame.callId, executionRequestDigest(frame))
    receiptStatus = 'started_unknown'
    const unknown = await registry.callTool('x', callEffect('memory-parent-2', 'memory', undefined, input))
    expect(unknown).toMatchObject({ ok: false, failure: { outcome: 'indeterminate' } })
    expect(completed).toBe(1)
    receiptStatus = 'denied'
    const denied = await registry.callTool('x', callEffect('memory-parent-3', 'memory', undefined, input))
    expect(denied).toMatchObject({ ok: false, failure: { outcome: 'indeterminate' } })
    expect(completed).toBe(1)
  })

  it('measures Host to Executor latency and reports an offline workspace', async () => {
    const registry = createExecutorRegistry(fakeIo() as never, makeResolver())
    const socket = makeFakeSocket('latency')
    socket.emit = (event, payload, ack) => {
      socket.emitted.push({ event: event as EmittedCall['event'], payload: payload as EmittedCall['payload'], ...(ack ? { ack } : {}) })
      if (event === 'executor:health_ping') ack?.({} as ToolResultAck)
    }
    registry.attach(socket as never, announceOf('exec-latency', 'ws-latency'))
    await expect(registry.measureLatency('ws-latency')).resolves.toEqual({ rttMs: expect.any(Number) })
    await expect(registry.measureLatency('missing')).resolves.toEqual({ error: 'workspace offline' })
  })

  it('allows MCP management only when the authenticated identity matches workspace and announced installation', async () => {
    const registry = createExecutorRegistry(fakeIo() as never, makeResolver(), 5_000, undefined, 0)
    const announcement = { ...announceOf('managed', 'ws-managed'), installId: 'install-real' }

    const legacy = makeFakeSocket('legacy')
    registry.attach(legacy as never, announcement)
    expect(registry.hasTrustedManagedExecutor('ws-managed', 'install-real')).toBe(false)
    await expect(registry.mcpConfigStatus('ws-managed', 'install-real', 'status-legacy')).resolves.toMatchObject({ ok: false })
    expect(legacy.emitted).toHaveLength(0)
    registry.detach(legacy as never)

    const forged = makeFakeSocket('forged')
    forged.data.executorIdentity = { accepted: true, workspaceId: 'ws-managed', installId: 'install-other' }
    registry.attach(forged as never, announcement)
    expect(registry.hasTrustedManagedExecutor('ws-managed', 'install-real')).toBe(false)
    await expect(registry.configureMcp('ws-managed', 'install-real', { requestId: 'configure-forged', servers: [] })).resolves.toMatchObject({ ok: false })
    expect(forged.emitted).toHaveLength(0)
    registry.detach(forged as never)

    const redeemed = makeFakeSocket('redeemed')
    redeemed.data.executorIdentity = { accepted: true, workspaceId: 'ws-managed', installId: 'install-real' }
    registry.attach(redeemed as never, announcement)
    expect(registry.hasTrustedManagedExecutor('ws-managed', 'install-real')).toBe(true)
    const status = registry.mcpConfigStatus('ws-managed', 'install-real', 'status-real')
    expect(redeemed.emitted[0]?.event).toBe('executor:mcp_config_status')
    redeemed.emitted[0]!.ack!({ ok: true, servers: [] } as never)
    await expect(status).resolves.toEqual({ ok: true, servers: [] })
    const configure = registry.configureMcp('ws-managed', 'install-real', { requestId: 'configure-real', servers: [] })
    expect(redeemed.emitted[1]?.event).toBe('executor:mcp_configure')
    redeemed.emitted[1]!.ack!({ ok: true } as never)
    await expect(configure).resolves.toEqual({ ok: true })
  })

  it('revalidates enrolled workspace authority and rejects stale MCP replies and foreign targets', async () => {
    let authorized = true
    const registry = createExecutorRegistry(fakeIo() as never, makeResolver(), 5_000, undefined, 0, async () => authorized)
    const socket = makeFakeSocket('enrolled')
    socket.data.executorIdentity = { accepted: true, workspaceId: 'ws-enrolled' }
    registry.attach(socket as never, announceOf('enrolled', 'ws-enrolled'))
    expect(registry.hasTrustedWorkspaceExecutor('ws-enrolled', 'other')).toBe(false)
    expect(registry.hasTrustedWorkspaceExecutor('foreign', 'enrolled')).toBe(false)
    expect(registry.hasTrustedWorkspaceExecutor('ws-enrolled', 'enrolled')).toBe(true)
    const status = registry.mcpConfigStatus('ws-enrolled', { executorId: 'enrolled' }, 'read')
    await vi.waitFor(() => expect(socket.emitted).toHaveLength(1))
    socket.emitted[0]!.ack!({ ok: true, servers: [] } as never)
    await expect(status).resolves.toEqual({ ok: true, servers: [] })
    const update = registry.configureMcp('ws-enrolled', { executorId: 'enrolled' }, { requestId: 'update', servers: [] })
    await vi.waitFor(() => expect(socket.emitted).toHaveLength(2))
    socket.connected = false
    socket.emitted[1]!.ack!({ ok: true } as never)
    await expect(update).resolves.toMatchObject({ ok: false })
    socket.connected = true
    authorized = false
    await expect(registry.configureMcp('ws-enrolled', { executorId: 'enrolled' }, { requestId: 'revoked', servers: [] })).resolves.toMatchObject({ ok: false })
    expect(socket.emitted).toHaveLength(2)
  })

  it('dispatches a tool call and resolves on ack', async () => {
    const reg = createExecutorRegistry(
      fakeIo() as never,
      makeResolver({ 'sess-1': 'ws-default' }),
      5_000,
    )
    const sock = makeFakeSocket('s1')
    reg.attach(sock as never, announceOf('e1'))

    const p = reg.callTool('sess-1', callEffect('c1', 'bash', '/tmp/work'))
    expect(sock.emitted).toHaveLength(1)
    expect(sock.emitted[0]!.event).toBe('tool:call')
    const payload = sock.emitted[0]!.payload as ToolCallMessage
    expect(payload.cwd).toBe('/tmp/work')
    expect(payload.ackTimeoutMs).toBe(5_000)
    expect('timeoutMs' in payload).toBe(false)

    // Ack via the callback — this is the sole settle path now that the
    // redundant executor:tool_result event has been removed.
    sock.emitted[0]!.ack!({ callId: 'c1', ok: true, content: 'hi\n' })
    await expect(p).resolves.toEqual({ ok: true, content: 'hi\n' })
  })

  it('keeps bash business timeout in input and stretches only the host ack timeout', async () => {
    const reg = createExecutorRegistry(
      fakeIo() as never,
      makeResolver({ 'sess-long': 'ws-default' }),
      60_000,
    )
    const sock = makeFakeSocket('s-long')
    reg.attach(sock as never, announceOf('e-long'))

    const p = reg.callTool('sess-long', callEffect('c-long', 'bash', undefined, {
      command: 'pnpm test',
      timeout_seconds: 600,
    }))
    const payload = sock.emitted[0]!.payload as ToolCallMessage
    expect(payload.input).toEqual({ command: 'pnpm test', timeout_seconds: 600 })
    expect(payload.ackTimeoutMs).toBe(660_000)
    expect('timeoutMs' in payload).toBe(false)

    sock.emitted[0]!.ack!({ callId: 'c-long', ok: true, content: 'ok' })
    await expect(p).resolves.toEqual({ ok: true, content: 'ok' })
  })

  it.each([['bash_output', true, 60_000, 66_000], ['bash_output', true, 120_000, 132_000], ['bash_output', false, 120_000, 60_000], ['shell', false, undefined, 132_000]] as const)('budgets acknowledgement separately from %s blocking=%s timeout=%s', async (name, block, timeoutMs, expected) => {
    const reg = createExecutorRegistry(fakeIo() as never, makeResolver({ 'sess-poll': 'ws-default' }), 60_000)
    const sock = makeFakeSocket('s-poll')
    reg.attach(sock as never, announceOf('e-poll'))
    const input = name === 'shell' ? { command: 'sleep 120', timeout_seconds: 120 } : { task_id: 'task', block, timeout_ms: timeoutMs }
    const p = reg.callTool('sess-poll', callEffect('c-poll', name, undefined, input))
    const payload = sock.emitted[0]!.payload as ToolCallMessage
    expect(payload.input).toEqual(input)
    expect(payload.ackTimeoutMs).toBe(expected)
    sock.emitted[0]!.ack!({ callId: 'c-poll', ok: true, content: 'done' })
    await expect(p).resolves.toMatchObject({ ok: true })
  })

  it('budgets acknowledgement timeout for process(action=poll, block=true) and shell(yield_time_ms) across remote executors', async () => {
    const reg = createExecutorRegistry(fakeIo() as never, makeResolver({ 'sess-proc': 'ws-default' }), 60_000)
    const sock = makeFakeSocket('s-proc')
    reg.attach(sock as never, announceOf('e-proc'))

    const pollPromise = reg.callTool(
      'sess-proc',
      callEffect('c-proc-poll', 'process', undefined, {
        action: 'poll',
        task_id: 'task-1',
        block: true,
        timeout_ms: 90_000,
      }),
    )
    const pollPayload = sock.emitted[0]!.payload as ToolCallMessage
    expect(pollPayload.ackTimeoutMs).toBe(99_000)
    sock.emitted[0]!.ack!({ callId: 'c-proc-poll', ok: true, content: '{}' })
    await expect(pollPromise).resolves.toMatchObject({ ok: true })

    const yieldPromise = reg.callTool(
      'sess-proc',
      callEffect('c-shell-yield', 'shell', undefined, {
        command: 'npm run dev',
        yield_time_ms: 90_000,
      }),
    )
    const yieldPayload = sock.emitted[1]!.payload as ToolCallMessage
    expect(yieldPayload.ackTimeoutMs).toBe(99_000)
    sock.emitted[1]!.ack!({ callId: 'c-shell-yield', ok: true, content: '{}' })
    await expect(yieldPromise).resolves.toMatchObject({ ok: true })

    const cappedPoll = reg.callTool(
      'sess-proc',
      callEffect('c-proc-capped', 'process', undefined, {
        action: 'poll', task_id: 'task-1', block: true, timeout_ms: 900_000,
      }),
    )
    expect((sock.emitted[2]!.payload as ToolCallMessage).ackTimeoutMs).toBe(330_000)
    sock.emitted[2]!.ack!({ callId: 'c-proc-capped', ok: true, content: '{}' })
    await expect(cappedPoll).resolves.toMatchObject({ ok: true })
  })

  it('fails pending calls when the executor disconnects with no replacement', async () => {
    const reg = createExecutorRegistry(
      fakeIo() as never,
      makeResolver({ 'sess-3': 'ws-default' }),
      5_000,
      undefined,
      0, // no grace window — assert instant-detach semantics
    )
    const sock = makeFakeSocket('s3')
    reg.attach(sock as never, announceOf('e3'))

    const p = reg.callTool('sess-3', callEffect('c1'))
    reg.detach(sock as never)
    await expect(p).resolves.toEqual({
      ok: false,
      content: 'executor disconnected',
    })
  })

  it('preserves pending calls across a reconnect and re-emits to the new socket', async () => {
    // B7 regression: a network blip mid-tool-call previously failed every
    // in-flight call before the new executor got to run them. Session
    // identity is baked into the pending record so redispatch delivers the
    // same sessionId onward.
    const reg = createExecutorRegistry(
      fakeIo() as never,
      makeResolver({ 'sess-4': 'ws-default' }),
      5_000,
    )
    const oldSock = makeFakeSocket('old')
    reg.attach(oldSock as never, announceOf('e-reconnect'))

    const p = reg.callTool('sess-4', callEffect('c1', 'bash', '/tmp/retry'))
    expect(oldSock.emitted).toHaveLength(1)

    // Reconnect: same executorId, fresh socket.
    const newSock = makeFakeSocket('new')
    reg.attach(newSock as never, announceOf('e-reconnect'))

    let resolvedEarly = false
    void p.then(() => {
      resolvedEarly = true
    })
    await Promise.resolve()
    expect(resolvedEarly).toBe(false)

    expect(newSock.emitted).toHaveLength(1)
    const redispatched = newSock.emitted[0]!
    expect(redispatched.event).toBe('tool:call')
    const rePayload = redispatched.payload as ToolCallMessage
    expect(rePayload.callId).toBe('c1')
    expect(rePayload.sessionId).toBe('sess-4')
    expect(rePayload.name).toBe('bash')
    expect(rePayload.cwd).toBe('/tmp/retry')
    expect(rePayload.input).toEqual({ command: 'echo hi' })

    // Old executor's late ACK is ignored (its bind was removed).
    oldSock.emitted[0]!.ack!({
      callId: 'c1',
      ok: false,
      content: 'ghost result',
    })

    redispatched.ack!({ callId: 'c1', ok: true, content: 'redone' })
    await expect(p).resolves.toEqual({ ok: true, content: 'redone' })
  })

  it.each([
    ['credential_revoked', 'executor_credential_revoked'],
    ['identity_authority_unavailable', 'executor_identity_unavailable'],
  ] as const)('invalidates pending work for %s without replay or a late-authorized stale emit', async (reason, code) => {
    let check = 0
    let releaseLateCheck!: (authorized: boolean) => void
    const lateCheck = new Promise<boolean>((resolve) => { releaseLateCheck = resolve })
    const reg = createExecutorRegistry(
      fakeIo() as never,
      makeResolver({ session: 'ws-revoked' }),
      5_000,
      undefined,
      500,
      async () => ++check === 1 ? true : await lateCheck,
    )
    const revoked = makeFakeSocket('revoked')
    reg.attach(revoked as never, announceOf('e-revoked', 'ws-revoked'))

    const inFlight = reg.callTool('session', callEffect('already-sent'))
    await vi.waitFor(() => expect(revoked.emitted).toHaveLength(1))

    const staleDispatch = reg.callTool('session', callEffect('must-not-send'))
    reg.revoke(revoked as never, reason)
    const replacement = makeFakeSocket('replacement')
    reg.attach(replacement as never, announceOf('e-replacement', 'ws-revoked'))
    releaseLateCheck(true)

    await expect(inFlight).resolves.toMatchObject({
      ok: false,
      failure: { code, outcome: 'indeterminate', retryable: false },
      content: reason === 'credential_revoked'
        ? 'executor credential revoked while tool call outcome was unknown'
        : 'executor identity authority unavailable while tool call outcome was unknown',
    })
    await expect(staleDispatch).resolves.toEqual({ ok: false, content: 'executor unavailable' })
    expect(revoked.emitted.map((call) => (call.payload as ToolCallMessage).callId)).toEqual(['already-sent'])
    expect(replacement.emitted).toHaveLength(0)
  })

  it('supersede-then-disconnect only fails calls still pending on the new socket', async () => {
    const reg = createExecutorRegistry(
      fakeIo() as never,
      makeResolver({ 'sess-5': 'ws-default' }),
      5_000,
      undefined,
      0, // no grace window — assert instant-detach semantics
    )
    const oldSock = makeFakeSocket('old-2')
    reg.attach(oldSock as never, announceOf('e-drop'))
    const p = reg.callTool('sess-5', callEffect('c1'))
    const newSock = makeFakeSocket('new-2')
    reg.attach(newSock as never, announceOf('e-drop'))
    reg.detach(newSock as never)
    await expect(p).resolves.toEqual({
      ok: false,
      content: 'executor disconnected',
    })
  })

  it('detach on a stale socket is a no-op (does not disturb the current bind)', async () => {
    const reg = createExecutorRegistry(
      fakeIo() as never,
      makeResolver({ 'sess-6': 'ws-default' }),
      5_000,
    )
    const oldSock = makeFakeSocket('stale-old')
    reg.attach(oldSock as never, announceOf('e-stale'))
    const p = reg.callTool('sess-6', callEffect('c1'))
    const newSock = makeFakeSocket('stale-new')
    reg.attach(newSock as never, announceOf('e-stale'))

    reg.detach(oldSock as never)

    const redispatched = newSock.emitted[newSock.emitted.length - 1]!
    redispatched.ack!({ callId: 'c1', ok: true, content: 'ok' })
    await expect(p).resolves.toEqual({ ok: true, content: 'ok' })
  })

  it('detach grace window: a fresh executorId that reclaims the same workspaceId resurrects pending calls and emits "updated" (no detach flicker)', async () => {
    const changes: ServerExecutorChangedPayload[] = []
    const reg = createExecutorRegistry(
      fakeIo() as never,
      makeResolver({ 'sess-grace': 'ws-restart' }),
      5_000,
      undefined,
      500, // 500ms grace window
    )
    reg.onChange((c) => changes.push(c))

    const oldSock = makeFakeSocket('grace-old')
    reg.attach(oldSock as never, announceOf('e-old', 'ws-restart'))
    const p = reg.callTool('sess-grace', callEffect('c1'))
    expect(oldSock.emitted).toHaveLength(1)

    // Executor process dies. Grace timer starts; no detach event yet.
    reg.detach(oldSock as never)
    expect(changes.find((c) => c.change === 'detached')).toBeUndefined()

    // Process restarts with a fresh executorId but same workspaceId.
    const newSock = makeFakeSocket('grace-new')
    reg.attach(newSock as never, announceOf('e-new', 'ws-restart'))

    // Pending call transferred and re-emitted to the new socket.
    expect(newSock.emitted).toHaveLength(1)
    const redispatched = newSock.emitted[0]!
    expect((redispatched.payload as ToolCallMessage).callId).toBe('c1')

    // Wire event is 'updated', not 'attached' — the dashboard sees a
    // seamless swap instead of a flicker.
    const lastChange = changes[changes.length - 1]
    expect(lastChange?.change).toBe('updated')

    redispatched.ack!({ callId: 'c1', ok: true, content: 'survived' })
    await expect(p).resolves.toEqual({ ok: true, content: 'survived' })

    // The detach event never fires after grace resolution.
    await new Promise((r) => setTimeout(r, 600))
    expect(changes.find((c) => c.change === 'detached')).toBeUndefined()
  })

  it('detach grace window: if nobody reconnects, pending calls fail and detached fans out when the timer fires', async () => {
    const changes: ServerExecutorChangedPayload[] = []
    const reg = createExecutorRegistry(
      fakeIo() as never,
      makeResolver({ 'sess-grace-expire': 'ws-lonely' }),
      5_000,
      undefined,
      50, // very short grace
    )
    reg.onChange((c) => changes.push(c))

    const sock = makeFakeSocket('lonely')
    reg.attach(sock as never, announceOf('e-lonely', 'ws-lonely'))
    const p = reg.callTool('sess-grace-expire', callEffect('c1'))
    reg.detach(sock as never)

    await expect(p).resolves.toEqual({
      ok: false,
      content: 'executor disconnected',
    })
    expect(changes.at(-1)?.change).toBe('detached')
  })

  it('honours the tool-call timeout when nobody ever acks', async () => {
    vi.useFakeTimers()
    try {
      const reg = createExecutorRegistry(
        fakeIo() as never,
        makeResolver({ 'sess-7': 'ws-default' }),
        100,
      )
      const sock = makeFakeSocket('to')
      reg.attach(sock as never, announceOf('e-to'))
      const p = reg.callTool('sess-7', callEffect('c1'))
      await vi.advanceTimersByTimeAsync(150)
      await expect(p).resolves.toMatchObject({
        ok: false,
        content: 'tool call ack timed out after 100ms; execution outcome is unknown. Inspect current state before retrying; do not blindly repeat side effects.',
        failure: { code: 'tool_ack_timeout', category: 'infrastructure', outcome: 'indeterminate', retryable: false, responsibility: 'system', timeoutStage: 'acknowledgement' },
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('preserves the original timeout deadline across reconnects', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    try {
      const reg = createExecutorRegistry(
        fakeIo() as never,
        makeResolver({ 'sess-deadline': 'ws-default' }),
        100,
      )
      const first = makeFakeSocket('deadline-1')
      reg.attach(first as never, announceOf('e-deadline'))
      const pending = reg.callTool('sess-deadline', callEffect('c-deadline'))

      await vi.advanceTimersByTimeAsync(80)
      const replacement = makeFakeSocket('deadline-2')
      reg.attach(replacement as never, announceOf('e-deadline'))

      // Reconnect leaves only the original 20ms budget; it must not reset to a
      // new 100ms window.
      await vi.advanceTimersByTimeAsync(19)
      let settled = false
      void pending.then(() => { settled = true })
      await Promise.resolve()
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await expect(pending).resolves.toMatchObject({
        ok: false,
        content: 'tool call ack timed out after 100ms (post-reconnect); execution outcome is unknown. Inspect current state before retrying; do not blindly repeat side effects.',
        failure: { code: 'tool_ack_timeout', category: 'infrastructure', outcome: 'indeterminate', retryable: false, responsibility: 'system', timeoutStage: 'acknowledgement' },
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancelPending emits tool:cancel for every in-flight call in that session', () => {
    const reg = createExecutorRegistry(
      fakeIo() as never,
      makeResolver({ 'sess-8': 'ws-default' }),
      5_000,
    )
    const sock = makeFakeSocket('cx')
    reg.attach(sock as never, announceOf('e-cx'))
    void reg.callTool('sess-8', callEffect('c1'))
    void reg.callTool('sess-8', callEffect('c2'))
    reg.cancelPending('sess-8')
    const cancels = sock.emitted.filter((e) => e.event === 'tool:cancel')
    expect(cancels).toHaveLength(2)
    expect(cancels.map((c) => (c.payload as { callId: string }).callId).sort()).toEqual([
      'c1',
      'c2',
    ])
  })

  it('cancels pending calls during detach grace and does not redispatch them', async () => {
    const reg = createExecutorRegistry(
      fakeIo() as never,
      makeResolver({ 'sess-grace-cancel': 'ws-default' }),
      5_000,
      undefined,
      10_000,
    )
    const oldSock = makeFakeSocket('grace-cancel-old')
    reg.attach(oldSock as never, announceOf('e-grace-cancel'))
    const pending = reg.callTool('sess-grace-cancel', callEffect('c1'))

    reg.detach(oldSock as never)
    expect(reg.activeSessions()).toEqual(['sess-grace-cancel'])
    reg.cancelPending('sess-grace-cancel')
    await expect(pending).resolves.toEqual({ ok: false, content: 'cancelled by user' })
    expect(reg.activeSessions()).toEqual([])

    const newSock = makeFakeSocket('grace-cancel-new')
    reg.attach(newSock as never, announceOf('e-grace-cancel'))
    expect(newSock.emitted.filter((entry) => entry.event === 'tool:call')).toHaveLength(0)
  })

  it('routes two different sessions to the same executor (1:N)', async () => {
    const reg = createExecutorRegistry(
      fakeIo() as never,
      makeResolver({ 'sess-A': 'ws-default', 'sess-B': 'ws-default' }),
      5_000,
    )
    const sock = makeFakeSocket('daemon')
    reg.attach(sock as never, announceOf('e-shared'))

    const pA = reg.callTool('sess-A', callEffect('a1'))
    const pB = reg.callTool('sess-B', callEffect('b1'))
    expect(sock.emitted).toHaveLength(2)
    expect((sock.emitted[0]!.payload as ToolCallMessage).sessionId).toBe('sess-A')
    expect((sock.emitted[1]!.payload as ToolCallMessage).sessionId).toBe('sess-B')

    sock.emitted[0]!.ack!({ callId: 'a1', ok: true, content: 'A' })
    sock.emitted[1]!.ack!({ callId: 'b1', ok: true, content: 'B' })
    await expect(pA).resolves.toEqual({ ok: true, content: 'A' })
    await expect(pB).resolves.toEqual({ ok: true, content: 'B' })
  })

  it('cancelPending only cancels calls for the target session, not siblings sharing the executor', () => {
    const reg = createExecutorRegistry(
      fakeIo() as never,
      makeResolver({
        'sess-keep': 'ws-default',
        'sess-cancel': 'ws-default',
      }),
      5_000,
    )
    const sock = makeFakeSocket('shared')
    reg.attach(sock as never, announceOf('e-shared-cancel'))

    void reg.callTool('sess-keep', callEffect('k1'))
    void reg.callTool('sess-cancel', callEffect('c1'))
    void reg.callTool('sess-cancel', callEffect('c2'))

    reg.cancelPending('sess-cancel')

    const cancels = sock.emitted.filter((e) => e.event === 'tool:cancel')
    expect(cancels).toHaveLength(2)
    for (const c of cancels) {
      expect((c.payload as { sessionId: string }).sessionId).toBe('sess-cancel')
    }
  })

  it('reports no-executor when a session tries to call before any daemon attaches', async () => {
    const reg = createExecutorRegistry(
      fakeIo() as never,
      makeResolver({ 'sess-orphan': 'ws-default' }),
      5_000,
    )
    const p = reg.callTool('sess-orphan', callEffect('c1'))
    await expect(p).resolves.toMatchObject({
      ok: false,
      content: 'workspace ws-default is offline — start its executor to run tools',
      failure: { code: 'workspace_offline', outcome: 'blocked' },
    })
  })

  it('waits event-first for a planned-continuation Executor reconnect', async () => {
    vi.useFakeTimers()
    try {
      const reg = createExecutorRegistry(fakeIo() as never, makeResolver({ 'sess-recovery': 'ws-recovery' }), 5_000)
      const waiting = reg.waitForSessionExecutor('sess-recovery', 1_000)
      let settled = false
      void waiting.then(() => { settled = true })
      await vi.advanceTimersByTimeAsync(500)
      expect(settled).toBe(false)

      reg.attach(makeFakeSocket('recovered') as never, announceOf('e-recovered', 'ws-recovery'))
      await expect(waiting).resolves.toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not commit workspace_offline while a planned continuation waits for its Executor', async () => {
    const reg = createExecutorRegistry(
      fakeIo() as never,
      makeResolver({ 'sess-continuation': 'ws-continuation' }),
      5_000,
    )

    const pending = reg.callToolWhenAvailable!('sess-continuation', callEffect('continuation-call'))
    await Promise.resolve()

    const executor = makeFakeSocket('continuation-executor')
    reg.attach(executor as never, announceOf('e-continuation', 'ws-continuation'))
    await vi.waitFor(() => expect(executor.emitted).toHaveLength(1))
    executor.emitted[0]!.ack!({ callId: 'continuation-call', ok: true, content: 'continued' })

    await expect(pending).resolves.toEqual({ ok: true, content: 'continued' })
  })

  it('bounds a planned-continuation Executor reconnect wait', async () => {
    vi.useFakeTimers()
    try {
      const reg = createExecutorRegistry(fakeIo() as never, makeResolver({ 'sess-timeout': 'ws-timeout' }), 5_000)
      const waiting = reg.waitForSessionExecutor('sess-timeout', 100)
      await vi.advanceTimersByTimeAsync(100)
      await expect(waiting).resolves.toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('routes a call to the executor announcing the matching workspaceId', async () => {
    const reg = createExecutorRegistry(
      fakeIo() as never,
      makeResolver({ 'sess-mbp': 'ws-mbp', 'sess-linux': 'ws-linux' }),
      5_000,
    )
    const mbp = makeFakeSocket('mbp')
    const linux = makeFakeSocket('linux')
    reg.attach(mbp as never, announceOf('e-mbp', 'ws-mbp', 'mbp'))
    reg.attach(linux as never, announceOf('e-linux', 'ws-linux', 'linux-box'))

    const p1 = reg.callTool('sess-mbp', callEffect('c1'))
    const p2 = reg.callTool('sess-linux', callEffect('c2'))
    expect(mbp.emitted).toHaveLength(1)
    expect(linux.emitted).toHaveLength(1)
    expect((mbp.emitted[0]!.payload as ToolCallMessage).sessionId).toBe('sess-mbp')
    expect((linux.emitted[0]!.payload as ToolCallMessage).sessionId).toBe('sess-linux')

    mbp.emitted[0]!.ack!({ callId: 'c1', ok: true, content: 'mbp' })
    linux.emitted[0]!.ack!({ callId: 'c2', ok: true, content: 'linux' })
    await expect(p1).resolves.toEqual({ ok: true, content: 'mbp' })
    await expect(p2).resolves.toEqual({ ok: true, content: 'linux' })
  })

  it('reports workspace-offline when the bound workspace has no executor attached', async () => {
    const reg = createExecutorRegistry(
      fakeIo() as never,
      makeResolver({ 'sess-lonely': 'ws-missing' }),
      5_000,
    )
    // Attach a different workspace — the target one is still offline.
    reg.attach(
      makeFakeSocket('other') as never,
      announceOf('e-other', 'ws-other', 'other'),
    )
    const p = reg.callTool('sess-lonely', callEffect('c1'))
    await expect(p).resolves.toMatchObject({
      ok: false,
      content: 'workspace ws-missing is offline — start its executor to run tools',
      failure: { code: 'workspace_offline', outcome: 'blocked' },
    })
  })

  it('legacy sessions with no workspaceId fall back to any online executor', async () => {
    // Sessions predating the workspaceId field must keep working — the
    // resolver returns undefined for them and the registry picks whichever
    // executor is online.
    const reg = createExecutorRegistry(
      fakeIo() as never,
      makeResolver({ 'sess-legacy': undefined }),
      5_000,
    )
    const sock = makeFakeSocket('only')
    reg.attach(sock as never, announceOf('e-only', 'ws-only', 'only'))
    const p = reg.callTool('sess-legacy', callEffect('c1'))
    expect(sock.emitted).toHaveLength(1)
    sock.emitted[0]!.ack!({ callId: 'c1', ok: true, content: 'ok' })
    await expect(p).resolves.toEqual({ ok: true, content: 'ok' })
  })

  it('rejects a second executor claiming the same workspaceId while the first is still connected', () => {
    const reg = createExecutorRegistry(fakeIo() as never, makeResolver(), 5_000)
    const first = makeFakeSocket('first')
    reg.attach(first as never, announceOf('e-first', 'ws-shared'))

    const second = makeFakeSocket('second')
    reg.attach(second as never, announceOf('e-second', 'ws-shared'))

    // Second attempt must be told off + disconnected. First must remain
    // the sole claimant.
    expect(second.connected).toBe(false)
    const reject = second.emitted.find((e) => e.event === 'executor:host_reject')
    expect(reject).toBeDefined()
    expect((reject!.payload as { code: string }).code).toBe('workspace_id_conflict')

    // First should still be able to route tool calls.
    const p = reg.callTool('sess-x', callEffect('c1'))
    expect(first.emitted).toHaveLength(1) // tool:call went to the original
    first.emitted[0]!.ack!({ callId: 'c1', ok: true, content: 'ok' })
    return expect(p).resolves.toEqual({ ok: true, content: 'ok' })
  })

  it('times out terminal create/kill ACKs and routes Session cleanup', async () => {
    vi.useFakeTimers()
    try {
      const reg = createExecutorRegistry(fakeIo() as never, makeResolver({ session: 'ws' }), 5_000)
      const sock = makeFakeSocket('terminal')
      reg.attach(sock as never, announceOf('e-terminal', 'ws'))

      const create = reg.createTerminal({ requestId: 'create', workspaceId: 'ws', sessionId: 'session' })
      const kill = reg.killTerminal({ requestId: 'kill', workspaceId: 'ws', sessionId: 'session', terminalId: 'term' })
      reg.closeSessionTerminals({ workspaceId: 'ws', sessionId: 'session' })
      await vi.advanceTimersByTimeAsync(5_000)

      await expect(kill).resolves.toMatchObject({ killed: false, error: 'terminal kill acknowledgement timed out' })
      expect(sock.emitted.at(-1)).toMatchObject({ event: 'terminal:close_session', payload: { workspaceId: 'ws', sessionId: 'session' } })
      await vi.advanceTimersByTimeAsync(TERMINAL_CREATE_ACK_TIMEOUT_MS - 5_000)
      await expect(create).resolves.toMatchObject({ error: 'terminal create acknowledgement timed out' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('allows delayed native terminal startup and disposes fresh ACKs after timeout or cancellation', async () => {
    vi.useFakeTimers()
    try {
      const reg = createExecutorRegistry(fakeIo() as never, makeResolver())
      const sock = makeFakeSocket('delayed-terminal')
      reg.attach(sock as never, announceOf('e-delayed-terminal', 'ws'))
      const payload = { requestId: 'delayed', workspaceId: 'ws', sessionId: 'session' }
      const first = reg.createTerminal(payload)
      await vi.advanceTimersByTimeAsync(10_000)
      sock.emitted[0]!.ack!({ ...payload, terminalId: 'ready-terminal' } as never)
      await expect(first).resolves.toMatchObject({ terminalId: 'ready-terminal' })
      expect(sock.emitted.filter((call) => call.event === 'terminal:kill')).toHaveLength(0)

      const late = reg.createTerminal({ ...payload, requestId: 'late' })
      const lateAck = sock.emitted.at(-1)!.ack!
      await vi.advanceTimersByTimeAsync(TERMINAL_CREATE_ACK_TIMEOUT_MS)
      await expect(late).resolves.toMatchObject({ error: 'terminal create acknowledgement timed out' })
      lateAck({ ...payload, terminalId: 'late-terminal' } as never)
      expect(sock.emitted.at(-1)).toMatchObject({ event: 'terminal:kill', payload: { terminalId: 'late-terminal' } })

      const controller = new AbortController()
      const cancelled = reg.createTerminal({ ...payload, requestId: 'cancelled' }, controller.signal)
      const cancelledAck = sock.emitted.at(-1)!.ack!
      controller.abort()
      await expect(cancelled).resolves.toMatchObject({ error: 'terminal create cancelled' })
      cancelledAck({ ...payload, terminalId: 'cancelled-terminal' } as never)
      expect(sock.emitted.at(-1)).toMatchObject({ event: 'terminal:kill', payload: { terminalId: 'cancelled-terminal' } })
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets a new executor claim a workspaceId whose previous holder has disconnected', () => {
    const reg = createExecutorRegistry(fakeIo() as never, makeResolver(), 5_000)
    const first = makeFakeSocket('first')
    reg.attach(first as never, announceOf('e-first', 'ws-takeover'))

    // Simulate the first executor's socket having gone down without a
    // detach event yet (race window). Its connected flag is false but the
    // bind still lives in the registry.
    first.connected = false

    const second = makeFakeSocket('second')
    reg.attach(second as never, announceOf('e-second', 'ws-takeover'))

    // Second executor is the new claimant; must not have been disconnected.
    expect(second.connected).toBe(true)
    expect(second.emitted.some((e) => e.event === 'executor:host_reject')).toBe(false)

    // Tool call should route to the new bind. Give the resolver a hint
    // that sess-y is bound to ws-takeover.
    const reg2 = createExecutorRegistry(
      fakeIo() as never,
      makeResolver({ 'sess-y': 'ws-takeover' }),
      5_000,
    )
    const a = makeFakeSocket('a')
    reg2.attach(a as never, announceOf('e-a', 'ws-takeover'))
    a.connected = false
    const b = makeFakeSocket('b')
    reg2.attach(b as never, announceOf('e-b', 'ws-takeover'))

    const p = reg2.callTool('sess-y', callEffect('c1'))
    // Only the new socket b should have received the tool:call
    expect(a.emitted).toHaveLength(0)
    expect(b.emitted).toHaveLength(1)
    b.emitted[0]!.ack!({ callId: 'c1', ok: true, content: 'ok' })
    return expect(p).resolves.toEqual({ ok: true, content: 'ok' })
  })

  it('does not classify legacy double-underscore internal tools as MCP tools', async () => {
    const reg = createExecutorRegistry(fakeIo() as never, makeResolver({ session: 'ws' }), 5_000)
    const socket = makeFakeSocket('legacy-internal')
    reg.attach(socket as never, announceOf('legacy', 'ws'))

    const pending = reg.callTool('session', callEffect('internal', '__fs_list_dirs'))
    expect(socket.emitted).toHaveLength(1)
    socket.emitted[0]!.ack!({ callId: 'internal', ok: true, content: 'ok' })
    await expect(pending).resolves.toEqual({ ok: true, content: 'ok' })
  })

  it('fails active-session MCP calls closed when reannounce removes a crashed service', async () => {
    const reg = createExecutorRegistry(
      fakeIo() as never,
      makeResolver({ 'sess-mcp': 'ws-mcp' }),
      5_000,
    )
    const socket = makeFakeSocket('mcp')
    const available = {
      ...announceOf('e-mcp', 'ws-mcp'),
      tools: ['bash', 'docs__search'],
      mcpTools: [{
        name: 'docs__search',
        description: 'Search docs',
        inputSchema: { type: 'object' },
        schemaHash: '0'.repeat(64),
      }],
    }
    reg.attach(socket as never, available)
    const pending = reg.callTool('sess-mcp', callEffect('mcp-running', 'docs__search'))
    expect(socket.emitted.filter((entry) => entry.event === 'tool:call')).toHaveLength(1)

    // The Executor uses a same-socket reannounce when the backing MCP server exits.
    reg.attach(socket as never, announceOf('e-mcp', 'ws-mcp'))
    await expect(pending).resolves.toMatchObject({
      ok: false,
      failure: { code: 'mcp_tool_unavailable', outcome: 'blocked' },
    })
    expect(socket.emitted.filter((entry) => entry.event === 'tool:call')).toHaveLength(1)

    await expect(reg.callTool('sess-mcp', callEffect('mcp-stale', 'docs__search'))).resolves.toMatchObject({
      ok: false,
      failure: { code: 'mcp_tool_unavailable', outcome: 'blocked' },
    })
    expect(socket.emitted.filter((entry) => entry.event === 'tool:call')).toHaveLength(1)
  })

  it('rejects a same-name MCP schema change for an active session and its in-flight call', async () => {
    const oldHash = 'a'.repeat(64)
    const newHash = 'b'.repeat(64)
    const reg = createExecutorRegistry(fakeIo() as never, {
      workspaceIdFor: () => 'ws-versioned',
      mcpSchemaHashFor: () => oldHash,
    }, 5_000)
    const socket = makeFakeSocket('versioned')
    const announcement = (hash: string) => ({
      ...announceOf('e-versioned', 'ws-versioned'),
      tools: ['bash', 'docs__search'],
      mcpTools: [{ name: 'docs__search', description: 'Search docs', inputSchema: { type: 'object' }, schemaHash: hash }],
    })
    reg.attach(socket as never, announcement(oldHash))
    const pending = reg.callTool('session', callEffect('old-in-flight', 'docs__search'))
    expect(socket.emitted.filter((entry) => entry.event === 'tool:call')).toHaveLength(1)
    reg.attach(socket as never, announcement(newHash))
    await expect(pending).resolves.toMatchObject({ ok: false, failure: { code: 'mcp_tool_unavailable' } })
    await expect(reg.callTool('session', callEffect('old-again', 'docs__search'))).resolves.toMatchObject({ ok: false, failure: { code: 'mcp_tool_unavailable' } })
    expect(socket.emitted.filter((entry) => entry.event === 'tool:call')).toHaveLength(1)
  })

  it('never dispatches one workspace MCP tool to another workspace executor', async () => {
    const reg = createExecutorRegistry(
      fakeIo() as never,
      makeResolver({ 'sess-a': 'ws-a', 'sess-b': 'ws-b' }),
      5_000,
    )
    const first = makeFakeSocket('workspace-a')
    const second = makeFakeSocket('workspace-b')
    reg.attach(first as never, {
      ...announceOf('e-a', 'ws-a'),
      tools: ['bash', 'docs__search'],
      mcpTools: [{ name: 'docs__search', description: '', inputSchema: { type: 'object' }, schemaHash: '0'.repeat(64) }],
    })
    reg.attach(second as never, announceOf('e-b', 'ws-b'))

    await expect(reg.callTool('sess-b', callEffect('wrong-workspace', 'docs__search'))).resolves.toMatchObject({
      ok: false,
      failure: { code: 'mcp_tool_unavailable' },
    })
    expect(first.emitted).toHaveLength(0)
    expect(second.emitted).toHaveLength(0)
  })
})
