/**
 * Wire-protocol contract tests.
 *
 * Three axes of coverage:
 *   1. Schema surface snapshot — the set of exported schema names is
 *      pinned. Removing or renaming a wire schema (a breaking change for
 *      any peer) trips this test and forces a review.
 *   2. Round-trip parses — representative payloads for the highest-traffic
 *      channels are validated via `.parse()`. Regressions where a schema
 *      stops accepting known-good data surface here.
 *   3. Rejection cases — payloads missing required fields, or with wrong
 *      shapes at the discriminator, must fail. This is the "safety net"
 *      for the trust boundary — parseWire() at the socket edge relies on
 *      these rejections to keep malformed data out of the loop.
 */
import { describe, expect, it } from 'vitest'
import { schema } from '@agent-kernel/shared'

describe('wire contract — schema surface', () => {
  it('exports a stable, sorted set of schema names', () => {
    const names = Object.keys(schema)
      .filter((k) => k.endsWith('Schema'))
      .sort()
    expect(names).toMatchSnapshot()
  })

  it('pins authoritative session timing on both Dashboard baseline schemas', () => {
    expect({
      sessionReady: Object.keys(schema.SessionReadyEventSchema.shape).sort(),
      stateChanged: Object.keys(schema.StateChangedEventSchema.shape).sort(),
    }).toMatchSnapshot()
  })
})

describe('wire contract — round-trip parses', () => {
  it('parses ClientUserMessage (text-only)', () => {
    const out = schema.ClientUserMessageSchema.parse({
      sessionId: 's-1',
      text: 'hello',
      intent: 'text',
    })
    expect(out.sessionId).toBe('s-1')
  })

  it('parses ClientUserMessage with structured content', () => {
    const out = schema.ClientUserMessageSchema.parse({
      sessionId: 's-1',
      text: 'see image',
      intent: 'text',
      content: [
        { type: 'text', text: 'part' },
        { type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: 'AAA' } },
      ],
    })
    expect(out.content?.length).toBe(2)
  })

  it('parses ClientUserApprove / ClientUserReject', () => {
    expect(schema.ClientUserApproveSchema.parse({ sessionId: 's', callId: 'c' }))
      .toEqual({ sessionId: 's', callId: 'c' })
    expect(schema.ClientUserRejectSchema.parse({ sessionId: 's', callId: 'c', reason: 'nope' }))
      .toMatchObject({ reason: 'nope' })
  })

  it('parses ClientAskUserChoice', () => {
    expect(schema.ClientAskUserChoiceSchema.parse({ sessionId: 's', callId: 'c', value: 'safe' }))
      .toEqual({ sessionId: 's', callId: 'c', value: 'safe' })
    expect(schema.ClientAskUserChoiceSchema.parse({ sessionId: 's', callId: 'c', customText: 'do this instead' }))
      .toEqual({ sessionId: 's', callId: 'c', customText: 'do this instead' })
    expect(schema.ClientAskUserChoiceSchema.parse({ sessionId: 's', callId: 'c', values: ['safe', 'fast'] }))
      .toEqual({ sessionId: 's', callId: 'c', values: ['safe', 'fast'] })
    expect(() => schema.ClientAskUserChoiceSchema.parse({ sessionId: 's', callId: 'c', value: 'safe', customText: 'both' }))
      .toThrow()
    expect(() => schema.ClientAskUserChoiceSchema.parse({ sessionId: 's', callId: 'c', value: 'safe', values: ['fast'] }))
      .toThrow()
  })

  it('parses legacy and acknowledged ClientCancel payloads', () => {
    expect(schema.ClientCancelSchema.parse({ sessionId: 's' })).toEqual({ sessionId: 's' })
    expect(schema.ClientCancelSchema.parse({ sessionId: 's', operationId: 'cancel-1' }))
      .toEqual({ sessionId: 's', operationId: 'cancel-1' })
  })

  it('parses ClientListSessions / ClientListExecutors from empty payloads', () => {
    expect(schema.ClientListSessionsSchema.parse(undefined)).toEqual({})
    expect(schema.ClientListSessionsSchema.parse({})).toEqual({})
    expect(schema.ClientListExecutorsSchema.parse(undefined)).toEqual({})
  })

  it('parses ClientSetApprovalMode across all four modes', () => {
    for (const mode of ['auto', 'ask', 'deny', 'allow_all'] as const) {
      expect(schema.ClientSetApprovalModeSchema.parse({ sessionId: 's', mode }))
        .toMatchObject({ mode })
    }
  })

  it('parses ExecutorAnnounce with workspaceId + workspaceName', () => {
    const out = schema.ExecutorAnnounceSchema.parse({
      executorId: 'ex-1',
      workspaceId: 'ws-1',
      workspaceName: 'demo',
      tools: ['read', 'write'],
      runtime: 'node',
      runtimeVersion: '22.0.0',
    })
    expect(out.workspaceId).toBe('ws-1')
  })

  it('preserves the advertised attachment transfer capability through Executor and Dashboard wire parsing', () => {
    const announcement = {
      executorId: 'ex-1',
      workspaceId: 'ws-1',
      workspaceName: 'Devbox',
      attachmentTransferVersion: 1,
      tools: [],
      runtime: 'node',
      runtimeVersion: '22',
    }
    expect(schema.ExecutorAnnounceSchema.parse(announcement)).toHaveProperty('attachmentTransferVersion', 1)
    expect(schema.AttachedExecutorSchema.parse({ ...announcement, attachedAt: '2026-11-09T00:00:00Z' }))
      .toHaveProperty('attachmentTransferVersion', 1)
    expect(schema.ExecutorAnnounceSchema.safeParse({ ...announcement, attachmentTransferVersion: 2 }).success).toBe(false)
  })

  it('parses ClientCreateSession with and without cwd', () => {
    expect(schema.ClientCreateSessionSchema.parse({
      sessionId: 's', workspaceId: 'ws',
    })).toMatchObject({ sessionId: 's', workspaceId: 'ws' })

    expect(schema.ClientCreateSessionSchema.parse({
      sessionId: 's', workspaceId: 'ws', workspaceName: 'demo', cwd: '/tmp',
    })).toMatchObject({ cwd: '/tmp' })
  })

  it('parses ClientFork (minimum + full)', () => {
    expect(schema.ClientForkSchema.parse({
      sourceSessionId: 's', cursor: 42,
    })).toMatchObject({ cursor: 42 })
    expect(schema.ClientForkSchema.parse({
      sourceSessionId: 's', cursor: 0, newSessionId: 'n', seedMessage: 'hi',
    })).toMatchObject({ seedMessage: 'hi' })
  })

  it('parses ManualModelInput', () => {
    expect(schema.ManualModelInputSchema.parse({
      providerId: 'anthropic', id: 'claude-opus-4-7', label: 'Opus 4.7', contextWindow: 200000,
    })).toMatchObject({ id: 'claude-opus-4-7' })
  })

  it('parses ModelInfo with a canonical provider-qualified ref', () => {
    expect(schema.ModelInfoSchema.parse({
      ref: 'anthropic:claude-opus-4-7',
      id: 'claude-opus-4-7',
      label: 'Opus 4.7',
      provider: 'Anthropic',
      providerId: 'anthropic',
      contextWindow: 200000,
    })).toMatchObject({ ref: 'anthropic:claude-opus-4-7', providerId: 'anthropic' })
  })

  it('parses ToolProgressPayload', () => {
    expect(schema.ToolProgressPayloadSchema.parse({
      sessionId: 's', callId: 'c', chunk: 'still working',
    })).toMatchObject({ chunk: 'still working' })
  })

  it('parses read-only git RPC payloads and results', () => {
    expect(schema.ClientGitStatusSchema.parse({ requestId: 'r', workspaceId: 'ws', sessionId: 's', cwd: '/repo/subdir' }))
      .toMatchObject({ workspaceId: 'ws', cwd: '/repo/subdir' })
    expect(schema.ClientGitDiffSchema.parse({ requestId: 'r', workspaceId: 'ws', cwd: '/repo/subdir', path: 'src/index.ts', staged: true }))
      .toMatchObject({ cwd: '/repo/subdir', path: 'src/index.ts', staged: true })
    expect(schema.GitStatusResultSchema.parse({
      requestId: 'r', workspaceId: 'ws', repo: { root: '/repo', branch: 'main' }, files: [
        { path: 'src/index.ts', status: 'modified', staged: false, unstaged: true },
      ],
    }).files).toHaveLength(1)
    expect(schema.GitDiffResultSchema.parse({
      requestId: 'r', workspaceId: 'ws', oldText: 'a', newText: 'b', language: 'typescript',
    }).newText).toBe('b')
  })
})

describe('wire contract — rejection cases', () => {
  it('accepts omitted legacy turn timing and rejects malformed present timestamps', () => {
    expect(schema.SessionReadyEventSchema.shape.turnStartedAt.safeParse(undefined).success).toBe(true)
    expect(schema.StateChangedEventSchema.shape.turnStartedAt.safeParse('2026-09-25T12:00:00.000Z').success).toBe(true)
    expect(schema.StateChangedEventSchema.shape.turnStartedAt.safeParse('not-a-timestamp').success).toBe(false)
  })

  it('rejects ClientUserMessage missing required fields', () => {
    expect(schema.ClientUserMessageSchema.safeParse({ sessionId: 's' }).success).toBe(false)
    expect(schema.ClientUserMessageSchema.safeParse({ text: 'orphan' }).success).toBe(false)
  })

  it('rejects blank dashboard wire identifiers', () => {
    expect(schema.ClientUserMessageSchema.safeParse({ sessionId: '   ', text: 'hi' }).success).toBe(false)
    expect(schema.ClientListDirsSchema.safeParse({ requestId: '', workspaceId: 'ws' }).success).toBe(false)
    expect(schema.ClientTerminalKillSchema.safeParse({
      requestId: 'r', workspaceId: 'ws', sessionId: 's', terminalId: ' ',
    }).success).toBe(false)
  })

  it('rejects blank executor wire identifiers', () => {
    expect(schema.ExecutorAnnounceSchema.safeParse({
      executorId: ' ', workspaceId: 'ws', workspaceName: 'demo', tools: [], runtime: 'node', runtimeVersion: '22',
    }).success).toBe(false)
    expect(schema.ToolProgressPayloadSchema.safeParse({
      sessionId: 's', callId: '', chunk: 'delta',
    }).success).toBe(false)
    expect(schema.ServerTerminalOutputSchema.safeParse({
      workspaceId: 'ws', sessionId: ' ', terminalId: 't', data: '',
    }).success).toBe(false)
  })

  it('keeps content and path fields outside id normalization', () => {
    expect(schema.ClientUserMessageSchema.parse({ sessionId: 's', text: '   ', intent: 'text' }).text).toBe('   ')
    expect(schema.ClientReadFileSchema.parse({
      requestId: 'r', workspaceId: 'ws', sessionId: 's', path: ' ./x ',
    }).path).toBe(' ./x ')
  })

  it('rejects ClientSetApprovalMode with unknown mode', () => {
    expect(schema.ClientSetApprovalModeSchema.safeParse({
      sessionId: 's', mode: 'yolo',
    }).success).toBe(false)
  })

  it('accepts supported chapter reading modes and rejects unknown modes', () => {
    expect(schema.ClientUpdatePreferencesSchema.safeParse({
      sessionId: 's', preferences: { chapterReadingMode: 'chapters' },
    }).success).toBe(true)
    expect(schema.ClientUpdatePreferencesSchema.safeParse({
      sessionId: 's', preferences: { chapterReadingMode: 'continuous' },
    }).success).toBe(true)
    expect(schema.ClientUpdatePreferencesSchema.safeParse({
      sessionId: 's', preferences: { chapterReadingMode: 'pages' },
    }).success).toBe(false)
  })

  it('rejects ExecutorAnnounce missing workspaceId', () => {
    // Regression: previously fixtures omitted workspaceId and slipped through.
    // The wire schema is authoritative — enforce it here so a future refactor
    // that "helpfully" makes workspaceId optional trips this test first.
    expect(schema.ExecutorAnnounceSchema.safeParse({
      executorId: 'ex-1',
      workspaceName: 'demo',
      tools: [],
      runtime: 'node',
      runtimeVersion: '22',
    }).success).toBe(false)
  })

  it('rejects ClientFork with negative cursor', () => {
    expect(schema.ClientForkSchema.safeParse({
      sourceSessionId: 's', cursor: -1,
    }).success).toBe(false)
  })

  it('rejects ManualModelInput with non-positive contextWindow', () => {
    expect(schema.ManualModelInputSchema.safeParse({
      providerId: 'p', id: 'm', contextWindow: 0,
    }).success).toBe(false)
  })

  it('rejects blank manual model/provider identifiers', () => {
    expect(schema.ManualModelInputSchema.safeParse({
      providerId: '   ', id: 'm',
    }).success).toBe(false)
    expect(schema.ManualProviderInputSchema.safeParse({
      id: '', wire: 'openai', baseUrl: 'http://localhost:8000/v1', apiKey: 'key',
    }).success).toBe(false)
  })

  it('rejects invalid manual provider URLs and empty API keys', () => {
    expect(schema.ManualProviderInputSchema.safeParse({
      id: 'local-openai', wire: 'openai', baseUrl: 'not a url', apiKey: 'key',
    }).success).toBe(false)
    expect(schema.ManualProviderInputSchema.safeParse({
      id: 'local-openai', wire: 'openai', baseUrl: 'http://localhost:8000/v1', apiKey: '   ',
    }).success).toBe(false)
  })

  it('rejects blank default model refs', () => {
    expect(schema.ClientSetDefaultModelSchema.safeParse({ model: '   ' }).success).toBe(false)
  })

  it('rejects ModelInfo without a canonical ref or providerId', () => {
    expect(schema.ModelInfoSchema.safeParse({
      id: 'claude-opus-4-7', label: 'Opus 4.7', provider: 'Anthropic', providerId: 'anthropic',
    }).success).toBe(false)
    expect(schema.ModelInfoSchema.safeParse({
      ref: 'anthropic:claude-opus-4-7', id: 'claude-opus-4-7', label: 'Opus 4.7', provider: 'Anthropic',
    }).success).toBe(false)
  })

  it('rejects ClientListDirs missing requestId', () => {
    expect(schema.ClientListDirsSchema.safeParse({
      workspaceId: 'ws', path: '/x',
    }).success).toBe(false)
  })

  it('rejects unsafe git diff paths', () => {
    expect(schema.ClientGitStatusSchema.safeParse({ requestId: '', workspaceId: 'ws' }).success).toBe(false)
    expect(schema.ClientGitStatusSchema.safeParse({ requestId: 'r', workspaceId: '   ' }).success).toBe(false)
    expect(schema.ClientGitDiffSchema.safeParse({ requestId: 'r', workspaceId: 'ws', path: '/etc/passwd' }).success).toBe(false)
    expect(schema.ClientGitDiffSchema.safeParse({ requestId: 'r', workspaceId: 'ws', path: '../secret' }).success).toBe(false)
    expect(schema.ClientGitDiffSchema.safeParse({ requestId: 'r', workspaceId: 'ws', path: 'src/../secret' }).success).toBe(false)
  })
})
