import { schema } from '@agent-kernel/shared'

export class ModelPolicyUnavailable extends Error {
  readonly status = 503
  constructor(readonly code = 'model_policy_authority_unavailable') { super(code) }
}

export class ModelPolicyClient {
  readonly #origin: string
  constructor(private readonly options: {
    origin: string; installationId: string; serviceSecret: string;
    fetch?: typeof fetch; timeoutMs?: number;
  }) {
    const url = new URL(options.origin)
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== options.origin
      || Buffer.byteLength(options.serviceSecret) < 32
      || !schema.SettingsModelPolicyRequestSchema.shape.installationId.safeParse(options.installationId).success) {
      throw new ModelPolicyUnavailable('invalid_model_policy_authority')
    }
    this.#origin = url.origin
  }

  /** Deliberately uncached: previous readiness never authorizes a new call or write. */
  async read(organizationId: string, unitId: string): Promise<schema.SettingsModelPolicy> {
    const request = schema.SettingsModelPolicyRequestSchema.parse({ installationId: this.options.installationId, organizationId, unitId })
    const decoded = schema.SettingsModelPolicySchema.safeParse(await this.request('/internal/settings/model-management/policy', request))
    if (!decoded.success) throw new ModelPolicyUnavailable('model_policy_state_invalid')
    const policy = decoded.data
    if (policy.installationId !== request.installationId || policy.organizationId !== organizationId || policy.unitId !== unitId) {
      throw new ModelPolicyUnavailable('model_policy_scope_mismatch')
    }
    return policy
  }

  async resource(organizationId: string, unitId: string, resource: schema.SettingsOperationalRequest['resource']) {
    const request = schema.SettingsOperationalRequestSchema.parse({ installationId: this.options.installationId, organizationId, unitId, resource })
    const decoded = schema.SettingsOperationalObservationSchema.safeParse(await this.request('/internal/settings/operational-resource', request))
    if (!decoded.success) throw new ModelPolicyUnavailable('operational_resource_state_invalid')
    const observation = decoded.data
    if (observation.installationId !== request.installationId || observation.organizationId !== organizationId || observation.unitId !== unitId
      || observation.resource.kind !== resource.kind || observation.resource.id !== resource.id) {
      throw new ModelPolicyUnavailable('operational_resource_scope_mismatch')
    }
    return observation
  }

  async executor(organizationId: string, unitId: string, executor: Pick<schema.SettingsExecutorAdmissionRequest, 'executorId' | 'workspaceId' | 'enrollmentHash'>) {
    const request = schema.SettingsExecutorAdmissionRequestSchema.parse({ installationId: this.options.installationId, organizationId, unitId, ...executor })
    const decoded = schema.SettingsExecutorAdmissionSchema.safeParse(await this.request('/internal/settings/executor-admission', request))
    if (!decoded.success) throw new ModelPolicyUnavailable('executor_admission_state_invalid')
    const observation = decoded.data
    if (observation.installationId !== request.installationId || observation.organizationId !== organizationId || observation.unitId !== unitId
      || observation.executorId !== request.executorId || observation.workspaceId !== request.workspaceId || observation.enrollmentHash !== request.enrollmentHash) {
      throw new ModelPolicyUnavailable('executor_admission_scope_mismatch')
    }
    return observation
  }
  private async request(path: string, request: unknown): Promise<unknown> {
    try {
      const response = await (this.options.fetch ?? fetch)(`${this.#origin}${path}`, {
        method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store',
        headers: { 'content-type': 'application/json', 'x-agent-runlab-ingress-secret': this.options.serviceSecret },
        body: JSON.stringify(request), signal: AbortSignal.timeout(this.options.timeoutMs ?? 5_000),
      })
      if (!response.ok) throw new ModelPolicyUnavailable()
      if (Number(response.headers.get('content-length')) > 2_097_152) { await response.body?.cancel(); throw new ModelPolicyUnavailable() }
      let raw = ''
      if (!response.body) throw new ModelPolicyUnavailable()
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      try {
        for (;;) {
          const part = await reader.read()
          if (part.done) break
          raw += decoder.decode(part.value, { stream: true })
          if (Buffer.byteLength(raw) > 2_097_152) { await reader.cancel(); throw new ModelPolicyUnavailable() }
        }
        raw += decoder.decode()
      } finally { reader.releaseLock() }
      return JSON.parse(raw)
    } catch (error) {
      throw error instanceof ModelPolicyUnavailable ? error : new ModelPolicyUnavailable()
    }
  }

  async assertActive(expected: Pick<schema.SettingsModelPolicy, 'organizationId' | 'unitId' | 'effectiveRevision' | 'effectiveManagement'>): Promise<void> {
    const policy = await this.read(expected.organizationId, expected.unitId)
    if (policy.state !== 'active' || policy.effectiveRevision !== expected.effectiveRevision
      || policy.effectiveManagement !== expected.effectiveManagement) throw new ModelPolicyUnavailable('model_policy_transition_fenced')
  }
}
