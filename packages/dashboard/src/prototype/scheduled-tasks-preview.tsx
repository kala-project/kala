import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Bell, CalendarClock, Check, ChevronRight, Clock3, Folder, History, MessageSquare, Plus, Send, X } from 'lucide-react'
import '@fontsource-variable/inter/wght.css'
import '@fontsource-variable/noto-sans-sc/wght.css'
import '../index.css'
import { Dialog, DialogContent, DialogDescription, DialogTitle, dialogMobileSheetClassName } from '../components/ui/dialog.js'
import { RightPanel, type RightPanelTab } from '../features/right-panel/RightPanel.js'
import { i18n } from '../i18n/index.js'
import { initializeTheme } from '../lib/theme.js'

// Fictional data only. This route is a browser-rendered interaction concept,
// not an implementation of scheduling or an API connected to a real account.
type Scope = 'session' | 'workspace'
type Task = { id: string; title: string; prompt: string; rule: string; next: string; status: '运行中' | '已暂停'; scope: Scope; owner: string; icon: string }
const tasks: Task[] = [
  { id: 'pulse', title: '项目进展简报', prompt: '整理本对话中的项目进展和待办事项，生成一份简短的晨间摘要。', rule: '每 3 天 · 09:00', next: '10 月 7 日，09:00', status: '运行中', scope: 'session', owner: '林舟', icon: '✦' },
  { id: 'review', title: '每周回顾', prompt: '根据本对话的工作记录，回顾本周进度与阻塞项。', rule: '每周一、四 · 09:00', next: '10 月 5 日，09:00', status: '运行中', scope: 'session', owner: '林舟', icon: '◈' },
  { id: 'check', title: '月度发布检查', prompt: '检查示例工作区的发布清单，报告缺失项目。', rule: '每月 1、15 日 · 10:30', next: '10 月 15 日，10:30', status: '已暂停', scope: 'workspace', owner: '周宁', icon: '◇' },
  { id: 'snapshot', title: '工作区状态速览', prompt: '列出示例工作区最近的变更和待处理事项。', rule: '每天 · 08:30', next: '10 月 5 日，08:30', status: '运行中', scope: 'workspace', owner: '林舟', icon: '○' },
]
const runs = [
  { id: 'run-3', taskId: 'pulse', when: '10 月 4 日 · 09:00', status: '已完成', detail: '已生成项目进展简报', elapsed: '2 分 14 秒' },
  { id: 'run-2', taskId: 'pulse', when: '10 月 1 日 · 09:00', status: '已完成', detail: '已生成项目进展简报', elapsed: '1 分 48 秒' },
  { id: 'run-1', taskId: 'pulse', when: '9 月 28 日 · 09:00', status: '已跳过', detail: '工作区暂不可用', elapsed: '—' },
]

function Preview(): JSX.Element {
  const [scope, setScope] = useState<Scope>('session')
  const [tab, setTab] = useState<RightPanelTab>('scheduledTasks')
  const [selectedTask, setSelectedTask] = useState<Task | null>(null)
  const [detailTab, setDetailTab] = useState<'details' | 'history'>('details')
  const [editing, setEditing] = useState(false)
  const [frequency, setFrequency] = useState<'once' | 'daily' | 'interval' | 'weekly' | 'monthly'>('interval')
  const [inboxOpen, setInboxOpen] = useState(false)
  const [hasUnread, setHasUnread] = useState(true)
  const [panelVisible, setPanelVisible] = useState(true)
  const openTask = (task: Task, history = false): void => { setInboxOpen(false); setEditing(false); setSelectedTask(task); setDetailTab(history ? 'history' : 'details') }
  const openEditor = (): void => { setInboxOpen(false); setSelectedTask(null); setEditing(true) }

  return <div className="flex h-[100dvh] min-h-[620px] flex-col overflow-hidden bg-background text-foreground" data-testid="schedule-preview">
    <div className="flex min-h-0 flex-1">
      <aside className="hidden w-[214px] shrink-0 flex-col border-r border-border/70 bg-muted/20 p-4 lg:flex">
        <div className="flex items-center gap-2 rounded-xl bg-card px-3 py-2.5 text-xs font-medium shadow-sm"><Folder className="size-4 text-primary" /> 示例工作区</div>
        <p className="mb-2 mt-8 px-2 text-[11px] font-semibold tracking-widest text-muted-foreground">对话</p>
        <div className="rounded-lg bg-primary/10 px-3 py-2.5 text-xs font-medium text-primary">项目周报</div><div className="px-3 py-2.5 text-xs text-muted-foreground">设计讨论</div><div className="px-3 py-2.5 text-xs text-muted-foreground">日常记录</div>
        <div className="mt-auto rounded-xl border border-border/60 bg-card p-3 text-xs text-muted-foreground"><span className="font-medium text-foreground">模拟数据</span><p className="mt-1 leading-relaxed">仅供方案评审，不会创建真实任务或发送通知。</p></div>
      </aside>
      <main className="hidden min-w-0 flex-1 flex-col bg-background md:flex">
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-border/50 px-8"><span className="text-sm font-medium">项目周报</span><span className="text-xs text-muted-foreground">示例对话 · 仅用于设计预览</span></div>
        <div className="mx-auto flex w-full max-w-[780px] flex-1 flex-col justify-end gap-8 overflow-hidden px-8 pb-8">
          <div className="max-w-[85%] self-end rounded-2xl rounded-br-md bg-primary px-5 py-4 text-sm leading-7 text-primary-foreground">请帮我每隔三天整理一次项目进展，早上九点发送简报。</div>
          <div className="flex gap-3"><span className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-foreground text-sm font-bold text-background">K</span><p className="pt-1 text-sm leading-7 text-foreground">已经为这段对话准备好定时计划。每次运行都会留在运行历史中；生成的消息也会标记来源，方便回到对应任务。</p></div>
          <div className="flex flex-col items-end gap-2"><button type="button" onClick={() => openTask(tasks[0]!, true)} data-testid="scheduled-message-badge" className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-2.5 py-1 text-[11px] font-medium text-primary hover:bg-primary/15"><CalendarClock className="size-3.5" /> 定时任务 <ChevronRight className="size-3" /></button><div className="max-w-[83%] rounded-2xl rounded-br-md bg-primary px-5 py-3.5 text-sm leading-6 text-primary-foreground">请整理今天的进展，重点列出已经完成的事项与下一步计划。</div><span className="text-[11px] text-muted-foreground">今天 09:00</span></div>
          <div className="rounded-2xl border border-border bg-card px-4 py-3 text-sm text-muted-foreground shadow-sm">给 Kala 发送消息… <Send className="float-right size-4" /></div>
        </div>
      </main>
      {panelVisible ? <aside className="relative min-w-0 flex-1 border-l border-border/60 md:w-[390px] md:flex-none xl:w-[420px]" data-testid="schedule-sidebar">
        <RightPanel activeTab={tab} onTabChange={setTab} onCollapse={() => setPanelVisible(false)} headerHelp={<button type="button" onClick={() => { setInboxOpen((value) => !value); setHasUnread(false) }} aria-label="通知收件箱" data-testid="schedule-inbox-trigger" className="relative flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted"><Bell className="size-4" />{hasUnread ? <span className="absolute right-1 top-1 size-1.5 rounded-full bg-rose-500" /> : null}</button>} scheduledTasks={<SchedulePanel scope={scope} setScope={setScope} onTask={openTask} onCreate={openEditor} />} files={<div className="p-5 text-sm text-muted-foreground">文件</div>} git={<div className="p-5 text-sm text-muted-foreground">Git</div>} terminal={<div className="p-5 text-sm text-muted-foreground">终端</div>} inspector={<div className="p-5 text-sm text-muted-foreground">检查器</div>} />
        {inboxOpen ? <InboxPopover onClose={() => setInboxOpen(false)} onTask={openTask} /> : null}
      </aside> : <button type="button" onClick={() => setPanelVisible(true)} className="m-3 flex size-9 items-center justify-center rounded-lg bg-muted" aria-label="展开侧栏"><CalendarClock className="size-4" /></button>}
    </div>
    <Dialog open={Boolean(selectedTask) || editing} onOpenChange={(open) => { if (!open) { setSelectedTask(null); setEditing(false) } }}>
      <DialogContent className={`${dialogMobileSheetClassName} !flex max-h-[min(770px,90dvh)] flex-col gap-0 !p-0 sm:max-w-[720px]`} data-testid="schedule-detail-modal">
        {editing ? <RuleEditor frequency={frequency} setFrequency={setFrequency} onClose={() => setEditing(false)} /> : selectedTask ? <TaskDetail task={selectedTask} tab={detailTab} setTab={setDetailTab} onClose={() => setSelectedTask(null)} /> : null}
      </DialogContent>
    </Dialog>
  </div>
}

function InboxPopover({ onClose, onTask }: { onClose(): void; onTask(task: Task, history?: boolean): void }): JSX.Element {
  return <div className="absolute right-2 top-12 z-40 w-[min(360px,calc(100vw-1.25rem))] overflow-hidden rounded-2xl border border-border bg-card shadow-2xl" data-testid="schedule-inbox">
    <div className="flex items-center justify-between border-b border-border/60 px-4 py-3"><p className="text-sm font-semibold">通知</p><button type="button" onClick={onClose} aria-label="关闭通知"><X className="size-4" /></button></div>
    <button type="button" className="flex w-full gap-3 border-b border-border/50 px-4 py-4 text-left hover:bg-muted/50" onClick={() => onTask(tasks[0]!, true)}><span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600"><Check className="size-4" /></span><span><span className="block text-sm font-medium">项目进展简报已完成</span><span className="mt-0.5 block text-xs text-muted-foreground">今天 09:02 · 点击查看运行记录</span></span></button>
    <button type="button" className="flex w-full gap-3 px-4 py-4 text-left hover:bg-muted/50" onClick={() => onTask(tasks[2]!, true)}><span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-amber-500/10 text-amber-600"><Clock3 className="size-4" /></span><span><span className="block text-sm font-medium">月度发布检查需要留意</span><span className="mt-0.5 block text-xs text-muted-foreground">昨天 10:31 · 查看详情</span></span></button>
  </div>
}

function SchedulePanel({ scope, setScope, onTask, onCreate }: { scope: Scope; setScope(value: Scope): void; onTask(task: Task, history?: boolean): void; onCreate(): void }): JSX.Element {
  const visible = tasks.filter((task) => task.scope === scope)
  return <section className="flex h-full min-h-0 flex-col" data-testid="schedule-plan-panel">
    <div className="shrink-0 border-b border-border/50 px-5 py-3">
      <div className="grid grid-cols-2 gap-1 rounded-xl bg-muted/65 p-1" role="tablist" aria-label="计划范围"><button type="button" role="tab" aria-selected={scope === 'session'} data-testid="scope-session" onClick={() => setScope('session')} className={scope === 'session' ? 'rounded-lg bg-card py-2 text-xs font-medium shadow-sm' : 'py-2 text-xs text-muted-foreground'}>此对话</button><button type="button" role="tab" aria-selected={scope === 'workspace'} data-testid="scope-workspace" onClick={() => setScope('workspace')} className={scope === 'workspace' ? 'rounded-lg bg-card py-2 text-xs font-medium shadow-sm' : 'py-2 text-xs text-muted-foreground'}>此工作区</button></div>
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4"><div className="flex items-center justify-between px-1"><span className="text-xs font-semibold text-muted-foreground">计划 · {visible.length}</span><button type="button" onClick={onCreate} className="inline-flex items-center gap-1 text-xs font-medium text-primary"><Plus className="size-3.5" /> 新建</button></div>
      <div className="mt-3 space-y-3">{visible.map((task) => <article key={task.id} className="rounded-2xl border border-border/70 bg-card p-4 shadow-[0_1px_3px_hsl(var(--foreground)/.035)]"><button type="button" onClick={() => onTask(task)} data-testid={`plan-${task.id}`} className="block w-full text-left"><div className="flex items-start gap-3"><span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-lg text-primary">{task.icon}</span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold">{task.title}</span><span className="mt-1 block text-xs text-muted-foreground">{task.rule}</span></span><ChevronRight className="mt-2 size-4 shrink-0 text-muted-foreground" /></div></button><div className="mt-4 flex items-center justify-between border-t border-border/45 pt-3 text-[11px]"><span className="inline-flex items-center gap-1 text-muted-foreground"><Clock3 className="size-3.5" /> 下次 {task.next}</span><span className={task.status === '运行中' ? 'rounded-full bg-emerald-500/10 px-2 py-1 font-medium text-emerald-700 dark:text-emerald-300' : 'rounded-full bg-muted px-2 py-1 text-muted-foreground'}>{task.status}</span></div></article>)}</div>
      <button type="button" onClick={onCreate} data-testid="schedule-new" className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-border py-3 text-xs font-medium text-muted-foreground hover:border-primary/50 hover:text-primary"><Plus className="size-4" /> 创建新的定时任务</button>
    </div><div className="shrink-0 border-t border-border/40 px-5 py-3 text-[11px] text-muted-foreground">显示时区 · Asia/Shanghai (UTC+8)</div>
  </section>
}

function TaskDetail({ task, tab, setTab, onClose }: { task: Task; tab: 'details' | 'history'; setTab(value: 'details' | 'history'): void; onClose(): void }): JSX.Element {
  return <><div className="flex items-start justify-between gap-3 border-b border-border/60 px-5 py-5 sm:px-7"><div className="flex min-w-0 gap-3"><span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-xl text-primary">{task.icon}</span><div className="min-w-0"><DialogTitle className="text-lg">{task.title}</DialogTitle><DialogDescription className="sr-only">查看任务详情和运行记录</DialogDescription></div></div><button type="button" aria-label="关闭详情" onClick={onClose} className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted"><X className="size-4" /></button></div>
    <div className="flex gap-1 border-b border-border/50 px-5 pt-3 sm:px-7" role="tablist" aria-label="任务详情标签"><button type="button" role="tab" aria-selected={tab === 'details'} onClick={() => setTab('details')} className={tab === 'details' ? 'border-b-2 border-primary px-3 pb-3 text-sm font-medium text-primary' : 'px-3 pb-3 text-sm text-muted-foreground'}>详情</button><button type="button" role="tab" aria-selected={tab === 'history'} data-testid="modal-history-tab" onClick={() => setTab('history')} className={tab === 'history' ? 'border-b-2 border-primary px-3 pb-3 text-sm font-medium text-primary' : 'px-3 pb-3 text-sm text-muted-foreground'}>运行记录 <span className="ml-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px]">3</span></button></div>
    <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-7" data-testid="schedule-modal-body">{tab === 'details' ? <div className="space-y-5"><div className="rounded-xl bg-muted/60 px-4 py-3"><p className="text-xs font-medium text-muted-foreground">执行指令</p><p className="mt-1.5 text-sm leading-6">{task.prompt}</p></div><div className="grid grid-cols-2 gap-x-5 gap-y-5 text-sm"><div><p className="text-xs text-muted-foreground">计划</p><p className="mt-1 font-medium">{task.rule}</p></div><div><p className="text-xs text-muted-foreground">下一次执行</p><p className="mt-1 font-medium">{task.next}</p></div><div><p className="text-xs text-muted-foreground">时区</p><p className="mt-1 font-medium">Asia/Shanghai</p></div><div><p className="text-xs text-muted-foreground">创建者</p><p className="mt-1 font-medium">{task.owner}</p></div><div><p className="text-xs text-muted-foreground">所属</p><p className="mt-1 font-medium">{task.scope === 'session' ? '项目周报' : '示例工作区'}</p></div></div><button type="button" onClick={() => setTab('history')} className="flex w-full items-center justify-between rounded-xl border border-border px-4 py-3 text-left text-sm hover:bg-muted/40"><span className="inline-flex items-center gap-2"><History className="size-4 text-primary" /> 查看过去的运行</span><ChevronRight className="size-4 text-muted-foreground" /></button></div> : <div><p className="mb-4 text-xs text-muted-foreground">每次执行单独记录；点击记录可跳转到产生结果的对话。</p><ol className="space-y-0">{runs.map((run, index) => <li key={run.id} className="relative flex gap-3 pb-6"><div className="flex flex-col items-center"><span className={run.status === '已完成' ? 'z-10 flex size-7 shrink-0 items-center justify-center rounded-full bg-emerald-500/12 text-emerald-700 dark:text-emerald-300' : 'z-10 flex size-7 shrink-0 items-center justify-center rounded-full bg-amber-500/12 text-amber-700 dark:text-amber-300'}>{run.status === '已完成' ? <Check className="size-3.5" /> : <Clock3 className="size-3.5" />}</span>{index < runs.length - 1 ? <span className="mt-1 h-full w-px bg-border" /> : null}</div><div className="min-w-0 flex-1 rounded-xl border border-border/70 bg-card p-3"><div className="flex items-center justify-between gap-2"><span className="text-xs font-semibold">{run.status}</span><span className="text-[11px] text-muted-foreground">{run.when}</span></div><p className="mt-1 text-xs text-muted-foreground">{run.detail} · {run.elapsed}</p>{run.status === '已完成' ? <button type="button" className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-primary"><MessageSquare className="size-3.5" /> 打开对话 <ChevronRight className="size-3" /></button> : null}</div></li>)}</ol></div>}</div>
    <div className="flex shrink-0 items-center justify-between border-t border-border/60 bg-muted/25 px-5 py-3 text-xs text-muted-foreground sm:px-7"><span>设计预览 · 模拟数据</span><button type="button" onClick={onClose} className="rounded-lg bg-foreground px-3.5 py-2 text-background">完成</button></div>
  </>
}

function RuleEditor({ frequency, setFrequency, onClose }: { frequency: 'once' | 'daily' | 'interval' | 'weekly' | 'monthly'; setFrequency(value: 'once' | 'daily' | 'interval' | 'weekly' | 'monthly'): void; onClose(): void }): JSX.Element {
  return <><div className="flex items-center justify-between border-b border-border/60 px-5 py-5 sm:px-7"><div><DialogTitle>创建任务</DialogTitle><DialogDescription className="sr-only">设置任务名称、执行指令和计划规则</DialogDescription></div><button type="button" onClick={onClose} aria-label="关闭编辑器"><X className="size-4" /></button></div>
    <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5 sm:px-7" data-testid="schedule-rule-editor"><label className="block text-xs font-medium text-muted-foreground">任务名称<input defaultValue="项目进展简报" className="mt-2 w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm text-foreground" /></label><label className="block text-xs font-medium text-muted-foreground">执行指令<textarea rows={2} defaultValue="整理此对话中的项目进展和待办事项。" className="mt-2 w-full resize-none rounded-xl border border-border bg-background px-3 py-2.5 text-sm text-foreground" /></label><div><p className="text-xs font-medium text-muted-foreground">重复方式</p><div className="mt-2 flex flex-wrap gap-2">{([['once', '一次'], ['daily', '每天'], ['interval', '每几天'], ['weekly', '每周'], ['monthly', '每月']] as const).map(([value, label]) => <button type="button" key={value} onClick={() => setFrequency(value)} className={frequency === value ? 'rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground' : 'rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground'}>{label}</button>)}</div></div>
      {frequency === 'interval' ? <div className="grid grid-cols-2 gap-3"><label className="text-xs font-medium text-muted-foreground">每隔几天<input type="number" min="1" defaultValue="3" className="mt-2 w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm text-foreground" /></label><label className="text-xs font-medium text-muted-foreground">从哪天开始<input type="date" defaultValue="2026-10-04" className="mt-2 w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm text-foreground" /></label></div> : frequency === 'weekly' ? <div className="flex flex-wrap gap-2 text-xs">{['一','二','三','四','五','六','日'].map((day, i) => <span key={day} className={i === 0 || i === 3 ? 'flex size-8 items-center justify-center rounded-full bg-primary text-primary-foreground' : 'flex size-8 items-center justify-center rounded-full bg-muted text-muted-foreground'}>{day}</span>)}</div> : frequency === 'monthly' ? <div className="flex gap-2"><span className="rounded-full bg-primary px-3 py-1.5 text-xs text-primary-foreground">1 日</span><span className="rounded-full bg-primary px-3 py-1.5 text-xs text-primary-foreground">15 日</span><button type="button" className="rounded-full bg-muted px-3 py-1.5 text-xs text-muted-foreground">+ 日期</button></div> : null}
      <div className="grid grid-cols-2 gap-3"><label className="text-xs font-medium text-muted-foreground">执行时间<input type="time" defaultValue="09:00" className="mt-2 w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm text-foreground" /></label><label className="text-xs font-medium text-muted-foreground">时区<input defaultValue="Asia/Shanghai" className="mt-2 w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm text-foreground" /></label></div><div className="rounded-xl bg-primary/5 p-3 text-xs text-muted-foreground"><span className="font-medium text-foreground">下一次执行预览</span><p className="mt-1">10 月 7 日 09:00 · 10 月 10 日 09:00 · 10 月 13 日 09:00</p></div>
    </div><div className="flex items-center justify-between border-t border-border/60 px-5 py-4 sm:px-7"><span className="text-xs text-muted-foreground">此页面仅演示交互，不会保存任务</span><button type="button" onClick={onClose} className="rounded-xl bg-primary px-4 py-2.5 text-xs font-medium text-primary-foreground">创建计划</button></div></>
}

initializeTheme()
void i18n.changeLanguage('zh')
const root = document.getElementById('root')
if (!root) throw new Error('missing prototype root')
createRoot(root).render(<Preview />)
