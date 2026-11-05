import { afterEach, describe, expect, it, vi } from 'vitest'

import { AdmissionDeliveryFailedError, AdmissionDeliveryPendingError, admissionOperationStatus, admitUserMessage, releaseMessageAttachments, uploadMessageAttachment } from './admission-client.js'

afterEach(() => { vi.unstubAllGlobals() })

describe('admitUserMessage', () => {
  it('uploads raw generic file bytes and returns a Host reference before admission', async () => {
    const file = new File(['plain text'], '../notes.txt', { type: 'text/plain' })
    const referenced = {
      type: 'file',
      name: 'notes.txt',
      mediaType: 'text/plain',
      source: {
        kind: 'host_ref',
        attachmentId: '00000000-0000-4000-8000-000000000000',
        sha256: 'a'.repeat(64),
        bytes: 10,
      },
    }
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ file: referenced }), { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(uploadMessageAttachment({
      host: 'https://runlab.example/',
      token: 'private-token',
      sessionId: 'session-1',
      file,
    })).resolves.toEqual(referenced)

    expect(fetchMock).toHaveBeenCalledWith(
      'https://runlab.example/runtime/attachments?sessionId=session-1',
      expect.objectContaining({
        method: 'POST',
        body: file,
        credentials: 'include',
        headers: expect.objectContaining({
          'content-type': 'text/plain',
          'x-agent-runlab-attachment-name': '..%2Fnotes.txt',
        }),
      }),
    )
  })

  it('releases pending Host references after an unaccepted submission', async () => {
    const file = {
      type: 'file',
      name: 'notes.txt',
      mediaType: 'text/plain',
      source: {
        kind: 'host_ref',
        attachmentId: '00000000-0000-4000-8000-000000000000',
        sha256: 'a'.repeat(64),
        bytes: 10,
      },
    } as const
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ released: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await releaseMessageAttachments({
      host: 'https://runlab.example/',
      token: 'private-token',
      sessionId: 'session-1',
      files: [file],
    })

    expect(fetchMock).toHaveBeenCalledWith(
      'https://runlab.example/runtime/attachments/release',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({
          sessionId: 'session-1',
          attachmentIds: [file.source.attachmentId],
        }),
      }),
    )
  })

  it('retries transport failure with one stable operation identity', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        accepted: true, duplicate: true, operationId: 'operation-0001', sequence: 8, state: 'committed', routeGeneration: 3,
      }), { status: 202, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(admitUserMessage({ host: 'https://runlab.example/', token: 'private-token', sessionId: 'session-1', operationId: 'operation-0001', text: 'continue', intent: 'text', mode: 'queue' })).resolves.toMatchObject({ accepted: true, duplicate: true, operationId: 'operation-0001' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    for (const call of fetchMock.mock.calls) {
      expect(call[0]).toBe('https://runlab.example/runtime/admission/messages')
      expect(call[1]).toMatchObject({ method: 'POST', credentials: 'include', headers: { authorization: 'Bearer private-token' } })
      expect(JSON.parse(String(call[1]?.body))).toMatchObject({ operationId: 'operation-0001', sessionId: 'session-1', intent: 'text' })
    }
  })

  it('does not retry a permanent validation failure', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: 'invalid admission message' }), { status: 400 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(admitUserMessage({ host: '', sessionId: 'session-1', operationId: 'operation-0002', text: 'bad', intent: 'text', mode: 'steer' })).rejects.toThrow('invalid admission message')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('preserves one operation identity when acknowledgement remains transport-ambiguous', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error('connection reset'))
    vi.stubGlobal('fetch', fetchMock)
    const result = admitUserMessage({
      host: '',
      sessionId: 'session-1',
      operationId: 'operation-uncertain',
      text: 'hello',
      intent: 'text',
      mode: 'steer',
      attempts: 3,
    })
    await expect(result).rejects.toMatchObject({
      durablyAccepted: true,
      operationId: 'operation-uncertain',
      attempts: 3,
      lastError: 'connection reset',
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('keeps a durable operation pending when attachment commitment returns retryable errors', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({
      error: 'attachment commitment unavailable',
      operationId: 'operation-attachment-pending',
      durablyAccepted: true,
    }), { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)
    const result = admitUserMessage({
      host: '',
      sessionId: 'session-1',
      operationId: 'operation-attachment-pending',
      text: '',
      intent: 'text',
      mode: 'queue',
      content: [{
        type: 'file',
        name: 'notes.md',
        mediaType: 'text/markdown',
        source: {
          kind: 'host_ref',
          attachmentId: '00000000-0000-4000-8000-000000000000',
          sha256: 'a'.repeat(64),
          bytes: 10,
        },
      }],
      attempts: 2,
    })
    await expect(result).rejects.toMatchObject({
      durablyAccepted: true,
      operationId: 'operation-attachment-pending',
      attempts: 2,
      lastError: 'attachment commitment unavailable',
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('waits for the durable operation to reach the Session log', async () => {
    const onAccepted = vi.fn()
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ accepted: true, duplicate: false, operationId: 'operation-0003', sequence: 9, state: 'pending', routeGeneration: 5 }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ operationId: 'operation-0003', sessionId: 'session-1', sequence: 9, state: 'pending', acceptedAt: new Date().toISOString(), routeGeneration: 5, attempts: 1 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ operationId: 'operation-0003', sessionId: 'session-1', sequence: 9, state: 'committed', acceptedAt: new Date().toISOString(), routeGeneration: 5, attempts: 2, sessionCursor: 44 }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(admitUserMessage({ host: '', sessionId: 'session-1', operationId: 'operation-0003', text: 'hello', intent: 'text', mode: 'steer', deliveryTimeoutMs: 2_000, onAccepted })).resolves.toMatchObject({ accepted: true })
    expect(onAccepted).toHaveBeenCalledWith(expect.objectContaining({ operationId: 'operation-0003', state: 'pending' }))
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      '/runtime/admission/messages',
      '/runtime/admission/messages/operation-0003',
      '/runtime/admission/messages/operation-0003',
    ])
  })

  it('reports server acceptance before waiting for Session commit', async () => {
    let finishStatus: ((response: Response) => void) | undefined
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        accepted: true, duplicate: false, operationId: 'slow-commit', sequence: 10, state: 'pending', routeGeneration: 5,
      }), { status: 202 }))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finishStatus = resolve }))
    vi.stubGlobal('fetch', fetchMock)
    const onAccepted = vi.fn()
    const operation = admitUserMessage({
      host: '', sessionId: 'session-1', operationId: 'slow-commit',
      text: 'continue', intent: 'text', mode: 'steer', onAccepted,
    })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(onAccepted).toHaveBeenCalledWith(expect.objectContaining({ state: 'pending', operationId: 'slow-commit' }))
    finishStatus?.(new Response(JSON.stringify({
      operationId: 'slow-commit', sessionId: 'session-1', sequence: 10, state: 'committed',
      acceptedAt: new Date().toISOString(), routeGeneration: 5, attempts: 1,
    }), { status: 200 }))
    await expect(operation).resolves.toMatchObject({ accepted: true })
  })

  it('treats a durably accepted queue message as queued without waiting for turn completion', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        accepted: true,
        duplicate: false,
        operationId: 'operation-queued',
        sequence: 10,
        state: 'pending',
        routeGeneration: 5,
      }), { status: 202 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(admitUserMessage({
      host: '',
      sessionId: 'session-1',
      operationId: 'operation-queued',
      text: 'later',
      intent: 'text',
      mode: 'queue',
      deliveryTimeoutMs: 1,
    })).resolves.toMatchObject({ accepted: true, state: 'pending' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('surfaces a durable pending error instead of silently treating HTTP 202 as delivery', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ accepted: true, duplicate: false, operationId: 'operation-0004', sequence: 10, state: 'pending', routeGeneration: 5 }), { status: 202 }))
      .mockResolvedValue(new Response(JSON.stringify({ operationId: 'operation-0004', sessionId: 'session-1', sequence: 10, state: 'pending', acceptedAt: new Date().toISOString(), routeGeneration: 5, attempts: 3, lastError: 'Runtime has not committed it' }), { status: 200 })))
    const result = admitUserMessage({ host: '', sessionId: 'session-1', operationId: 'operation-0004', text: 'hello', intent: 'text', mode: 'steer', deliveryTimeoutMs: 1 })
    await expect(result).rejects.toBeInstanceOf(AdmissionDeliveryPendingError)
  })

  it('surfaces a permanent durable delivery failure immediately', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ accepted: true, duplicate: false, operationId: 'operation-failed', sequence: 11, state: 'pending', routeGeneration: 5 }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ operationId: 'operation-failed', sessionId: 'deleted-session', sequence: 11, state: 'failed', acceptedAt: new Date().toISOString(), failedAt: new Date().toISOString(), routeGeneration: 5, attempts: 1, lastError: 'The target Session no longer exists' }), { status: 200 })))
    await expect(admitUserMessage({ host: '', sessionId: 'deleted-session', operationId: 'operation-failed', text: 'hello', intent: 'text', mode: 'steer', deliveryTimeoutMs: 2_000 }))
      .rejects.toBeInstanceOf(AdmissionDeliveryFailedError)
  })

  it('does not report an expired durable operation as delivered', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ accepted: true, duplicate: false, operationId: 'operation-expired', sequence: 12, state: 'pending', routeGeneration: 5 }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ operationId: 'operation-expired', sessionId: 'session-1', sequence: 12, state: 'expired', acceptedAt: new Date().toISOString(), routeGeneration: 5, attempts: 4 }), { status: 200 })))
    await expect(admitUserMessage({ host: '', sessionId: 'session-1', operationId: 'operation-expired', text: 'hello', intent: 'text', mode: 'steer', deliveryTimeoutMs: 2_000 }))
      .rejects.toMatchObject({ state: 'expired', durablyAccepted: true })
  })

  it('validates the operation status response', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ operationId: 'wrong', state: 'committed', attempts: 1 }), { status: 200 })))
    await expect(admissionOperationStatus({ host: '', operationId: 'operation-0005' })).rejects.toThrow('invalid admission operation status')
  })
})
