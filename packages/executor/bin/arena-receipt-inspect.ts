import { createHash } from 'node:crypto'
import { ExecutionReceiptStore } from '../src/execution-receipts.js'

const [path, sessionId, callId] = process.argv.slice(2)
if (!path || !sessionId || !callId || !/^arena-(probe|init|apply|cleanup|status|diff)-[A-Z0-9]+$/u.test(callId)) {
  console.error('Usage: tsx bin/arena-receipt-inspect.ts <receipt-journal-path> <session-id> <arena-call-id>')
  process.exitCode = 2
} else {
  const journal = new ExecutionReceiptStore(path)
  await journal.load()
  const receipt = journal.inspectArena(`${sessionId}:${callId}`)
  const text = JSON.stringify(receipt)
  console.log(text.length <= 64_000 ? text : JSON.stringify({
    state: receipt.state, ownerGeneration: receipt.ownerGeneration,
    requestDigest: receipt.requestDigest, resultBytes: Buffer.byteLength(text),
    resultSha256: createHash('sha256').update(text).digest('hex'),
    message: 'Receipt exceeds 64 KiB; inspect the original journal locally before any reconciliation.',
  }))
}
