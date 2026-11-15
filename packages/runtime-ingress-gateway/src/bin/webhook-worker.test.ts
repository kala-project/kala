import { describe, expect, it, vi } from 'vitest'
import { scopedWebhookSecrets } from './webhook-worker.js'

describe('organization-scoped worker resolver authority', () => {
  it('passes the exact immutable organization reference and abort signal to the configured resolver', async () => {
    const resolve = vi.fn(async () => 'fictional-key')
    const signal = new AbortController().signal
    const reference = 'bao:organizations/org-a/webhooks/signing-v2#key'
    expect(await scopedWebhookSecrets({ resolve })({ ref: reference }, 'org-a', signal)).toBe('fictional-key')
    expect(resolve).toHaveBeenCalledWith(reference, signal)
  })

  it('rejects prefix-only matches, traversal, missing fields and foreign namespace before invoking the resolver', async () => {
    const resolve = vi.fn(async () => 'must-not-resolve')
    const scoped = scopedWebhookSecrets({ resolve })
    for (const reference of [
      { ref: 'bao:organizations/org-b/webhooks/key#value' },
      { ref: 'bao:organizations/org-a/webhooks/../identity#key' },
      { ref: 'bao:organizations/org-a/webhooks/%2e%2e/key#value' },
      { ref: 'bao:organizations/org-a/webhooks/key' },
      { ref: 'bao:organizations/org-a/webhooks/#key' },
      { ref: 'bao:organizations/org-a/webhooks/key#key#extra' }, { ref: 'file:/protected/key' }, null,
    ]) await expect(scoped(reference, 'org-a', new AbortController().signal)).rejects.toThrow('Webhook secret reference denied')
    expect(resolve).not.toHaveBeenCalled()
  })
})
