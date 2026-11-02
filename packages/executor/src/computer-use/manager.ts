import { createHash, randomUUID } from 'node:crypto'
import {
  ComputerInputActionSchema, ComputerRequestSchema, ComputerScreenshotSchema,
  ComputerSemanticRequestSchema, ComputerObservationSchema,
  COMPUTER_SCREENSHOT_KIND,
  type ComputerRequest, type ComputerResponse, type ComputerStatus,
} from '@agent-kernel/shared'
import { createConfiguredDesktopDriver, type ConfiguredDesktopDriver } from './companion.js'
import { ToolError, type Tool } from '../tools/registry.js'

export const COMPUTER_LEASE_MS = 30_000
type Driver = ConfiguredDesktopDriver
type Lease = {
  id: string
  sessionId: string
  owner: string
  allowAgent: boolean
  expiresAt: number
  controller: AbortController
  agentController: AbortController
  automatic?: boolean
}

export class ComputerUseManager {
  private lease: Lease | undefined
  private queue: Promise<unknown> = Promise.resolve()
  private readonly recent = new Map<string, { fingerprint: string; response: ComputerResponse }>()
  private expiryTimer: ReturnType<typeof setTimeout> | undefined
  private pending = 0
  private releasing = Promise.resolve()
  private releaseError: string | undefined
  private closing: Promise<void> | undefined
  private readonly pausedSessions = new Set<string>()
  private featurePolicy = { computerUseEnabled: true, desktopPreviewEnabled: true }

  setFeaturePolicy(policy: { computerUseEnabled: boolean; desktopPreviewEnabled: boolean }): void {
    this.featurePolicy = policy
    if (!policy.computerUseEnabled || (!policy.desktopPreviewEnabled && this.lease && !this.lease.automatic)) this.revoke()
  }

  constructor(
    private readonly driver: Driver = createConfiguredDesktopDriver(),
    private readonly enabled = process.env.KALA_COMPUTER_USE_ENABLED === '1',
    private readonly now: () => number = Date.now,
  ) {}

  private expire(): void {
    if (this.lease && this.lease.expiresAt <= this.now()) this.revoke()
  }

  revoke(): void {
    if (!this.lease) return
    this.lease?.controller.abort()
    this.lease.agentController.abort()
    this.lease = undefined
    clearTimeout(this.expiryTimer)
    this.expiryTimer = undefined
    this.recent.clear()
    this.releaseNative(true)
  }

  private releaseNative(revokeClaim = false): void {
    this.releasing = this.releasing.then(() => revokeClaim && this.driver.releaseClaim ? this.driver.releaseClaim() : this.driver.releaseInputs()).catch((error: unknown) => {
      this.releaseError = `Desktop input cleanup failed; restart the local desktop connection before sharing again: ${error instanceof Error ? error.message : String(error)}`
    })
  }

  private scheduleExpiry(): void {
    clearTimeout(this.expiryTimer)
    this.expiryTimer = setTimeout(() => this.expire(), COMPUTER_LEASE_MS + 1)
    this.expiryTimer.unref()
  }

  async status(manualAuthorizationRequired = true, includePolicy = false, includeFeatures = false, preview = false): Promise<ComputerStatus> {
    if (this.closing) return { available: false, platform: process.platform, reason: 'The desktop connection is closed', active: false, allowAgent: false }
    this.expire()
    await this.releasing
    const native = !this.featurePolicy.computerUseEnabled || (preview && !this.featurePolicy.desktopPreviewEnabled)
      ? { available: false, platform: process.platform, reason: !this.featurePolicy.computerUseEnabled ? 'Computer Use is disabled in administrator Settings.' : 'Desktop preview is disabled in administrator Settings.' }
      : this.releaseError
      ? { available: false, platform: process.platform, reason: this.releaseError }
      : this.enabled || !manualAuthorizationRequired
      ? await this.driver.status()
      : { available: false, platform: process.platform, reason: 'Desktop sharing is disabled on this Executor. Enable KALA_COMPUTER_USE_ENABLED=1 on the Executor. A Windows service also requires a configured companion running in the logged-in desktop session.' }
    if (!native.available && this.lease && !(preview && !this.featurePolicy.desktopPreviewEnabled && this.featurePolicy.computerUseEnabled && this.lease.automatic)) this.revoke()
    await this.releasing
    const lease = this.lease
    return {
      ...native, active: Boolean(lease), allowAgent: lease?.allowAgent ?? false,
      ...(includePolicy ? { manualAuthorizationRequired, automatic: lease?.automatic ?? false } : {}),
      ...(includeFeatures ? this.featurePolicy : {}),
      ...(lease ? { sessionId: lease.sessionId, expiresAt: lease.expiresAt } : {}),
    }
  }

  private authorized(sessionId: string, owner?: string, leaseId?: string): Lease {
    this.expire()
    const lease = this.lease
    if (!lease) throw new ToolError('EACCES', 'Desktop authorization has expired or was stopped. Ask the user to enable it in the Computer panel.')
    if (lease.sessionId !== sessionId) throw new ToolError('EACCES', 'Another session owns this desktop')
    if (owner !== undefined && (lease.owner !== owner || lease.id !== leaseId)) throw new ToolError('EACCES', 'Desktop control belongs to a different connection')
    if (owner === undefined && !lease.allowAgent) throw new ToolError('EACCES', 'Agent desktop control is paused; only the user can authorize it')
    return lease
  }

  async request(input: ComputerRequest, owner: string, signal: AbortSignal, manualAuthorizationRequired = true): Promise<ComputerResponse> {
    const parsed = ComputerRequestSchema.safeParse(input)
    if (!parsed.success) return { requestId: input?.requestId ?? '', error: { code: 'invalid_request', message: parsed.error.message } }
    if (!owner) return { requestId: input.requestId, error: { code: 'denied', message: 'Missing desktop controller identity' } }
    const request = parsed.data
    const includePolicy = request.policyStatusVersion !== undefined
    const includeFeatures = request.policyStatusVersion === 2
    if (request.operation !== 'status' && request.operation !== 'stop' &&
      (!this.featurePolicy.computerUseEnabled || !this.featurePolicy.desktopPreviewEnabled)) {
      return { requestId: request.requestId, error: { code: 'denied', message: 'Desktop preview is disabled in administrator Settings.' } }
    }
    if (request.operation === 'start' && !signal.aborted && this.lease?.automatic && this.lease.sessionId === request.sessionId) {
      this.pausedSessions.add(request.sessionId)
      this.lease.allowAgent = false
      this.lease.agentController.abort()
      this.releaseNative()
    }
    if (request.operation === 'stop') {
      try {
        this.authorized(request.sessionId, owner, request.leaseId)
        this.pausedSessions.add(request.sessionId)
        this.revoke()
        const status = await this.status(manualAuthorizationRequired, includePolicy, includeFeatures, true)
        if (this.releaseError) throw new Error(this.releaseError)
        return { requestId: request.requestId, status }
      } catch (error) { return this.failure(request.requestId, error) }
    }
    if (request.operation === 'agent' && !request.allowAgent || request.operation === 'input') {
      try {
        const lease = this.authorized(request.sessionId, owner, request.leaseId)
        this.pausedSessions.add(request.sessionId)
        if (lease.allowAgent || request.operation === 'agent') {
          lease.agentController.abort()
          lease.agentController = new AbortController()
          lease.allowAgent = false
          this.releaseNative()
        }
        if (request.operation === 'agent') {
          const status = await this.status(manualAuthorizationRequired, includePolicy, includeFeatures, true)
          if (this.releaseError) throw new Error(this.releaseError)
          return { requestId: request.requestId, status }
        }
      } catch (error) { return this.failure(request.requestId, error) }
    }
    const key = `${owner}:${request.sessionId}:${request.requestId}`
    const fingerprint = createHash('sha256').update(JSON.stringify(request)).digest('hex')
    if (request.operation === 'renew') {
      try {
        if (signal.aborted) throw new ToolError('ECANCELED', 'Desktop request cancelled')
        await this.releasing
        if (this.releaseError) throw new ToolError('EACCES', this.releaseError)
        const lease = this.authorized(request.sessionId, owner, request.leaseId)
        const previous = this.recent.get(key)
        if (previous) {
          if (previous.fingerprint !== fingerprint) throw new ToolError('EINVAL', 'A desktop request ID cannot be reused with different arguments')
          return previous.response
        }
        lease.expiresAt = this.now() + COMPUTER_LEASE_MS
        this.scheduleExpiry()
        // A heartbeat must not queue behind native I/O or start another native operation.
        const result: ComputerResponse = {
          requestId: request.requestId,
          status: { available: true, platform: process.platform, active: true, sessionId: lease.sessionId, allowAgent: lease.allowAgent, expiresAt: lease.expiresAt,
            ...(includePolicy ? { manualAuthorizationRequired, automatic: lease.automatic ?? false } : {}),
            ...(includeFeatures ? this.featurePolicy : {}) },
        }
        this.remember(key, fingerprint, result)
        return result
      } catch (error) { return this.failure(request.requestId, error) }
    }
    return this.serialized<ComputerResponse>(async () => {
      try {
        if (request.operation !== 'status' && (!this.featurePolicy.computerUseEnabled || !this.featurePolicy.desktopPreviewEnabled)) throw new ToolError('EACCES', 'Desktop preview is disabled in administrator Settings.')
        if (signal.aborted) throw new ToolError('ECANCELED', 'Desktop request cancelled')
        await this.releasing
        if (this.releaseError) throw new ToolError('EACCES', this.releaseError)
        if (request.operation === 'status') return { requestId: request.requestId, status: await this.status(manualAuthorizationRequired, includePolicy, includeFeatures, true) }
        const previous = this.recent.get(key)
        if (previous) {
          if (previous.fingerprint !== fingerprint) throw new ToolError('EINVAL', 'A desktop request ID cannot be reused with different arguments')
          return previous.response
        }
        if (request.operation === 'start') {
          const status = await this.status(manualAuthorizationRequired, includePolicy, includeFeatures, true)
          if (!status.available) return { requestId: request.requestId, status, error: { code: 'unavailable', message: status.reason ?? 'Desktop is unavailable' } }
          const takeover = this.lease?.automatic && this.lease.sessionId === request.sessionId
          if (this.lease && !takeover) return { requestId: request.requestId, status, error: { code: 'busy', message: 'This desktop already has a controller. Stop it or wait for its authorization to expire.' } }
          if (takeover) {
            this.lease!.controller.abort()
            this.lease!.agentController.abort()
          } else {
            await this.driver.acquire?.()
          }
          if (signal.aborted || this.closing) {
            if (takeover) {
              this.revoke()
              await this.releasing
              if (this.releaseError) throw new ToolError('EACCES', this.releaseError)
            } else if (this.driver.releaseClaim) await this.driver.releaseClaim()
            else await this.driver.releaseInputs()
            throw new ToolError('ECANCELED', 'Desktop request cancelled')
          }
          this.lease = { id: randomUUID(), sessionId: request.sessionId, owner, allowAgent: request.allowAgent, expiresAt: this.now() + COMPUTER_LEASE_MS, controller: new AbortController(), agentController: new AbortController() }
          if (request.allowAgent) this.pausedSessions.delete(request.sessionId)
          else this.pausedSessions.add(request.sessionId)
          this.scheduleExpiry()
          const result = { requestId: request.requestId, leaseId: this.lease.id, status: await this.status(manualAuthorizationRequired, includePolicy, includeFeatures, true) }
          this.remember(key, fingerprint, result)
          return result
        }
        const lease = this.authorized(request.sessionId, owner, request.leaseId)
        if (request.operation === 'agent') {
          lease.allowAgent = request.allowAgent
          if (request.allowAgent) this.pausedSessions.delete(request.sessionId)
        } else {
          const combined = AbortSignal.any([signal, lease.controller.signal])
          if (request.operation === 'capture') {
            const screenshot = ComputerScreenshotSchema.parse(await this.driver.screenshot(combined))
            this.authorized(request.sessionId, owner, request.leaseId)
            return { requestId: request.requestId, screenshot }
          }
          await this.driver.input(request.action, combined)
          this.authorized(request.sessionId, owner, request.leaseId)
        }
        const result = { requestId: request.requestId, status: await this.status(manualAuthorizationRequired, includePolicy, includeFeatures, true) }
        this.remember(key, fingerprint, result)
        return result
      } catch (error) { return this.failure(request.requestId, error) }
    }).catch((error: unknown) => this.failure(request.requestId, error))
  }

  async agent(input: Record<string, unknown>, sessionId: string, signal: AbortSignal, manualAuthorizationRequired = true): Promise<string> {
    if (!this.featurePolicy.computerUseEnabled) throw new ToolError('EACCES', 'Computer Use is disabled in administrator Settings.')
    if (manualAuthorizationRequired && this.lease?.automatic) this.revoke()
    if (input.operation === 'status') return JSON.stringify({ ...await this.status(manualAuthorizationRequired), manualAuthorizationRequired })
    return this.serialized(async () => {
      if (!this.featurePolicy.computerUseEnabled) throw new ToolError('EACCES', 'Computer Use is disabled in administrator Settings.')
      if (signal.aborted) throw new ToolError('ECANCELED', 'Desktop action cancelled')
      await this.releasing
      if (this.releaseError) throw new ToolError('EACCES', this.releaseError)
      if (!manualAuthorizationRequired) {
        if (this.pausedSessions.has(sessionId)) throw new ToolError('EACCES', 'Agent desktop control was paused or stopped by the user; resume it in the Computer panel')
        if (!['screenshot', 'observe', 'act', 'batch', 'input'].includes(String(input.operation))) {
          throw new ToolError('EINVAL', 'Use status, observe, act, batch, screenshot, or input; only the Host determines desktop authorization')
        }
        this.expire()
        if (!this.lease) {
          const status = await this.status(false)
          if (!status.available) throw new ToolError('ENOTSUP', status.reason ?? 'Native desktop access is unavailable')
          if (signal.aborted || this.closing) throw new ToolError('ECANCELED', 'Desktop action cancelled')
          await this.driver.acquire?.()
          if (signal.aborted || this.closing) {
            if (this.driver.releaseClaim) await this.driver.releaseClaim()
            else await this.driver.releaseInputs()
            throw new ToolError('ECANCELED', 'Desktop action cancelled')
          }
          this.lease = { id: randomUUID(), sessionId, owner: `agent:${sessionId}`, allowAgent: true, automatic: true, expiresAt: this.now() + COMPUTER_LEASE_MS, controller: new AbortController(), agentController: new AbortController() }
          this.scheduleExpiry()
        }
      }
      const lease = this.authorized(sessionId)
      const heartbeat = !manualAuthorizationRequired && lease.automatic ? setInterval(() => {
        if (this.lease !== lease || signal.aborted || !lease.allowAgent) return
        lease.expiresAt = this.now() + COMPUTER_LEASE_MS
        this.scheduleExpiry()
      }, COMPUTER_LEASE_MS / 3) : undefined
      heartbeat?.unref()
      try {
        return await this.runAgentOperation(input, sessionId, signal, lease)
      } finally {
        clearInterval(heartbeat)
      }
    })
  }

  private async runAgentOperation(input: Record<string, unknown>, sessionId: string, signal: AbortSignal, lease: Lease): Promise<string> {
    const combined = AbortSignal.any([signal, lease.controller.signal, lease.agentController.signal])
    const check = () => {
      if (combined.aborted || this.authorized(sessionId) !== lease) throw new ToolError('ECANCELED', 'Desktop action cancelled')
    }
    check()
    if (input.operation === 'screenshot') {
      const screenshot = ComputerScreenshotSchema.parse(await this.driver.screenshot(combined))
      check()
      return JSON.stringify({ kind: COMPUTER_SCREENSHOT_KIND, screenshot })
    }
    if (input.operation === 'observe' || input.operation === 'act') {
      const request = ComputerSemanticRequestSchema.safeParse(input)
      if (!request.success) throw new ToolError('EINVAL', request.error.message)
      if (!this.driver.semantic) throw new ToolError('ENOTSUP', 'Upgrade this Executor and its interactive companion for semantic control; screenshot/input remain available')
      const observation = ComputerObservationSchema.parse(await this.driver.semantic(request.data, combined))
      check()
      return JSON.stringify(observation)
    }
    if (input.operation === 'batch') {
      if (!Array.isArray(input.actions) || input.actions.length < 1 || input.actions.length > 8) throw new ToolError('EINVAL', 'A visual batch requires 1 to 8 input actions')
      const actions = input.actions.map((action) => ComputerInputActionSchema.parse(action))
      for (let i = 0; i < actions.length; i++) {
        try { check(); await this.driver.input(actions[i]!, combined); check() }
        catch (error) {
          await this.driver.releaseInputs()
          throw new ToolError('EIO', `Visual batch stopped at action ${i + 1}; ${actions.length - i - 1} later actions skipped. ${error instanceof Error ? error.message : 'Desktop action failed'}`)
        }
      }
      const screenshot = ComputerScreenshotSchema.parse(await this.driver.screenshot(combined))
      check()
      return JSON.stringify({ kind: COMPUTER_SCREENSHOT_KIND, screenshot })
    }
    if (input.operation !== 'input') throw new ToolError('EINVAL', 'Use status, observe, act, batch, screenshot, or input; only the user can grant or renew desktop access')
    const action = ComputerInputActionSchema.safeParse(input.action)
    if (!action.success) throw new ToolError('EINVAL', action.error.message)
    await this.driver.input(action.data, combined)
    check()
    return 'Desktop input delivered. Take a fresh screenshot before deciding the next action.'
  }

  private serialized<T>(run: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new ToolError('ECANCELED', 'The desktop connection is closed'))
    if (this.pending >= 16) return Promise.reject(new ToolError('EBUSY', 'Too many pending desktop operations; wait for the current operation to finish'))
    this.pending += 1
    const execute = () => {
      if (this.closing) throw new ToolError('ECANCELED', 'The desktop connection is closed')
      return run()
    }
    const result = this.queue.then(execute, execute).finally(() => { this.pending -= 1 })
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }

  private remember(key: string, fingerprint: string, response: ComputerResponse): void {
    this.recent.set(key, { fingerprint, response })
    while (this.recent.size > 100) this.recent.delete(this.recent.keys().next().value!)
  }

  private failure(requestId: string, error: unknown): ComputerResponse {
    let code: NonNullable<ComputerResponse['error']>['code'] = 'execution_error'
    if (error instanceof ToolError) {
      if (error.code === 'EACCES') code = 'denied'
      else if (error.code === 'EBUSY') code = 'busy'
      else if (error.code === 'EINVAL') code = 'invalid_request'
    }
    return { requestId, error: { code, message: error instanceof Error ? error.message : String(error) } }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.revoke()
    this.closing = (async () => {
      await this.queue
      await this.releasing
      await this.driver.close()
    })()
    return this.closing
  }
}

export function computerUseTools(manager: ComputerUseManager): readonly Tool[] {
  return [
    { name: 'computer_use', run: (input, ctx) => {
      manager.setFeaturePolicy({ computerUseEnabled: ctx.desktopComputerUseEnabled ?? false, desktopPreviewEnabled: ctx.desktopPreviewEnabled ?? false })
      return manager.agent(input, ctx.sessionId, ctx.signal, ctx.desktopManualAuthorizationRequired ?? true)
    } },
    {
      name: '__computer_use',
      async run(input, ctx) {
        if (ctx.origin !== 'host') throw new ToolError('EACCES', 'Only the Host can manage desktop authorization')
        manager.setFeaturePolicy({ computerUseEnabled: input.desktopComputerUseEnabled === true, desktopPreviewEnabled: input.desktopPreviewEnabled === true })
        const { owner, request } = input
        if (typeof owner !== 'string') throw new ToolError('EINVAL', 'Desktop controller identity is missing')
        const parsed = ComputerRequestSchema.safeParse(request)
        if (!parsed.success) throw new ToolError('EINVAL', parsed.error.message)
        return JSON.stringify(await manager.request(parsed.data, owner, ctx.signal, input.desktopManualAuthorizationRequired !== false))
      },
    },
  ]
}
