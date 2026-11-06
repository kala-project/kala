/**
 * Cross-Agent Message Board (`agent_board`).
 *
 * Provides a shared, session-tree-scoped coordination board where a parent
 * session and its child/sibling sub-agents can publish discovered facts,
 * interface contracts, test statuses, and advisory file-ownership claims.
 *
 * See `docs/host/multi-agent-board-and-steering.md` (SoT).
 */

import type { ToolExecutionResult } from '../agent-modules/execution.js'
import type { SessionRecord, SessionStore } from '../store/session.js'
import type { AgentBoardState } from '../store/agent-board-state.js'
import type { AgentBoardEntry, AgentBoardFileClaim } from '../store/agent-board-state.js'
import type { HostToolContext } from './registry.js'

export const AGENT_BOARD_TOOL_NAME = 'agent_board'
const MAX_BOARD_TOPICS = 200
const MAX_FILE_CLAIMS = 200
const MAX_TOPIC_CONTENT_BYTES = 32 * 1024

export type { AgentBoardEntry, AgentBoardFileClaim } from '../store/agent-board-state.js'

type RootBoardState = {
  rootSessionId: string
  revision: number
  entries: Map<string, AgentBoardEntry>
  fileClaims: Map<string, AgentBoardFileClaim>
}

const boardsByRootSession = new Map<string, RootBoardState>()

/**
 * Walk `parentSessionId` links up to the root session ID so that the parent
 * and all of its child/descendant sub-agents share one board.
 */
export function resolveRootSessionId(
  store: Pick<SessionStore, 'get'>,
  sessionId: string,
): string {
  let currentId = sessionId
  const visited = new Set<string>()
  while (!visited.has(currentId)) {
    visited.add(currentId)
    const record = store.get(currentId)
    if (!record?.parentSessionId) return currentId
    currentId = record.parentSessionId
  }
  return currentId
}

export function clearAgentBoardForRoot(rootSessionId: string): void {
  boardsByRootSession.delete(rootSessionId)
}

export function inspectAgentBoard(rootSessionId: string): {
  revision: number
  entries: readonly AgentBoardEntry[]
  fileClaims: readonly AgentBoardFileClaim[]
} {
  const board = boardsByRootSession.get(rootSessionId)
  if (!board) return { revision: 0, entries: [], fileClaims: [] }
  return {
    revision: board.revision,
    entries: [...board.entries.values()],
    fileClaims: [...board.fileClaims.values()],
  }
}

function authorRoleFor(record: SessionRecord | undefined): string {
  if (!record) return 'unknown'
  if (!record.parentSessionId) return 'parent'
  return record.agentType ?? 'subagent'
}

export async function runAgentBoardTool(context: HostToolContext): Promise<ToolExecutionResult> {
  const { deps, sessionId, effect } = context
  const record = deps.store.get(sessionId)
  if (!record) {
    return { ok: false, content: 'Session is unavailable' }
  }
  await deps.assertSessionEffectOwner?.(sessionId)
  const input = effect.input
  const operation = typeof input.operation === 'string' ? input.operation : ''

  let observed: { rootSessionId: string; board: AgentBoardState } | undefined
  const result = await deps.store.agentBoardTransaction(sessionId, (rootSessionId, board, actor) => {
    board.entries = Object.assign(Object.create(null), board.entries) as AgentBoardState['entries']
    board.fileClaims = Object.assign(Object.create(null), board.fileClaims) as AgentBoardState['fileClaims']
    const entries = board.entries
    const claims = board.fileClaims
    const valueCount = (values: object): number => Object.keys(values).length
    const values = <T>(values: Record<string, T>): T[] => Object.values(values)
    const execute = (): ToolExecutionResult => {
      switch (operation) {
    case 'post': {
      const topic = typeof input.topic === 'string' ? input.topic.trim() : ''
      if (!topic || topic.length > 120) {
        return { ok: false, content: 'agent_board post requires a non-empty `topic` (max 120 chars)' }
      }
      const content = typeof input.content === 'string' ? input.content : ''
      if (!content.trim()) {
        return { ok: false, content: 'agent_board post requires non-empty `content`' }
      }
      if (Buffer.byteLength(content, 'utf8') > MAX_TOPIC_CONTENT_BYTES) {
        return { ok: false, content: `agent_board post content exceeds ${MAX_TOPIC_CONTENT_BYTES} bytes` }
      }

      const existing = entries[topic]
      if (!existing && valueCount(entries) >= MAX_BOARD_TOPICS) {
        return { ok: false, content: `agent_board reached maximum topic count (${MAX_BOARD_TOPICS})` }
      }
      if (typeof input.expected_revision === 'number' && Number.isFinite(input.expected_revision)) {
        const currentRev = existing?.revision ?? 0
        if (currentRev !== Math.floor(input.expected_revision)) {
          return {
            ok: false,
            content: `agent_board revision mismatch on topic "${topic}": expected ${Math.floor(input.expected_revision)}, actual ${currentRev}`,
          }
        }
      }

      const tags = Array.isArray(input.tags)
        ? input.tags.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).map((t) => t.trim()).slice(0, 10)
        : (existing?.tags ?? [])

      const nextRevision = (existing?.revision ?? 0) + 1
      board.revision += 1
      const entry: AgentBoardEntry = {
        topic,
        content,
        authorSessionId: sessionId,
        authorRole: authorRoleFor(record),
        tags,
        revision: nextRevision,
        updatedAt: new Date().toISOString(),
      }
      entries[topic] = entry
      return {
        ok: true,
        content: JSON.stringify({
          ok: true,
          operation: 'post',
          rootSessionId,
          boardRevision: board.revision,
          entry,
        }, null, 2),
      }
    }

    case 'read': {
      const topic = typeof input.topic === 'string' ? input.topic.trim() : ''
      const tagFilter = typeof input.tag === 'string' ? input.tag.trim() : ''
      if (topic) {
        const entry = entries[topic]
        if (!entry) {
          return { ok: false, content: `Topic "${topic}" not found on agent_board` }
        }
        return {
          ok: true,
          content: JSON.stringify({
            ok: true,
            operation: 'read',
            rootSessionId,
            boardRevision: board.revision,
            entry,
          }, null, 2),
        }
      }

      const filtered = values(entries).filter((e) => !tagFilter || e.tags.includes(tagFilter))
      return {
        ok: true,
        content: JSON.stringify({
          ok: true,
          operation: 'read',
          rootSessionId,
          boardRevision: board.revision,
          entries: filtered,
          fileClaims: values(claims),
        }, null, 2),
      }
    }

    case 'list': {
      const tagFilter = typeof input.tag === 'string' ? input.tag.trim() : ''
      const summaries = values(entries)
        .filter((e) => !tagFilter || e.tags.includes(tagFilter))
        .map((e) => ({
          topic: e.topic,
          authorSessionId: e.authorSessionId,
          authorRole: e.authorRole,
          tags: e.tags,
          revision: e.revision,
          updatedAt: e.updatedAt,
          preview: e.content.length > 160 ? `${e.content.slice(0, 160)}...` : e.content,
        }))

      return {
        ok: true,
        content: JSON.stringify({
          ok: true,
          operation: 'list',
          rootSessionId,
          boardRevision: board.revision,
          topics: summaries,
          fileClaims: values(claims),
        }, null, 2),
      }
    }

    case 'claim_file': {
      const path = typeof input.path === 'string' ? input.path.trim() : ''
      if (!path || path.length > 1024) {
        return { ok: false, content: 'agent_board claim_file requires a non-empty `path` (max 1024 chars)' }
      }
      const existingClaim = claims[path]
      if (!existingClaim && valueCount(claims) >= MAX_FILE_CLAIMS) {
        return { ok: false, content: `agent_board reached maximum file claim count (${MAX_FILE_CLAIMS})` }
      }
      if (existingClaim && existingClaim.holderSessionId !== sessionId) {
        return {
          ok: false,
          content: JSON.stringify({
            ok: false,
            error: `File "${path}" is already claimed by session ${existingClaim.holderSessionId} (${existingClaim.holderRole ?? 'subagent'})`,
            claim: existingClaim,
          }, null, 2),
        }
      }
      const claim: AgentBoardFileClaim = {
        path,
        holderSessionId: sessionId,
        holderRole: authorRoleFor(record),
        claimedAt: new Date().toISOString(),
        ...(typeof input.note === 'string' && input.note.trim().length > 0 ? { note: input.note.trim().slice(0, 1024) } : {}),
      }
      claims[path] = claim
      board.revision += 1
      return {
        ok: true,
        content: JSON.stringify({
          ok: true,
          operation: 'claim_file',
          rootSessionId,
          boardRevision: board.revision,
          claim,
        }, null, 2),
      }
    }

    case 'release_file': {
      const path = typeof input.path === 'string' ? input.path.trim() : ''
      if (!path || path.length > 1024) {
        return { ok: false, content: 'agent_board release_file requires a non-empty `path` (max 1024 chars)' }
      }
      const existingClaim = claims[path]
      if (!existingClaim) {
        return {
          ok: true,
          content: JSON.stringify({
            ok: true,
            operation: 'release_file',
            released: false,
            path,
          }, null, 2),
        }
      }
      if (existingClaim.holderSessionId !== sessionId && record.parentSessionId !== undefined) {
        return {
          ok: false,
          content: `File "${path}" is claimed by another session (${existingClaim.holderSessionId}); only the holder or root parent can release it`,
        }
      }
      delete claims[path]
      board.revision += 1
      return {
        ok: true,
        content: JSON.stringify({
          ok: true,
          operation: 'release_file',
          released: true,
          path,
          boardRevision: board.revision,
        }, null, 2),
      }
    }

    case 'clear': {
      if (actor.parentSessionId !== undefined) {
        return { ok: false, content: 'Only the root parent can clear the agent_board' }
      }
      board.entries = Object.create(null) as AgentBoardState['entries']
      board.fileClaims = Object.create(null) as AgentBoardState['fileClaims']
      board.revision += 1
      return {
        ok: true,
        content: JSON.stringify({
          ok: true,
          operation: 'clear',
          rootSessionId,
          boardRevision: board.revision,
        }, null, 2),
      }
    }

    default:
      return {
        ok: false,
        content: `Unsupported agent_board operation "${operation}". Expected one of: post, read, list, claim_file, release_file, clear.`,
      }
      }
    }
    const answer = execute()
    observed = { rootSessionId, board: structuredClone(board) }
    return answer
  })
  if (observed) {
    const { rootSessionId, board } = observed
    boardsByRootSession.set(rootSessionId, {
      rootSessionId,
      revision: board.revision,
      entries: new Map(Object.entries(board.entries)),
      fileClaims: new Map(Object.entries(board.fileClaims)),
    })
  }
  return result
}
