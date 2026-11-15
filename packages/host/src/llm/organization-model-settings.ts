import type { PostgresTenantStateStore } from '../tenant-runtime/postgres-state.js'
import type { HotStateSqlExecutor } from '../tenant-runtime/postgres-hot-state.js'
import { createRuntimeLogger, type RuntimeLogger } from '../logger.js'
import { ExplicitLLMClientFactory, type LLMClientFactory, type SecretResolver } from './client-factory.js'
import { createOrganizationProviderRuntime, parseOrganizationProviderCatalog } from './runtime-provider-catalog.js'
import { TenantModelSettings } from './tenant-model-settings.js'

export const ORGANIZATION_MODEL_SETTINGS_CREDENTIAL = 'organization-model-settings:v1'
export const ORGANIZATION_MODEL_SETTINGS_CHANNEL = 'kala_organization_model_settings'

export type OrganizationModelPolicyGuards = {
  assertCallAllowed(): Promise<void>
  assertMutationAllowed(transaction: HotStateSqlExecutor): Promise<void>
  assertInitializationAllowed(transaction: HotStateSqlExecutor): Promise<void>
}

/** No deployment seed or shared-secret resolver is accepted by this authority. */
export class OrganizationModelSettings extends TenantModelSettings<string | null> {
  constructor(
    state: PostgresTenantStateStore, organizationId: string, guards: OrganizationModelPolicyGuards,
    factory: (resolver: SecretResolver) => LLMClientFactory = resolver => new ExplicitLLMClientFactory(resolver),
    logger: Pick<RuntimeLogger, 'warn' | 'info'> = createRuntimeLogger('organization-model-settings'),
  ) {
    const requireRevision = async (transaction: HotStateSqlExecutor) => {
      if (!await state.credentialRevision(ORGANIZATION_MODEL_SETTINGS_CREDENTIAL, transaction)) {
        throw Object.assign(new Error('configuration_revisions_unavailable'), { status: 503 })
      }
    }
    super({
      credential: ORGANIZATION_MODEL_SETTINGS_CREDENTIAL, channel: ORGANIZATION_MODEL_SETTINGS_CHANNEL, prefix: 'organization:',
      parseCatalog: parseOrganizationProviderCatalog, compileRuntime: createOrganizationProviderRuntime,
      beforeCall: () => guards.assertCallAllowed(),
      beforeMutation: async transaction => { await requireRevision(transaction); await guards.assertMutationAllowed(transaction) },
      beforeInitialize: async transaction => { await requireRevision(transaction); await guards.assertInitializationAllowed(transaction) },
    }, state, organizationId, { version: 1, defaultModel: null, providers: [] },
    { resolve: async () => { throw new Error('organization_model_shared_credentials_forbidden') } }, factory, logger)
  }
}
