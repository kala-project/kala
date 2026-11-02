import { createHash, createHmac, randomUUID } from 'node:crypto'
import { redactForPersistence } from '@agent-kernel/shared'
import type { ControlPlaneDatabase } from '../persistence/postgres.js'

type Event = { id: string; organization_id: string | null; topic: string; occurred_at: string }
type Claim = { event_id: string; endpoint_id: string; organization_id: string; destination_url: string; secret_ref: unknown;
  lease_token: string | null; lease_generation: string; attempt_count: number; state: string; topic: string; payload: unknown; payload_valid: boolean }
type FailureCode = 'request_failed' | 'delivery_timeout' | 'secret_unavailable' | 'destination_rejected' |
  'payload_rejected' | 'http_rejected' | 'attempts_exhausted' | 'endpoint_changed' | 'worker_stopping'
type Outcome = 'delivered' | 'retried' | 'dead' | 'cancelled' | 'stale'
export type DeliveryBatchResult = Record<Outcome | 'materialized' | 'claimed', number>
export type WebhookWorkerOptions = {
  resolveSecret(ref: unknown, organizationId: string, signal: AbortSignal): Promise<string>
  allowedOrigins: readonly string[]
  allowLoopbackHttp?: boolean
  fetchImpl?: typeof fetch
  maxAttempts?: number
  concurrency?: number
  leaseMs?: number
  requestTimeoutMs?: number
  maxPayloadBytes?: number
}

/** PostgreSQL owns all progress; network/secret I/O is never inside a transaction. */
export class WebhookOutboxWorker {
  private readonly origins: Set<string>
  private readonly concurrency: number
  private readonly leaseMs: number
  private readonly timeoutMs: number
  private readonly maxAttempts: number
  private readonly maxBytes: number
  constructor(private readonly database: ControlPlaneDatabase, private readonly options: WebhookWorkerOptions) {
    this.concurrency = integer(options.concurrency ?? 4, 1, 16)
    this.leaseMs = integer(options.leaseMs ?? 30_000, 1_000, 120_000)
    this.timeoutMs = integer(options.requestTimeoutMs ?? 10_000, 100, this.leaseMs - 1)
    this.maxAttempts = integer(options.maxAttempts ?? 10, 1, 100)
    this.maxBytes = integer(options.maxPayloadBytes ?? 65_536, 1_024, 1_048_576)
    this.origins = new Set(options.allowedOrigins.map((value) => {
      const url = new URL(value)
      if (url.origin !== value || !safeDestination(url, options.allowLoopbackHttp)) throw new Error('Invalid webhook origin policy')
      return url.origin
    }))
    if (!this.origins.size) throw new Error('Webhook origin policy is required')
  }

  /** Compatibility entrypoint: returns delivered endpoint count, not event count. */
  async deliverBatch(limit = 50): Promise<number> { return (await this.runBatch(limit)).delivered }

  async runBatch(limit = 50, signal?: AbortSignal): Promise<DeliveryBatchResult> {
    integer(limit, 1, 100)
    const result: DeliveryBatchResult = { materialized: 0, claimed: 0, delivered: 0, retried: 0, dead: 0, cancelled: 0, stale: 0 }
    if (signal?.aborted) return result
    result.materialized = await this.materialize(Math.min(limit, 20))
    while (result.claimed < limit && !signal?.aborted) {
      // Claim only immediately executable slots, never an entire batch whose
      // leases would expire while waiting behind slow endpoints.
      const claims = await this.claim(Math.min(this.concurrency, limit - result.claimed))
      if (!claims.length) break
      result.claimed += claims.length
      const outcomes = await Promise.all(claims.map((claim) => claim.state === 'dead'
        ? Promise.resolve<Outcome>('dead') : this.deliver(claim, signal)))
      for (const outcome of outcomes) result[outcome] += 1
    }
    return result
  }

  private async materialize(limit: number): Promise<number> {
    return this.database.transaction(async (tx) => {
      const events = await tx.query<Event & Record<string, unknown>>(`SELECT id, organization_id, topic, occurred_at::text AS occurred_at
        FROM outbox_events WHERE webhook_fanout_state='pending' AND available_at<=clock_timestamp()
        ORDER BY occurred_at,id FOR UPDATE SKIP LOCKED LIMIT $1`, [limit])
      for (const event of events.rows) {
        const endpoints = event.organization_id ? await tx.query(`SELECT id,url,secret_ref,delivery_generation AS endpoint_generation FROM webhook_endpoints
          WHERE organization_id=$1 AND enabled AND $2=ANY(topics) AND created_at<=$3
          ORDER BY id LIMIT 101`, [event.organization_id, event.topic, event.occurred_at]) : { rows: [] }
        const fanoutError = endpoints.rows.length > 100 ? 'recipient_limit' : endpoints.rows.some((endpoint) =>
          !endpoint.secret_ref || typeof endpoint.secret_ref !== 'object' || Array.isArray(endpoint.secret_ref)) ? 'invalid_endpoint' : undefined
        if (fanoutError) {
          await tx.query(`UPDATE outbox_events SET webhook_fanout_state='blocked',webhook_fanout_error=$2
            WHERE id=$1`, [event.id, fanoutError])
          continue
        }
        await tx.query(`INSERT INTO webhook_deliveries(event_id,endpoint_id,organization_id,destination_url,secret_ref,endpoint_generation)
          SELECT $1,endpoint.id,$2,endpoint.url,endpoint.secret_ref,endpoint.endpoint_generation
          FROM jsonb_to_recordset($3::jsonb) AS endpoint(id text,url text,secret_ref jsonb,endpoint_generation bigint)
          ON CONFLICT(event_id,endpoint_id) DO NOTHING`, [event.id, event.organization_id, JSON.stringify(endpoints.rows)])
        await tx.query(`UPDATE outbox_events SET webhook_fanout_state='complete',webhook_materialized_at=clock_timestamp()
          WHERE id=$1`, [event.id])
      }
      return events.rows.length
    })
  }

  private async claim(limit: number): Promise<Claim[]> {
    return this.database.transaction(async (tx) => {
      const claimed = await tx.query<Claim & Record<string, unknown>>(`WITH ready AS (
        SELECT event_id,endpoint_id FROM webhook_deliveries
        WHERE (state='pending' AND available_at<=clock_timestamp())
          OR (state='inflight' AND lease_expires_at<=clock_timestamp())
        ORDER BY available_at,event_id,endpoint_id FOR UPDATE SKIP LOCKED LIMIT $1
      ), claimed AS (
        UPDATE webhook_deliveries AS delivery SET
          state=CASE WHEN attempt_count >= $4 THEN 'dead' ELSE 'inflight' END,
          lease_token=CASE WHEN attempt_count >= $4 THEN NULL ELSE $2::uuid END,
          lease_expires_at=CASE WHEN attempt_count >= $4 THEN NULL ELSE clock_timestamp()+$3*interval '1 millisecond' END,
          lease_generation=lease_generation+1,
          last_error=CASE WHEN attempt_count >= $4 THEN 'attempts_exhausted' ELSE last_error END,
          completed_at=CASE WHEN attempt_count >= $4 THEN clock_timestamp() ELSE NULL END,
          attempt_count=CASE WHEN attempt_count >= $4 THEN attempt_count ELSE attempt_count+1 END,
          updated_at=clock_timestamp()
        FROM ready WHERE delivery.event_id=ready.event_id AND delivery.endpoint_id=ready.endpoint_id
        RETURNING delivery.*
      ) SELECT claimed.*,event.topic,octet_length(event.payload::text)<=$5 AS payload_valid,
        CASE WHEN octet_length(event.payload::text)<=$5 THEN event.payload ELSE '{}'::jsonb END AS payload FROM claimed
        JOIN outbox_events AS event ON event.id=claimed.event_id AND event.organization_id=claimed.organization_id`,
      [limit, randomUUID(), this.leaseMs, this.maxAttempts, this.maxBytes])
      return claimed.rows
    })
  }

  private async eligibility(claim: Claim): Promise<'ready' | 'cancelled' | 'stale'> {
    const result = await this.database.query<{ live: boolean; current_endpoint: boolean }>(`SELECT
        (delivery.state='inflight' AND delivery.lease_token=$3::uuid AND delivery.lease_generation=$4
          AND delivery.lease_expires_at>clock_timestamp()) AS live,
        (endpoint.enabled AND endpoint.delivery_generation=delivery.endpoint_generation AND endpoint.url=delivery.destination_url AND endpoint.secret_ref=delivery.secret_ref) AS current_endpoint
      FROM webhook_deliveries AS delivery JOIN webhook_endpoints AS endpoint
        ON endpoint.id=delivery.endpoint_id AND endpoint.organization_id=delivery.organization_id
      WHERE delivery.event_id=$1 AND delivery.endpoint_id=$2`,
    [claim.event_id, claim.endpoint_id, claim.lease_token, claim.lease_generation])
    if (!result.rows[0]?.live) return 'stale'
    return result.rows[0].current_endpoint ? 'ready' : 'cancelled'
  }

  private async deliver(claim: Claim, stopping?: AbortSignal): Promise<Outcome> {
    let error: FailureCode | undefined
    let status: number | undefined
    let terminal = false
    const signal = stopping ? AbortSignal.any([stopping, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs)
    try {
      let url: URL
      try { url = new URL(claim.destination_url) } catch { throw new DeliveryFailure('destination_rejected', true) }
      if (!claim.payload_valid) throw new DeliveryFailure('payload_rejected', true)
      if (!safeDestination(url, this.options.allowLoopbackHttp) || !this.origins.has(url.origin)) throw new DeliveryFailure('destination_rejected', true)
      const check = await beforeDeadline(signal, () => this.eligibility(claim))
      if (check === 'stale') return 'stale'
      if (check === 'cancelled') return this.finish(claim, 'cancelled', 'endpoint_changed')
      const deliveryId = webhookDeliveryId(claim.event_id, claim.endpoint_id)
      const body = JSON.stringify({ schemaVersion: 1, id: claim.event_id, deliveryId, topic: claim.topic,
        organizationId: claim.organization_id, payload: redactForPersistence(claim.payload, { maxStringLength: 20_000 }).value })
      if (Buffer.byteLength(body) > this.maxBytes) throw new DeliveryFailure('payload_rejected', true)
      await beforeDeadline(signal, async () => {
        let secret: string
        try { secret = await this.options.resolveSecret(claim.secret_ref, claim.organization_id, signal) }
        catch { throw new DeliveryFailure('secret_unavailable') }
        signal.throwIfAborted()
        if (!secret) throw new DeliveryFailure('secret_unavailable')
        const eligible = await this.eligibility(claim)
        signal.throwIfAborted()
        if (eligible !== 'ready') throw new DeliveryFailure(eligible === 'stale' ? 'attempts_exhausted' : 'endpoint_changed')
        const response = await (this.options.fetchImpl ?? fetch)(url.toString(), {
          method: 'POST', redirect: 'error', signal,
          headers: { 'content-type': 'application/json', 'x-agent-runlab-event-id': claim.event_id,
            'x-agent-runlab-delivery-id': deliveryId,
            'x-agent-runlab-signature': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` }, body,
        })
        status = response.status
        await response.body?.cancel()
        if (!response.ok || response.redirected) throw new DeliveryFailure('http_rejected')
      })
      return this.finish(claim, 'delivered', undefined, status)
    } catch (failure) {
      error = stopping?.aborted ? 'worker_stopping' : signal.aborted ? 'delivery_timeout'
        : failure instanceof DeliveryFailure ? failure.code : 'request_failed'
      terminal = failure instanceof DeliveryFailure && failure.terminal
    }
    if (error === 'endpoint_changed') return this.finish(claim, 'cancelled', error, status)
    return this.finish(claim, terminal || claim.attempt_count >= this.maxAttempts ? 'dead' : 'pending', error, status)
  }

  private async finish(claim: Claim, state: 'delivered' | 'pending' | 'dead' | 'cancelled', error?: FailureCode, status?: number): Promise<Outcome> {
    // Lock first, then evaluate expiry. A plain UPDATE can evaluate its WHERE
    // before waiting for a row lock and acknowledge after the lease has expired.
    const result = await this.database.query(`WITH locked AS MATERIALIZED (
        SELECT event_id,endpoint_id,state,lease_token,lease_generation,lease_expires_at
        FROM webhook_deliveries WHERE event_id=$1 AND endpoint_id=$2 FOR UPDATE
      ), eligible AS MATERIALIZED (
        SELECT event_id,endpoint_id FROM locked WHERE state='inflight' AND lease_token=$3::uuid
          AND lease_generation=$4 AND lease_expires_at>clock_timestamp()
      ) UPDATE webhook_deliveries AS delivery SET state=$5,
        available_at=CASE WHEN $5='pending' THEN clock_timestamp()+LEAST(3600,5*power(2,LEAST(attempt_count-1,10)))*interval '1 second' ELSE available_at END,
        last_error=$6,last_status=$7,lease_token=NULL,lease_expires_at=NULL,
        completed_at=CASE WHEN $5='pending' THEN NULL ELSE clock_timestamp() END,updated_at=clock_timestamp()
      FROM eligible WHERE delivery.event_id=eligible.event_id AND delivery.endpoint_id=eligible.endpoint_id`,
    [claim.event_id, claim.endpoint_id, claim.lease_token, claim.lease_generation, state, error ?? null, status ?? null])
    return result.rowCount !== 1 ? 'stale' : state === 'pending' ? 'retried' : state
  }
}

export function webhookDeliveryId(eventId: string, endpointId: string): string {
  return createHash('sha256').update(JSON.stringify([eventId, endpointId])).digest('hex')
}
function safeDestination(url: URL, loopbackHttp = false): boolean {
  return (url.protocol === 'https:' || (loopbackHttp && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    && !url.username && !url.password && !url.search && !url.hash
}
function integer(value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error('Invalid webhook worker bound')
  return value
}
class DeliveryFailure extends Error {
  constructor(readonly code: FailureCode, readonly terminal = false) { super(code) }
}
async function beforeDeadline<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  signal.throwIfAborted()
  let abort!: () => void
  const deadline = new Promise<never>((_, reject) => {
    abort = () => reject(new DeliveryFailure('delivery_timeout'))
    signal.addEventListener('abort', abort, { once: true })
  })
  try { return await Promise.race([operation(), deadline]) }
  finally { signal.removeEventListener('abort', abort) }
}
