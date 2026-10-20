/**
 * @agent-kernel/host public API.
 *
 * Stable exports only. Private Cloud tenant-runtime registries, proxies, persistence,
 * and loopback composition remain internal until their contracts mature.
 */

export { startHostServer } from './server.js'
export type { HostServer, HostServerOptions } from './server.js'
export { PostgresDagStore } from './dag/postgres-store.js'
export type { ClaimedDagNode, DagStorage } from './dag/storage.js'
export type { TenantRuntimeUnit, TenantRuntimeUnitId, TenantRuntimeUnitState } from './tenant-runtime/unit.js'
export {
  assertPostgresSchemaCurrent,
  checkPostgresSchemaVersion,
  LATEST_POSTGRES_SCHEMA_VERSION,
  migratePostgres,
  runPostgresMigrations,
} from './postgres-migrations.js'
export type {
  PostgresMigrationClient,
  PostgresMigrationExecutor,
  PostgresMigrationPool,
  PostgresMigrationResult,
  PostgresSchemaManagement,
} from './postgres-migrations.js'
export {
  assertResourceOwner,
  createPostgresRuntimeResourceOwnershipStore,
  PostgresRuntimeResourceOwnershipStore,
  RuntimeResourceOwnershipExpiredError,
  RuntimeResourceOwnershipFencedError,
  RuntimeResourceOwnershipHeldError,
  RuntimeUnitReplicaMembershipExpiredError,
  RuntimeUnitReplicaMembershipFencedError,
  RuntimeUnitReplicaMembershipHeldError,
} from './tenant-runtime/postgres-runtime-resource-ownership.js'
export type {
  RegisterRuntimeUnitReplicaInput,
  RuntimeResourceLiveOwner,
  RuntimeResourceOwnership,
  RuntimeResourceOwnershipDatabase,
  RuntimeResourceOwnershipSqlExecutor,
  RuntimeResourceScope,
  RuntimeUnitLiveReplica,
  RuntimeUnitReplicaMembership,
  RuntimeUnitReplicaScope,
} from './tenant-runtime/postgres-runtime-resource-ownership.js'
export { RuntimeRoutingTicketIssuer } from './tenant-runtime/runtime-routing-ticket-issuer.js'
export type {
  AuthorizedRuntimeRoutingTicketScope,
  RuntimeResourceLiveOwnerReader,
  RuntimeRoutingTicketAuthorizer,
  RuntimeRoutingTicketIssuerOptions,
  VerifiedRoutingTicketPrincipal,
} from './tenant-runtime/runtime-routing-ticket-issuer.js'

export type { LLMAdapter, LLMResponse } from './llm/adapter.js'
export { anthropicAdapter } from './llm/anthropic.js'
export type { AnthropicOptions } from './llm/anthropic.js'
export { openaiAdapter, OpenAIHTTPError } from './llm/openai.js'
export type { OpenAIOptions } from './llm/openai.js'
export { policyGatewayAdapter } from './llm/policy-gateway.js'
export type { PolicyGatewayOptions } from './llm/policy-gateway.js'

export { SessionStore } from './store/session.js'
export type { SessionRecord } from './store/session.js'
export { readSessionLog, appendEventEntry, writeHeader } from './store/log.js'
export {
  STORAGE_CATEGORIES,
  STORAGE_INVENTORY_PERSISTENCE_INTERVAL_MS,
  StorageInventory,
} from './store/storage-inventory.js'
export type {
  CachedGlobalStorage,
  CachedSessionStorage,
  CachedSessionTreeStorage,
  StorageCategory,
  StorageCategoryStats,
  StorageInventoryOptions,
  StorageInventoryScanState,
  StorageInventoryState,
  StorageOrphanCandidate,
} from './store/storage-inventory.js'
export { SAFE_CLEANUP_OPERATIONS, SafeCleanupEngine, SafeCleanupError } from './store/safe-cleanup.js'
export type {
  SafeCleanupEntryType,
  SafeCleanupManifestEntry,
  SafeCleanupOperation,
  SafeCleanupOptions,
  SafeCleanupPlan,
  SafeCleanupRecoveryResult,
  SafeCleanupResult,
} from './store/safe-cleanup.js'

export { runHostLoop } from './loop.js'
export type { HostLoopDeps, LoopHandle } from './loop.js'

export { builtinTools, createBuiltinTools, createBuiltinAgentModule, resolveBuiltinAgentModule } from './builtin-tools.js'
export { resolveAgentModule, renderToolDescription, renderToolSchema, stableHash } from './agent-modules/renderers.js'
export type {
  AgentModule, AgentModuleContext, ResolvedAgentModule, RuntimePolicyPlugin,
  SystemPromptPlugin, ToolDefinition, ToolExecutionKind, ToolPrompt, ToolRisk,
  ToolsetContext, ToolsetPlugin,
} from './agent-modules/types.js'
export { discoverSkills, skillToolSchema, SKILL_TOOL_NAME } from './extensions/skills.js'
export type { SkillInfo, SkillRegistry } from './extensions/skills.js'
export { createBuiltinExtensionRegistry, BUILTIN_HOST_TOOL_HANDLERS } from './extensions/builtin-registry.js'
export { createExtensionRegistry } from './extensions/registry.js'
export type { ExtensionLifecycle, ExtensionRegistry, HostExtension, HostToolContext, HostToolHandler } from './extensions/registry.js'
export type { WebSearchCredentialStore } from './web-search/index.js'
