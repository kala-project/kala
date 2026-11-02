import { LOG_FORMAT_VERSION, type HeaderEntry } from '@agent-kernel/shared'
import { createSessionProfile, redactForPersistence, type ArtifactStore } from '@agent-kernel/shared/enhancement'

import type { SessionArtifactStorage } from './session-artifact-registry.js'
import { writeSessionTraceArtifacts } from './session-export.js'
import { createRolloutSegmentsArtifact } from './rl-export.js'
import type { SessionStore } from './store/session.js'

export type DurableSessionExportAction = 'trace-export-session' | 'profile-session' | 'rollout-export-segments'

export async function exportDurableSession(input: {
  action: DurableSessionExportAction
  sessionId: string
  sessions: Pick<SessionStore, 'load' | 'readHistory'>
  artifacts: SessionArtifactStorage
  runId?: string
  evalInstanceId?: string
  assertCanStore?: (bytes: number) => Promise<void>
}): Promise<unknown> {
  const registerJson = input.artifacts.registerJson?.bind(input.artifacts)
  if (!registerJson) throw new Error('durable JSON artifact storage is unavailable')
  const session = await input.sessions.load(input.sessionId)
  const history = await input.sessions.readHistory(input.sessionId)
  const header: HeaderEntry = {
    kind: 'header',
    seq: 0,
    ts: session.createdAt,
    sessionId: session.sessionId,
    agentRuntime: session.agentRuntime,
    executionMode: session.executionMode,
    agentRuntimeVersion: session.agentRuntimeVersion,
    parentSessionId: session.parentSessionId,
    parentCursor: session.parentCursor,
    workspaceId: session.workspaceId,
    organizationId: session.organizationId,
    formatVersion: LOG_FORMAT_VERSION,
    kernelVersion: '@agent-kernel/kernel@0.0.0',
    config: history.config,
    initialState: history.initialState,
  }
  const store: Pick<ArtifactStore, 'writeJson'> = {
    async writeJson(kind, title, value) {
      const redacted = redactForPersistence(value)
      const data = Buffer.from(JSON.stringify(redacted.value, null, 2) + '\n')
      await input.assertCanStore?.(data.byteLength)
      const record = await registerJson({
        sessionId: session.sessionId,
        title,
        data,
      })
      return {
        kind,
        uri: `/session-artifacts/${encodeURIComponent(record.artifactId)}?sessionId=${encodeURIComponent(session.sessionId)}`,
        sha256: record.sha256,
        bytes: record.bytes,
        mediaType: record.mediaType,
        redaction: redacted.summary,
      }
    },
  }
  if (input.action === 'trace-export-session') {
    const result = await writeSessionTraceArtifacts({ ...input, header, events: history.events, store })
    return { action: input.action, ...result }
  }
  if (input.action === 'profile-session') {
    const profile = createSessionProfile({ header, events: history.events })
    const artifact = await store.writeJson('metadata', 'profile.json', profile)
    return { action: input.action, sessionId: session.sessionId, profile, artifact }
  }
  const segments = createRolloutSegmentsArtifact(header, history.initialState.messages, history.events)
  const artifact = await store.writeJson('rl_token_segments', 'rollout-segments.json', segments)
  return { action: input.action, sessionId: session.sessionId, segmentCount: segments.segments.length, artifact }
}
