import { randomUUID } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type {
  AgentState,
  ApprovalMode,
  Message,
  MessageContent,
  PendingToolCall,
  ToolSchema,
} from '@agent-kernel/kernel'
import {
  COPILOT_RUNTIME_COMPACTION_POLICY,
  COPILOT_AGENT_RUNTIME_CAPABILITIES,
  copilotRuntimeCompactionPolicy,
  type AgentRuntimeDescriptor,
  type CompactStatusEvent,
  type ContextUsageSnapshot,
  type ModelInfo,
  type RuntimeCompactionPolicy,
} from '@agent-kernel/shared'
import {
  CopilotClient,
  RuntimeConnection,
  ToolSet,
  type ModelInfo as CopilotModelInfo,
  type MessageOptions,
  type CopilotSession,
  type SessionEvent,
  type Tool,
  type ToolResultObject,
} from '@github/copilot-sdk'

import type { SessionRecord } from '../store/session.js'
import { findPersistedToolResult } from '../store/log.js'
import { messageOperationFingerprint } from '../message-operation-fingerprint.js'
import type {
  AgentRuntime,
  AgentRuntimeContext,
  AgentRuntimeSendInput,
} from './types.js'

type ApprovalDecision = { approved: true } | { approved: false; reason?: string }

type PendingApproval = {
  resolve(decision: ApprovalDecision): void
}

type TurnCapture = {
  assistantEventIds: Set<string>
  reasoningTexts: Set<string>
  eventIds: Set<string>
  projections: Promise<void>[]
  projectionError?: unknown
}

type ActiveTurnTiming = {
  turnId: string
  startedAt: string
}

type ActiveCompaction = {
  attemptId: string
  tokensBefore: number
  trigger: 'manual' | 'auto'
  startedAt: string
  startSnapshot?: ContextUsageSnapshot
  scope: { kind: 'root' | 'subagent'; agentId?: string }
}

const COPILOT_FIRST_ACTIVITY_TIMEOUT_MS = 5 * 60_000
const COPILOT_INACTIVITY_TIMEOUT_MS = 30 * 60_000
const COPILOT_SDK_TURN_TIMEOUT_MS = 24 * 60 * 60_000

export type CopilotAgentRuntimeOptions = {
  enabled: boolean
  sessionsDir: string
  gitHubToken?: string
  runtimeEntryPath?: string
  backgroundCompactionThreshold?: number
  bufferExhaustionThreshold?: number
}

export class CopilotAgentRuntime implements AgentRuntime {
  readonly id = 'copilot' as const
  private client: CopilotClient | undefined
  private readonly sessions = new Map<string, CopilotSession>()
  private readonly sessionSystemPrompts = new Map<string, string>()
  private readonly approvals = new Map<string, PendingApproval>()
  private readonly cancelledCalls = new Set<string>()
  private readonly turnGenerations = new Map<string, number>()
  private readonly turnSystemPrompts = new Map<string, string>()
  private readonly cancelledTurnGenerations = new Set<string>()
  private readonly requestGenerations = new Map<string, number>()
  private readonly sdkInteractionGenerations = new Map<string, number>()
  private readonly sdkTurnGenerations = new Map<string, number>()
  private readonly eventGenerations = new Map<string, number>()
  private readonly toolCallGenerations = new Map<string, number>()
  private readonly compactions = new Map<string, ActiveCompaction>()
  private readonly tails = new Map<string, Promise<void>>()
  private readonly accountedUsageCallIds = new Set<string>()
  private readonly turnCaptures = new Map<string, TurnCapture>()
  private readonly contextEventTimes = new Map<string, number>()
  private readonly contextTokenHighWater = new Map<string, number>()
  private readonly activeTurnTimings = new Map<string, ActiveTurnTiming>()
  private status: AgentRuntimeDescriptor['status']
  private reason: string | undefined
  private models: readonly ModelInfo[] = []
  private readonly compactionPolicy: RuntimeCompactionPolicy

  constructor(
    private readonly context: AgentRuntimeContext,
    private readonly options: CopilotAgentRuntimeOptions,
  ) {
    const backgroundThreshold = options.backgroundCompactionThreshold
      ?? COPILOT_RUNTIME_COMPACTION_POLICY.automatic.startThreshold
    const blockingThreshold = options.bufferExhaustionThreshold
      ?? COPILOT_RUNTIME_COMPACTION_POLICY.automatic.blockingThreshold!
    if (!(backgroundThreshold > 0 && backgroundThreshold < blockingThreshold && blockingThreshold <= 1)) {
      throw new Error('Copilot compaction thresholds must satisfy 0 < background < blocking <= 1')
    }
    this.compactionPolicy = copilotRuntimeCompactionPolicy(backgroundThreshold, blockingThreshold)
    this.status = options.enabled ? 'unavailable' : 'disabled'
    this.reason = options.enabled ? 'Copilot runtime is starting' : 'Copilot runtime is disabled'
  }

  async start(): Promise<void> {
    if (!this.options.enabled) return
    try {
      const configuredCliPath = process.env.COPILOT_CLI_PATH?.trim()
      const packagedCliPath = configuredCliPath
        ? undefined
        : materializePackagedCopilotRuntime(
            this.options.runtimeEntryPath ?? process.argv[1] ?? process.execPath,
            join(this.options.sessionsDir, '..', 'copilot-runtime'),
          )
      this.client = new CopilotClient({
        mode: 'empty',
        connection: RuntimeConnection.forStdio({
          args: ['--no-remote-export'],
          ...(configuredCliPath || packagedCliPath ? { path: configuredCliPath ?? packagedCliPath } : {}),
        }),
        baseDirectory: join(this.options.sessionsDir, '..', 'copilot-runtime'),
        ...(this.options.gitHubToken ? { gitHubToken: this.options.gitHubToken, useLoggedInUser: false } : {}),
      })
      await this.client.start()
      const auth = await this.client.getAuthStatus()
      if (!auth.isAuthenticated) throw new Error('Copilot CLI is not authenticated')
      this.models = (await this.client.listModels()).map(modelInfo)
      this.status = 'ready'
      this.reason = undefined
    } catch (error) {
      this.status = 'unavailable'
      this.reason = copilotStartupFailureReason(error)
      await this.client?.stop().catch(() => [])
      this.client = undefined
    }
  }

  descriptor(): AgentRuntimeDescriptor {
    return {
      id: this.id,
      label: 'GitHub Copilot',
      description: 'Official GitHub Copilot SDK agent runtime',
      available: this.status === 'ready',
      status: this.status,
      ...(this.reason ? { reason: this.reason } : {}),
      version: '1.0.11',
      capabilities: COPILOT_AGENT_RUNTIME_CAPABILITIES,
      compactionPolicy: this.compactionPolicy,
      models: this.models,
    }
  }

  currentCompactStatus(sessionId: string): CompactStatusEvent | undefined {
    const active = this.compactions.get(compactionKey(sessionId))
    if (!active) return undefined
    return {
      sessionId,
      kind: 'running',
      trigger: active.trigger,
      tokensBefore: active.tokensBefore,
      attemptId: active.attemptId,
      startedAt: active.startedAt,
      authority: this.compactionPolicy.authority,
      scope: active.scope,
      ...(active.startSnapshot ? { startSnapshot: active.startSnapshot } : {}),
    }
  }

  async toolResultPersisted(record: SessionRecord, callId: string): Promise<boolean> {
    return await findPersistedToolResult(record.logPath, callId, this.id)
  }

  async send(record: SessionRecord, input: AgentRuntimeSendInput): Promise<void> {
    this.context.store.assertStorageWritable(record.sessionId)
    // Capture before ensureSession yields: a concurrent durable replacement must
    // fence every event from the SDK Session configured with this prompt.
    const turnSystemPrompt = record.config.systemPrompt ?? 'You are an AI coding agent.'
    const session = await this.ensureSession(record, input.model)
    if (input.model) await session.setModel(input.model)
    const generation = (this.turnGenerations.get(record.sessionId) ?? 0) + 1
    const requestId = randomUUID()
    const timing = {
      turnId: input.operationId ?? requestId,
      startedAt: new Date().toISOString(),
    }
    this.activeTurnTimings.set(record.sessionId, timing)
    this.turnGenerations.set(record.sessionId, generation)
    this.turnSystemPrompts.set(record.sessionId, turnSystemPrompt)
    this.requestGenerations.set(approvalKey(record.sessionId, requestId), generation)
    await this.project(record, 'copilot.user_message', {
      text: input.text,
      ...(input.operationId ? {
        operationId: input.operationId,
        requestFingerprint: messageOperationFingerprint(input.text, input.content),
      } : {}),
      ...(input.queuedAt ? { queuedAt: input.queuedAt } : {}),
    }, (state) => ({
      ...state,
      messages: [...state.messages, withTemporalMetadata(userMessage(input), {
        messageId: `${requestId}:user`,
        turnId: timing.turnId,
        createdAt: timing.startedAt,
        turnStartedAt: timing.startedAt,
      })],
      status: 'thinking',
      pendingCalls: [],
      error: undefined,
    }))
    void this.runTurn(record, session, input, generation, requestId)
  }

  async cancel(record: SessionRecord): Promise<void> {
    const session = this.sessions.get(record.sessionId)
    const generation = this.turnGenerations.get(record.sessionId)
    if (generation !== undefined) {
      this.cancelledTurnGenerations.add(turnGenerationKey(record.sessionId, generation))
    }
    if (session) await session.abort()
    for (const call of record.state.pendingCalls) {
      this.cancelledCalls.add(approvalKey(record.sessionId, call.callId))
    }
    await this.context.tools.cancelPending(record.sessionId)
    for (const [key, approval] of this.approvals) {
      if (!key.startsWith(`${record.sessionId}:`)) continue
      approval.resolve({ approved: false, reason: 'cancelled' })
      this.approvals.delete(key)
    }
    const timing = this.activeTurnTimings.get(record.sessionId)
    await this.project(record, 'copilot.cancelled', {}, (state) => ({
      ...state,
      messages: timing ? completeTemporalTurn(state.messages, timing, 'cancelled') : state.messages,
      status: 'done',
      pendingCalls: [],
      error: undefined,
    }))
    this.activeTurnTimings.delete(record.sessionId)
  }

  async approve(record: SessionRecord, callId: string): Promise<void> {
    const pending = this.approvals.get(approvalKey(record.sessionId, callId))
    if (!pending) {
      await this.expireUnresumableApproval(record, callId)
      return
    }
    pending.resolve({ approved: true })
    this.approvals.delete(approvalKey(record.sessionId, callId))
  }

  async reject(record: SessionRecord, callId: string, reason?: string): Promise<void> {
    const pending = this.approvals.get(approvalKey(record.sessionId, callId))
    if (!pending) {
      await this.expireUnresumableApproval(record, callId)
      return
    }
    pending.resolve({ approved: false, ...(reason ? { reason } : {}) })
    this.approvals.delete(approvalKey(record.sessionId, callId))
  }

  async setApprovalMode(record: SessionRecord, mode: ApprovalMode): Promise<void> {
    await this.project(record, 'copilot.approval_mode_changed', { mode }, (state) => ({
      ...state,
      approvalMode: mode,
    }))
  }

  async setModel(record: SessionRecord, model: string): Promise<void> {
    const session = await this.ensureSession(record)
    await session.setModel(model)
  }

  async compact(record: SessionRecord): Promise<void> {
    if (!isRestingStatus(record.state.status)) {
      throw new Error('Copilot compaction is only available while the session is resting')
    }
    const session = await this.ensureSession(record, record.preferences?.selectedModel)
    const active: ActiveCompaction = {
      attemptId: randomUUID(),
      tokensBefore: record.runtimeContextSnapshot?.usage.inputTokens ?? 0,
      trigger: 'manual',
      startedAt: new Date().toISOString(),
      ...(record.runtimeContextSnapshot ? { startSnapshot: record.runtimeContextSnapshot } : {}),
      scope: { kind: 'root' },
    }
    const key = compactionKey(record.sessionId)
    this.compactions.set(key, active)
    try {
      await this.projectCompactionStart(record, active)
      this.context.broadcast.onCompactStatus?.({
        sessionId: record.sessionId,
        kind: 'running',
        trigger: 'manual',
        tokensBefore: active.tokensBefore,
        attemptId: active.attemptId,
        startedAt: active.startedAt,
        authority: this.compactionPolicy.authority,
        scope: active.scope,
        ...(active.startSnapshot ? { startSnapshot: active.startSnapshot } : {}),
      })
      const result = await session.rpc.history.compact({ trigger: 'manual' })
      if (!result.success) throw new Error('Copilot compaction did not complete successfully')
      const completedAt = new Date().toISOString()
      const completionSnapshot = result.contextWindow
        ? this.freshContextSnapshot(
          record,
          copilotContextSnapshot(record, result.contextWindow),
          completedAt,
          true,
        )
        : undefined
      if (completionSnapshot) this.context.broadcast.onState(record, record.state, completionSnapshot)
      const current = this.compactions.get(key)
      if (current) {
        this.compactions.delete(key)
        const completion = {
          tokensAfter: result.contextWindow?.currentTokens ?? Math.max(0, current.tokensBefore - result.tokensRemoved),
          replacedCount: result.messagesRemoved,
          ...(result.summaryContent ? { summary: result.summaryContent } : {}),
          endedAt: completedAt,
        }
        await this.projectCompactionDone(record, current, completion)
        this.context.broadcast.onCompactStatus?.({
          sessionId: record.sessionId,
          kind: 'done',
          attemptId: current.attemptId,
          tokensBefore: current.tokensBefore,
          trigger: current.trigger,
          authority: this.compactionPolicy.authority,
          scope: current.scope,
          ...(current.startSnapshot ? { startSnapshot: current.startSnapshot } : {}),
          ...(completionSnapshot ? { completionSnapshot } : {}),
          summaryValidation: this.compactionPolicy.summary.validation,
          ...completion,
        })
      }
    } catch (error) {
      const active = this.compactions.get(key)
      if (active) {
        this.compactions.delete(key)
        const message = error instanceof Error ? error.message : String(error)
        const endedAt = new Date().toISOString()
        await this.projectCompactionError(record, active, message, endedAt)
        this.context.broadcast.onCompactStatus?.({
          sessionId: record.sessionId,
          kind: 'error',
          attemptId: active.attemptId,
          message,
          endedAt,
          authority: this.compactionPolicy.authority,
          scope: active.scope,
        })
      }
      throw error
    }
  }

  async confirmModelChange(record: SessionRecord, from: string | undefined, to: string): Promise<void> {
    if (from === to) return
    await this.project(record, 'copilot.model_changed', {
      ...(from ? { from } : {}),
      to,
    }, (state) => ({
      ...state,
      messages: [...state.messages, {
        role: 'system',
        content: [{ type: 'text', text: `Model changed${from ? `: ${from} → ${to}` : ` to ${to}`}` }],
        metadata: {
          kind: 'model_changed',
          ...(from ? { from } : {}),
          to,
        },
      }],
    }))
  }

  async delete(record: SessionRecord): Promise<void> {
    const session = this.sessions.get(record.sessionId)
    const generation = this.turnGenerations.get(record.sessionId)
    if (generation !== undefined) {
      this.cancelledTurnGenerations.add(turnGenerationKey(record.sessionId, generation))
    }
    if (session) {
      await session.disconnect()
      this.sessions.delete(record.sessionId)
      this.sessionSystemPrompts.delete(record.sessionId)
    }
    this.contextEventTimes.delete(record.sessionId)
    this.contextTokenHighWater.delete(record.sessionId)
    this.activeTurnTimings.delete(record.sessionId)
    await this.client?.deleteSession(record.externalSessionId ?? record.sessionId).catch(() => undefined)
  }

  async close(): Promise<void> {
    this.sessions.clear()
    this.sessionSystemPrompts.clear()
    this.turnGenerations.clear()
    this.turnSystemPrompts.clear()
    this.cancelledTurnGenerations.clear()
    this.requestGenerations.clear()
    this.sdkInteractionGenerations.clear()
    this.sdkTurnGenerations.clear()
    this.eventGenerations.clear()
    this.toolCallGenerations.clear()
    this.contextEventTimes.clear()
    this.contextTokenHighWater.clear()
    this.activeTurnTimings.clear()
    if (this.client) await this.client.stop()
    this.client = undefined
  }

  private async ensureSession(record: SessionRecord, model?: string): Promise<CopilotSession> {
    const effectivePrompt = record.config.systemPrompt ?? 'You are an AI coding agent.'
    const existing = this.sessions.get(record.sessionId)
    if (existing && this.sessionSystemPrompts.get(record.sessionId) === effectivePrompt) return existing
    if (existing) {
      // Disconnect only the local SDK object. deleteSession() would destroy the
      // resumable provider session and is intentionally reserved for user delete.
      await existing.disconnect()
      this.sessions.delete(record.sessionId)
      this.sessionSystemPrompts.delete(record.sessionId)
    }
    if (!this.client || this.status !== 'ready') {
      throw new Error(this.reason ?? 'Copilot runtime is unavailable')
    }
    const config = this.sessionConfig(record, model)
    let session: CopilotSession
    try {
      session = await this.client.resumeSession(record.externalSessionId ?? record.sessionId, {
        ...config,
        continuePendingWork: false,
      })
    } catch {
      session = await this.client.createSession({
        ...config,
        sessionId: record.externalSessionId ?? record.sessionId,
      })
    }
    session.on((event) => this.handleEvent(record, event))
    this.sessions.set(record.sessionId, session)
    this.sessionSystemPrompts.set(record.sessionId, effectivePrompt)
    await this.restorePersistedContext(record, session)
    return session
  }

  private async restorePersistedContext(record: SessionRecord, session: CopilotSession): Promise<void> {
    const currentModel = await session.rpc.model.getCurrent()
    const model = currentModel.modelId ?? record.preferences?.selectedModel
    if (model && record.preferences?.selectedModel !== model) {
      await this.context.store.updatePreferences(record.sessionId, { selectedModel: model })
    }
    const persisted = record.runtimeContextSnapshot
    if (!persisted) return
    const snapshot = model && persisted.model.ref !== model
      ? { ...persisted, model: { ref: model, provider: 'github-copilot', id: model } }
      : persisted
    this.context.broadcast.onState(record, record.state, snapshot)
  }

  private sessionConfig(record: SessionRecord, model?: string) {
    const tools = record.config.tools.map((schema) => this.tool(record, schema))
    const workingDirectory = join(this.options.sessionsDir, '..')
    return {
      clientName: 'agent-runlab',
      ...(model ? { model } : {}),
      // The SDK defaults this to false. Without it, only the terminal
      // assistant.message event is emitted and the Dashboard stays on
      // "Thinking" until the complete response arrives at once.
      streaming: true,
      // The Copilot CLI runs with the Host, while record.state.cwd belongs to
      // the remote Workspace Executor. Never expose Host-only paths as message
      // attachments; persisted attachments are sent to the SDK as blobs below.
      workingDirectory,
      systemMessage: {
        mode: 'replace' as const,
        content: record.config.systemPrompt ?? 'You are an AI coding agent.',
      },
      tools,
      availableTools: [
        ...tools.map((tool) => `custom:${tool.name}`),
        ...new ToolSet().addBuiltIn('view').toArray(),
      ],
      excludedTools: ['mcp:*'],
      additionalDirectories: [],
      onPermissionRequest: (request: { kind: string; path?: string; managedApprovalRequired?: boolean }) => {
        if (
          request.kind === 'read'
          && !request.managedApprovalRequired
          && typeof request.path === 'string'
          && this.context.messageAttachments?.allowsSdkRead(record.sessionId, request.path)
        ) return { kind: 'approve-once' as const }
        return {
          kind: 'reject' as const,
          feedback: 'Copilot may only read the exact Host-managed file attached to this message.',
        }
      },
      skipCustomInstructions: true,
      customAgentsLocalOnly: true,
      remoteSession: 'off' as const,
      infiniteSessions: {
        enabled: true,
        backgroundCompactionThreshold: this.compactionPolicy.automatic.startThreshold,
        bufferExhaustionThreshold: this.compactionPolicy.automatic.blockingThreshold,
      },
      coauthorEnabled: false,
      enableExperimentalMode: false,
      skipEmbeddingRetrieval: true,
      embeddingCacheStorage: 'in-memory' as const,
      enableOnDemandInstructionDiscovery: false,
      enableFileHooks: false,
      enableHostGitOperations: false,
      enableSessionStore: false,
      enableSkills: false,
    }
  }

  private tool(record: SessionRecord, schema: ToolSchema): Tool {
    return {
      name: schema.name,
      description: schema.description,
      parameters: schema.inputSchema,
      skipPermission: true,
      overridesBuiltInTool: true,
      handler: async (args, invocation) => {
        const input = asRecord(args)
        const callKey = approvalKey(record.sessionId, invocation.toolCallId)
        const generation = this.toolCallGenerations.get(callKey)
          ?? this.turnGenerations.get(record.sessionId)
        if (generation === undefined || !this.isCurrentTurn(record.sessionId, generation)) {
          return toolResult(false, 'cancelled', 'failure')
        }
        const pending: PendingToolCall = {
          callId: invocation.toolCallId,
          name: schema.name,
          input,
          status: 'dispatched',
        }
        if (record.state.approvalMode === 'deny' && schema.requiresApproval) {
          await this.projectToolCall(record, { ...pending, status: 'awaiting_approval' })
          await this.projectToolResult(record, pending, false, 'rejected by approval policy')
          return toolResult(false, 'rejected by approval policy', 'denied')
        }
        if (requiresApproval(record.state.approvalMode, schema.requiresApproval)) {
          pending.status = 'awaiting_approval'
          const decisionPromise = new Promise<ApprovalDecision>((resolve) => {
            this.approvals.set(approvalKey(record.sessionId, pending.callId), { resolve })
          })
          try {
            await this.projectToolCall(record, pending)
            this.context.broadcast.onApprovalRequired(record.sessionId)
          } catch (error) {
            this.approvals.delete(approvalKey(record.sessionId, pending.callId))
            throw error
          }
          const decision = await decisionPromise
          if (!this.isCurrentTurn(record.sessionId, generation)) {
            return toolResult(false, 'cancelled', 'failure')
          }
          if (!decision.approved) {
            await this.projectToolResult(record, pending, false, decision.reason ?? 'rejected by user')
            return toolResult(false, decision.reason ?? 'rejected by user', 'rejected')
          }
          await this.project(record, 'copilot.tool_approved', { callId: pending.callId }, (state) => ({
            ...state,
            status: 'executing_tools',
            pendingCalls: state.pendingCalls.map((call) => call.callId === pending.callId
              ? { ...call, status: 'dispatched' }
              : call),
            error: undefined,
          }))
        } else {
          await this.projectToolCall(record, pending)
        }
        const result = await this.context.tools.callTool(record.sessionId, {
          kind: 'call_tool',
          callId: pending.callId,
          name: pending.name,
          input: pending.input,
          ...(record.state.cwd ? { cwd: record.state.cwd } : {}),
        })
        if (this.cancelledCalls.delete(callKey) || !this.isCurrentTurn(record.sessionId, generation)) {
          return toolResult(false, 'cancelled', 'failure')
        }
        await this.projectToolResult(record, pending, result.ok, result.content)
        return toolResult(result.ok, result.content, result.ok ? 'success' : 'failure')
      },
    }
  }

  private handleEvent(record: SessionRecord, event: SessionEvent): void {
    const generation = this.trackEventGeneration(record.sessionId, event)
    if (isTurnScopedEvent(event) && generation !== undefined && !this.isCurrentTurn(record.sessionId, generation)) {
      return
    }
    if (event.type === 'assistant.usage') {
      if (event.data.apiCallId) this.accountedUsageCallIds.add(event.data.apiCallId)
      void this.project(record, 'copilot.assistant_usage', nativeEventPayload(event), (state) => ({
        ...state,
        usage: {
          inputTokens: state.usage.inputTokens + (event.data.inputTokens ?? 0),
          outputTokens: state.usage.outputTokens + (event.data.outputTokens ?? 0),
          cacheCreationTokens: state.usage.cacheCreationTokens + (event.data.cacheWriteTokens ?? 0),
          cacheReadTokens: state.usage.cacheReadTokens + (event.data.cacheReadTokens ?? 0),
        },
      }))
      return
    }
    if (event.type === 'session.usage_info') {
      if (event.agentId) return
      const snapshot = this.freshContextSnapshot(
        record,
        copilotContextSnapshot(record, event.data),
        event.timestamp,
        event.data.isInitial === true,
      )
      if (snapshot) this.context.broadcast.onState(record, record.state, snapshot)
      return
    }
    if (event.type === 'session.compaction_start') {
      const tokensBefore = event.data.currentTokens ?? event.data.conversationTokens ?? 0
      const trigger = event.data.trigger === 'manual' ? 'manual' : 'auto'
      const scope = event.agentId
        ? { kind: 'subagent' as const, agentId: event.agentId }
        : { kind: 'root' as const }
      const key = compactionKey(record.sessionId, event.agentId)
      const startSnapshot = !event.agentId && event.data.tokenLimit && event.data.currentTokens !== undefined
        ? this.freshContextSnapshot(record, copilotContextSnapshot(record, {
            currentTokens: event.data.currentTokens,
            tokenLimit: event.data.tokenLimit,
            ...(event.data.systemTokens !== undefined ? { systemTokens: event.data.systemTokens } : {}),
            ...(event.data.conversationTokens !== undefined ? { conversationTokens: event.data.conversationTokens } : {}),
            ...(event.data.toolDefinitionsTokens !== undefined ? { toolDefinitionsTokens: event.data.toolDefinitionsTokens } : {}),
          }), event.timestamp)
        : undefined
      const existing = this.compactions.get(key)
      const active: ActiveCompaction = existing ?? {
        attemptId: event.id,
        tokensBefore,
        trigger,
        startedAt: event.timestamp,
        ...(startSnapshot ? { startSnapshot } : {}),
        scope,
      }
      this.compactions.set(key, active)
      if (startSnapshot) this.context.broadcast.onState(record, record.state, startSnapshot)
      if (!existing) {
        const projection = event.agentId ? Promise.resolve() : this.projectCompactionStart(record, active)
        void projection.then(() => {
          this.context.broadcast.onCompactStatus?.({
            sessionId: record.sessionId,
            kind: 'running',
            trigger,
            tokensBefore,
            attemptId: active.attemptId,
            startedAt: active.startedAt,
            authority: this.compactionPolicy.authority,
            scope,
            ...(active.startSnapshot ? { startSnapshot: active.startSnapshot } : {}),
          })
        }).catch((error) => {
          this.compactions.delete(key)
          this.context.broadcast.onError(record.sessionId, error instanceof Error ? error.message : String(error))
        })
      }
      return
    }
    if (event.type === 'session.compaction_complete') {
      const scope = event.agentId
        ? { kind: 'subagent' as const, agentId: event.agentId }
        : { kind: 'root' as const }
      const key = compactionKey(record.sessionId, event.agentId)
      const active = this.compactions.get(key)
      const current: ActiveCompaction = active ?? {
        attemptId: event.parentId ?? event.id,
        tokensBefore: event.data.preCompactionTokens ?? 0,
        trigger: event.data.trigger === 'manual' ? 'manual' : 'auto',
        startedAt: event.timestamp,
        scope,
      }
      this.compactions.delete(key)
      if (event.data.success) {
        const tokensAfter = event.data.postCompactionTokens ?? event.data.conversationTokens ?? 0
        const currentTokens = completeCompactionContextTokens(event.data)
        const completionSnapshot = !event.agentId && event.data.tokenLimit && currentTokens !== undefined
          ? this.freshContextSnapshot(record, copilotContextSnapshot(record, {
              currentTokens,
              tokenLimit: event.data.tokenLimit,
              ...(event.data.systemTokens !== undefined ? { systemTokens: event.data.systemTokens } : {}),
              ...(event.data.conversationTokens !== undefined ? { conversationTokens: event.data.conversationTokens } : {}),
              ...(event.data.toolDefinitionsTokens !== undefined ? { toolDefinitionsTokens: event.data.toolDefinitionsTokens } : {}),
            }), event.timestamp, true)
          : undefined
        const completion = {
          tokensAfter,
          ...(event.data.messagesRemoved !== undefined ? { replacedCount: event.data.messagesRemoved } : {}),
          ...(event.data.summaryContent ? { summary: event.data.summaryContent } : {}),
          endedAt: event.timestamp,
        }
        const projection = event.agentId ? Promise.resolve() : this.projectCompactionDone(record, current, completion)
        void projection.then(() => {
          this.context.broadcast.onCompactStatus?.({
            sessionId: record.sessionId,
            kind: 'done',
            attemptId: current.attemptId,
            tokensBefore: event.data.preCompactionTokens ?? current.tokensBefore,
            trigger: current.trigger,
            authority: this.compactionPolicy.authority,
            scope,
            ...(current.startSnapshot ? { startSnapshot: current.startSnapshot } : {}),
            ...(completionSnapshot ? { completionSnapshot } : {}),
            summaryValidation: this.compactionPolicy.summary.validation,
            ...completion,
          })
        }).catch((error) => {
          this.context.broadcast.onError(record.sessionId, error instanceof Error ? error.message : String(error))
        })
        if (completionSnapshot) this.context.broadcast.onState(record, record.state, completionSnapshot)
      } else {
        const message = event.data.error ?? 'Copilot compaction failed'
        const projection = event.agentId ? Promise.resolve() : this.projectCompactionError(record, current, message, event.timestamp)
        void projection.then(() => {
          this.context.broadcast.onCompactStatus?.({
            sessionId: record.sessionId,
            kind: 'error',
            attemptId: current.attemptId,
            message,
            endedAt: event.timestamp,
            authority: this.compactionPolicy.authority,
            scope,
          })
        }).catch((error) => {
          this.context.broadcast.onError(record.sessionId, error instanceof Error ? error.message : String(error))
        })
      }
      return
    }
    if (event.type === 'assistant.message_delta') {
      this.context.broadcast.onTokenDelta(record.sessionId, event.data.deltaContent)
      return
    }
    if ((event.type === 'assistant.message' || event.type === 'assistant.reasoning') && !event.agentId) {
      const capture = this.turnCaptures.get(record.sessionId)
      if (!capture || capture.eventIds.has(event.id)) return
      capture.eventIds.add(event.id)
      const content: MessageContent[] = []
      const reasoningTexts: string[] = []
      let assistantText = ''
      if (event.type === 'assistant.reasoning') {
        const text = event.data.content.trim()
        if (text && !capture.reasoningTexts.has(text)) {
          reasoningTexts.push(text)
          content.push({ type: 'thinking', text: event.data.content, provider: 'github-copilot' })
        }
      } else {
        const reasoning = event.data.reasoningText?.trim()
        if (reasoning && !capture.reasoningTexts.has(reasoning)) {
          reasoningTexts.push(reasoning)
          content.push({ type: 'thinking', text: event.data.reasoningText!, provider: 'github-copilot' })
        }
        assistantText = event.data.content.trim()
        if (assistantText) content.push({ type: 'text', text: event.data.content })
      }
      if (content.length > 0) {
        // Reserve content immediately to de-duplicate back-to-back complete
        // events. A failed projection fails the whole turn below rather than
        // allowing session_idle to hide the missing transcript content.
        for (const text of reasoningTexts) capture.reasoningTexts.add(text)
        if (assistantText) capture.assistantEventIds.add(event.id)
        const outputTokens = event.type === 'assistant.message'
          ? this.takeOutputTokens(event.data.apiCallId, event.data.outputTokens)
          : 0
        const projection = this.projectAssistantContent(
          record,
          event.type === 'assistant.reasoning' ? 'copilot.assistant_reasoning' : 'copilot.assistant_message',
          nativeEventPayload(event),
          content,
          outputTokens,
          event.timestamp,
          event.id,
        ).catch((error) => { capture.projectionError ??= error })
        capture.projections.push(projection)
      }
      return
    }
    if (event.type === 'assistant.reasoning_delta') return
    if (event.type === 'session.idle') {
      if (this.turnCaptures.has(record.sessionId)) return
      void this.projectSessionIdle(record, nativeEventPayload(event)).catch((error) => {
        this.context.broadcast.onError(record.sessionId, error instanceof Error ? error.message : String(error))
      })
      return
    }
    if (event.type === 'session.error') {
      void this.project(record, 'copilot.session_error', nativeEventPayload(event), (state) => ({
        ...state,
        status: 'error',
        pendingCalls: [],
        error: event.data.message,
      })).finally(() => this.activeTurnTimings.delete(record.sessionId))
      this.context.broadcast.onError(record.sessionId, event.data.message)
    }
  }

  private trackEventGeneration(sessionId: string, event: SessionEvent): number | undefined {
    const data = event.data && typeof event.data === 'object'
      ? event.data as Record<string, unknown>
      : {}
    const requestId = typeof data.clientRequestId === 'string' ? data.clientRequestId : undefined
    const turnId = typeof data.turnId === 'string' ? data.turnId : undefined
    const interactionId = typeof data.interactionId === 'string' ? data.interactionId : undefined
    let generation = requestId
      ? this.requestGenerations.get(approvalKey(sessionId, requestId))
      : undefined
    if (generation === undefined && event.type === 'user.message' && interactionId) {
      generation = this.turnGenerations.get(sessionId)
    }
    if (generation === undefined && interactionId) {
      generation = this.sdkInteractionGenerations.get(sdkInteractionGenerationKey(sessionId, interactionId))
    }
    if (generation === undefined && event.parentId) {
      generation = this.eventGenerations.get(approvalKey(sessionId, event.parentId))
    }
    if (generation === undefined && turnId && interactionId) {
      generation = this.sdkTurnGenerations.get(sdkTurnGenerationKey(sessionId, interactionId, turnId))
    }
    if (generation === undefined) generation = this.turnGenerations.get(sessionId)

    if (generation !== undefined) {
      this.eventGenerations.set(approvalKey(sessionId, event.id), generation)
      if (interactionId) {
        this.sdkInteractionGenerations.set(sdkInteractionGenerationKey(sessionId, interactionId), generation)
      }
      if (turnId && interactionId) {
        this.sdkTurnGenerations.set(sdkTurnGenerationKey(sessionId, interactionId, turnId), generation)
      }
      const toolRequests = Array.isArray(data.toolRequests) ? data.toolRequests : []
      for (const request of toolRequests) {
        if (!request || typeof request !== 'object') continue
        const toolCallId = (request as Record<string, unknown>).toolCallId
        if (typeof toolCallId === 'string') {
          this.toolCallGenerations.set(approvalKey(sessionId, toolCallId), generation)
        }
      }
      if (event.type === 'tool.execution_start' && typeof data.toolCallId === 'string') {
        this.toolCallGenerations.set(approvalKey(sessionId, data.toolCallId), generation)
      }
    }
    return generation
  }

  private isCurrentTurn(sessionId: string, generation: number): boolean {
    const currentPrompt = this.context.store.get(sessionId)?.config.systemPrompt ?? 'You are an AI coding agent.'
    return this.turnGenerations.get(sessionId) === generation
      && this.turnSystemPrompts.get(sessionId) === currentPrompt
      && !this.cancelledTurnGenerations.has(turnGenerationKey(sessionId, generation))
  }

  private async runTurn(
    record: SessionRecord,
    session: CopilotSession,
    input: AgentRuntimeSendInput,
    generation: number,
    requestId: string,
  ): Promise<void> {
    const capture: TurnCapture = {
      assistantEventIds: new Set(), reasoningTexts: new Set(), eventIds: new Set(), projections: [],
    }
    this.turnCaptures.set(record.sessionId, capture)
    try {
      const message = await copilotMessageOptions(this.context, record, input, requestId)
      await this.context.assertSessionEffectOwner?.(record.sessionId)
      const response = await sendAndWaitWithActivityTimeout(session, message)
      if (!this.isCurrentTurn(record.sessionId, generation)) return
      await Promise.all(capture.projections)
      if (capture.projectionError) throw capture.projectionError
      const pendingProjection = this.tails.get(record.sessionId)
      if (pendingProjection) await pendingProjection
      if (!response && capture.assistantEventIds.size === 0) throw new Error('Copilot turn completed without an assistant message')
      const timing = this.activeTurnTimings.get(record.sessionId)
      const content: MessageContent[] = []
      if (response?.data.reasoningText && !capture.reasoningTexts.has(response.data.reasoningText.trim())) {
        content.push({ type: 'thinking', text: response.data.reasoningText, provider: 'github-copilot' })
      }
      if (response?.data.content && !capture.assistantEventIds.has(response.id)) {
        content.push({ type: 'text', text: response.data.content })
      }
      if (content.length > 0) {
        const createdAt = response?.timestamp ?? new Date().toISOString()
        const temporalMessage = withTemporalMetadata({ role: 'assistant' as const, content }, {
          messageId: response?.id ?? `${requestId}:assistant`,
          turnId: input.operationId ?? requestId,
          createdAt,
          turnStartedAt: timing?.startedAt ?? createdAt,
        })
        const assistantMessage = this.context.publishLocalImages
          ? await this.context.publishLocalImages(record.sessionId, record, temporalMessage)
          : temporalMessage
        const outputTokens = this.takeOutputTokens(response?.data.apiCallId, response?.data.outputTokens)
        await this.project(record, 'copilot.assistant_message', response ? nativeEventPayload(response) : {}, (state) => ({
          ...state,
          messages: [...state.messages, assistantMessage],
          usage: outputTokens > 0
            ? { ...state.usage, outputTokens: state.usage.outputTokens + outputTokens }
            : state.usage,
          status: 'thinking',
          pendingCalls: [],
          error: undefined,
        }))
      }
      await this.projectSessionIdle(record, response ? nativeEventPayload(response) : {})
    } catch (error) {
      if (!this.isCurrentTurn(record.sessionId, generation)) return
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('waiting for session.idle') || message.includes('Copilot session activity')) {
        await session.abort().catch(() => undefined)
        for (const call of record.state.pendingCalls) {
          this.cancelledCalls.add(approvalKey(record.sessionId, call.callId))
        }
        await this.context.tools.cancelPending(record.sessionId)
      }
      const timing = this.activeTurnTimings.get(record.sessionId)
      await this.project(record, 'copilot.session_error', { message }, (state) => ({
        ...state,
        messages: timing ? completeTemporalTurn(state.messages, timing, 'failed') : state.messages,
        status: 'error',
        pendingCalls: [],
        error: message,
      }))
      this.context.broadcast.onError(record.sessionId, message)
    } finally {
      if (this.turnCaptures.get(record.sessionId) === capture) this.turnCaptures.delete(record.sessionId)
      if (
        this.turnGenerations.get(record.sessionId) === generation
        && (this.context.store.get(record.sessionId) ?? record).state.pendingCalls.length === 0
      ) {
        this.activeTurnTimings.delete(record.sessionId)
      }
    }
  }

  private async projectSessionIdle(
    record: SessionRecord,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const timing = this.activeTurnTimings.get(record.sessionId)
    await this.project(record, 'copilot.session_idle', payload, (state) => {
      if (state.pendingCalls.length > 0) return state
      return {
        ...state,
        messages: timing ? completeTemporalTurn(state.messages, timing, 'completed') : state.messages,
        status: 'done',
        pendingCalls: [],
        error: undefined,
      }
    })
    if ((this.context.store.get(record.sessionId) ?? record).state.pendingCalls.length === 0) {
      this.activeTurnTimings.delete(record.sessionId)
    }
  }

  private takeOutputTokens(apiCallId: string | undefined, outputTokens: number | undefined): number {
    if (!apiCallId || this.accountedUsageCallIds.has(apiCallId)) return 0
    const tokens = outputTokens ?? 0
    if (tokens > 0) this.accountedUsageCallIds.add(apiCallId)
    return tokens
  }

  private async projectToolCall(record: SessionRecord, pending: PendingToolCall): Promise<void> {
    const timing = this.activeTurnTimings.get(record.sessionId)
    const createdAt = new Date().toISOString()
    await this.project(record, 'copilot.tool_call', {
      callId: pending.callId,
      name: pending.name,
      input: pending.input,
    }, (state) => ({
      ...state,
      messages: [...state.messages, withTemporalMetadata({
        role: 'assistant',
        content: [{
          type: 'tool_call',
          callId: pending.callId,
          name: pending.name,
          input: pending.input,
        }],
      }, {
        messageId: `tool-call:${pending.callId}`,
        turnId: timing?.turnId ?? `turn:${record.sessionId}`,
        createdAt,
        turnStartedAt: timing?.startedAt ?? createdAt,
      })],
      status: pending.status === 'awaiting_approval' ? 'awaiting_approval' : 'executing_tools',
      pendingCalls: [...state.pendingCalls.filter((call) => call.callId !== pending.callId), pending],
      error: undefined,
    }))
  }

  private async projectToolResult(
    record: SessionRecord,
    pending: PendingToolCall,
    ok: boolean,
    content: string,
  ): Promise<void> {
    const timing = this.activeTurnTimings.get(record.sessionId)
    const createdAt = new Date().toISOString()
    await this.project(record, 'copilot.tool_result', { callId: pending.callId, ok }, (state) => {
      const pendingCalls = state.pendingCalls.filter((call) => call.callId !== pending.callId)
      const status = pendingCalls.some((call) => call.status === 'awaiting_approval')
        ? 'awaiting_approval'
        : pendingCalls.length > 0
          ? 'executing_tools'
          : 'thinking'
      return {
        ...state,
        messages: [...state.messages, withTemporalMetadata({
          role: 'tool',
          content: [{ type: 'tool_result', callId: pending.callId, ok, content }],
        }, {
          messageId: `tool-result:${pending.callId}`,
          turnId: timing?.turnId ?? `turn:${record.sessionId}`,
          createdAt,
          turnStartedAt: timing?.startedAt ?? createdAt,
        })],
        status,
        pendingCalls,
        error: undefined,
      }
    })
  }

  private async expireUnresumableApproval(
    record: SessionRecord,
    callId: string,
  ): Promise<void> {
    const latest = this.context.store.get(record.sessionId) ?? record
    const pending = latest.state.pendingCalls.find((call) => call.callId === callId)
    if (!pending) return
    const message = 'Copilot approval could not be resumed after host restart'
    await this.project(
      latest,
      'copilot.approval_expired_after_restart',
      { callId },
      (state) => ({
        ...state,
        messages: [...state.messages, {
          role: 'tool',
          content: [{ type: 'tool_result', callId, ok: false, content: message }],
        }],
        status: 'error',
        pendingCalls: state.pendingCalls.filter((call) => call.callId !== callId),
        error: message,
      }),
    )
  }

  private async projectAssistantContent(
    record: SessionRecord,
    action: string,
    payload: Record<string, unknown>,
    content: MessageContent[],
    outputTokens: number,
    createdAt: string,
    messageId: string,
  ): Promise<void> {
    const previous = this.tails.get(record.sessionId) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(async () => {
      const latest = this.context.store.get(record.sessionId) ?? record
      const timing = this.activeTurnTimings.get(record.sessionId)
      const message: Message = timing
        ? withTemporalMetadata({ role: 'assistant', content }, {
            messageId,
            turnId: timing.turnId,
            createdAt,
            turnStartedAt: timing.startedAt,
          })
        : { role: 'assistant', content }
      const assistantMessage = this.context.publishLocalImages
        ? await this.context.publishLocalImages(record.sessionId, latest, message)
        : message
      const projected = {
        ...latest.state,
        messages: [...latest.state.messages, assistantMessage],
        usage: outputTokens > 0
          ? { ...latest.state.usage, outputTokens: latest.state.usage.outputTokens + outputTokens }
          : latest.state.usage,
        ...(latest.state.pendingCalls.length > 0
          ? {
              status: latest.state.status === 'awaiting_approval' ? 'awaiting_approval' as const : 'executing_tools' as const,
              pendingCalls: latest.state.pendingCalls,
            }
          : { status: 'thinking' as const, pendingCalls: [] as const }),
        error: undefined,
        cursor: latest.state.cursor + 1,
      } as AgentState
      const next = await this.externalizeInlineImages(record.sessionId, projected)
      await this.context.store.recordRuntimeProjection(record.sessionId, next, action, payload)
      this.context.broadcast.onState(latest, next)
    })
    this.tails.set(record.sessionId, current)
    try {
      await current
    } finally {
      if (this.tails.get(record.sessionId) === current) this.tails.delete(record.sessionId)
    }
  }

  private async externalizeInlineImages(sessionId: string, state: AgentState): Promise<AgentState> {
    const store = this.context.messageAttachments
    if (!store) return state
    let changed = false
    const messages: Message[] = []
    for (const [messageIndex, message] of state.messages.entries()) {
      const content: MessageContent[] = []
      for (const [contentIndex, block] of message.content.entries()) {
        if (block.type !== 'image' || block.source.kind !== 'base64' || !block.source.data) {
          content.push(block)
          continue
        }
        const extension = imageExtension(block.source.mediaType)
        const file = await store.register({
          sessionId,
          name: `pasted-image-${messageIndex + 1}-${contentIndex + 1}.${extension}`,
          mediaType: block.source.mediaType,
          data: Buffer.from(block.source.data, 'base64'),
        })
        await store.commitReferences(sessionId, [file])
        content.push(file)
        changed = true
      }
      messages.push(changed ? { ...message, content } : message)
    }
    return changed ? { ...state, messages } as AgentState : state
  }

  private async project(
    record: SessionRecord,
    action: string,
    payload: Record<string, unknown>,
    update: (state: AgentState) => Omit<AgentState, 'cursor'>,
    contextSnapshot?: (record: SessionRecord) => ContextUsageSnapshot | undefined,
  ): Promise<void> {
    const previous = this.tails.get(record.sessionId) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(async () => {
      const latest = this.context.store.get(record.sessionId) ?? record
      const projected = { ...update(latest.state), cursor: latest.state.cursor + 1 } as AgentState
      const next = await this.externalizeInlineImages(record.sessionId, projected)
      await this.context.store.recordRuntimeProjection(record.sessionId, next, action, payload)
      this.context.broadcast.onState(latest, next, contextSnapshot?.(latest))
    })
    this.tails.set(record.sessionId, current)
    try {
      await current
    } finally {
      if (this.tails.get(record.sessionId) === current) this.tails.delete(record.sessionId)
    }
  }

  private async projectCompactionStart(record: SessionRecord, active: ActiveCompaction): Promise<void> {
    await this.project(record, 'copilot.compaction_start', {
      attemptId: active.attemptId,
      trigger: active.trigger,
      tokensBefore: active.tokensBefore,
    }, (state) => ({
      ...state,
      messages: [...state.messages, {
        role: 'system',
        content: [],
        metadata: {
          kind: 'context_compaction',
          attemptId: active.attemptId,
          phase: 'running',
          trigger: active.trigger,
          tokensBefore: active.tokensBefore,
          startedAt: active.startedAt,
        },
      }],
    }))
  }

  private async projectCompactionDone(
    record: SessionRecord,
    active: ActiveCompaction,
    completion: {
      tokensAfter: number
      replacedCount?: number
      summary?: string
      endedAt: string
    },
  ): Promise<void> {
    await this.project(record, 'copilot.compaction_complete', {
      attemptId: active.attemptId,
      trigger: active.trigger,
      tokensBefore: active.tokensBefore,
      ...completion,
    }, (state) => ({
      ...state,
      messages: updateCompactionMarker(state.messages, active, {
        phase: 'done',
        ...completion,
      }),
    }))
  }

  private async projectCompactionError(
    record: SessionRecord,
    active: ActiveCompaction,
    error: string,
    endedAt: string,
  ): Promise<void> {
    await this.project(record, 'copilot.compaction_error', {
      attemptId: active.attemptId,
      error,
      endedAt,
    }, (state) => ({
      ...state,
      messages: updateCompactionMarker(state.messages, active, {
        phase: 'error',
        error,
        endedAt,
      }),
    }))
  }

  private freshContextSnapshot(
    record: SessionRecord,
    snapshot: ContextUsageSnapshot,
    eventTimestamp: string,
    allowDecrease = false,
  ): ContextUsageSnapshot | undefined {
    const eventTime = Date.parse(eventTimestamp)
    const updatedAt = Number.isFinite(eventTime) ? eventTime : Date.now()
    const latestTime = this.contextEventTimes.get(record.sessionId)
      ?? record.runtimeContextSnapshot?.updatedAt
      ?? 0
    if (updatedAt < latestTime) return undefined
    const latestTokens = this.contextTokenHighWater.get(record.sessionId)
      ?? record.runtimeContextSnapshot?.usage.inputTokens
    if (!allowDecrease && latestTokens !== undefined && snapshot.usage.inputTokens < latestTokens) {
      process.emitWarning(
        `Rejected unexplained context usage regression for ${record.sessionId}: ${latestTokens} -> ${snapshot.usage.inputTokens}`,
        { code: 'KALA_CONTEXT_USAGE_REGRESSION' },
      )
      return undefined
    }
    this.contextEventTimes.set(record.sessionId, updatedAt)
    this.contextTokenHighWater.set(record.sessionId, snapshot.usage.inputTokens)
    return { ...snapshot, updatedAt }
  }
}

function updateCompactionMarker(
  messages: readonly Message[],
  active: ActiveCompaction,
  update: {
    phase: 'done' | 'error'
    tokensAfter?: number
    replacedCount?: number
    summary?: string
    endedAt: string
    error?: string
  },
): Message[] {
  let found = false
  const next = messages.map((message) => {
    if (message.metadata?.kind !== 'context_compaction' || message.metadata.attemptId !== active.attemptId) return message
    found = true
    return {
      ...message,
      metadata: {
        ...message.metadata,
        ...update,
      },
    }
  })
  if (found) return next
  return [...next, {
    role: 'system',
    content: [],
    metadata: {
      kind: 'context_compaction',
      attemptId: active.attemptId,
      trigger: active.trigger,
      tokensBefore: active.tokensBefore,
      startedAt: active.startedAt,
      ...update,
    },
  }]
}

async function sendAndWaitWithActivityTimeout(session: CopilotSession, message: MessageOptions) {
  let timeout: NodeJS.Timeout | undefined
  let receivedActivity = false
  let rejectInactivity!: (error: Error) => void
  const inactivity = new Promise<never>((_, reject) => {
    rejectInactivity = reject
  })
  const armTimeout = () => {
    if (timeout) clearTimeout(timeout)
    const timeoutMs = receivedActivity
      ? COPILOT_INACTIVITY_TIMEOUT_MS
      : COPILOT_FIRST_ACTIVITY_TIMEOUT_MS
    timeout = setTimeout(() => {
      const phase = receivedActivity ? '' : 'initial '
      rejectInactivity(new Error(`Timeout after ${timeoutMs}ms without ${phase}Copilot session activity`))
    }, timeoutMs)
    timeout.unref?.()
  }
  const unsubscribe = session.on((event) => {
    if (!isCopilotTurnActivity(event)) return
    receivedActivity = true
    armTimeout()
  })
  armTimeout()
  try {
    return await Promise.race([
      session.sendAndWait(message, COPILOT_SDK_TURN_TIMEOUT_MS),
      inactivity,
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
    unsubscribe()
  }
}

function isCopilotTurnActivity(event: SessionEvent): boolean {
  return event.type !== 'user.message'
    && event.type !== 'assistant.turn_start'
}

function modelInfo(model: CopilotModelInfo): ModelInfo {
  return {
    ref: model.id,
    id: model.id,
    label: model.name,
    provider: 'GitHub Copilot',
    providerId: 'github-copilot',
    ...(model.capabilities.limits.max_context_window_tokens
      ? { contextWindow: model.capabilities.limits.max_context_window_tokens }
      : {}),
  }
}

function compactionKey(sessionId: string, agentId?: string): string {
  return `${sessionId}:${agentId ?? 'root'}`
}

function isRestingStatus(status: AgentState['status']): boolean {
  return status === 'idle' || status === 'done' || status === 'error'
}

function userMessage(input: AgentRuntimeSendInput): Message {
  if (input.content && input.content.length > 0) return { role: 'user', content: [...input.content] }
  return { role: 'user', content: [{ type: 'text', text: input.text }] }
}

function withTemporalMetadata(
  message: Message,
  timing: { messageId: string; turnId: string; createdAt: string; turnStartedAt: string },
): Message {
  return {
    ...message,
    metadata: {
      kind: 'temporal',
      messageId: timing.messageId,
      turnId: timing.turnId,
      createdAt: timing.createdAt,
      turnStartedAt: timing.turnStartedAt,
    },
  }
}

function completeTemporalTurn(
  messages: readonly Message[],
  timing: ActiveTurnTiming,
  status: 'completed' | 'failed' | 'cancelled' | 'interrupted',
): Message[] {
  const completedAt = new Date().toISOString()
  const durationMs = Math.max(0, Date.parse(completedAt) - Date.parse(timing.startedAt))
  let index = -1
  for (let candidate = messages.length - 1; candidate >= 0; candidate -= 1) {
    const message = messages[candidate]
    if (
      message?.role === 'assistant'
      && message.metadata?.kind === 'temporal'
      && message.metadata.turnId === timing.turnId
    ) {
      index = candidate
      break
    }
  }
  if (index < 0) {
    for (let candidate = messages.length - 1; candidate >= 0; candidate -= 1) {
      const message = messages[candidate]
      if (
        message?.role === 'user'
        && message.metadata?.kind === 'temporal'
        && message.metadata.turnId === timing.turnId
      ) {
        index = candidate
        break
      }
    }
  }
  if (index < 0) return [...messages]
  return messages.map((message, messageIndex) => {
    if (messageIndex !== index || message.metadata?.kind !== 'temporal') return message
    return {
      ...message,
      metadata: {
        ...message.metadata,
        turnCompletedAt: completedAt,
        turnDurationMs: durationMs,
        turnStatus: status,
      },
    }
  })
}

async function copilotMessageOptions(
  context: AgentRuntimeContext,
  record: SessionRecord,
  input: AgentRuntimeSendInput,
  requestId: string,
): Promise<MessageOptions> {
  const attachments: NonNullable<MessageOptions['attachments']> = []
  for (const block of input.content ?? []) {
    if (block.type === 'file' && 'data' in block) {
      attachments.push({
        type: 'blob',
        data: block.data,
        mimeType: block.mediaType,
        ...(!block.mediaType.startsWith('image/') ? { displayName: block.name } : {}),
      })
    } else if (block.type === 'file') {
      if (!context.messageAttachments) {
        throw new Error(`Attachment "${block.name}" cannot be resolved because Host attachment storage is unavailable`)
      }
      const data = await (await context.messageAttachments.resolve(record.sessionId, block)).read()
      attachments.push({
        type: 'blob',
        data: data.toString('base64'),
        mimeType: block.mediaType,
        ...(!block.mediaType.startsWith('image/') ? { displayName: block.name } : {}),
      })
    } else if (block.type === 'image' && block.source.kind === 'base64') {
      attachments.push({
        type: 'blob',
        data: block.source.data,
        mimeType: block.source.mediaType,
      })
    } else if (block.type === 'image' && block.source.kind === 'file_ref') {
      attachments.push({
        type: 'file',
        path: block.source.path,
        displayName: block.source.path.split(/[\\/]/u).at(-1) ?? block.source.path,
      })
    }
  }
  return {
    prompt: input.text,
    requestHeaders: { 'x-request-id': requestId },
    ...(attachments.length > 0 ? { attachments } : {}),
  }
}

function imageExtension(mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'): string {
  if (mediaType === 'image/jpeg') return 'jpg'
  return mediaType.slice('image/'.length)
}

function completeCompactionContextTokens(data: {
  postCompactionTokens?: number
  systemTokens?: number
  conversationTokens?: number
  toolDefinitionsTokens?: number
}): number | undefined {
  if (
    data.systemTokens === undefined
    || data.conversationTokens === undefined
    || data.toolDefinitionsTokens === undefined
  ) return data.postCompactionTokens
  return data.systemTokens + data.conversationTokens + data.toolDefinitionsTokens
}

function copilotContextSnapshot(
  record: SessionRecord,
  usage: {
    currentTokens: number
    tokenLimit: number
    systemTokens?: number
    conversationTokens?: number
    toolDefinitionsTokens?: number
  },
): ContextUsageSnapshot {
  const system = usage.systemTokens ?? 0
  const transcript = usage.conversationTokens ?? Math.max(0, usage.currentTokens - system - (usage.toolDefinitionsTokens ?? 0))
  const tools = usage.toolDefinitionsTokens ?? 0
  const model = record.preferences?.selectedModel ?? 'unknown'
  return {
    model: { ref: model, provider: 'github-copilot', id: model },
    contextWindow: { tokens: usage.tokenLimit, source: 'api_reported' },
    usage: { inputTokens: usage.currentTokens, totalTokens: usage.currentTokens },
    breakdown: {
      system,
      transcript,
      tools,
      memory: Math.max(0, usage.currentTokens - system - transcript - tools),
      attachments: 0,
      pendingUserInput: 0,
    },
    estimator: {
      total: { kind: 'provider_reported', confidence: 'exact' },
      breakdown: { kind: 'heuristic', confidence: 'estimated' },
      version: 'copilot-sdk-usage-info-v1',
    },
    updatedAt: Date.now(),
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function requiresApproval(mode: ApprovalMode, toolRequiresApproval: boolean): boolean {
  if (mode === 'allow_all') return false
  if (mode === 'ask') return true
  if (mode === 'deny') return false
  return toolRequiresApproval
}

function materializePackagedCopilotRuntime(runtimeEntryPath: string, cacheRoot: string): string | undefined {
  const target = copilotRuntimeTarget()
  if (!target) return undefined
  const releaseDir = dirname(runtimeEntryPath)
  const sourceWrapper = join(releaseDir, `kala-copilot-runtime-${target}`)
  const sourceLibrary = join(releaseDir, `kala-copilot-runtime-node-${target}.node`)
  if (!existsSync(sourceWrapper) || !existsSync(sourceLibrary)) return undefined

  const installDir = join(cacheRoot, `sdk-1.0.14-${target}`)
  const installedWrapper = join(installDir, process.platform === 'win32' ? 'copilot-runtime.exe' : 'copilot-runtime')
  const installedLibrary = join(installDir, 'runtime.node')
  if (sameSize(sourceWrapper, installedWrapper) && sameSize(sourceLibrary, installedLibrary)) return installedWrapper

  mkdirSync(cacheRoot, { recursive: true })
  const stagingDir = join(cacheRoot, `.sdk-runtime-${randomUUID()}`)
  mkdirSync(stagingDir, { mode: 0o700 })
  try {
    const stagedWrapper = join(stagingDir, process.platform === 'win32' ? 'copilot-runtime.exe' : 'copilot-runtime')
    copyFileSync(sourceWrapper, stagedWrapper)
    copyFileSync(sourceLibrary, join(stagingDir, 'runtime.node'))
    chmodSync(stagedWrapper, 0o700)
    rmSync(installDir, { recursive: true, force: true })
    renameSync(stagingDir, installDir)
  } finally {
    rmSync(stagingDir, { recursive: true, force: true })
  }
  return installedWrapper
}

function copilotRuntimeTarget(): string | undefined {
  if ((process.arch !== 'x64' && process.arch !== 'arm64')
    || (process.platform !== 'linux' && process.platform !== 'darwin' && process.platform !== 'win32')) return undefined
  return `${process.platform}-${process.arch}`
}

function sameSize(source: string, target: string): boolean {
  return existsSync(target) && statSync(source).size === statSync(target).size
}

function copilotStartupFailureReason(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  if (/could not (?:find|resolve).*@github\/copilot|copilot cli not found|path to copilot cli is required|\bENOENT\b/i.test(detail)) {
    return `Copilot CLI unavailable: ${detail} Install the complete @github/copilot-sdk npm dependencies or set COPILOT_CLI_PATH to a compatible Copilot CLI executable.`
  }
  return detail
}

function approvalKey(sessionId: string, callId: string): string {
  return `${sessionId}:${callId}`
}

function turnGenerationKey(sessionId: string, generation: number): string {
  return `${sessionId}:${generation}`
}

function sdkInteractionGenerationKey(sessionId: string, interactionId: string): string {
  return `${sessionId}:${interactionId}`
}

function sdkTurnGenerationKey(sessionId: string, interactionId: string, turnId: string): string {
  return `${sessionId}:${interactionId}:${turnId}`
}

function isTurnScopedEvent(event: SessionEvent): boolean {
  return event.type.startsWith('assistant.')
    || event.type.startsWith('tool.')
    || event.type === 'session.error'
    || event.type === 'session.usage_info'
}

function toolResult(ok: boolean, content: string, resultType: ToolResultObject['resultType']): ToolResultObject {
  return {
    textResultForLlm: content,
    resultType,
    ...(!ok ? { error: content } : {}),
  }
}

function nativeEventPayload(event: SessionEvent): Record<string, unknown> {
  return {
    id: event.id,
    type: event.type,
    timestamp: event.timestamp,
  }
}
