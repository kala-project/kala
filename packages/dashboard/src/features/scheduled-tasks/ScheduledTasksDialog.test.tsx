import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ScheduledRun, ScheduledTask, ScheduledTasksClient } from '../../scheduled-tasks-client.js'
import { ScheduledTasksDialog, ScheduledTasksPanel, ScheduledTasksTrigger } from './ScheduledTasksDialog.js'

const sessionTarget = { kind: 'session', sessionId: 'session-1' } as const
const workspaceTarget = { kind: 'workspace', workspaceId: 'workspace-1', workspaceName: 'Dev box' } as const
const activeTask: ScheduledTask = {
  id: 'task-1',
  status: 'active',
  prompt: 'Summarize progress',
  target: sessionTarget,
  schedule: { kind: 'daily', timezone: 'UTC', hour: 9, minute: 0 },
  nextRunAt: '2026-10-03T09:00:00.000Z',
}
const workspaceTask: ScheduledTask = {
  id: 'task-2',
  status: 'paused',
  prompt: 'Monthly release checks',
  target: workspaceTarget,
  schedule: { kind: 'monthly', timezone: 'Asia/Shanghai', hour: 10, minute: 30, daysOfMonth: [1, 15] },
  nextRunAt: '2026-10-15T02:30:00.000Z',
}
const run: ScheduledRun = {
  occurrenceId: 'occurrence-1',
  taskId: 'task-1',
  operationId: 'operation-1',
  scheduledFor: '2026-10-02T09:00:00.000Z',
  claimedAt: '2026-10-02T09:00:01.000Z',
  updatedAt: '2026-10-02T09:00:03.000Z',
  status: 'enqueued',
  task: {
    id: 'task-1',
    generation: 1,
    ownerKey: 'principal:alice',
    createdBy: 'alice',
    prompt: 'Summarize progress',
    target: sessionTarget,
  },
  sessionId: 'session-run-1',
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function mockClient(initial: readonly ScheduledTask[] = []): ScheduledTasksClient & { tasks: ScheduledTask[] } {
  const result = {
    tasks: [...initial],
    list: vi.fn(async () => result.tasks),
    create: vi.fn(async (draft) => {
      const created: ScheduledTask = { id: 'created', status: 'active', nextRunAt: '2026-10-04T09:00:00.000Z', ...draft }
      result.tasks.push(created)
      return created
    }),
    update: vi.fn(async (taskId, patch) => {
      const index = result.tasks.findIndex((item) => item.id === taskId)
      result.tasks[index] = { ...result.tasks[index]!, ...patch }
      return result.tasks[index]!
    }),
    pause: vi.fn(async (taskId) => {
      const index = result.tasks.findIndex((item) => item.id === taskId)
      result.tasks[index] = { ...result.tasks[index]!, status: 'paused' }
      return result.tasks[index]!
    }),
    resume: vi.fn(async (taskId) => {
      const index = result.tasks.findIndex((item) => item.id === taskId)
      result.tasks[index] = { ...result.tasks[index]!, status: 'active' }
      return result.tasks[index]!
    }),
    delete: vi.fn(async (taskId) => { result.tasks = result.tasks.filter((item) => item.id !== taskId) }),
    history: vi.fn(async () => [run]),
  } satisfies ScheduledTasksClient & { tasks: ScheduledTask[] }
  return result
}

function renderDialog(client: ScheduledTasksClient, options: { target?: ScheduledTask['target']; taskId?: string | null; onOpenSession?: (sessionId: string) => void; onOpenChange?: (open: boolean) => void; onTasksChange?: () => void } = {}) {
  return render(<ScheduledTasksDialog open onOpenChange={options.onOpenChange ?? (() => {})} host="https://runlab.example" target={options.target ?? sessionTarget} taskId={options.taskId} sessionNames={new Map([['session-run-1', 'Progress review']])} client={client} onOpenSession={options.onOpenSession} onTasksChange={options.onTasksChange} />)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ScheduledTasksPanel', () => {
  it('loads real tasks, switches between conversation and workspace scopes, and opens cards in the parent modal', async () => {
    const client = mockClient([activeTask, workspaceTask])
    const onOpen = vi.fn()
    const onTaskOpen = vi.fn()
    render(<ScheduledTasksPanel target={sessionTarget} workspaceTarget={workspaceTarget} client={client} onOpen={onOpen} onTaskOpen={onTaskOpen} />)

    expect(await screen.findByText('Summarize progress')).toBeTruthy()
    expect(screen.queryByRole('heading', { name: '定时任务' })).toBeNull()
    fireEvent.click(screen.getByTestId('scheduled-task-card-task-1'))
    expect(onTaskOpen).toHaveBeenCalledWith('task-1', sessionTarget)

    fireEvent.click(screen.getByRole('tab', { name: '此工作区' }))
    expect(screen.getByText('Monthly release checks')).toBeTruthy()
    expect(screen.getByText(/每月 1、15 日/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /创建新的定时任务/ }))
    expect(onOpen).toHaveBeenCalledWith(workspaceTarget)
  })

  it('ignores an old account load that resolves after the replacement account', async () => {
    const delayedA = deferred<readonly ScheduledTask[]>()
    const clientA = mockClient()
    clientA.list = vi.fn(() => delayedA.promise)
    const clientB = mockClient([activeTask])
    const view = render(<ScheduledTasksPanel target={sessionTarget} host="https://a.example" token="token-a" client={clientA} onOpen={() => {}} />)

    expect(screen.getByRole('status').textContent).toContain('正在加载计划')
    view.rerender(<ScheduledTasksPanel target={sessionTarget} host="https://b.example" token="token-b" client={clientB} onOpen={() => {}} />)
    expect(await screen.findByText('Summarize progress')).toBeTruthy()

    await act(async () => delayedA.resolve([workspaceTask]))
    expect(screen.getByText('Summarize progress')).toBeTruthy()
    expect(screen.queryByText('Monthly release checks')).toBeNull()
  })

  it('shows loading, empty, unavailable-scope, and retryable error states', async () => {
    let resolveList!: (tasks: readonly ScheduledTask[]) => void
    const loadingClient = mockClient()
    loadingClient.list = vi.fn(() => new Promise((resolve) => { resolveList = resolve }))
    const loadingView = render(<ScheduledTasksPanel target={sessionTarget} client={loadingClient} onOpen={() => {}} />)
    expect(screen.getByRole('status').textContent).toContain('正在加载计划')
    resolveList([])
    expect(await screen.findByText('此范围还没有计划')).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: '此工作区' }))
    expect(screen.getByText('当前范围不可用')).toBeTruthy()
    loadingView.unmount()

    const failing = mockClient()
    vi.mocked(failing.list).mockRejectedValue(new Error('Cannot load tasks'))
    render(<ScheduledTasksPanel target={sessionTarget} client={failing} onOpen={() => {}} />)
    expect((await screen.findByRole('alert')).textContent).toContain('Cannot load tasks')
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(failing.list).toHaveBeenCalledTimes(2)
  })
})

describe('ScheduledTasksDialog', () => {
  it('creates interval and monthly schedules with timezone and exact backend contract fields', async () => {
    const intervalClient = mockClient()
    const onOpenChange = vi.fn()
    const view = renderDialog(intervalClient, { onOpenChange })
    fireEvent.change(screen.getByLabelText('执行指令'), { target: { value: 'Review the queue' } })
    fireEvent.click(screen.getByRole('button', { name: '每几天' }))
    fireEvent.change(screen.getByLabelText('每隔几天'), { target: { value: '4' } })
    fireEvent.change(screen.getByLabelText('从哪天开始'), { target: { value: '2026-10-04' } })
    fireEvent.change(screen.getByLabelText('时区'), { target: { value: 'America/New_York' } })
    fireEvent.click(screen.getByRole('button', { name: '创建计划' }))
    await waitFor(() => expect(intervalClient.create).toHaveBeenCalled())
    expect(vi.mocked(intervalClient.create).mock.calls[0]![0]).toMatchObject({
      prompt: 'Review the queue',
      target: sessionTarget,
      schedule: { kind: 'interval', timezone: 'America/New_York', everyDays: 4, startDate: '2026-10-04' },
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
    view.unmount()

    const monthlyClient = mockClient()
    renderDialog(monthlyClient, { target: workspaceTarget })
    fireEvent.change(screen.getByLabelText('执行指令'), { target: { value: 'Run workspace checks' } })
    fireEvent.click(screen.getByRole('button', { name: '每月' }))
    fireEvent.change(screen.getByLabelText('每月日期'), { target: { value: '15, 1, 15, 31' } })
    fireEvent.change(screen.getByLabelText('时区'), { target: { value: 'Asia/Shanghai' } })
    fireEvent.click(screen.getByRole('button', { name: '创建计划' }))
    await waitFor(() => expect(monthlyClient.create).toHaveBeenCalled())
    expect(vi.mocked(monthlyClient.create).mock.calls[0]![0]).toMatchObject({
      target: workspaceTarget,
      schedule: { kind: 'monthly', timezone: 'Asia/Shanghai', daysOfMonth: [1, 15, 31] },
    })
  })

  it('shows one selected task, loads history in its modal tab, and keeps edit, pause, resume, and delete accessible', async () => {
    const client = mockClient([activeTask])
    const onOpenSession = vi.fn()
    const onOpenChange = vi.fn()
    const onTasksChange = vi.fn()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderDialog(client, { taskId: 'task-1', onOpenSession, onOpenChange, onTasksChange })
    expect(await screen.findByRole('heading', { name: 'Summarize progress' })).toBeTruthy()
    expect(screen.queryByLabelText('Scheduled tasks list')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '暂停' }))
    await waitFor(() => expect(client.pause).toHaveBeenCalledWith('task-1'))
    fireEvent.click(await screen.findByRole('button', { name: '恢复' }))
    await waitFor(() => expect(client.resume).toHaveBeenCalledWith('task-1'))

    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    fireEvent.change(screen.getByLabelText('执行指令'), { target: { value: 'Updated summary' } })
    fireEvent.click(screen.getByRole('button', { name: '保存更改' }))
    await waitFor(() => expect(client.update).toHaveBeenCalledWith('task-1', expect.objectContaining({ prompt: 'Updated summary' })))

    fireEvent.click(screen.getByRole('button', { name: '查看过去的运行' }))
    expect(client.history).toHaveBeenCalledWith('task-1')
    const sessionLink = await screen.findByRole('button', { name: /打开对话 Progress review/i })
    expect(screen.queryByText(/打开对话 session-run-1/i)).toBeNull()
    const timingDetails = screen.getByText('时间详情').closest('details')!
    expect(timingDetails.open).toBe(false)
    expect(timingDetails.textContent).toContain('计划时间：')
    expect(timingDetails.textContent).toContain('领取派发：')
    expect(timingDetails.textContent).toContain('更新时间：')
    fireEvent.click(sessionLink)
    expect(onOpenSession).toHaveBeenCalledWith('session-run-1')

    fireEvent.click(screen.getByRole('tab', { name: '详情' }))
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    await waitFor(() => expect(client.delete).toHaveBeenCalledWith('task-1'))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onTasksChange).toHaveBeenCalled()
  })

  it('opens a deleted task from its immutable run snapshot as read-only archival detail', async () => {
    const client = mockClient()
    const archivedRun: ScheduledRun = {
      ...run,
      occurrenceId: 'deleted-occurrence',
      taskId: 'deleted-task',
      task: {
        id: 'deleted-task',
        generation: 3,
        ownerKey: 'organization:private-unit',
        createdBy: 'archivist',
        prompt: 'Historical release summary',
        target: workspaceTarget,
      },
    }
    vi.mocked(client.history).mockResolvedValue([archivedRun])

    renderDialog(client, { taskId: 'deleted-task', target: workspaceTarget })

    expect(await screen.findByRole('heading', { name: 'Historical release summary' })).toBeTruthy()
    expect(screen.getByText('已删除的任务 · 只读')).toBeTruthy()
    expect(screen.getByText('工作区 · Dev box')).toBeTruthy()
    expect(screen.getByText('archivist')).toBeTruthy()
    expect(screen.queryByText('organization:private-unit')).toBeNull()
    expect(screen.queryByText('计划')).toBeNull()
    expect(screen.queryByText('下一次执行')).toBeNull()
    expect(screen.queryByRole('button', { name: '暂停' })).toBeNull()
    expect(screen.queryByRole('button', { name: '编辑' })).toBeNull()
    expect(screen.queryByRole('button', { name: '删除' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '查看过去的运行' }))
    expect(screen.getByText('enqueued')).toBeTruthy()
    expect(client.history).toHaveBeenCalledTimes(1)
  })

  it('does not expose a deleted task when its history request is forbidden', async () => {
    const client = mockClient()
    vi.mocked(client.history).mockRejectedValue(new Error('Forbidden'))

    renderDialog(client, { taskId: 'forbidden-task' })

    expect((await screen.findByRole('alert')).textContent).toContain('Forbidden')
    expect(screen.queryByText('已删除的任务 · 只读')).toBeNull()
    expect(screen.queryByRole('tab', { name: '详情' })).toBeNull()
    expect(client.history).toHaveBeenCalledWith('forbidden-task')
  })

  it('ignores an archival fallback from an old authenticated dialog identity', async () => {
    const delayedHistoryA = deferred<readonly ScheduledRun[]>()
    const clientA = mockClient()
    clientA.history = vi.fn(() => delayedHistoryA.promise)
    const clientB = mockClient()
    const archivedB: ScheduledRun = {
      ...run,
      occurrenceId: 'occurrence-b',
      taskId: 'deleted-b',
      task: {
        id: 'deleted-b',
        generation: 1,
        ownerKey: 'principal:b',
        createdBy: 'account-b',
        prompt: 'Archived B',
        target: workspaceTarget,
      },
    }
    vi.mocked(clientB.history).mockResolvedValue([archivedB])
    const view = render(<ScheduledTasksDialog open onOpenChange={() => {}} host="https://a.example" token="token-a" target={sessionTarget} taskId="deleted-a" client={clientA} />)
    await waitFor(() => expect(clientA.history).toHaveBeenCalledWith('deleted-a'))

    view.rerender(<ScheduledTasksDialog open onOpenChange={() => {}} host="https://b.example" token="token-b" target={workspaceTarget} taskId="deleted-b" client={clientB} />)
    expect(await screen.findByRole('heading', { name: 'Archived B' })).toBeTruthy()

    await act(async () => delayedHistoryA.resolve([{
      ...run,
      occurrenceId: 'occurrence-a',
      taskId: 'deleted-a',
      task: { ...run.task, id: 'deleted-a', prompt: 'Archived A' },
    }]))
    expect(screen.getByRole('heading', { name: 'Archived B' })).toBeTruthy()
    expect(screen.queryByText('Archived A')).toBeNull()
  })

  it('shows only B when delayed task A resolves after B and clears A at the render identity boundary', async () => {
    const delayedA = deferred<readonly ScheduledTask[]>()
    const clientA = mockClient()
    clientA.list = vi.fn(() => delayedA.promise)
    const clientB = mockClient([workspaceTask])
    const view = render(<ScheduledTasksDialog open onOpenChange={() => {}} host="https://a.example" token="token-a" target={sessionTarget} taskId="task-1" client={clientA} />)

    expect(screen.getByRole('status').textContent).toContain('正在加载任务')
    view.rerender(<ScheduledTasksDialog open onOpenChange={() => {}} host="https://b.example" token="token-b" target={workspaceTarget} taskId="task-2" client={clientB} />)
    expect(screen.queryByText('Summarize progress')).toBeNull()
    expect(await screen.findByRole('heading', { name: 'Monthly release checks' })).toBeTruthy()

    await act(async () => delayedA.resolve([activeTask]))
    expect(screen.getByRole('heading', { name: 'Monthly release checks' })).toBeTruthy()
    expect(screen.queryByText('Summarize progress')).toBeNull()
  })

  it('does not let a create from closed A close or mutate reopened B', async () => {
    const delayedCreate = deferred<ScheduledTask>()
    const client = mockClient()
    client.create = vi.fn(() => delayedCreate.promise)
    const onOpenChange = vi.fn()
    const onTasksChange = vi.fn()
    const view = render(<ScheduledTasksDialog open onOpenChange={onOpenChange} host="https://runlab.example" token="token-a" target={sessionTarget} client={client} onTasksChange={onTasksChange} />)

    fireEvent.change(screen.getByLabelText('执行指令'), { target: { value: 'Account A prompt' } })
    fireEvent.click(screen.getByRole('button', { name: '创建计划' }))
    await waitFor(() => expect(client.create).toHaveBeenCalledTimes(1))

    view.rerender(<ScheduledTasksDialog open={false} onOpenChange={onOpenChange} host="https://runlab.example" token="token-a" target={sessionTarget} client={client} onTasksChange={onTasksChange} />)
    view.rerender(<ScheduledTasksDialog open onOpenChange={onOpenChange} host="https://runlab.example" token="token-b" target={workspaceTarget} client={client} onTasksChange={onTasksChange} />)
    const prompt = screen.getByLabelText('执行指令') as HTMLTextAreaElement
    fireEvent.change(prompt, { target: { value: 'Account B prompt' } })

    await act(async () => delayedCreate.resolve({ ...activeTask, prompt: 'Account A prompt' }))
    expect(prompt.value).toBe('Account B prompt')
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(onTasksChange).not.toHaveBeenCalled()
  })

  it('reports a missing selected task and retries API errors', async () => {
    const client = mockClient()
    vi.mocked(client.list).mockRejectedValueOnce(new Error('Cannot load task'))
    renderDialog(client, { taskId: 'missing' })
    expect((await screen.findByRole('alert')).textContent).toContain('Cannot load task')
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(client.list).toHaveBeenCalledTimes(2)
    expect((await screen.findByRole('alert')).textContent).toContain('找不到这个定时任务')
  })

  it('disables scheduling when there is no validated workspace target', () => {
    const onOpen = vi.fn()
    render(<ScheduledTasksTrigger target={null} scope="workspace" onOpen={onOpen} />)
    const trigger = screen.getByRole('button', { name: /Scheduled tasks for this workspace/i })
    expect((trigger as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(trigger)
    expect(onOpen).not.toHaveBeenCalled()
  })
})
