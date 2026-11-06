export type AgentBoardEntry = {
  topic: string
  content: string
  authorSessionId: string
  authorRole?: string
  tags: readonly string[]
  revision: number
  updatedAt: string
}

export type AgentBoardFileClaim = {
  path: string
  holderSessionId: string
  holderRole?: string
  claimedAt: string
  note?: string
}

export type AgentBoardState = {
  revision: number
  entries: Record<string, AgentBoardEntry>
  fileClaims: Record<string, AgentBoardFileClaim>
}

export function emptyAgentBoard(): AgentBoardState {
  return { revision: 0, entries: Object.create(null), fileClaims: Object.create(null) }
}

export type AgentBoardTransaction = <T>(
  sessionId: string,
  operation: (rootSessionId: string, board: AgentBoardState, actor: { sessionId: string; parentSessionId?: unknown; agentType?: unknown }) => T,
) => Promise<T>
