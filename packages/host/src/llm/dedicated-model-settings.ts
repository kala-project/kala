import type { PostgresTenantStateStore } from '../tenant-runtime/postgres-state.js'
import { createRuntimeLogger, type RuntimeLogger } from '../logger.js'
import { ExplicitLLMClientFactory, type LLMClientFactory, type SecretResolver } from './client-factory.js'
import { createRuntimeProviderRuntime, parseRuntimeProviderCatalog, type RuntimeProviderCatalog } from './runtime-provider-catalog.js'
import { TenantModelSettings } from './tenant-model-settings.js'

export const DEDICATED_MODEL_SETTINGS_CREDENTIAL = 'dedicated-model-settings:v1'
export const DEDICATED_MODEL_SETTINGS_CHANNEL = 'kala_dedicated_model_settings'

/** Dedicated initialization alone may copy its protected deployment seed. */
export class DedicatedModelSettings extends TenantModelSettings<string> {
  constructor(
    state: PostgresTenantStateStore, organizationId: string, seed: RuntimeProviderCatalog, seedSecrets: SecretResolver,
    factory: (resolver: SecretResolver) => LLMClientFactory = resolver => new ExplicitLLMClientFactory(resolver),
    logger: Pick<RuntimeLogger, 'warn' | 'info'> = createRuntimeLogger('dedicated-model-settings'),
  ) {
    super({
      credential: DEDICATED_MODEL_SETTINGS_CREDENTIAL, channel: DEDICATED_MODEL_SETTINGS_CHANNEL, prefix: 'dedicated:',
      parseCatalog: value => parseRuntimeProviderCatalog(value, { allowEmptyProviders: true }),
      compileRuntime: createRuntimeProviderRuntime,
    }, state, organizationId, seed, seedSecrets, factory, logger)
  }
}
