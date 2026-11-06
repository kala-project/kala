import type { ChildCommand, ChildCommandInbox } from './child-command-state.js'

export async function consumeNextChildCommand(
  inbox: ChildCommandInbox,
  childSessionId: string,
  dispatch: (command: ChildCommand) => Promise<void>,
  reconcile: (command: ChildCommand) => Promise<{ ok: boolean; content: string } | undefined>,
  onClaim?: (command: ChildCommand) => void,
  onMarkFailed?: (command: ChildCommand) => void,
): Promise<ChildCommand | undefined> {
  const command = await inbox.claimChildCommand(childSessionId)
  if (command) onClaim?.(command)
  return consumeClaimed(inbox, childSessionId, command, dispatch, reconcile, onMarkFailed)
}

export async function consumeNextChildStop(
  inbox: ChildCommandInbox,
  childSessionId: string,
  dispatch: (command: ChildCommand) => Promise<{ ok: boolean; content: string }>,
): Promise<ChildCommand | undefined> {
  const command = await inbox.claimChildStop(childSessionId)
  if (command?.dispatchedAt) {
    return inbox.completeChildCommand(childSessionId, command.commandId, {
      ok: false, content: 'UNKNOWN: previous Stop was dispatched without a durable acknowledgement; never assume the child or its tools stopped.',
    })
  }
  let outcome: { ok: boolean; content: string } | undefined
  return consumeClaimed(inbox, childSessionId, command, async (claimed) => {
    outcome = await dispatch(claimed)
  }, async () => outcome)
}

async function consumeClaimed(
  inbox: ChildCommandInbox,
  childSessionId: string,
  command: ChildCommand | undefined,
  dispatch: (command: ChildCommand) => Promise<void>,
  reconcile?: (command: ChildCommand) => Promise<{ ok: boolean; content: string } | undefined>,
  onMarkFailed?: (command: ChildCommand) => void,
): Promise<ChildCommand | undefined> {
  if (!command) return undefined

  if (command.dispatchedAt) {
    // Keep the durable head of the queue claimed. Completing it as a failure
    // would admit later turns while an external effect may still be running.
    const outcome = await reconcile?.(command)
    return outcome ? inbox.completeChildCommand(childSessionId, command.commandId, outcome) : command
  }

  let marked: ChildCommand
  try {
    marked = await inbox.markChildCommandDispatched(childSessionId, command.commandId)
  } catch (error) {
    onMarkFailed?.(command)
    throw error
  }
  await dispatch(marked)
  const outcome = await reconcile?.(marked)
  return outcome ? inbox.completeChildCommand(childSessionId, command.commandId, outcome) : marked
}
