import { describe, expect, it, vi } from 'vitest'
import { messageOperationFingerprint } from '../message-operation-fingerprint.js'
import type { ChildCommand, ChildCommandInbox } from './child-command-state.js'
import { reconcileChildTurn, startChildCommandWorker, stopChildTurn } from './child-command-worker.js'
import { consumeNextChildCommand } from './child-command-consumer.js'

describe('child command owner worker', () => {
  it('delivers a persisted initial completion only through the parent owner, retrying failed delivery', async () => {
    let acknowledged = false
    const finishedAt = new Date().toISOString()
    const onChildFinished = vi.fn()
      .mockImplementationOnce(() => { throw new Error('dashboard temporarily unavailable') })
      .mockImplementation(() => undefined)
    const acknowledgeChildCompletion = vi.fn(async () => { acknowledged = true })
    const stop = startChildCommandWorker({
      inbox: {
        pendingChildSessionIds: async () => [],
        pendingFinishedParentSessionIds: async () => acknowledged ? [] : ['parent'],
        readPendingChildCompletions: async () => [{
          commandId: 'initial', parentSessionId: 'parent', childSessionId: 'child',
          kind: 'message', message: 'prompt', status: 'completed', outcome: { ok: true, content: 'done' },
          completedAt: finishedAt, sequence: '1',
        }],
        acknowledgeChildCompletion,
      } as unknown as ChildCommandInbox,
      store: {
        load: async () => ({
          parentSessionId: 'parent', parentCallId: 'initial',
          subAgentStartedAt: new Date(Date.parse(finishedAt) - 100).toISOString(),
        }),
        countCompletedChildModelTurns: async () => 2,
      } as never,
      runtimes: {} as never,
      assertOwner: async () => undefined,
      onChildFinished,
    }, 10)
    try {
      await vi.waitFor(() => expect(acknowledgeChildCompletion).toHaveBeenCalledOnce())
      expect(onChildFinished).toHaveBeenCalledTimes(2)
      expect(onChildFinished).toHaveBeenLastCalledWith({
        parentSessionId: 'parent', parentCallId: 'initial', childSessionId: 'child',
        status: 'completed', turns: 2, durationMs: 100, finishedAt,
      })
    } finally { await stop() }
  })

  it('replays confirmed completion into a subscribing replica room without acquiring the parent lease', async () => {
    const finishedAt = new Date().toISOString()
    let rooms = ['parent']
    const onChildFinished = vi.fn()
    const readFinishedChildCompletions = vi.fn(async (_parent, since?: unknown) => since ? [] : [{
      commandId: 'initial', parentSessionId: 'parent', childSessionId: 'child',
      kind: 'message' as const, message: 'prompt', status: 'completed' as const,
      outcome: { ok: true, content: 'done' }, completedAt: finishedAt, sequence: '1',
    }])
    const assertOwner = vi.fn(async () => { throw new Error('parent is owned on another replica') })
    const stop = startChildCommandWorker({
      inbox: {
        pendingChildSessionIds: async () => [],
        pendingFinishedParentSessionIds: async () => [],
        readFinishedChildCompletions,
      } as unknown as ChildCommandInbox,
      store: {
        load: async () => ({ parentSessionId: 'parent', parentCallId: 'initial' }),
        countCompletedChildModelTurns: async () => 1,
      } as never,
      runtimes: {} as never,
      assertOwner,
      listLocalParentRooms: () => rooms,
      onChildFinished,
    }, 10)
    try {
      await vi.waitFor(() => expect(onChildFinished).toHaveBeenCalledOnce())
      expect(assertOwner).not.toHaveBeenCalled()
      rooms = []
      await new Promise<void>((resolve) => setTimeout(resolve, 40))
      rooms = ['parent']
      await vi.waitFor(() => expect(onChildFinished).toHaveBeenCalledTimes(2))
    } finally { await stop() }
  })

  it('replays an earlier child that commits after a later child without repeating delivered notices', async () => {
    let lateCommitted = false
    const finishedAt = new Date().toISOString()
    const notices = (late: boolean) => [
      { commandId: 'call-b', parentSessionId: 'parent', childSessionId: 'child-b',
        kind: 'message' as const, message: 'B', status: 'completed' as const,
        outcome: { ok: true, content: 'done' }, completedAt: new Date(Date.parse(finishedAt) + 1).toISOString(),
        sequence: '1' },
      ...(late ? [{ commandId: 'call-a', parentSessionId: 'parent', childSessionId: 'child-a',
        kind: 'message' as const, message: 'A', status: 'completed' as const,
        outcome: { ok: true, content: 'done' }, completedAt: finishedAt, sequence: '2' }] : []),
    ]
    const onChildFinished = vi.fn()
    const stop = startChildCommandWorker({
      inbox: {
        pendingChildSessionIds: async () => [],
        pendingFinishedParentSessionIds: async () => [],
        readFinishedChildCompletions: async (_parent: string, since?: { sequence: string }) =>
          notices(lateCommitted).filter((notice) => !since || Number(notice.sequence) > Number(since.sequence)),
      } as unknown as ChildCommandInbox,
      store: {
        load: async (id: string) => ({
          parentSessionId: 'parent', parentCallId: id === 'child-a' ? 'call-a' : 'call-b',
        }),
        countCompletedChildModelTurns: async () => 1,
      } as never,
      runtimes: {} as never,
      assertOwner: async () => undefined,
      listLocalParentRooms: () => ['parent'],
      onChildFinished,
    }, 10)
    try {
      await vi.waitFor(() => expect(onChildFinished).toHaveBeenCalledTimes(1))
      lateCommitted = true
      await vi.waitFor(() => expect(onChildFinished).toHaveBeenCalledTimes(2))
      expect(onChildFinished.mock.calls.map(([notice]) => notice.childSessionId)).toEqual(['child-b', 'child-a'])
      await new Promise<void>((resolve) => setTimeout(resolve, 50))
      expect(onChildFinished).toHaveBeenCalledTimes(2)
    } finally { await stop() }
  })

  it('paginates a long completed history once, then polls only above a stable sequence', async () => {
    const finishedAt = new Date().toISOString()
    const onChildFinished = vi.fn()
    const readFinishedChildCompletions = vi.fn(async (_parent: string, since?: { sequence: string }) => {
      const start = Number(since?.sequence ?? 0) + 1
      return Array.from({ length: Math.max(0, Math.min(128, 1_100 - start + 1)) }, (_, index) => {
        const sequence = start + index
        return {
          commandId: `call-${sequence}`, parentSessionId: 'parent', childSessionId: `child-${sequence}`,
          kind: 'message' as const, message: 'prompt', status: 'completed' as const,
          outcome: { ok: true, content: 'done' }, completedAt: finishedAt, sequence: String(sequence),
        }
      })
    })
    const stop = startChildCommandWorker({
      inbox: {
        pendingChildSessionIds: async () => [],
        pendingFinishedParentSessionIds: async () => [],
        readFinishedChildCompletions,
      } as unknown as ChildCommandInbox,
      store: {
        load: async (id: string) => ({ parentSessionId: 'parent', parentCallId: id.replace('child-', 'call-') }),
        countCompletedChildModelTurns: async () => 1,
      } as never,
      runtimes: {} as never,
      assertOwner: async () => undefined,
      listLocalParentRooms: () => ['parent'],
      onChildFinished,
    }, 10)
    try {
      await vi.waitFor(() => expect(onChildFinished).toHaveBeenCalledTimes(1_100))
      await new Promise<void>((resolve) => setTimeout(resolve, 50))
      expect(onChildFinished).toHaveBeenCalledTimes(1_100)
      expect(readFinishedChildCompletions.mock.calls.at(-1)?.[1]).toEqual({ sequence: '1100' })
      expect(readFinishedChildCompletions.mock.calls.length).toBeLessThan(30)
    } finally { await stop() }
  })

  it('continues deadlines, out-of-band UNKNOWN Stop and other children during a suspended runtime send', async () => {
    let releaseSend!: () => void
    const suspendedSend = new Promise<void>((resolve) => { releaseSend = resolve })
    let timedOut = false
    let stopClaimed = false
    let expired = false
    const stopOutcomes: Array<{ ok: boolean; content: string }> = []
    const send = vi.fn(async (record: { sessionId: string }) => {
      if (record.sessionId === 'child-a') await suspendedSend
    })
    const command = (id: string): ChildCommand => ({
      commandId: `initial-${id}`, parentSessionId: 'parent', childSessionId: id,
      kind: 'message', message: `prompt-${id}`, status: 'claimed',
    })
    const stop = startChildCommandWorker({
      inbox: {
        pendingChildSessionIds: async () => ['child-a', 'child-b'],
        hasStopBarrier: async (id: string) => id === 'child-a' && timedOut,
        readActiveChildMessage: async (id: string) => id === 'child-a' ? {
          ...command(id), timeoutMs: 1_000,
        } : undefined,
        enqueueTimedOutChildStop: async () => { timedOut = true; return undefined },
        claimChildStop: async (id: string) => {
          if (id !== 'child-a' || !timedOut || stopClaimed) return undefined
          stopClaimed = true
          return { ...command(id), kind: 'stop', message: undefined, commandId: 'timeout-child-a' }
        },
        claimChildCommand: async (id: string) => id === 'child-a' || id === 'child-b' ? command(id) : undefined,
        markChildCommandDispatched: async (id: string, commandId: string) => ({
          ...command(id), commandId, dispatchedAt: new Date().toISOString(),
        }),
        completeChildCommand: async (_id: string, commandId: string, outcome: { ok: boolean; content: string }) => {
          if (commandId === 'timeout-child-a') stopOutcomes.push(outcome)
          return command('child-a')
        },
        hasUnconfirmedMessageBeforeStop: async () => true,
      } as unknown as ChildCommandInbox,
      store: {
        load: async (id: string) => ({
          sessionId: id, parentSessionId: 'parent', parentCallId: `initial-${id}`,
          subAgentStartedAt: new Date(Date.now() - (expired ? 2_000 : 0)).toISOString(),
          agentRuntime: 'kernel', state: { status: 'idle', pendingCalls: [] },
        }),
        findOperation: async () => undefined,
      } as never,
      runtimes: { require: () => ({ send, cancelForChildStop: async () => true }) } as never,
      assertOwner: async () => undefined,
    }, 10)
    try {
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2))
      expired = true
      await vi.waitFor(() => expect(stopOutcomes).toHaveLength(1))
      expect(stopOutcomes[0]).toMatchObject({ ok: false, content: expect.stringContaining('UNKNOWN') })
      expect(timedOut).toBe(true)
      await expect(Promise.race([
        stop().then(() => 'stopped'),
        new Promise((resolve) => setTimeout(() => resolve('blocked'), 200)),
      ])).resolves.toBe('stopped')
    } finally {
      releaseSend()
      await stop()
    }
  })

  it('reconciles a claimed terminal after a failed completion commit without replaying the send or advancing early', async () => {
    const commands: ChildCommand[] = ['first', 'second'].map((commandId) => ({
      commandId, childSessionId: 'child', parentSessionId: 'parent',
      kind: 'message', message: commandId, status: 'pending',
    }))
    let commitsFail = true
    let terminal = false
    const send = vi.fn(async (_record: unknown, _input: { operationId: string }) => { terminal = true })
    const completeChildCommand = vi.fn(async (_id: string, commandId: string, outcome: { ok: boolean; content: string }) => {
      if (commandId === 'first' && commitsFail) throw Object.assign(new Error('transaction rolled back'), { code: '40P01' })
      const command = commands.find((item) => item.commandId === commandId)!
      command.status = 'completed'
      command.outcome = outcome
      return { ...command }
    })
    const stop = startChildCommandWorker({
      inbox: {
        pendingChildSessionIds: async () => commands.some((item) => item.status !== 'completed') ? ['child'] : [],
        hasStopBarrier: async () => false,
        claimChildStop: async () => undefined,
        claimChildCommand: async () => {
          const head = commands.find((item) => item.status !== 'completed')
          if (!head || head.status === 'claimed') return undefined
          head.status = 'claimed'
          return { ...head }
        },
        markChildCommandDispatched: async (_id: string, commandId: string) => {
          const head = commands.find((item) => item.commandId === commandId)!
          head.dispatchedAt = new Date().toISOString()
          return { ...head }
        },
        completeChildCommand,
      } as unknown as ChildCommandInbox,
      store: {
        load: async () => ({ parentSessionId: 'parent', agentRuntime: 'copilot',
          state: { status: terminal ? 'done' : 'idle', pendingCalls: [] } }),
        findOperation: async (_id: string, commandId: string) => terminal
          ? { kind: 'runtime_metadata', action: 'copilot.user_message',
            requestFingerprint: messageOperationFingerprint(commandId) } : undefined,
        findLatestRuntimeMetadata: async () => ({ payload: { childCommandId: 'first' } }),
      } as never,
      runtimes: { require: () => ({ send }) } as never,
      assertOwner: async () => undefined,
    }, 10)
    try {
      await vi.waitFor(() => expect(completeChildCommand.mock.calls.length).toBeGreaterThan(2))
      expect(send).toHaveBeenCalledTimes(1)
      expect(commands[0]?.status).toBe('claimed')
      expect(commands[1]?.status).toBe('pending')
      commitsFail = false
      await vi.waitFor(() => expect(commands[0]?.status).toBe('completed'))
      expect(send.mock.calls.filter(([, input]) => input.operationId === 'first')).toHaveLength(1)
    } finally { await stop() }
  })

  it('retries a rolled-back dispatch marker only after proving the claimed head and SDK operation are absent', async () => {
    const commands: ChildCommand[] = ['first', 'second'].map((commandId) => ({
      commandId, childSessionId: 'child', parentSessionId: 'parent',
      kind: 'message', message: commandId, status: 'pending', ownerGeneration: '1',
    }))
    const send = vi.fn(async (_record: unknown, input: { operationId: string }) => {
      if (input.operationId === 'first') terminal = true
    })
    let terminal = false
    let attempts = 0
    const inbox = {
      pendingChildSessionIds: async () => commands[0]?.status === 'completed' ? [] : ['child'],
      hasStopBarrier: async () => false,
      claimChildStop: async () => undefined,
      claimChildCommand: async () => {
        const head = commands.find((item) => item.status !== 'completed')
        if (!head || head.status === 'claimed') return undefined
        head.status = 'claimed'
        return { ...head }
      },
      readActiveChildMessage: async () => ({ ...commands[0]! }),
      markChildCommandDispatched: async (_id: string, commandId: string, onlyIfUndispatched?: boolean) => {
        attempts++
        if (attempts === 1) throw Object.assign(new Error('mark rolled back'), { code: '40001' })
        expect(onlyIfUndispatched).toBe(true)
        const head = commands.find((item) => item.commandId === commandId)!
        head.dispatchedAt = new Date().toISOString()
        return { ...head }
      },
      completeChildCommand: async (_id: string, commandId: string, outcome: { ok: boolean; content: string }) => {
        const head = commands.find((item) => item.commandId === commandId)!
        head.status = 'completed'
        head.outcome = outcome
        return { ...head }
      },
    } as ChildCommandInbox
    const stop = startChildCommandWorker({
      inbox,
      store: {
        load: async () => ({ parentSessionId: 'parent', agentRuntime: 'copilot',
          state: { status: terminal ? 'done' : 'idle', pendingCalls: [] } }),
        findOperation: async (_id: string, commandId: string) => terminal
          ? { kind: 'runtime_metadata', action: 'copilot.user_message',
            requestFingerprint: messageOperationFingerprint(commandId) } : undefined,
        findLatestRuntimeMetadata: async () => ({ payload: { childCommandId: 'first' } }),
      } as never,
      runtimes: { require: () => ({ send }) } as never,
      assertOwner: async () => undefined,
    }, 10)
    try {
      await vi.waitFor(() => expect(commands[0]?.status).toBe('completed'))
      expect(attempts).toBe(2)
      expect(send.mock.calls.filter(([, input]) => input.operationId === 'first')).toHaveLength(1)
      expect(commands[1]?.status).toBe('pending')
    } finally { await stop() }
  })

  it.each(['marker committed before ACK loss', 'SDK operation already persisted'] as const)(
    'does not re-send when the mark result is uncertain: %s', async (scenario) => {
      const command: ChildCommand = {
        commandId: 'message', parentSessionId: 'parent', childSessionId: 'child',
        kind: 'message', message: 'effect', status: 'pending', ownerGeneration: '1',
      }
      const send = vi.fn()
      let headReads = 0
      const markChildCommandDispatched = vi.fn(async (_id: string, _commandId: string, strict?: boolean) => {
        if (strict) throw new Error('Unsafe strict re-mark')
        if (scenario === 'marker committed before ACK loss') command.dispatchedAt = new Date().toISOString()
        throw new Error('mark ACK lost')
      })
      const stop = startChildCommandWorker({
        inbox: {
          pendingChildSessionIds: async () => ['child'],
          hasStopBarrier: async () => false,
          claimChildStop: async () => undefined,
          claimChildCommand: async () => {
            if (command.status === 'claimed') return undefined
            command.status = 'claimed'
            return { ...command }
          },
          readActiveChildMessage: async () => { headReads++; return { ...command } },
          markChildCommandDispatched,
        } as unknown as ChildCommandInbox,
        store: {
          load: async () => ({ parentSessionId: 'parent', agentRuntime: 'copilot',
            state: { status: 'idle', pendingCalls: [] } }),
          findOperation: async () => scenario === 'SDK operation already persisted'
            ? { kind: 'runtime_metadata', action: 'copilot.user_message',
              requestFingerprint: messageOperationFingerprint('effect') } : undefined,
        } as never,
        runtimes: { require: () => ({ send }) } as never,
        assertOwner: async () => undefined,
      }, 10)
      try {
        await vi.waitFor(() => expect(headReads).toBeGreaterThan(0))
        await new Promise<void>((resolve) => setTimeout(resolve, 40))
        expect(send).not.toHaveBeenCalled()
        expect(markChildCommandDispatched).toHaveBeenCalledTimes(1)
        expect(command.status).toBe('claimed')
      } finally { await stop() }
    })

  it.each([false, true])('requires absent SDK operation before resuming a reclaimed unmarked head (existing operation: %s)',
    async (operationExists) => {
      const command: ChildCommand = {
        commandId: 'message', parentSessionId: 'parent', childSessionId: 'child',
        kind: 'message', message: 'effect', status: 'claimed', ownerGeneration: '2', reclaimed: true,
      }
      let claimed = false
      let terminal = false
      const send = vi.fn(async () => { terminal = true })
      const markChildCommandDispatched = vi.fn(async (_id: string, _key: string, strict?: boolean) => {
        expect(strict).toBe(true)
        command.dispatchedAt = new Date().toISOString()
        return { ...command }
      })
      const stop = startChildCommandWorker({
        inbox: {
          pendingChildSessionIds: async () => ['child'],
          hasStopBarrier: async () => false,
          claimChildStop: async () => undefined,
          claimChildCommand: async () => {
            if (claimed) return undefined
            claimed = true
            return { ...command }
          },
          readActiveChildMessage: async () => ({ ...command }),
          markChildCommandDispatched,
          completeChildCommand: async () => ({ ...command, status: 'completed' as const }),
        } as unknown as ChildCommandInbox,
        store: {
          load: async () => ({ parentSessionId: 'parent', agentRuntime: 'copilot',
            state: { status: terminal ? 'done' : 'idle', pendingCalls: [] } }),
          findOperation: async () => operationExists || terminal
            ? { kind: 'runtime_metadata', action: 'copilot.user_message',
              requestFingerprint: messageOperationFingerprint('effect') } : undefined,
          findLatestRuntimeMetadata: async () => ({ payload: { childCommandId: 'message' } }),
        } as never,
        runtimes: { require: () => ({ send }) } as never,
        assertOwner: async () => undefined,
      }, 10)
      try {
        await vi.waitFor(() => expect(claimed).toBe(true))
        if (operationExists) {
          await new Promise<void>((resolve) => setTimeout(resolve, 40))
          expect(markChildCommandDispatched).not.toHaveBeenCalled()
          expect(send).not.toHaveBeenCalled()
        } else {
          await vi.waitFor(() => expect(markChildCommandDispatched).toHaveBeenCalledOnce())
          expect(send).toHaveBeenCalledOnce()
        }
      } finally { await stop() }
    })

  it('recovers a claim with a lost SQL acknowledgement after a transient head-read failure', async () => {
    let readFails = true
    let committed = false
    const command: ChildCommand = {
      commandId: 'message', parentSessionId: 'parent', childSessionId: 'child',
      kind: 'message', message: 'effect', status: 'claimed', dispatchedAt: new Date().toISOString(),
    }
    const send = vi.fn()
    const completeChildCommand = vi.fn(async () => { committed = true; return { ...command, status: 'completed' as const } })
    const stop = startChildCommandWorker({
      inbox: {
        pendingChildSessionIds: async () => committed ? [] : ['child'],
        hasStopBarrier: async () => false,
        claimChildStop: async () => undefined,
        claimChildCommand: async () => { throw new Error('claim ACK lost') },
        readActiveChildMessage: async () => {
          if (readFails) { readFails = false; throw new Error('connection reset') }
          return command
        },
        completeChildCommand,
      } as unknown as ChildCommandInbox,
      store: {
        load: async () => ({ parentSessionId: 'parent', agentRuntime: 'copilot',
          state: { status: 'done', pendingCalls: [] } }),
        findOperation: async () => ({
          kind: 'runtime_metadata', action: 'copilot.user_message',
          requestFingerprint: messageOperationFingerprint('effect'),
        }),
        findLatestRuntimeMetadata: async () => ({ payload: { childCommandId: 'message' } }),
      } as never,
      runtimes: { require: () => ({ send }) } as never,
      assertOwner: async () => undefined,
    }, 10)
    try {
      await vi.waitFor(() => expect(committed).toBe(true))
      expect(send).not.toHaveBeenCalled()
      expect(completeChildCommand).toHaveBeenCalledOnce()
    } finally { await stop() }
  })

  it('installs a durable timeout Stop before dispatching any later message', async () => {
    let barrier = false
    const enqueueTimedOutChildStop = vi.fn(async (_id: string, commandId: string) => {
      barrier = true
      return { commandId, childSessionId: 'child', parentSessionId: 'parent',
        kind: 'stop' as const, status: 'pending' as const }
    })

    const claimChildCommand = vi.fn(async () => undefined)
    const stop = startChildCommandWorker({
      inbox: {
        pendingChildSessionIds: async () => ['child'],
        hasStopBarrier: async () => barrier,
        readActiveChildMessage: async () => ({ commandId: 'initial', parentSessionId: 'parent',
          childSessionId: 'child', kind: 'message', message: 'start', status: 'pending' }),
        enqueueTimedOutChildStop,
        claimChildStop: async () => undefined,
        claimChildCommand,
      } as unknown as ChildCommandInbox,
      store: { load: async () => ({
        parentSessionId: 'parent', parentCallId: 'initial',
        subAgentStartedAt: new Date(Date.now() - 10_000).toISOString(),
        subAgentTimeoutMs: 1_000, agentRuntime: 'copilot',
        state: { status: 'thinking', messages: [], pendingCalls: [] },
      }) } as never,
      runtimes: {} as never,
      assertOwner: async () => undefined,
    }, 10)
    try {
      await vi.waitFor(() => expect(enqueueTimedOutChildStop).toHaveBeenCalledOnce())
      expect(enqueueTimedOutChildStop.mock.calls[0]![1]).toMatch(/^timeout-[a-f0-9]{32}$/u)
      expect(claimChildCommand).not.toHaveBeenCalled()
    } finally { await stop() }
  })

  it('uses durable model-turn terminals rather than the number of assistant fragments for max-turns', async () => {
    let turns = 1
    let barrier = false
    const enqueueTimedOutChildStop = vi.fn(async () => {
      barrier = true
      return undefined
    })
    const stop = startChildCommandWorker({
      inbox: {
        pendingChildSessionIds: async () => ['child'],
        hasStopBarrier: async () => barrier,
        readActiveChildMessage: async () => ({ commandId: 'initial', parentSessionId: 'parent',
          childSessionId: 'child', kind: 'message', message: 'start', status: 'claimed' }),
        enqueueTimedOutChildStop,
        claimChildStop: async () => undefined,
        claimChildCommand: async () => undefined,
      } as unknown as ChildCommandInbox,
      store: {
        load: async () => ({
          parentSessionId: 'parent', parentCallId: 'initial', agentRuntime: 'copilot',
          subAgentMaxTurns: 2, state: {
            status: 'thinking', pendingCalls: [],
            messages: [{ role: 'assistant' }, { role: 'assistant' }, { role: 'assistant' }],
          },
        }),
        countCompletedChildModelTurns: async () => turns,
      } as never,
      runtimes: {} as never,
      assertOwner: async () => undefined,
    }, 10)
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 50))
      expect(enqueueTimedOutChildStop).not.toHaveBeenCalled()
      turns = 2
      await vi.waitFor(() => expect(enqueueTimedOutChildStop).toHaveBeenCalledOnce())
    } finally { await stop() }
  })

  it('applies a follow-up command deadline only after its dispatch and targets that command with Stop', async () => {
    let dispatchedAt: string | undefined
    let stopped = false
    const enqueueTimedOutChildStop = vi.fn(async () => { stopped = true; return undefined })
    const stop = startChildCommandWorker({
      inbox: {
        pendingChildSessionIds: async () => ['child'],
        hasStopBarrier: async () => stopped,
        readActiveChildMessage: async () => ({ commandId: 'follow-up', parentSessionId: 'parent',
          childSessionId: 'child', kind: 'message' as const, message: 'continue',
          status: 'claimed' as const, timeoutMs: 1_000, maxTurns: 3, ...(dispatchedAt ? { dispatchedAt } : {}) }),
        enqueueTimedOutChildStop,
        claimChildStop: async () => undefined,
        claimChildCommand: async () => undefined,
      } as unknown as ChildCommandInbox,
      store: { load: async () => ({ parentSessionId: 'parent', parentCallId: 'initial',
        agentRuntime: 'copilot', state: { status: 'thinking', pendingCalls: [] } }),
      countCompletedChildModelTurns: async () => 0 } as never,
      runtimes: {} as never,
      assertOwner: async () => undefined,
    }, 10)
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 40))
      expect(enqueueTimedOutChildStop).not.toHaveBeenCalled()
      dispatchedAt = new Date(Date.now() - 2_000).toISOString()
      await vi.waitFor(() => expect(enqueueTimedOutChildStop).toHaveBeenCalledOnce())
      expect(enqueueTimedOutChildStop.mock.calls[0]?.[2]).toBe('follow-up')
    } finally { await stop() }
  })

  it('leaves a model-policy-denied child turn UNKNOWN without dispatch or retry', async () => {
    const command: ChildCommand = {
      childSessionId: 'child', parentSessionId: 'parent', commandId: 'initial',
      kind: 'message', message: 'work', status: 'pending',
    }
    const send = vi.fn(async () => undefined)
    const assertCanUseModel = vi.fn(async () => { throw new Error('model denied by tenant') })
    const stop = startChildCommandWorker({
      inbox: {
        pendingChildSessionIds: async () => ['child'],
        hasStopBarrier: async () => false,
        claimChildStop: async () => undefined,
        claimChildCommand: async () => {
          if (command.status !== 'pending') return undefined
          command.status = 'claimed'
          return { ...command }
        },
        markChildCommandDispatched: async () => {
          command.dispatchedAt = new Date().toISOString()
          return { ...command }
        },
      } as unknown as ChildCommandInbox,
      store: { load: async () => ({
        parentSessionId: 'parent', organizationId: 'tenant-a', principal: 'operator-a',
        agentRuntime: 'copilot', preferences: { selectedModel: 'provider/model-v1' },
        state: { status: 'idle', pendingCalls: [] },
      }) } as never,
      runtimes: { require: () => ({ send }) } as never,
      modelPolicy: { assertCanUseModel } as never,
      assertOwner: async () => undefined,
    }, 10)
    try {
      await vi.waitFor(() => expect(assertCanUseModel).toHaveBeenCalledOnce())
      expect(send).not.toHaveBeenCalled()
      expect(command).toMatchObject({ status: 'claimed', dispatchedAt: expect.any(String) })
    } finally { await stop() }
  })

  it('does not send a claimed turn when Stop is accepted during model authorization', async () => {
    let barrier = false
    const command: ChildCommand = {
      childSessionId: 'child', parentSessionId: 'parent', commandId: 'initial',
      kind: 'message', message: 'work', status: 'pending',
    }
    const send = vi.fn(async () => undefined)
    const stop = startChildCommandWorker({
      inbox: {
        pendingChildSessionIds: async () => ['child'],
        hasStopBarrier: async () => barrier,
        claimChildStop: async () => undefined,
        claimChildCommand: async () => {
          if (command.status !== 'pending') return undefined
          command.status = 'claimed'
          return { ...command }
        },
        markChildCommandDispatched: async () => {
          command.dispatchedAt = new Date().toISOString()
          return { ...command }
        },
      } as unknown as ChildCommandInbox,
      store: { load: async () => ({
        parentSessionId: 'parent', agentRuntime: 'copilot',
        organizationId: 'tenant', preferences: { selectedModel: 'provider/model' },
        state: { status: 'idle', pendingCalls: [] },
      }) } as never,
      runtimes: { require: () => ({ send }) } as never,
      modelPolicy: { assertCanUseModel: async () => { barrier = true } } as never,
      assertOwner: async () => undefined,
    }, 10)
    try {
      await vi.waitFor(() => expect(command.dispatchedAt).toBeDefined())
      await new Promise<void>((resolve) => setTimeout(resolve, 40))
      expect(send).not.toHaveBeenCalled()
      expect(command.status).toBe('claimed')
    } finally { await stop() }
  })

  it('links commandId to a single SDK send and waits for durable terminal evidence before releasing the next message', async () => {
    const commands: ChildCommand[] = ['first', 'second'].map((commandId) => ({
      commandId, childSessionId: 'child', parentSessionId: 'parent', kind: 'message',
      message: commandId, status: 'pending',
    }))
    let terminal: string | undefined
    let sent: string | undefined
    const sends = vi.fn(async (_record, input: { operationId: string }) => { sent = input.operationId })
    const inbox = {
      pendingChildSessionIds: async () => ['child'],
      hasStopBarrier: async () => false,
      claimChildStop: async () => undefined,
      claimChildCommand: async () => {
        const command = commands.find((item) => item.status !== 'completed')
        if (!command || command.status === 'claimed') return undefined
        command.status = 'claimed'
        return { ...command }
      },
      markChildCommandDispatched: async (_id: string, commandId: string) => {
        const command = commands.find((item) => item.commandId === commandId)!
        command.dispatchedAt = new Date().toISOString()
        return { ...command }
      },
      completeChildCommand: async (_id: string, commandId: string, outcome: { ok: boolean; content: string }) => {
        const command = commands.find((item) => item.commandId === commandId)!
        command.status = 'completed'
        command.outcome = outcome
        return { ...command }
      },
    } as ChildCommandInbox
    const store = {
      load: async () => ({ sessionId: 'child', parentSessionId: 'parent', agentRuntime: 'copilot',
        organizationId: 'tenant-a', principal: 'operator-a', preferences: { selectedModel: 'provider/model-v1' },
        state: { status: !sent || terminal === sent && terminal ? 'done' : 'thinking', pendingCalls: [] } }),
      findOperation: async (_id: string, operationId: string) => sent === operationId
        ? { kind: 'runtime_metadata', action: 'copilot.user_message', requestFingerprint: messageOperationFingerprint(operationId) } : undefined,
      findLatestRuntimeMetadata: async () => terminal
        ? { payload: { childCommandId: terminal } } : undefined,
    }
    const assertCanUseModel = vi.fn(async () => undefined)
    const deps = { inbox, store: store as never,
      runtimes: { require: () => ({ send: sends }) } as never,
      modelPolicy: { assertCanUseModel } as never,
      assertOwner: async () => ({ ownerGeneration: '2' }) }
    const stop = startChildCommandWorker(deps, 10)
    try {
      await vi.waitFor(() => expect(sends).toHaveBeenCalledTimes(1))
      expect(sends.mock.calls[0]![1]).toMatchObject({ operationId: 'first', text: 'first', model: 'provider/model-v1' })
      expect(assertCanUseModel).toHaveBeenCalledWith({
        organizationId: 'tenant-a', sessionId: 'child', model: 'provider/model-v1', principal: 'operator-a',
      })
      await new Promise<void>((resolve) => setTimeout(resolve, 40))
      expect(commands[0]?.status).toBe('claimed')
      expect(sends).toHaveBeenCalledTimes(1)
      terminal = 'first'
      await vi.waitFor(() => expect(commands[0]?.status).toBe('completed'))
      await vi.waitFor(() => expect(sends).toHaveBeenCalledTimes(2))
      expect(sends.mock.calls[1]![1].operationId).toBe('second')
      terminal = 'second'
      await vi.waitFor(() => expect(commands[1]?.status).toBe('completed'))
    } finally { await stop() }
  })

  it('never infers completion from a started command without a matching durable turn', async () => {
    const command: ChildCommand = {
      commandId: 'original', childSessionId: 'child', parentSessionId: 'parent',
      kind: 'message', message: 'effect', status: 'claimed', dispatchedAt: new Date().toISOString(),
      ownerGeneration: '1',
    }
    const store = {
      load: async () => ({ parentSessionId: 'parent', agentRuntime: 'copilot',
        state: { status: 'done', pendingCalls: [] } }),
      findOperation: async () => undefined,
      findLatestRuntimeMetadata: async () => ({ payload: { childCommandId: 'original' } }),
    }
    expect(await reconcileChildTurn({
      inbox: {} as never, store: store as never, runtimes: {} as never, assertOwner: async () => undefined,
    }, command)).toBeUndefined()
  })

  it('does not turn a Kernel cancellation into a successful message completion', async () => {
    const command: ChildCommand = {
      commandId: 'message', childSessionId: 'child', parentSessionId: 'parent',
      kind: 'message', message: 'effect', status: 'claimed', dispatchedAt: new Date().toISOString(),
    }
    const store = {
      load: async () => ({ parentSessionId: 'parent', agentRuntime: 'kernel',
        state: { status: 'done', pendingCalls: [] } }),
      findOperation: async () => ({ kind: 'event', event: { kind: 'user_message', text: 'effect', operationId: 'message' } }),
      readEventEntries: async () => [
        { seq: 1, event: { kind: 'user_message', text: 'effect', operationId: 'message' } },
        { seq: 2, event: { kind: 'cancel' } },
      ],
    }
    expect(await reconcileChildTurn({
      inbox: {} as never, store: store as never, runtimes: {} as never, assertOwner: async () => undefined,
    }, command)).toBeUndefined()
  })

  it('leaves a failed or uncertain send claimed instead of completing it and admitting the next command', async () => {
    const calls: string[] = []
    const command: ChildCommand = {
      commandId: 'uncertain', childSessionId: 'child', parentSessionId: 'parent',
      kind: 'message', message: 'effect', status: 'pending',
    }
    const inbox = {
      claimChildCommand: async () => {
        if (command.status !== 'pending') return undefined
        command.status = 'claimed'
        return { ...command }
      },
      markChildCommandDispatched: async () => {
        command.dispatchedAt = new Date().toISOString()
        return { ...command }
      },
      completeChildCommand: async () => { calls.push('completed'); return command },
    } as ChildCommandInbox
    await expect(consumeNextChildCommand(inbox, 'child', async () => {
      calls.push('dispatched')
      throw new Error('SDK acknowledgement lost')
    }, async () => ({ ok: true, content: 'must not confirm' }))).rejects.toThrow('SDK acknowledgement lost')
    expect(command).toMatchObject({ status: 'claimed', dispatchedAt: expect.any(String) })
    expect(calls).toEqual(['dispatched'])
    expect(await consumeNextChildCommand(inbox, 'child', async () => { calls.push('replayed') },
      async () => undefined)).toBeUndefined()
    expect(calls).toEqual(['dispatched'])
  })

  it('cancels the local SDK turn and routes a fenced remote Executor Stop, but reports UNKNOWN when its ACK or terminal receipt is lost', async () => {
    const request = { ownerGeneration: '2', requestDigest: 'a'.repeat(64) }
    let acknowledgement: 'cancel_requested' | 'unavailable' = 'unavailable'
    let terminal = false
    const cancelForChildStop = vi.fn(async () => true)
    const cancelExecution = vi.fn(async () => ({ status: acknowledgement }))
    const queryExecutionReceipt = vi.fn(async () => terminal
      ? { status: 'completed', result: { callId: 'call', ok: false, content: 'cancelled after possible effects' } }
      : { status: 'started_unknown' })
    const deps = {
      inbox: { hasUnconfirmedMessageBeforeStop: async () => false } as never,
      store: {
        load: async () => ({ parentSessionId: 'parent', agentRuntime: 'copilot',
          state: { status: 'executing_tools', pendingCalls: [{ callId: 'call', status: 'dispatched' }] } }),
        findCopilotToolRequest: async () => request,
      } as never,
      runtimes: { require: () => ({ cancelForChildStop }) } as never,
      assertOwner: async () => ({ ownerGeneration: '3' }),
      executors: { cancelExecution, queryExecutionReceipt } as never,
    }
    const command: ChildCommand = {
      commandId: 'stop', childSessionId: 'child', parentSessionId: 'parent',
      kind: 'stop', status: 'claimed', dispatchedAt: new Date().toISOString(),
    }
    expect(await stopChildTurn(deps, command)).toMatchObject({ ok: false, content: expect.stringContaining('UNKNOWN') })
    expect(cancelForChildStop).toHaveBeenCalledTimes(1)
    expect(cancelExecution).toHaveBeenCalledWith({ sessionId: 'child', callId: 'call', stopCommandId: 'stop', ...request })
    acknowledgement = 'cancel_requested'
    terminal = true
    expect(await stopChildTurn(deps, command)).toMatchObject({ ok: true, content: expect.stringContaining('Earlier effects may already have occurred') })
    expect(queryExecutionReceipt).toHaveBeenCalledWith({ sessionId: 'child', callId: 'call', stopCommandId: 'stop', ...request })
    deps.inbox = { hasUnconfirmedMessageBeforeStop: async () => true } as never
    expect(await stopChildTurn(deps, command)).toMatchObject({ ok: false, content: expect.stringContaining('UNKNOWN') })
  })
})
