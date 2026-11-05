/** Exhaust the Unit's keyed-create capacity rather than evict a key that could be replayed. */
export const MAX_CREATE_RECEIPTS = 10_000

export function assertCreateReceiptCapacity(state: { createReceipts?: readonly unknown[] }): void {
  if ((state.createReceipts?.length ?? 0) >= MAX_CREATE_RECEIPTS) {
    throw new Error('scheduled task create receipt capacity exhausted; new idempotency keys cannot be accepted')
  }
}
