import { describe, expect, it } from 'vitest'

import { effectiveAttachmentLimit } from './message-attachment-policy.js'

describe('effectiveAttachmentLimit', () => {
  it('uses the trusted organization limit only for ingress and defaults legacy requests to 2 MiB', () => {
    const header = { 'x-agent-runlab-attachment-max-bytes': String(8 * 1024 * 1024) }
    expect(effectiveAttachmentLimit(header, true)).toBe(8 * 1024 * 1024)
    expect(effectiveAttachmentLimit(header, false)).toBe(2 * 1024 * 1024)
    expect(effectiveAttachmentLimit({}, true)).toBe(2 * 1024 * 1024)
    expect(() => effectiveAttachmentLimit({ 'x-agent-runlab-attachment-max-bytes': 'not-a-limit' }, true)).toThrow('invalid organization attachment limit')
  })
})
