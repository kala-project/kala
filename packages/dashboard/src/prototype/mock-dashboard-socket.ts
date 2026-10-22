import { createInitialState, type AgentState, type Message } from '@agent-kernel/kernel'
import {
  KERNEL_AGENT_RUNTIME_CAPABILITIES,
  type AttachedExecutor,
  type ChannelSubscriptionResult,
  type DashboardChannel,
  type EventAppendedEvent,
  type SessionReadyEvent,
  type SessionSummary,
} from '@agent-kernel/shared'

type Handler = (...args: unknown[]) => void

const now = Date.parse('2026-10-02T08:00:00.000Z')
const iso = (offsetMinutes: number): string => new Date(now + offsetMinutes * 60_000).toISOString()

type PrototypeSessionSummary = SessionSummary & { costUsd?: number | null }

type PrototypeClientPayload = {
  channels: DashboardChannel[]
  requestId: string
  generation: number
  sessionId: string
  operation: string
  targetId: string
  planId: string
  preferences: NonNullable<SessionSummary['preferences']>
  label: string
  workspaceId: string
  workspaceName: string
  path?: string
  query?: string
  limit?: number
  value?: string
  values?: string[]
  customText?: string
  parentSessionId?: string
}

// Fictional directory density for responsive Explorer screenshots. Keep the
// transport shape and existing interactive Sessions unchanged.
const sidebarWorkspaces = [
  { id: 'workspace-build', name: 'Build Systems', os: 'linux', labels: ['Compare reproducible release assets', 'Trace an intermittent CI timeout', 'Harden build cache invalidation'] },
  { id: 'workspace-docs', name: 'Documentation', os: 'darwin', labels: ['梳理移动端引导流程中的关键步骤', '检查术语在不同页面中的一致性', 'Map deployment prerequisites'] },
  { id: 'workspace-infra', name: 'Infrastructure', os: 'linux', labels: ['Audit staging network boundaries', 'Check automatic recovery paths', 'Tune monitoring alerts'] },
  { id: 'workspace-mobile', name: 'Mobile QA', os: 'win32', labels: ['Check small-screen navigation', 'Test touch target spacing', 'Review accessibility labels'] },
  { id: 'workspace-storage', name: 'Storage Lab', os: 'linux', labels: ['Plan artifact retention limits', 'Verify backup restore checklist'] },
] as const

const sessions: PrototypeSessionSummary[] = [
  {
    sessionId: 'prototype-workstream', agentRuntime: 'kernel', executionMode: 'chat',
    createdAt: iso(-220), lastEventAt: iso(-100), eventCount: 16,
    workspaceId: 'workspace-storage', workspaceName: 'Storage Lab', currentCwd: '/placeholder/storage-lab',
    label: '确认对象存储恢复路径', firstUserMessage: '核对存储设计与恢复路径，修复会造成数据丢失的缺口，并说明尚未验证的部分。',
    status: 'done', preferences: { rightPanelTab: 'files', toolCardMode: 'dots' },
  },
  {
    sessionId: 'prototype-workstream-review', agentRuntime: 'kernel', executionMode: 'chat',
    createdAt: iso(-195), lastEventAt: iso(-180), eventCount: 3,
    workspaceId: 'workspace-storage', workspaceName: 'Storage Lab', currentCwd: '/placeholder/storage-lab',
    label: '审查对象引用的丢失窗口', firstUserMessage: '独立检查对象引用和消息确认是否存在数据丢失窗口。',
    status: 'done', parentSessionId: 'prototype-workstream',
  },
  {
    sessionId: 'prototype-active',
    agentRuntime: 'kernel',
    executionMode: 'chat',
    createdAt: iso(-180),
    lastEventAt: iso(-1),
    eventCount: 48,
    workspaceId: 'workspace-studio',
    workspaceName: 'Product Studio',
    currentCwd: '/workspace/product-studio',
    label: 'Refine the dashboard layout',
    firstUserMessage: 'Review the production sidebar hierarchy, preserve the existing workbench, verify responsive behavior at three widths, keep hover actions stable, and provide enough implementation detail that the transcript can be scrolled while the original prompt remains available as a lightweight pinned context anchor.',
    status: 'thinking',
    costUsd: null,
    preferences: { rightPanelTab: 'files', toolCardMode: 'dots' },
  },
  {
    sessionId: 'prototype-attention',
    agentRuntime: 'kernel',
    executionMode: 'chat',
    createdAt: iso(-320),
    lastEventAt: iso(-8),
    eventCount: 5,
    workspaceId: 'workspace-studio',
    workspaceName: 'Product Studio',
    currentCwd: '/workspace/product-studio',
    label: 'Update retry guard tests',
    firstUserMessage: 'Apply the reviewed retry guard and update the focused tests.',
    status: 'awaiting_approval',
    costUsd: 0,
  },
  {
    sessionId: 'prototype-ask-user',
    agentRuntime: 'kernel',
    executionMode: 'chat',
    createdAt: iso(-1_440),
    lastEventAt: iso(-34),
    eventCount: 7,
    workspaceId: 'workspace-studio',
    workspaceName: 'Product Studio',
    currentCwd: '/workspace/product-studio',
    label: 'Plan a safe retry rollout',
    firstUserMessage: 'Prepare a safe rollout plan and ask me for the two decisions you need.',
    status: 'executing_tools',
    costUsd: 1.25,
  },
  {
    sessionId: 'prototype-subagents',
    agentRuntime: 'kernel',
    executionMode: 'chat',
    createdAt: iso(-2_880),
    lastEventAt: iso(-95),
    eventCount: 18,
    workspaceId: 'workspace-labs',
    workspaceName: 'Research Lab',
    currentCwd: '/workspace/research-lab',
    label: 'Review responsive behavior',
    firstUserMessage: 'Run a realistic parallel review across implementation, tests, accessibility, and failure recovery.',
    status: 'executing_tools',
  },
  {
    sessionId: 'prototype-subagent-running',
    agentRuntime: 'kernel',
    executionMode: 'chat',
    createdAt: iso(-22),
    lastEventAt: iso(-4),
    eventCount: 2,
    parentSessionId: 'prototype-subagents',
    workspaceId: 'workspace-labs',
    workspaceName: 'Research Lab',
    currentCwd: '/workspace/research-lab',
    label: 'Inspect responsive layouts',
    firstUserMessage: 'Inspect responsive behavior and collect focused evidence.',
    status: 'executing_tools',
  },
  {
    sessionId: 'prototype-subagent-completed',
    agentRuntime: 'kernel',
    executionMode: 'chat',
    createdAt: iso(-28),
    lastEventAt: iso(-9),
    eventCount: 9,
    parentSessionId: 'prototype-subagents',
    workspaceId: 'workspace-labs',
    workspaceName: 'Research Lab',
    currentCwd: '/workspace/research-lab',
    label: 'Verify the retry policy',
    firstUserMessage: 'Review the retry policy and verify the focused tests.',
    status: 'done',
  },
  {
    sessionId: 'prototype-subagent-failed',
    agentRuntime: 'kernel',
    executionMode: 'chat',
    createdAt: iso(-26),
    lastEventAt: iso(-8),
    eventCount: 6,
    parentSessionId: 'prototype-subagents',
    workspaceId: 'workspace-labs',
    workspaceName: 'Research Lab',
    currentCwd: '/workspace/research-lab',
    label: 'Test retry integration',
    firstUserMessage: 'Run the retry integration fixture and report controlled failures.',
    status: 'error',
  },
  {
    sessionId: 'prototype-subagent-cancelled',
    agentRuntime: 'kernel',
    executionMode: 'chat',
    createdAt: iso(-24),
    lastEventAt: iso(-7),
    eventCount: 6,
    parentSessionId: 'prototype-subagents',
    workspaceId: 'workspace-labs',
    workspaceName: 'Research Lab',
    currentCwd: '/workspace/research-lab',
    label: 'Compare retry guidance',
    firstUserMessage: 'Collect optional comparison evidence until the parent has enough.',
    status: 'done',
  },
  {
    sessionId: 'prototype-usage',
    agentRuntime: 'kernel',
    executionMode: 'chat',
    createdAt: iso(-10_080),
    lastEventAt: iso(-7_200),
    eventCount: 7,
    workspaceId: 'workspace-windows',
    workspaceName: 'Windows QA',
    currentCwd: '/workspace/research-lab',
    label: 'Inspect usage history',
    firstUserMessage: 'Inspect long-running usage statistics.',
    status: 'done',
    costUsd: 0,
  },
  {
    sessionId: 'prototype-chapters',
    agentRuntime: 'kernel',
    executionMode: 'chat',
    createdAt: iso(-28),
    lastEventAt: iso(-8),
    eventCount: 2,
    workspaceId: 'workspace-studio',
    workspaceName: 'Product Studio',
    currentCwd: '/placeholder/product-studio',
    label: '梳理工作台的信息层级',
    firstUserMessage: '请分析工作台的信息层级，并按主题说明各部分的取舍。',
    status: 'done',
    preferences: { rightPanelTab: 'files', toolCardMode: 'dots' },
  },
  {
    sessionId: 'prototype-chat',
    agentRuntime: 'kernel',
    executionMode: 'chat',
    createdAt: iso(-45),
    lastEventAt: iso(-12),
    eventCount: 2,
    label: '梳理移动端会话列表的排版层级',
    firstUserMessage: '请检查移动端会话列表的字体、层级与无障碍表现。',
    status: 'idle',
    costUsd: 12.34,
  },
  ...['比较桌面与手机布局中的标题可读性', 'Compare navigation options'].map((label, index): PrototypeSessionSummary => ({
    sessionId: `prototype-chat-${index + 2}`,
    agentRuntime: 'kernel', executionMode: 'chat',
    createdAt: iso(-1_600 - index * 150), lastEventAt: iso(-110 - index * 25), eventCount: 3,
    label, firstUserMessage: label, status: 'done',
  })),
  ...sidebarWorkspaces.flatMap((workspace, workspaceIndex) => workspace.labels.map((label, index): PrototypeSessionSummary => ({
    sessionId: `prototype-${workspace.id.slice('workspace-'.length)}-${index + 1}`,
    agentRuntime: 'kernel', executionMode: 'chat',
    createdAt: iso(-2_000 - workspaceIndex * 400 - index * 100),
    lastEventAt: iso(-20 - workspaceIndex * 30 - index * 7), eventCount: 3 + index,
    workspaceId: workspace.id, workspaceName: workspace.name,
    currentCwd: `/placeholder/${workspace.id.slice('workspace-'.length)}`,
    label, firstUserMessage: label, status: index === 0 ? 'idle' : 'done',
  }))),
  ...['Revisit retired test fixtures', 'Summarize prior experiments'].map((label, index): PrototypeSessionSummary => ({
    sessionId: `prototype-archive-${index + 1}`,
    agentRuntime: 'kernel', executionMode: 'chat',
    createdAt: iso(-10_000 - index * 1_000), lastEventAt: iso(-8_000 - index * 500), eventCount: 4,
    workspaceId: 'workspace-archive', workspaceName: 'Archived Studies',
    currentCwd: '/placeholder/archive', label, firstUserMessage: label, status: 'done',
  })),
]

const executors: AttachedExecutor[] = [
  {
    executorId: 'executor-studio',
    workspaceId: 'workspace-studio',
    workspaceName: 'Product Studio',
    tools: ['read', 'write', 'bash', 'agent'],
    defaultCwd: '/placeholder/product-studio',
    runtime: 'node',
    runtimeVersion: '22.0.0-placeholder',
    hostname: 'studio.placeholder.local',
    os: 'darwin',
    attachedAt: iso(-240),
    clientVersion: 'prototype',
  },
  {
    executorId: 'executor-labs',
    workspaceId: 'workspace-labs',
    workspaceName: 'Research Lab',
    tools: ['read', 'grep', 'agent'],
    defaultCwd: '/placeholder/research-lab',
    runtime: 'node',
    runtimeVersion: '22.0.0-placeholder',
    hostname: 'labs.placeholder.local',
    os: 'linux',
    attachedAt: iso(-180),
    clientVersion: 'prototype',
  },
  {
    executorId: 'executor-windows',
    workspaceId: 'workspace-windows',
    workspaceName: 'Windows QA',
    tools: ['read', 'write', 'bash', 'agent'],
    defaultCwd: 'C:\\placeholder\\windows-qa',
    runtime: 'node',
    runtimeVersion: '22.0.0-placeholder',
    hostname: 'windows-qa.placeholder.local',
    os: 'win32',
    attachedAt: iso(-300),
    clientVersion: 'prototype',
  },
  ...sidebarWorkspaces.map((workspace, index): AttachedExecutor => ({
    executorId: `executor-${workspace.id.slice('workspace-'.length)}`,
    workspaceId: workspace.id, workspaceName: workspace.name,
    tools: ['read', 'write'], defaultCwd: `/placeholder/${workspace.id.slice('workspace-'.length)}`,
    runtime: 'node', runtimeVersion: '22.0.0-placeholder',
    hostname: `${workspace.id.slice('workspace-'.length)}.placeholder.example`,
    os: workspace.os, attachedAt: iso(-420 - index * 50), clientVersion: 'prototype',
  })),
]

const workstreamMessages: Message[] = [
  { role: 'user', content: [{ type: 'text', text: '核对对象存储设计与恢复路径，找出可能丢失已确认消息的缺口；先统一设计，再修复主要路径，最后说明没有验证的边界。' }] },
  { role: 'assistant', content: [{ type: 'thinking', text: '## 对齐设计约束\n检查存储权威与已确认消息的恢复承诺，先划清目标与当前实现。' }] },
  { role: 'assistant', content: [
    { type: 'tool_call', callId: 'work-read-contract', name: 'read_file', input: { path: 'docs/storage-contract.md' }, intent: '核对已确认消息与对象存储的持久化约束' },
    { type: 'tool_call', callId: 'work-read-queue', name: 'read_file', input: { path: 'src/storage/message-queue.ts' }, intent: '查明消息入队与对象引用的提交顺序' },
  ] },
  { role: 'tool', content: [
    { type: 'tool_result', callId: 'work-read-contract', ok: true, content: '设计要求已确认的消息在节点替换后仍可恢复；上传对象与引用需要一致。' },
    { type: 'tool_result', callId: 'work-read-queue', ok: true, content: '当前队列先确认消息、再单独提交对象引用，失败时可能留下可过期的引用。' },
  ] },
  { role: 'assistant', content: [{ type: 'thinking', text: '## 独立审查风险\n请另一个视角确认是否还有旧数据误认或清理竞争。' }] },
  { role: 'assistant', content: [{ type: 'tool_call', callId: 'work-review', name: 'agent', input: { role: 'review', task: '审查对象引用的丢失窗口' }, intent: '独立审查消息确认与过期清理之间的数据丢失风险' }] },
  { role: 'tool', content: [{ type: 'tool_result', callId: 'work-review', ok: true, content: '<sub_agent session_id="prototype-workstream-review" agent_type="review" intention="独立审查消息确认与过期清理之间的数据丢失风险" status="completed" turns="7" duration_ms="18500"><result>确认存在确认后引用仍可过期的窗口；建议先保护对象，再接受消息。</result></sub_agent>' }] },
  { role: 'assistant', content: [{ type: 'thinking', text: '## 收敛实现方案\n让消息确认依赖对象引用保护，清理与确认按 Session 顺序执行。' }] },
  { role: 'assistant', content: [
    { type: 'tool_call', callId: 'work-edit-contract', name: 'replace_in_file', input: { path: 'docs/storage-contract.md' }, intent: '落实文档与存储路径设计' },
    { type: 'tool_call', callId: 'work-edit-admission', name: 'replace_in_file', input: { path: 'src/storage/message-queue.ts' }, intent: '将对象引用保护移到消息持久入队之前' },
    { type: 'tool_call', callId: 'work-edit-cleanup', name: 'replace_in_file', input: { path: 'src/storage/object-cleanup.ts' }, intent: '协调单实例的引用确认与过期清理顺序' },
  ] },
  { role: 'tool', content: [
    { type: 'tool_result', callId: 'work-edit-contract', ok: true, content: '已记录确认边界和仍待解决的跨副本事务问题。' },
    { type: 'tool_result', callId: 'work-edit-admission', ok: true, content: '可靠消息确认前先保护对象引用。' },
    { type: 'tool_result', callId: 'work-edit-cleanup', ok: true, content: '同一 Session 的确认和待清理操作按顺序执行。' },
  ] },
  { role: 'assistant', content: [{ type: 'thinking', text: '## 验证与交付\n检查失败时不能先入队，且清理不能误删刚确认的对象。' }] },
  { role: 'assistant', content: [
    { type: 'tool_call', callId: 'work-typecheck', name: 'shell', input: { command: 'typecheck' }, intent: '验证类型与失败恢复行为' },
    { type: 'tool_call', callId: 'work-verify', name: 'shell', input: { command: 'test:storage' }, intent: '验证提交失败重试和清理竞争场景' },
  ] },
  { role: 'tool', content: [
    { type: 'tool_result', callId: 'work-typecheck', ok: true, content: '类型检查通过。' },
    { type: 'tool_result', callId: 'work-verify', ok: true, content: '模拟的失败重试与单实例并发场景通过。' },
  ] },
  { role: 'assistant', content: [{ type: 'text', text: '已统一存储确认边界：对象引用先受保护，消息随后可靠入队。单实例内清理与确认不会互相抢先。仍未完成跨副本事务、未使用对象的安全回收和真实外部存储恢复演练，不能宣称高可用验收。' }] },
]
const workstreamSummary = sessions.find((entry) => entry.sessionId === 'prototype-workstream')!
workstreamSummary.eventCount = messageCursor(workstreamMessages)

const activeMessages: Message[] = [
  { role: 'user', content: [{ type: 'text', text: [
    'Review the production sidebar hierarchy without replacing the existing workbench.',
    'Keep message hover actions stable, align Thinking with the assistant text column, and verify title/time behavior at wide, medium, and narrow widths.',
    'Use realistic production components and protocol events rather than a substitute UI.',
    'Provide enough implementation evidence and validation detail that this transcript becomes long enough to exercise the lightweight pinned prompt while scrolling.',
  ].join('\n') }] },
  {
    role: 'assistant',
    content: [{ type: 'thinking', text: '## Inspecting layout\n\nI will preserve the production workbench and inspect the current Explorer row geometry first.' }],
  },
  {
    role: 'assistant',
    content: [{ type: 'thinking', text: '## Checking interaction geometry\n\nNext I will compare hover metadata, timestamp overlays, and action positions before changing CSS.' }],
  },
  {
    role: 'assistant',
    content: [{ type: 'thinking', text: '## Planning validation\n\nI will add focused unit assertions and browser geometry checks for the final responsive behavior.' }],
  },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'I inspected the production layout and kept the workbench intact. The implementation below uses the real Explorer, ChatPanel, Composer, and responsive panel system.' },
      { type: 'tool_call', callId: 'read-explorer', name: 'read', input: { path: 'src/features/explorer/Explorer.tsx' }, intent: 'Inspect the production Explorer hierarchy and row geometry.' },
      { type: 'tool_call', callId: 'read-chat', name: 'read', input: { path: 'src/features/chat/ChatPanel.tsx' }, intent: 'Inspect metadata overlays and Thinking alignment.' },
      { type: 'tool_call', callId: 'overview-graph', name: 'todo_graph', input: { operations: [{ operation: 'replace', nodes: ['baseline', 'protocol', 'dashboard', 'docs', 'unit', 'integration', 'responsive', 'accessibility', 'operations', 'browser', 'supply', 'release'] }] }, intent: 'Plan the implementation and validation work as a dependency graph.' },
      { type: 'tool_call', callId: 'run-focused-tests', name: 'bash', input: { command: 'pnpm vitest run Explorer ChatPanel RuntimeMetrics' }, intent: 'Validate focused production behavior.' },
    ],
  },
  {
    role: 'tool',
    content: [
      { type: 'tool_result', callId: 'read-explorer', ok: true, content: 'Explorer hierarchy inspected. Session title, activity time, and hover actions share a container-query driven row.' },
      { type: 'tool_result', callId: 'read-chat', ok: true, content: 'Chat metadata and Thinking clusters inspected. Overlay geometry can avoid hidden layout slots.' },
      { type: 'tool_result', callId: 'overview-graph', ok: true, content: JSON.stringify({
        version: 1,
        revision: 7,
        nodes: [
          { id: 'baseline', content: 'Map product constraints', status: 'completed', priority: 'high' },
          { id: 'protocol', content: 'Refine runtime contract', status: 'in_progress', priority: 'high' },
          { id: 'dashboard', content: 'Build responsive workspace', status: 'in_progress', priority: 'high' },
          { id: 'docs', content: 'Document operator workflow', status: 'in_progress', priority: 'medium' },
          { id: 'unit', content: 'Verify state invariants', status: 'pending', priority: 'high' },
          { id: 'integration', content: 'Exercise runtime recovery', status: 'pending', priority: 'high' },
          { id: 'responsive', content: 'Run viewport matrix', status: 'pending', priority: 'high' },
          { id: 'accessibility', content: 'Audit keyboard and screen reader UX', status: 'pending', priority: 'medium' },
          { id: 'operations', content: 'Review deployment runbook', status: 'pending', priority: 'medium' },
          { id: 'browser', content: 'Complete browser acceptance', status: 'pending', priority: 'high' },
          { id: 'supply', content: 'Verify release evidence', status: 'pending', priority: 'high' },
          { id: 'release', content: 'Approve production release', status: 'pending', priority: 'high' },
        ],
        edges: [
          { from: 'baseline', to: 'protocol' },
          { from: 'baseline', to: 'dashboard' },
          { from: 'baseline', to: 'docs' },
          { from: 'protocol', to: 'unit' },
          { from: 'protocol', to: 'integration' },
          { from: 'dashboard', to: 'responsive' },
          { from: 'dashboard', to: 'accessibility' },
          { from: 'docs', to: 'operations' },
          { from: 'integration', to: 'browser' },
          { from: 'responsive', to: 'browser' },
          { from: 'accessibility', to: 'browser' },
          { from: 'unit', to: 'supply' },
          { from: 'operations', to: 'supply' },
          { from: 'browser', to: 'release' },
          { from: 'supply', to: 'release' },
        ],
        summary: { total: 12, completed: 1, active: 3, ready: 0, blocked: 8, cancelled: 0 },
        ready: [],
        blocked: [
          { id: 'unit', waitingOn: ['protocol'] },
          { id: 'integration', waitingOn: ['protocol'] },
          { id: 'responsive', waitingOn: ['dashboard'] },
          { id: 'accessibility', waitingOn: ['dashboard'] },
          { id: 'operations', waitingOn: ['docs'] },
          { id: 'browser', waitingOn: ['integration', 'responsive', 'accessibility'] },
          { id: 'supply', waitingOn: ['unit', 'operations'] },
          { id: 'release', waitingOn: ['browser', 'supply'] },
        ],
        changed: ['protocol', 'dashboard', 'docs'],
      }) },
      { type: 'tool_result', callId: 'run-focused-tests', ok: true, content: 'Focused production tests passed in the prototype fixture.' },
    ],
  },
  {
    role: 'assistant',
    content: [{ type: 'text', text: [
      'The sidebar now follows a three-stage responsive rule. At wide widths, the long title is already capped and truncated while the last-activity value remains visible. At the threshold, the activity value disappears first and the title receives that space. At very narrow widths, the title continues truncating without allowing the hover action overlay to participate in grid sizing.',
      '',
      'Message timestamps use overlays instead of invisible flex children. User actions keep the same x-position before and after hover, while assistant completion timing remains a separate semantic control from the timestamp.',
      '',
      'The context usage indicator uses a static track and a clipped fill whose width equals the measured percentage. Only the fill receives the low-contrast active stripe animation, and reduced-motion removes that animation entirely.',
      '',
      'The remaining transcript is intentionally detailed so scrolling can demonstrate the real pinned prompt. No replacement UI is involved: this is the production App with a local mock transport.',
      '',
      'Validation covers metadata geometry, merged Thinking updates, pinned prompt visibility, three Explorer widths, compact statistics, storage inventory, approval, ask-user decisions, and sub-agent lifecycle states.',
    ].join('\n') }],
  },
  {
    role: 'user',
    content: [{ type: 'text', text: 'Keep the final verification focused on the production workbench and preserve the existing interaction hierarchy.' }],
  },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'The focused checks are green. I am delegating one independent review before closing the plan.' },
      { type: 'tool_call', callId: 'overview-agent', name: 'agent', input: { agent_type: 'Explore', intention: 'Review the responsive implementation independently and summarize the strongest evidence.' } },
    ],
  },
  {
    role: 'tool',
    content: [
      { type: 'tool_result', callId: 'overview-agent', ok: true, content: '<sub_agent session_id="prototype-subagent-completed" agent_type="Explore" intention="Review the responsive implementation independently and summarize the strongest evidence." status="completed" turns="4" duration_ms="12600"><result>Responsive hierarchy, tool activity, and pinned prompt behavior are consistent across the focused viewport matrix.</result></sub_agent>' },
    ],
  },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'The independent review confirms the layout contract. I am checking the browser matrix and release evidence before closing the graph.' },
      { type: 'tool_call', callId: 'review-layout-source', name: 'read', input: { path: 'src/features/chat/ChatPanel.tsx' }, intent: 'Confirm the final production transcript and tool-dot layout source.' },
      { type: 'tool_call', callId: 'review-layout-search', name: 'grep', input: { pattern: 'overflow|container', path: 'src/features' }, intent: 'Check the responsive layout guards across the changed feature surfaces.' },
      { type: 'tool_call', callId: 'review-browser-matrix', name: 'bash', input: { command: 'pnpm test:browser -- responsive' }, intent: 'Verify desktop, tablet, and mobile production geometry.' },
      { type: 'tool_call', callId: 'review-accessibility', name: 'bash', input: { command: 'pnpm test:accessibility -- dashboard' }, intent: 'Verify keyboard navigation, labels, focus order, and reduced-motion behavior.' },
      { type: 'tool_call', callId: 'review-production-build', name: 'bash', input: { command: 'pnpm --filter @agent-kernel/dashboard build' }, intent: 'Build the production Dashboard with the verified responsive components.' },
      { type: 'tool_call', callId: 'review-privacy-gate', name: 'bash', input: { command: 'pnpm privacy:check' }, intent: 'Verify that public product evidence contains only fictional fixture data.' },
      { type: 'tool_call', callId: 'review-release-evidence', name: 'read', input: { path: 'release/evidence/verification.json' }, intent: 'Confirm the release evidence records the focused checks.' },
    ],
  },
  {
    role: 'tool',
    content: [
      { type: 'tool_result', callId: 'review-layout-source', ok: true, content: 'The production ChatPanel keeps tool summaries compact while preserving accessible detail on demand.' },
      { type: 'tool_result', callId: 'review-layout-search', ok: true, content: 'Responsive guards cover the transcript, Composer, Explorer, and right-panel boundaries.' },
      { type: 'tool_result', callId: 'review-browser-matrix', ok: true, content: 'Desktop, tablet, and mobile acceptance passed with no horizontal overflow.' },
      { type: 'tool_result', callId: 'review-accessibility', ok: true, content: 'Keyboard, labels, focus order, contrast, and reduced-motion checks passed.' },
      { type: 'tool_result', callId: 'review-production-build', ok: true, content: 'The production Dashboard build completed with the verified component graph.' },
      { type: 'tool_result', callId: 'review-privacy-gate', ok: true, content: 'Privacy verification found only fictional prototype identifiers and public product content.' },
      { type: 'tool_result', callId: 'review-release-evidence', ok: true, content: 'Verification receipt includes unit, browser, accessibility, and supply-chain evidence.' },
    ],
  },
  {
    role: 'assistant',
    content: [{ type: 'text', text: 'The implementation, independent review, responsive matrix, and release evidence are complete. The final release gate is ready for the operator.' }],
  },
]

const askResponses = new Map<string, string[]>()

function askUserPendingCalls(sessionId: string): AgentState['pendingCalls'] {
  const answered = askResponses.get(sessionId)?.length ?? 0
  const calls: AgentState['pendingCalls'] = [
    {
      callId: 'ask-rollout-window',
      name: 'ask_user_choice',
      input: {
        message: 'Which rollout window should the mock plan use?',
        choices: [
          {
            value: 'business-hours',
            label: 'Business hours',
            description: 'Ship while the product and operations teams are online, with immediate monitoring and a staffed rollback path.',
          },
          {
            value: 'maintenance-window',
            label: 'Maintenance window',
            description: 'Use the scheduled low-traffic window so the fictional migration has extra capacity for verification and recovery.',
          },
        ],
        defaultValue: 'business-hours',
      },
      status: 'dispatched',
    },
    {
      callId: 'ask-validation-scope',
      name: 'ask_user_choice',
      input: {
        message: 'Which validation scope should follow the rollout?',
        choices: [
          {
            value: 'focused',
            label: 'Focused component tests',
            description: 'Run the production choice-card and protocol tests first, keeping feedback fast while covering the changed behavior.',
          },
          {
            value: 'browser',
            label: 'Responsive browser matrix',
            description: 'Exercise desktop, narrow sub-agent, and mobile layouts to verify readable descriptions and overflow-safe controls.',
          },
          {
            value: 'prototype',
            label: 'Prototype build verification',
            description: 'Build the isolated prototype and verify its production-component wiring without touching the deployed Dashboard.',
          },
        ],
        multiple: true,
        defaultValues: ['focused', 'browser'],
      },
      status: 'dispatched',
    },
  ]
  return calls.slice(answered)
}

function subAgentMatrixMessages(): Message[] {
  return [
    { role: 'user', content: [{ type: 'text', text: 'Run a realistic parallel review across implementation, tests, accessibility, and failure recovery.' }] },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'I will map and verify the production surfaces first, then coordinate independent reviews while keeping every lifecycle visible.' },
        { type: 'tool_call', callId: 'agent-read-contract', name: 'read', input: { path: 'src/features/chat/SubAgentCard.tsx' }, intent: 'Inspect the production sub-agent lifecycle contract before delegation.' },
        { type: 'tool_call', callId: 'agent-search-statuses', name: 'grep', input: { pattern: 'running|completed|failed|cancelled|pending', path: 'src/features/chat' }, intent: 'Confirm every delegated lifecycle has a production rendering path.' },
        { type: 'tool_call', callId: 'agent-test-matrix', name: 'bash', input: { command: 'pnpm vitest run SubAgentCard' }, intent: 'Verify the focused lifecycle matrix before launching delegated work.' },
        { type: 'tool_call', callId: 'agent-check-layout', name: 'bash', input: { command: 'pnpm verify:subagent-scroll' }, intent: 'Verify nested activity remains usable at compact viewport widths.' },
        { type: 'tool_call', callId: 'agent-read-protocol', name: 'read', input: { path: 'docs/host/sub-agent-design.md' }, intent: 'Confirm parent-child lifecycle and cancellation semantics.' },
        { type: 'tool_call', callId: 'agent-build-dashboard', name: 'bash', input: { command: 'pnpm --filter @agent-kernel/dashboard build' }, intent: 'Build the production delegated-work surfaces.' },
        { type: 'tool_call', callId: 'agent-privacy-check', name: 'bash', input: { command: 'pnpm privacy:check' }, intent: 'Verify the lifecycle fixture contains no private data.' },
      ],
    },
    {
      role: 'tool',
      content: [
        { type: 'tool_result', callId: 'agent-read-contract', ok: true, content: 'The production card supports running, completed, failed, cancelled, idle, and pending delegated work.' },
        { type: 'tool_result', callId: 'agent-search-statuses', ok: true, content: 'Every lifecycle maps to a visible label, timing state, and inspectable nested transcript.' },
        { type: 'tool_result', callId: 'agent-test-matrix', ok: true, content: 'The focused sub-agent lifecycle matrix passed.' },
        { type: 'tool_result', callId: 'agent-check-layout', ok: true, content: 'Nested activity remained readable and scrollable across the compact viewport matrix.' },
        { type: 'tool_result', callId: 'agent-read-protocol', ok: true, content: 'Parent-child ownership, completion, failure, cancellation, and pending states are explicit.' },
        { type: 'tool_result', callId: 'agent-build-dashboard', ok: true, content: 'The production Dashboard build completed.' },
        { type: 'tool_result', callId: 'agent-privacy-check', ok: true, content: 'The fixture contains only fictional product data.' },
      ],
    },
    { role: 'user', content: [{ type: 'text', text: 'Keep every delegated lifecycle visible together so I can compare running, completed, failed, cancelled, and pending work.' }] },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Starting a mixed lifecycle matrix with long intentions and nested production transcripts.' },
        { type: 'tool_call', callId: 'agent-running', name: 'agent', input: { agent_type: 'Explore', intention: 'Inspect responsive geometry across wide, threshold, and very narrow Explorer widths while collecting exact DOM measurements and nested tool evidence.' } },
        { type: 'tool_call', callId: 'agent-completed', name: 'agent', input: { agent_type: 'Task', intention: 'Run focused production tests and summarize the stable assertions.' } },
        { type: 'tool_call', callId: 'agent-failed', name: 'agent', input: { agent_type: 'Task', intention: 'Probe a deliberately unavailable fictional service and report the controlled failure.' } },
        { type: 'tool_call', callId: 'agent-cancelled', name: 'agent', input: { agent_type: 'Research', intention: 'Collect optional comparison notes until the parent cancels the nonessential work.' } },
        { type: 'tool_call', callId: 'agent-pending', name: 'agent', input: { agent_type: 'Explore', intention: 'Wait for capacity before beginning an additional accessibility pass.' } },
      ],
    },
    {
      role: 'tool',
      content: [
        { type: 'tool_result', callId: 'agent-completed', ok: true, content: '<sub_agent session_id="prototype-subagent-completed" agent_type="Task" intention="Run focused production tests and summarize the stable assertions." status="completed" turns="6" duration_ms="18400"><result>Focused Explorer, ChatPanel, and RuntimeMetrics checks passed.</result></sub_agent>' },
        { type: 'tool_result', callId: 'agent-failed', ok: false, content: '<sub_agent session_id="prototype-subagent-failed" agent_type="Task" intention="Probe a deliberately unavailable fictional service and report the controlled failure." status="failed" turns="3" duration_ms="7200"><error>Fictional service returned a controlled unavailable response.</error></sub_agent>' },
        { type: 'tool_result', callId: 'agent-cancelled', ok: false, content: '<sub_agent session_id="prototype-subagent-cancelled" agent_type="Research" intention="Collect optional comparison notes until the parent cancels the nonessential work." status="cancelled" turns="2" duration_ms="4100"><error>Cancelled by parent after sufficient evidence was collected.</error></sub_agent>' },
      ],
    },
  ]
}

function messageCursor(messages: readonly Message[]): number {
  return messages.reduce((cursor, message) => cursor + 1 + (message.role === 'tool'
    ? message.content.filter((content) => content.type === 'tool_result').length
    : 0), 0)
}

function stateFor(sessionId: string): AgentState {
  const base = createInitialState({ sessionId })
  if (sessionId === 'prototype-workstream') {
    return { ...base, messages: workstreamMessages, cursor: messageCursor(workstreamMessages), status: 'done', pendingCalls: [] } as AgentState
  }
  if (sessionId === 'prototype-workstream-review') {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: '独立检查对象引用和消息确认之间的丢失窗口。' }] },
      { role: 'assistant', content: [{ type: 'tool_call', callId: 'review-source', name: 'read_file', input: { path: 'src/storage/message-queue.ts' }, intent: '检查提交顺序和对象过期条件' }] },
      { role: 'tool', content: [{ type: 'tool_result', callId: 'review-source', ok: true, content: '消息先持久化，对象引用稍后提交；待提交对象仍会过期。' }] },
      { role: 'assistant', content: [{ type: 'text', text: '建议先保护对象引用，再确认消息；跨副本清理仍需要数据库围栏。' }] },
    ]
    return { ...base, messages, cursor: messageCursor(messages), status: 'done', pendingCalls: [] } as AgentState
  }
  if (sessionId === 'prototype-subagent-running') {
    return {
      ...base,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Inspect responsive geometry and collect nested evidence.' }] },
        {
          role: 'assistant',
          content: [
            { type: 'tool_call', callId: 'nested-read', name: 'read_file', input: { path: 'src/orders/retry-policy.ts' }, intent: 'Inspect the retry budget calculation before running focused checks.' },
            { type: 'tool_call', callId: 'nested-search', name: 'grep', input: { pattern: 'retry budget', path: 'src/orders' }, intent: 'Find every retry-budget branch that needs responsive evidence.' },
          ],
        },
        {
          role: 'tool',
          content: [
            { type: 'tool_result', callId: 'nested-read', ok: true, content: 'Read retry-policy.ts: exponential backoff is capped at 4 attempts and records the remaining retry budget.' },
            { type: 'tool_result', callId: 'nested-search', ok: true, content: 'Found 3 retry budget references in retry-policy.ts and retry-policy.test.ts; no unrelated matches.' },
          ],
        },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', text: 'The source and matching tests are understood. Running the focused retry-policy test now.' },
            { type: 'tool_call', callId: 'nested-test', name: 'bash', input: { command: 'pnpm test retry-policy' }, intent: 'Run the focused retry-policy suite and capture the remaining failure evidence.' },
          ],
        },
      ],
      cursor: 5,
      status: 'executing_tools',
      pendingCalls: [{ callId: 'nested-test', name: 'bash', input: { command: 'pnpm test retry-policy' }, intent: 'Run the focused retry-policy suite and capture the remaining failure evidence.', status: 'dispatched' }],
    } as AgentState
  }
  if (sessionId === 'prototype-subagent-completed') {
    return {
      ...base,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Review the retry policy, apply the bounded-attempt fix, and verify it.' }] },
        {
          role: 'assistant',
          content: [
            { type: 'tool_call', callId: 'completed-read', name: 'read_file', input: { path: 'src/orders/retry-policy.ts' }, intent: 'Read the current retry policy before editing.' },
            { type: 'tool_call', callId: 'completed-grep', name: 'grep', input: { pattern: 'retry budget', path: 'src/orders' }, intent: 'Locate focused retry-budget tests and call sites.' },
          ],
        },
        {
          role: 'tool',
          content: [
            { type: 'tool_result', callId: 'completed-read', ok: true, content: 'The policy allowed one extra attempt after the retry budget reached zero.' },
            { type: 'tool_result', callId: 'completed-grep', ok: true, content: 'Found the policy and 4 focused assertions in src/orders/retry-policy.test.ts.' },
          ],
        },
        {
          role: 'assistant',
          content: [
            { type: 'tool_call', callId: 'completed-patch', name: 'apply_file_patch', input: { path: 'src/orders/retry-policy.ts', patch: 'Stop retrying when remainingBudget <= 0.' }, intent: 'Apply the bounded-attempt guard without changing backoff timing.' },
            { type: 'tool_call', callId: 'completed-test', name: 'bash', input: { command: 'pnpm test retry-policy' }, intent: 'Verify the retry policy and its edge cases.' },
          ],
        },
        {
          role: 'tool',
          content: [
            { type: 'tool_result', callId: 'completed-patch', ok: true, content: 'Updated retry-policy.ts with a zero-budget terminal guard; 3 lines changed.' },
            { type: 'tool_result', callId: 'completed-test', ok: true, content: 'retry-policy: 12 tests passed, including zero budget and maximum-attempt coverage.' },
          ],
        },
        { role: 'assistant', content: [{ type: 'text', text: 'Completed the bounded retry fix and verified all 12 focused tests.' }] },
      ],
      cursor: 9,
      status: 'done',
      pendingCalls: [],
    } as AgentState
  }
  if (sessionId === 'prototype-subagent-failed') {
    return {
      ...base,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Run the retry integration fixture and report a controlled failure.' }] },
        {
          role: 'assistant',
          content: [
            { type: 'tool_call', callId: 'failed-read', name: 'read_file', input: { path: 'src/orders/retry-policy.integration.test.ts' }, intent: 'Inspect the fictional integration fixture and expected endpoint.' },
            { type: 'tool_call', callId: 'failed-test', name: 'bash', input: { command: 'pnpm test retry-policy.integration' }, intent: 'Run the integration fixture and preserve the exact failure summary.' },
          ],
        },
        {
          role: 'tool',
          content: [
            { type: 'tool_result', callId: 'failed-read', ok: true, content: 'Fixture expects the placeholder endpoint http://orders.invalid.test/retry to return 200.' },
            { type: 'tool_result', callId: 'failed-test', ok: false, content: 'FAILED: retry-policy.integration timed out after 5s because the fictional orders fixture was unavailable; no files were changed.' },
          ],
        },
      ],
      cursor: 5,
      status: 'error',
      pendingCalls: [],
    } as AgentState
  }
  if (sessionId === 'prototype-subagent-cancelled') {
    return {
      ...base,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Collect optional retry-policy comparison evidence until the parent has enough.' }] },
        {
          role: 'assistant',
          content: [
            { type: 'tool_call', callId: 'cancelled-read', name: 'read_file', input: { path: 'docs/retry-guidelines.md' }, intent: 'Read the documented retry constraints for comparison.' },
            { type: 'tool_call', callId: 'cancelled-grep', name: 'grep', input: { pattern: 'maximum attempts', path: 'docs' }, intent: 'Find the documented maximum-attempt guidance.' },
          ],
        },
        {
          role: 'tool',
          content: [
            { type: 'tool_result', callId: 'cancelled-read', ok: true, content: 'Guidelines recommend bounded retries, jittered backoff, and explicit terminal errors.' },
            { type: 'tool_result', callId: 'cancelled-grep', ok: true, content: 'Found 2 relevant maximum-attempt references; both agree with the implemented four-attempt cap.' },
          ],
        },
        { role: 'assistant', content: [{ type: 'text', text: 'The useful comparison evidence is recorded. Remaining optional research was cancelled by the parent.' }] },
      ],
      cursor: 6,
      status: 'done',
      pendingCalls: [],
    } as AgentState
  }
  if (sessionId === 'prototype-chapters') {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: '请分析工作台的信息层级，并按主题说明各部分的取舍。' }] },
      { role: 'assistant', content: [{ type: 'text', text: [
        '我按使用顺序梳理了工作台的改版建议。你可以逐章阅读，也可以查看完整回复。',
        '',
        '## 确定阅读目标',
        '',
        '这次改版的重点不是让所有页面看起来一样，而是让第一次进入工作区的人知道：**现在在哪里、下一步能做什么、怎样回到刚才的工作。**',
        '',
        '目前首页同时呈现最近对话、工作区列表和操作入口，但三者视觉权重接近。用户需要逐项读完，才能找到要继续的事情。可以先让“继续工作”成为最容易识别的动作，再让其他入口服务于查找。',
        '',
        '> 先调整信息层级，再决定是否增加新的导航控件。',
        '',
        '```typescript',
        'const nextStep = choosePrimaryAction(workspace)',
        '```',
        '',
        '对于初次进入的人，最近一次工作应有明确的时间、工作区归属和继续入口；对于回访的人，则要保留找到其他对话的可靠路径。两种任务的优先级不同，因此不能把所有信息平铺成同等大小的卡片。把主要动作放在稳定的位置，能减少每次切换工作区时重新辨认界面的负担。',
        '',
        '例如返回昨天的工作时，用户先要确认自己仍在正确的对话，然后才是阅读上次留下的结论；如果工作区名称、会话标题与最后活动时间分别出现在相距很远的位置，这一步就需要反复来回查看。将这些信息放在相邻区域，并突出唯一的继续入口，才能避免信息虽然完整却难以使用的问题。设计评估时应让真实任务贯穿从打开、定位到继续输入的全过程，而不是只看首页的一张静态截图。',
        '',
        '## 将信息分成三个层次',
        '',
        '建议用用户的决策顺序组织页面，而不是用数据来源组织页面：',
        '',
        '1. **继续当前工作。** 在最显眼的位置呈现最近活跃的对话，并让工作区名称作为明确的上下文。',
        '2. **找到其他工作。** 历史对话和工作区可以在同一导航区域查找，但不要让它们与当前对话争夺注意力。',
        '3. **查看辅助信息。** 文件、运行记录和设置仍然可用，但不应该打断正在阅读的回复。',
        '',
        '这样，打开页面时先有清晰的起点；需要追溯时再逐层展开。这不是把信息藏起来，而是减少用户每次都要重复做的判断。',
        '',
        '### 为什么不直接增加顶栏？',
        '',
        '新增顶栏会改变工作台的垂直空间，也让移动端多一层需要收起的导航。现有侧栏已有位置承载入口，优先复用它更稳妥。',
        '',
        '目录和章节切换属于这条回复本身，而不是全局的工作区导航；因此它们应贴在消息内部。用户可以在章节开头查找结构，也能在结尾顺手进入下一章，不必滚回页面顶部。对于只有一两段的答复，保留原样更利于阅读，不应该为了展示导航而强行分段。',
        '',
        '在长回复里，用户经常不是从第一行读到最后一行，而是先看结论、再回到证据或者操作步骤。目录提供一个粗粒度索引，标题给出各段的主题；上一章和下一章则服务于顺序阅读。两种入口相辅相成，不必用重复的标题和说明占据消息空间。保留连续阅读选项也很重要：需要全文查找、复制或比较相邻章节时，可以直接查看完整回复，而不是逐页切换。',
        '',
        '## 处理不同屏幕的边界',
        '',
        '桌面端可以让工作区导航与对话并排显示；窄屏则应让对话始终是主要区域，其他面板按需打开。两端沿用同一套信息优先级。',
        '',
        '| 场景 | 默认展示 | 按需展开 |',
        '| --- | --- | --- |',
        '| 桌面 | 对话与当前工作区 | 文件、历史记录 |',
        '| 手机 | 对话与输入区 | 工作区导航、详情 |',
        '',
        '特别要检查长回复里的代码块、表格和操作按钮：切换章节不能截断它们，也不能把等待处理的工具审批藏到另一页。',
        '',
        '窄屏的正文宽度会让同一段话占据更多行，但章节身份应由内容结构决定，而不是随着手机横竖屏变化不断重排。阅读位置应尽量保持稳定，用户从桌面转到手机后仍能在目录中识别同一个主题。特别长的章节可在完整段落或者下级标题处断开，而不能截取固定字数。',
        '',
        '页面高度仍可能因字体、缩放、窗口尺寸和代码块折行产生很大差异。与其追求每页完全一样长，不如设置宽松的上限和下限：很短的内容附在相邻主题里，超长内容只在独立的结构单元之间断开。若一个代码块本身超过一屏，就允许那一页变长，也不能把代码从中间切断。这样分段虽然不是数学意义上的等长，却让用户始终能够在完整的上下文里理解内容。',
        '',
        '## 验证与交付顺序',
        '',
        '先在虚构会话里确认桌面和手机端的布局、切换动作与目录可发现性。再用真实的 Markdown 渲染器检查标题、列表、表格和长代码块。',
        '',
        '- 没有标题或内容较短的回复仍保持连续阅读；',
        '- 搜索命中其他章节时，先切换再定位；',
        '- 复制得到完整回复，而不仅是当前章节；',
        '- 生成中的回复不随着新标题不断切页。',
        '',
        '最后要分别检查成功完成、工具中断以及正在生成中的对话。只有完整完成的长篇文字才提供稳定的章节目录；进行中的消息始终按原来的流式方式显示，避免内容增长时页码跳来跳去。历史搜索需要能够访问隐藏章节，整条回复的复制仍应保留全部原始文本。',
        '',
        '这一步还应在不同的屏幕尺寸下重复进行，并检查对话切换和返回时的状态。如果分页控件只有在宽屏能被发现，或者切换后把读者带回错误的位置，这项设计就没有真正解决长回复难以浏览的问题。与其依靠静态效果图，最好让同一份 Mock 会话经过实际的消息列表、Markdown 渲染器与输入区，再逐项验证目录、页脚按钮、滚动行为和复制操作。',
        '',
        '完成这些验证后，再把章节导航接入实际消息列表。',
      ].join('\n') }] },
    ]
    return { ...base, messages, cursor: messageCursor(messages), status: 'done', pendingCalls: [] } as AgentState
  }
  if (sessionId === 'prototype-active') {
    return { ...base, messages: activeMessages, cursor: messageCursor(activeMessages), status: 'thinking', pendingCalls: [] } as AgentState
  }
  if (sessionId === 'prototype-attention') {
    return {
      ...base,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Apply the reviewed retry guard and update the focused tests.' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'The patch is ready and requires approval before the fictional file is changed.' }] },
      ],
      cursor: 2,
      status: 'awaiting_approval',
      pendingCalls: [{
        callId: 'approval-retry-guard',
        name: 'apply_file_patch',
        input: {
          path: 'src/payments/retry-policy.ts',
          intent: 'Apply the reviewed retry guard and update focused tests',
          patch: '*** Update File: src/payments/retry-policy.ts\n@@ retryPayment\n- return retry(request)\n+ if (attempt >= maxAttempts) return terminalFailure(request)\n+ return retry(request)',
        },
        status: 'awaiting_approval',
      }],
    } as AgentState
  }
  if (sessionId === 'prototype-ask-user') {
    const pendingCalls = askUserPendingCalls(sessionId)
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'Prepare the production rollout for the retry-policy change. Inspect the current runbook and tests, identify the safe window, and stop for decisions that require an operator.' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'I will gather the rollout, recovery, and verification evidence before asking for decisions that belong to you.' }] },
      { role: 'user', content: [{ type: 'text', text: 'Keep rollout timing and validation depth as explicit operator-owned choices.' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', text: 'I will inspect the deployment contract and focused recovery tests before asking for operator-owned choices.' },
          { type: 'tool_call', callId: 'ask-read-runbook', name: 'read', input: { path: 'docs/operations/retry-policy-rollout.md' }, intent: 'Read the rollout and rollback contract.' },
          { type: 'tool_call', callId: 'ask-search-checkpoints', name: 'grep', input: { pattern: 'checkpoint|rollback|observation', path: 'docs/operations' }, intent: 'Locate every operator-owned rollout checkpoint.' },
          { type: 'tool_call', callId: 'ask-run-tests', name: 'bash', input: { command: 'pnpm test retry-policy recovery' }, intent: 'Verify retry behavior and recovery before choosing a window.' },
          { type: 'tool_call', callId: 'ask-build-dashboard', name: 'bash', input: { command: 'pnpm --filter @agent-kernel/dashboard build' }, intent: 'Build the production decision workflow before presenting choices.' },
          { type: 'tool_call', callId: 'ask-check-accessibility', name: 'bash', input: { command: 'pnpm test:accessibility -- ask-user' }, intent: 'Verify choice labels, descriptions, focus order, and keyboard submission.' },
          { type: 'tool_call', callId: 'ask-read-evidence', name: 'read', input: { path: 'release/evidence/verification.json' }, intent: 'Confirm the rollout evidence is bound to the reviewed revision.' },
          { type: 'tool_call', callId: 'ask-privacy-check', name: 'bash', input: { command: 'pnpm privacy:check' }, intent: 'Verify the operator decision fixture contains no private data.' },
        ],
      },
      {
        role: 'tool',
        content: [
          { type: 'tool_result', callId: 'ask-read-runbook', ok: true, content: 'Runbook requires a staffed rollback window, two healthy checkpoints, and ten minutes of error-rate observation.' },
          { type: 'tool_result', callId: 'ask-search-checkpoints', ok: true, content: 'Found the readiness, cutover, observation, and rollback decision boundaries.' },
          { type: 'tool_result', callId: 'ask-run-tests', ok: true, content: 'retry-policy and recovery: 28 focused tests passed; rollback fixture restored the previous route generation.' },
          { type: 'tool_result', callId: 'ask-build-dashboard', ok: true, content: 'The production Dashboard decision workflow built successfully.' },
          { type: 'tool_result', callId: 'ask-check-accessibility', ok: true, content: 'Choice descriptions, focus order, and keyboard submission checks passed.' },
          { type: 'tool_result', callId: 'ask-read-evidence', ok: true, content: 'Release evidence contains the focused recovery and browser receipts.' },
          { type: 'tool_result', callId: 'ask-privacy-check', ok: true, content: 'The fixture contains only fictional product data.' },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'The implementation and rollback evidence are ready. I need the operator to choose the rollout window and validation depth before proceeding.' }] },
    ]
    return {
      ...base,
      messages,
      cursor: messageCursor(messages) + (askResponses.get(sessionId)?.length ?? 0),
      status: pendingCalls.length > 0 ? 'executing_tools' : 'done',
      pendingCalls,
    } as AgentState
  }
  if (sessionId === 'prototype-subagents') {
    const messages = subAgentMatrixMessages()
    return {
      ...base,
      messages,
      cursor: messageCursor(messages),
      status: 'executing_tools',
      pendingCalls: [
        { callId: 'agent-running', name: 'agent', input: {}, status: 'dispatched' },
        { callId: 'agent-pending', name: 'agent', input: {}, status: 'pending_approval' },
      ],
    } as AgentState
  }
  return {
    ...base,
    messages: [
      { role: 'user', content: [{ type: 'text', text: sessions.find((session) => session.sessionId === sessionId)?.firstUserMessage ?? 'Placeholder request.' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'This is clearly marked placeholder content rendered by the production ChatPanel.' }] },
    ],
    cursor: 2,
    status: 'done',
    pendingCalls: [],
  } as AgentState
}

function historyFor(sessionId: string): EventAppendedEvent[] {
  const messages = stateFor(sessionId).messages.filter((message) => message.role !== 'system')
  let seq = 0
  const entries: EventAppendedEvent[] = []
  for (const message of messages) {
    seq += 1
    if (message.role === 'user') {
      entries.push({ sessionId, seq, ts: iso(-12 + seq), event: { kind: 'user_message', content: message.content }, effects: [] })
    } else if (message.role === 'assistant') {
      entries.push({ sessionId, seq, ts: iso(-12 + seq), event: { kind: 'llm_response', message }, effects: [] })
    } else if (message.role === 'tool') {
      for (const content of message.content) {
        if (content.type !== 'tool_result') continue
        seq += 1
        entries.push({ sessionId, seq, ts: iso(-12 + seq), event: { kind: 'tool_result', callId: content.callId, ok: content.ok, content: content.content }, effects: [] })
      }
    }
  }
  return entries
}

function readyFor(sessionId: string): SessionReadyEvent {
  const summary = sessions.find((candidate) => candidate.sessionId === sessionId)
  const state = stateFor(sessionId)
  const contextInputTokens = sessionId === 'prototype-subagents'
    ? 260_000
    : sessionId === 'prototype-active'
      ? 220_000
      : sessionId === 'prototype-ask-user'
        ? 180_000
        : 12_345
  return {
    sessionId,
    agentRuntime: 'kernel',
    executionMode: 'chat',
    agentRuntimeCapabilities: KERNEL_AGENT_RUNTIME_CAPABILITIES,
    cursor: state.cursor,
    state,
    config: { systemPrompt: 'Prototype placeholder system prompt.', tools: [] },
    contextSnapshot: {
      model: { ref: 'openai:gpt-5.6', id: 'gpt-5.6', provider: 'openai' },
      contextWindow: { tokens: 1_000_000, source: 'model_registry' },
      usage: { inputTokens: contextInputTokens, totalTokens: contextInputTokens },
      breakdown: { system: 2_400, transcript: Math.max(8_000, contextInputTokens - 9_000), tools: 5_000, memory: 1_000, attachments: 600, pendingUserInput: 0 },
      estimator: { total: { kind: 'heuristic', confidence: 'estimated' }, breakdown: { kind: 'heuristic', confidence: 'estimated' }, version: 'prototype-placeholder-v1' },
      updatedAt: Date.now(),
    },
    reason: 'load',
    ...(summary?.parentSessionId ? { parentSessionId: summary.parentSessionId, parentCursor: 7, parentCallId: 'agent-running', agentType: 'Explore' } : {}),
    ...(summary?.workspaceId ? { workspaceId: summary.workspaceId, workspaceName: summary.workspaceName } : {}),
    selectedModel: 'openai:gpt-5.6',
  }
}

class PrototypeDashboardSocket {
  connected = true
  active = true
  id = 'prototype-dashboard-socket'
  io = { on: () => this.io, off: () => this.io }
  private handlers = new Map<string, Set<Handler>>()

  on(event: string, handler: Handler): this {
    const handlers = this.handlers.get(event) ?? new Set<Handler>()
    handlers.add(handler)
    this.handlers.set(event, handlers)
    return this
  }

  off(event: string, handler?: Handler): this {
    if (!handler) this.handlers.delete(event)
    else this.handlers.get(event)?.delete(handler)
    return this
  }

  connect(): this {
    this.connected = true
    queueMicrotask(() => this.serverEmit('connect'))
    return this
  }

  close(): this {
    this.connected = false
    return this
  }

  disconnect(): this {
    this.connected = false
    return this
  }

  timeout(): { emit: (event: string, ...args: unknown[]) => void; emitWithAck: (event: string, payload: unknown) => Promise<unknown> } {
    return {
      emit: (event, ...args) => {
        const callback = args.at(-1)
        if (event === 'client:connection_ping' && typeof callback === 'function') callback(null, Date.now())
        else if (event === 'client:executor_ping' && typeof callback === 'function') callback(null, { rttMs: 7 })
        else this.emit(event, ...args)
      },
      emitWithAck: (event, payload) => new Promise((resolve) => {
        this.emit(event, payload, resolve)
      }),
    }
  }

  emit(event: string, ...args: unknown[]): this {
    const payload = args[0] as PrototypeClientPayload
    const ack = typeof args.at(-1) === 'function' ? args.at(-1) as Handler : undefined

    if (event === 'client:subscribe_channels' || event === 'client:restore_subscriptions' || event === 'client:refresh_channels') {
      const channels = payload.channels as DashboardChannel[]
      const result: ChannelSubscriptionResult = {
        requestId: payload.requestId,
        generation: payload.generation,
        accepted: channels,
        rejected: [],
        cursors: Object.fromEntries(channels.map((channel) => [channel, channel.startsWith('session:') ? stateFor(channel.slice(8)).cursor : 0])),
      }
      ack?.(result)
      window.setTimeout(() => this.publishChannels(channels), 0)
      return this
    }
    if (event === 'client:unsubscribe_channels') {
      ack?.({ requestId: payload.requestId, generation: payload.generation, accepted: payload.channels, rejected: [], cursors: {} })
      return this
    }
    if (event === 'client:list_executors') {
      queueMicrotask(() => this.serverEmit('server:executors', { executors }))
      return this
    }
    if (event === 'client:list_sessions') {
      queueMicrotask(() => this.serverEmit('server:sessions', { sessions }))
      return this
    }
    if (event === 'client:list_dirs') {
      const session = sessions.find((candidate) => candidate.workspaceId === payload.workspaceId)
      const root = session?.currentCwd ?? '/workspace'
      const path = payload.path ?? root
      const entries = path === root
        ? [
            { name: '.github', path: `${root}/.github`, type: 'directory' as const },
            { name: 'deploy', path: `${root}/deploy`, type: 'directory' as const },
            { name: 'docs', path: `${root}/docs`, type: 'directory' as const },
            { name: 'packages', path: `${root}/packages`, type: 'directory' as const },
            { name: 'scripts', path: `${root}/scripts`, type: 'directory' as const },
            { name: 'tests', path: `${root}/tests`, type: 'directory' as const },
            { name: 'package.json', path: `${root}/package.json`, type: 'file' as const, size: 4_812 },
            { name: 'pnpm-workspace.yaml', path: `${root}/pnpm-workspace.yaml`, type: 'file' as const, size: 1_284 },
            { name: 'README.md', path: `${root}/README.md`, type: 'file' as const, size: 12_640 },
          ]
        : path === `${root}/packages`
          ? [
              { name: 'dashboard', path: `${path}/dashboard`, type: 'directory' as const },
              { name: 'executor', path: `${path}/executor`, type: 'directory' as const },
              { name: 'host', path: `${path}/host`, type: 'directory' as const },
              { name: 'protocol', path: `${path}/protocol`, type: 'directory' as const },
            ]
        : [
            { name: 'src', path: `${path}/src`, type: 'directory' as const },
            { name: 'package.json', path: `${path}/package.json`, type: 'file' as const, size: 2_418 },
            { name: 'tsconfig.json', path: `${path}/tsconfig.json`, type: 'file' as const, size: 912 },
          ]
      const result = { requestId: payload.requestId, workspaceId: payload.workspaceId, path, roots: [root], entries }
      ack?.(result)
      queueMicrotask(() => this.serverEmit('server:dir_list', result))
      return this
    }
    if (event === 'client:list_files') {
      const session = sessions.find((candidate) => candidate.workspaceId === payload.workspaceId)
      const root = session?.currentCwd ?? '/workspace'
      queueMicrotask(() => this.serverEmit('server:file_list', {
        requestId: payload.requestId,
        workspaceId: payload.workspaceId,
        files: [
          { path: `${root}/packages/dashboard/src/app.tsx`, size: 128_406 },
          { path: `${root}/packages/dashboard/src/features/chat/Composer.tsx`, size: 54_812 },
          { path: `${root}/packages/host/src/runtime.ts`, size: 38_240 },
          { path: `${root}/packages/executor/src/executor.ts`, size: 24_116 },
          { path: `${root}/packages/protocol/src/events.ts`, size: 18_904 },
          { path: `${root}/docs/architecture/overview.md`, size: 22_731 },
          { path: `${root}/scripts/release/build-release-assets.mjs`, size: 16_508 },
          { path: `${root}/package.json`, size: 4_812 },
        ],
      }))
      return this
    }
    if (event === 'client:load_history') {
      const entries = historyFor(payload.sessionId)
      queueMicrotask(() => this.serverEmit('server:history', { sessionId: payload.sessionId, entries }))
      return this
    }
    if (event === 'client:get_session_storage') {
      const billionFixture = payload.sessionId === 'prototype-usage' || payload.sessionId === 'prototype-active'
      ack?.({
        ok: true,
        value: {
          session: { sessionId: payload.sessionId, directBytes: 128_000, treeBytes: 512_000, descendantCount: 1, categories: {}, treeCategories: {} },
          descendants: [{ sessionId: 'prototype-subagent-running', parentSessionId: payload.sessionId, directBytes: 384_000, treeBytes: 384_000, descendantCount: 0, categories: {}, treeCategories: {} }],
          tokenUsage: {
            direct: { currentContextTokens: 12_350, cumulativeInputTokens: 1_250_000, cumulativeOutputTokens: 12_345, cacheCreationTokens: 0, cacheReadTokens: billionFixture ? 2_400_000_000 : 0, sessionCount: 1 },
            tree: { currentContextTokens: 1_250_000, cumulativeInputTokens: billionFixture ? 2_400_000_000 : 2_400_000, cumulativeOutputTokens: 12_345_678, cacheCreationTokens: 0, cacheReadTokens: 0, sessionCount: 2 },
          },
          state: { measuredAt: iso(0) },
        },
      })
      return this
    }
    if (event === 'client:get_global_storage') {
      ack?.({
        ok: true,
        value: {
          totalBytes: 18_874_368,
          totalFiles: 248,
          categories: {
            jsonl: { bytes: 8_388_608, files: 72 },
            snapshot: { bytes: 3_145_728, files: 41 },
            summary: { bytes: 1_048_576, files: 19 },
            context: { bytes: 2_097_152, files: 28 },
            artifacts: { bytes: 3_670_016, files: 82 },
            'orphan-artifacts': { bytes: 524_288, files: 5 },
            corrupt: { bytes: 1_024, files: 1 },
          },
          largestSessionTrees: [
            { sessionId: 'prototype-subagents', sessionLabel: 'Review responsive behavior', workspaceId: 'workspace-labs', workspaceName: 'Research Lab', directBytes: 2_097_152, treeBytes: 6_291_456, descendantCount: 5, categories: {}, treeCategories: {} },
            { sessionId: 'prototype-active', sessionLabel: 'Refine the dashboard layout', workspaceId: 'workspace-studio', workspaceName: 'Product Studio', directBytes: 3_145_728, treeBytes: 3_670_016, descendantCount: 0, categories: {}, treeCategories: {} },
            { sessionId: 'prototype-usage', sessionLabel: 'Inspect usage history', workspaceId: 'workspace-windows', workspaceName: 'Windows QA', directBytes: 1_048_576, treeBytes: 1_572_864, descendantCount: 0, categories: {}, treeCategories: {} },
          ],
          orphanCandidates: [
            { id: 'mock-artifacts-unattached-001', category: 'orphan-artifacts', bytes: 524_288, files: 5 },
            { id: 'mock-corrupt-record-001', category: 'corrupt', bytes: 1_024, files: 1 },
          ],
          state: { measuredAt: iso(0), generation: 3, stale: false, scan: { status: 'idle' } },
        },
      })
      return this
    }
    if (event === 'client:prepare_storage_cleanup') {
      ack?.({
        ok: true,
        value: {
          planId: '00000000-0000-4000-8000-000000000000',
          operation: payload.operation,
          targetId: payload.targetId,
          sessionIds: [],
          estimatedBytes: 524_288,
          itemCount: 6,
          expiresAt: iso(5),
        },
      })
      return this
    }
    if (event === 'client:execute_storage_cleanup') {
      ack?.({ ok: true, value: { planId: payload.planId, operation: 'orphan-artifacts', targetId: 'mock-artifacts-unattached-001', logicalDeletion: true, bytesQuarantined: 524_288, completedAt: iso(0) } })
      return this
    }
    if (event === 'client:update_preferences') {
      const session = sessions.find((candidate) => candidate.sessionId === payload.sessionId)
      if (session) session.preferences = { ...session.preferences, ...payload.preferences }
      ack?.({ ok: true })
      queueMicrotask(() => this.serverEmit('server:control_update', { kind: 'session_meta_changed', sessionId: payload.sessionId, preferences: payload.preferences }))
      return this
    }
    if (event === 'client:rename_session') {
      const session = sessions.find((candidate) => candidate.sessionId === payload.sessionId)
      if (session) session.label = payload.label
      ack?.({ ok: true, value: payload.label })
      queueMicrotask(() => this.serverEmit('server:control_update', { kind: 'session_meta_changed', sessionId: payload.sessionId, label: payload.label }))
      return this
    }
    if (event === 'client:rename_workspace') {
      for (const session of sessions) if (session.workspaceId === payload.workspaceId) session.workspaceName = payload.workspaceName
      const executor = executors.find((candidate) => candidate.workspaceId === payload.workspaceId)
      if (executor) executor.workspaceName = payload.workspaceName
      ack?.({ ok: true, value: payload.workspaceName })
      queueMicrotask(() => this.serverEmit('server:control_update', { kind: 'workspace_meta_changed', workspaceId: payload.workspaceId, workspaceName: payload.workspaceName }))
      return this
    }
    if (event === 'client:delete_session') {
      const index = sessions.findIndex((candidate) => candidate.sessionId === payload.sessionId)
      if (index >= 0) sessions.splice(index, 1)
      ack?.({ ok: true })
      queueMicrotask(() => this.serverEmit('server:session_deleted', { sessionId: payload.sessionId }))
      return this
    }
    if (event === 'client:ask_user_choice') {
      const responses = askResponses.get(payload.sessionId) ?? []
      responses.push(payload.value ?? payload.values?.join(',') ?? payload.customText ?? 'response')
      askResponses.set(payload.sessionId, responses)
      ack?.({ ok: true })
      queueMicrotask(() => this.serverEmit('state:changed', {
        sessionId: payload.sessionId,
        cursor: stateFor(payload.sessionId).cursor,
        state: stateFor(payload.sessionId),
      }))
      return this
    }
    if (event === 'sub_agent:list') {
      const parentSessionId = payload.parentSessionId ?? payload.sessionId
      ack?.({
        sessionId: parentSessionId,
        children: parentSessionId === 'prototype-subagents' ? [{
          parentSessionId,
          parentCallId: 'agent-running',
          childSessionId: 'prototype-subagent-running',
          agentType: 'Explore',
          status: 'running',
          startedAt: iso(-3),
        }] : [],
      })
      return this
    }
    if (event === 'agent_types:list') {
      ack?.({ agentTypes: [{ id: 'Explore', label: 'Explore', description: 'Placeholder explorer' }] })
      return this
    }
    if (event.startsWith('client:') && ack) ack({ ok: true })
    return this
  }

  private publishChannels(channels: readonly DashboardChannel[]): void {
    if (channels.includes('global')) {
      this.serverEmit('server:executors', { executors })
      this.serverEmit('server:sessions', { sessions })
      this.serverEmit('server:agent_runtimes', {
        runtimes: [{
          id: 'kernel',
          label: 'Kala Agent',
          description: 'Local placeholder runtime',
          available: true,
          status: 'ready',
          version: 'prototype',
          capabilities: KERNEL_AGENT_RUNTIME_CAPABILITIES,
          models: [{
            ref: 'openai:gpt-5.6',
            id: 'gpt-5.6',
            label: 'GPT 5.6',
            provider: 'Anthropic',
            providerId: 'anthropic',
          }],
        }],
      })
    }
    for (const channel of channels) {
      if (!channel.startsWith('session:')) continue
      const sessionId = channel.slice('session:'.length)
      if (!sessions.some((session) => session.sessionId === sessionId)) continue
      this.serverEmit('session:ready', readyFor(sessionId))
    }
  }

  private serverEmit(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args)
  }
}

export function createPrototypeDashboardSocket(): unknown {
  return new PrototypeDashboardSocket()
}
