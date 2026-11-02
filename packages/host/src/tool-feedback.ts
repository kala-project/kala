import type { ToolFailure } from '@agent-kernel/kernel'

type Feedback = { happened: string; next: string; state?: string }
type FailureInput = { content: string; toolName?: string; failure?: ToolFailure; denied?: boolean }

const guidance: Readonly<Record<string, Feedback>> = {
  EINVAL: {
    happened: 'The tool rejected an argument or operation. The exact reason is in Details.',
    next: 'Check the current tool schema and rejected field; correct the request instead of submitting it unchanged.',
  },
  ENOENT: {
    happened: 'A required target was not found. Details identify the missing target.',
    next: 'Verify the target in the current workspace or tool state and correct its path or ID. Do not create or delete unrelated data just to suppress this error.',
  },
  EISDIR: {
    happened: 'The target is a directory, but this operation requires a file.',
    next: 'List the directory to locate the intended file, or use a directory operation.',
  },
  EAMBIG: {
    happened: 'The edit matches more than one location and cannot be applied unambiguously.',
    next: 'Read the current file and supply unique surrounding context. Use replace_all only if changing every occurrence is intended; do not force an overwrite.',
  },
  ENOTFOUND: {
    happened: 'The required target or edit context was not found in the current state.',
    next: 'Inspect the current target and revise the request using exact current context. Do not retry stale text or overwrite the file to force success.',
  },
  ESTALE: {
    happened: 'The target changed or its revision no longer matches the request.',
    next: 'Read the latest state and rebase the intended change using its current revision. Preserve unrelated changes; do not disable revision protection.',
  },
  ECONFLICT: {
    happened: 'The request conflicts with the current state. Details describe the conflict.',
    next: 'Inspect the latest state and revise only the intended operation. Do not clear unfinished work or discard concurrent changes to bypass the conflict.',
  },
  EEXIST: {
    happened: 'The destination already exists.',
    next: 'Inspect the existing destination and choose the intended target or operation. Do not delete it merely to force this request to succeed.',
  },
  EPATCHPARSE: {
    happened: 'The patch format could not be parsed.',
    next: 'Correct the reported format error using the Kala patch schema, including Begin/End Patch markers and separate @@ hunks; do not repeat the malformed patch.',
  },
  ECHAIN: {
    happened: 'An edit depends on text introduced by an earlier edit in the same request.',
    next: 'Read the current file and express the intended change as one coherent replacement or non-chained hunks. Do not bypass the edit safety check.',
  },
  ECYCLE: {
    happened: 'The graph change would create a dependency cycle.',
    next: 'Revise the proposed edges to express genuine prerequisites without a cycle. Do not delete unrelated tasks to bypass validation.',
  },
  EBLOCKED: {
    happened: 'The requested work still has incomplete prerequisites.',
    next: 'Complete and verify the actual prerequisites first, or correct an erroneous dependency. Do not mark unfinished work complete just to bypass the guard.',
  },
  E2BIG: {
    happened: 'The requested input or output exceeds a tool limit.',
    next: 'Use the limit named in Details to narrow the batch, search scope or read. Do not repeat the same oversized request or blindly raise resource/security limits.',
  },
  ELIMIT: {
    happened: 'The request exceeds a tool limit.',
    next: 'Reduce the request according to the limit in Details; preserve unfinished work rather than silently dropping it.',
  },
  EBINARY: {
    happened: 'The file cannot be rendered as UTF-8 text.',
    next: 'Use an appropriate file/image preview or authorized text extraction method instead of repeating the same text read.',
  },
  ESEARCH_QUOTA: {
    happened: 'The search provider reported exhausted credits.',
    next: 'Report the provider-account blocker and resolve billing through an authorized user. Do not repeat searches, switch accounts or borrow credentials to bypass it.',
  },
  ESEARCH_CREDENTIAL: {
    happened: 'The search credential is missing or provider authentication was rejected.',
    next: 'Report the credential/configuration blocker and use an explicitly authorized configuration flow. Do not guess, print or borrow credentials.',
  },
}

/** Model-facing explanation, separate from machine classification and tool data.
 * Do not infer completion/rollback from ok=false or retry safety from retryable.
 * Prefix recovery guidance before diagnostics so output caps keep it visible.
 */
export function formatToolFailureForAgent(input: FailureInput): string {
  const diagnostic = input.content.startsWith('ERROR:') ? input.content.slice(6).trimStart() : input.content
  const prefixCode = /^([A-Z][A-Z0-9_]{1,63})(?::|$)/.exec(diagnostic)?.[1]
  const code = input.failure?.code ?? prefixCode
  let feedback: Feedback
  if (input.denied) {
    feedback = {
      happened: 'Approval for this operation was denied.',
      next: 'Do not execute the denied operation through another tool or retry it unchanged. Continue only with an authorized alternative or new applicable user authorization.',
    }
  } else if (input.failure?.outcome === 'indeterminate' || code === 'tool_ack_timeout') {
    feedback = {
      happened: 'The result was not confirmed. Completion and side effects are unknown; this is not proof the operation failed to run or stopped.',
      next: 'Inspect the existing task, output and current effects before retrying. Do not launch a duplicate or blindly repeat a state-changing operation.',
    }
  } else if (input.failure?.outcome === 'cancelled' || code === 'ECANCELED' || input.content === 'cancelled') {
    feedback = {
      happened: 'The operation was cancelled. Cancellation does not roll back earlier effects.',
      next: 'Do not restart automatically. Inspect current effects if needed and resume only when the current request still authorizes it.',
    }
  } else if (code === 'EPARTIAL') {
    feedback = partialFeedback(input.toolName)
  } else if (['EACCES', 'EPERM', 'ENETWORKPOLICY'].includes(code ?? '')) {
    feedback = {
      happened: 'Access or policy restrictions blocked the operation.',
      next: 'Verify the target and use an authorized scope or source; report the permission blocker if needed. Do not widen the sandbox, borrow credentials or bypass the restriction through another tool.',
    }
  } else if (code === 'EHTTP') {
    const status = /\bHTTP\s+([45]\d\d)\b/i.exec(input.content)?.[1]
    feedback = status === '401' || status === '403'
      ? { happened: `The remote service rejected access (HTTP ${status}).`, next: 'Use an authorized source or configuration flow. Do not bypass access restrictions or blindly repeat the same request.' }
      : status === '404'
        ? { happened: 'The remote resource was not found (HTTP 404).', next: 'Verify the URL or find the resource through its official source; do not keep fetching the same missing URL.' }
        : status === '429'
          ? { happened: 'The remote service rate-limited the request (HTTP 429).', next: 'Back off and honor any supplied Retry-After guidance. Retry only when appropriate, not in a tight loop.' }
          : { happened: 'The remote service returned an unsuccessful HTTP response.', next: 'Inspect the status and reason in Details before choosing a bounded retry or another authorized source. For state-changing requests, check effects before retrying.' }
  } else if (code === 'ETIMEDOUT') {
    feedback = {
      happened: 'The tool exceeded its waiting time. The timeout alone does not establish whether earlier effects occurred.',
      next: 'Inspect existing task/output and effects before retrying writes. Narrow the request or use background execution with bounded polling for long commands; do not start a duplicate blindly.',
    }
  } else {
    feedback = (code && Object.hasOwn(guidance, code) ? guidance[code] : undefined) ?? {
      happened: 'The tool reported an unsuccessful result. This status alone does not establish completion or side effects.',
      next: 'Read the diagnostic details and inspect current state before retrying. If the cause remains unclear, report the blocker instead of guessing, forcing an overwrite or changing permissions.',
    }
  }
  // Codes remain useful for machines, but are never the only explanation.
  const safeCode = code && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(code) ? code : undefined
  return [
    `What happened: ${feedback.happened}`,
    ...(feedback.state ? [`State: ${feedback.state}`] : []),
    `Next step: ${feedback.next}`,
    ...(safeCode ? [`Error code: ${safeCode}`] : []),
    '',
    'Details:',
    input.content.trim() ? input.content : 'No further diagnostic details were returned.',
  ].join('\n')
}

function partialFeedback(toolName?: string): Feedback {
  const happened = 'The batch was not fully successful. Some items failed; this does not mean every item failed.'
  if (toolName === 'apply_file_patch') return {
    happened,
    state: 'Earlier file operations may already be applied; a batch error is not a rollback. Use the applied-operation receipt for confirmed effects.',
    next: 'Inspect the receipt and current files, correct the cause and apply only remaining changes. Do not replay the entire patch. If the receipt is missing, inspect state before choosing what to retry.',
  }
  if (toolName === 'read_files' || toolName === 'multi_grep') return {
    happened,
    state: 'Preserved successful sections remain usable. Failed or truncated sections are not evidence of no matches or a complete read.',
    next: 'Use the successful sections and correct/retry only failed or omitted items. If details are missing or truncated, narrow the request or increase the supported output budget before drawing conclusions.',
  }
  return {
    happened,
    state: 'Completion of unreported items and any rollback are not established by this error code.',
    next: 'Inspect individual outcomes and current effects, then correct/retry only unfinished work. Do not assume rollback or blindly repeat the entire batch.',
  }
}
