import { schema } from '@agent-kernel/shared'
import { OperatorExecutionError } from './operator-store.js'

export class OperatorModelPolicyTransport {
  private readonly allowed: ReadonlySet<string>
  constructor(private readonly options: {
    installationId: string; profile: schema.SettingsOperatorProfile; credential(): Promise<string>;
    fetch?: typeof fetch;
  }) {
    this.allowed = new Set([options.profile.runtimeControlOrigin, ...options.profile.additionalRuntimeControlOrigins ?? []])
  }
  assertOrigin(origin: string): void {
    if (!this.allowed.has(origin)) throw new OperatorExecutionError(4, 'unapproved_runtime_control_origin')
  }
  async request(path: 'inspect' | 'quiesce' | 'reconcile' | 'resume' | 'observe', input: unknown,
    origin = this.options.profile.runtimeControlOrigin): Promise<unknown> {
    return this.send(`/internal/settings/model-management/${path}`, input, origin)
  }
  async operational(path: 'workspace-references' | 'workspace-reserve' | 'operational-consume', input: Record<string, unknown>,
    origin = this.options.profile.runtimeControlOrigin): Promise<unknown> {
    return this.send(`/internal/settings/${path}`, { ...input, installationId: this.options.installationId }, origin)
  }
  private async send(path: string, input: unknown, origin: string): Promise<unknown> {
    this.assertOrigin(origin)
    const secret = await this.options.credential()
    if (Buffer.byteLength(secret) < 32) throw new OperatorExecutionError(5, 'runtime_service_credential_unavailable')
    try {
      const response = await (this.options.fetch ?? fetch)(`${origin}${path}`, {
        method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(30_000),
        headers: { 'content-type': 'application/json', 'x-agent-runlab-ingress-secret': secret }, body: JSON.stringify(input),
      })
      if (!response.body) throw new Error()
      let raw = ''
      const reader = response.body.getReader(), decoder = new TextDecoder()
      try {
        for (;;) {
          const part = await reader.read()
          if (part.done) break
          raw += decoder.decode(part.value, { stream: true })
          if (Buffer.byteLength(raw) > 2_097_152) { await reader.cancel(); throw new Error() }
        }
        raw += decoder.decode()
      } finally { reader.releaseLock() }
      const body: unknown = JSON.parse(raw)
      if (!response.ok) {
        if (path === '/internal/settings/workspace-reserve' && body && typeof body === 'object'
          && 'error' in body && body.error === 'workspace_references_changed') {
          throw new OperatorExecutionError(3, 'workspace_references_changed')
        }
        throw new Error()
      }
      return body
    } catch (error) {
      if (error instanceof OperatorExecutionError) throw error
      throw new OperatorExecutionError(4, 'runtime_model_policy_outcome_pending')
    }
  }
  async inspect(organizationId: string, unitId: string, origin = this.options.profile.runtimeControlOrigin): Promise<schema.SettingsModelPolicyInspection> {
    const parsed = schema.SettingsModelPolicyInspectionSchema.safeParse(await this.request('inspect', { organizationId, unitId }, origin))
    if (!parsed.success || parsed.data.installationId !== this.options.installationId
      || parsed.data.organizationId !== organizationId || parsed.data.unitId !== unitId) {
      throw new OperatorExecutionError(5, 'runtime_model_policy_identity_mismatch')
    }
    if (!parsed.data.installed) throw new OperatorExecutionError(4, 'model_policy_protocol_not_installed')
    for (const replica of parsed.data.servingScope) this.assertOrigin(replica.origin)
    return parsed.data
  }
}
