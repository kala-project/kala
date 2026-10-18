import { createRoot } from 'react-dom/client'
import { KERNEL_AGENT_RUNTIME_CAPABILITIES, type AttachedExecutor, type DirListResult, type SessionSummary } from '@agent-kernel/shared'

import '../index.css'
import { i18n } from '../i18n/index.js'
import { useVisualViewportHeight } from '../lib/useVisualViewportHeight.js'
import { NewSessionDialog } from '../features/explorer/WorkspacePicker.js'
import { Explorer } from '../features/explorer/Explorer.js'
import { ChatPanel } from '../features/chat/ChatPanel.js'

const workspace: AttachedExecutor = {
  executorId: 'mobile-layout-executor',
  workspaceId: 'mobile-layout-workspace',
  workspaceName: 'Sample workspace',
  os: 'linux',
  runtime: 'node',
  runtimeVersion: 'v22.22.1',
  tools: [],
  sandboxRoots: ['/workspace'],
  ipAddresses: [],
  attachedAt: new Date().toISOString(),
}

const socket = {
  on: () => {},
  off: () => {},
  emit: (event: string, request: { requestId: string; workspaceId: string; path: string }, ack?: (result: DirListResult) => void) => {
    if (event !== 'client:list_dirs' || !ack) return
    window.setTimeout(() => ack({
      requestId: request.requestId,
      workspaceId: request.workspaceId,
      path: request.path,
      roots: ['/workspace'],
      entries: [{ name: 'project', path: '/workspace/project', type: 'directory' }],
    }), 0)
  },
}

function Fixture(): JSX.Element {
  useVisualViewportHeight()
  return (
    <NewSessionDialog
      open
      workspaces={[workspace]}
      agentRuntimes={[
        { id: 'kernel', label: 'Kala', description: 'Kala Kernel', available: true, status: 'ready', capabilities: KERNEL_AGENT_RUNTIME_CAPABILITIES },
        { id: 'copilot', label: 'GitHub Copilot', description: 'GitHub Copilot', available: true, status: 'ready', capabilities: { ...KERNEL_AGENT_RUNTIME_CAPABILITIES, queue: false } },
      ]}
      socket={socket as never}
      onCreate={() => {}}
      onCreateSimpleChat={() => {}}
      onCancel={() => {}}
    />
  )
}

function ThinkingFixture(): JSX.Element {
  useVisualViewportHeight()
  return <ChatPanel messages={[{ role: 'assistant', content: [
    { type: 'thinking', text: '## I’ m investigating\n\nI’ m checking John’s report and “quoted text”.' },
  ] }]} />
}

function ExplorerFixture(): JSX.Element {
  const height = useVisualViewportHeight()
  const sessions: SessionSummary[] = [
    { sessionId: 'visible-session', workspaceId: workspace.workspaceId, workspaceName: workspace.workspaceName, createdAt: new Date().toISOString(), lastEventAt: new Date().toISOString(), eventCount: 1, status: 'done', agentRuntime: 'kernel', executionMode: 'chat', firstUserMessage: 'Visible conversation' },
    { sessionId: 'hidden-session', workspaceId: workspace.workspaceId, workspaceName: workspace.workspaceName, createdAt: new Date().toISOString(), lastEventAt: new Date().toISOString(), eventCount: 1, status: 'done', agentRuntime: 'kernel', executionMode: 'chat', firstUserMessage: 'Hidden conversation' },
  ]
  return (
    <div className="flex w-screen flex-col bg-card" style={{ height }} data-testid="explorer-mobile-fixture">
      <div className="min-h-0 flex-1 overflow-hidden">
        <Explorer executors={[workspace]} sessions={sessions} selectedSessionId={null} onSelect={() => {}} onNewSession={() => {}} onDelete={() => {}} onRename={() => {}} />
      </div>
      <div className="min-h-14 flex-none border-t border-border/35 px-3 py-2" data-testid="narrow-drawer-footer">Settings</div>
    </div>
  )
}

const params = new URLSearchParams(location.search)
if (params.get('surface') === 'explorer') {
  localStorage.setItem('ak-hidden-workspaces', JSON.stringify({ version: 1, ids: ['missing-hidden-workspace'] }))
  localStorage.setItem('ak-hidden-sessions', JSON.stringify({ version: 1, ids: ['hidden-session'] }))
}
await i18n.changeLanguage(params.get('lng') === 'en' ? 'en' : 'zh')
createRoot(document.getElementById('root')!).render(params.get('surface') === 'explorer' ? <ExplorerFixture /> : params.get('surface') === 'thinking' ? <ThinkingFixture /> : <Fixture />)
