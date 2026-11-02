import type { ScheduledTaskState } from './state-store.js'

export type ScheduledInboxScope = { ownerKey: string; principal: string }
type InboxSignature = ScheduledInboxScope & { value: string }

export function inboxSignatures(state: ScheduledTaskState): Map<string, InboxSignature> {
  const receipts = new Map((state.inboxReceipts ?? []).map((receipt) => [
    JSON.stringify([receipt.ownerKey, receipt.principal]), new Set(receipt.occurrenceIds),
  ]))
  const groups = new Map<string, ScheduledInboxScope & { values: string[] }>()
  for (const run of state.runs) {
    if (run.status !== 'enqueued' && run.status !== 'failed' && run.status !== 'needs_review') continue
    const scope = { ownerKey: run.task.ownerKey, principal: run.task.createdBy }
    const key = JSON.stringify([scope.ownerKey, scope.principal])
    let group = groups.get(key)
    if (!group) { group = { ...scope, values: [] }; groups.set(key, group) }
    group.values.push(JSON.stringify([run, receipts.get(key)?.has(run.occurrenceId) ?? false]))
  }
  return new Map([...groups].map(([key, group]) => [key, { ownerKey: group.ownerKey, principal: group.principal, value: group.values.join('\n') }]))
}

export function changedInboxes(before: ReturnType<typeof inboxSignatures>, state: ScheduledTaskState): ScheduledInboxScope[] {
  const after = inboxSignatures(state)
  return [...new Set([...before.keys(), ...after.keys()])].flatMap((key) => {
    if (before.get(key)?.value === after.get(key)?.value) return []
    const scope = after.get(key) ?? before.get(key)!
    return [{ ownerKey: scope.ownerKey, principal: scope.principal }]
  })
}
