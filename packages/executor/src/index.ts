export { createSandbox, SandboxError } from './sandbox.js'
export type { Sandbox, SandboxOptions } from './sandbox.js'
export {
  createToolRegistry,
  ToolError,
  readFileTool,
  readFilesTool,
  lsTool,
  globTool,
  multiGrepTool,
  writeFileTool,
  replaceInFileTool,
  replaceManyInFileTool,
  applyFilePatchTool,
  bashTool,
  allTools,
} from './tools/index.js'
export type { Tool, ToolContext, ToolRunner } from './tools/index.js'
export { startExecutor } from './client.js'
export { executionRequestDigest } from './execution-receipts.js'
export type { ExecutorOptions, ExecutorHandle } from './client.js'
export { parseMcpServerConfig, parseMcpServerDeclaration, parseMcpServers } from './mcp-config.js'
export type { McpServerConfig } from './mcp-config.js'
export type { McpToolDescriptor } from './mcp-client.js'
export {
  applyLegacyIdentityMigration,
  discoverLegacyExecutorProfiles,
  discoverLegacyIdentityMigration,
} from './legacy-identity-migration.js'
export type {
  DiscoverLegacyIdentityOptions,
  ExecutorInstallationSource,
  LegacyIdentity,
  MigrationConflict,
  MigrationPlan,
} from './legacy-identity-migration.js'
export {
  createWindowsServicePlan,
  executeWindowsServiceCommand,
  executeWindowsServicePlan,
  quoteWindowsArgument,
  spawnWindowsCommand,
  windowsServiceLayout,
} from './windows-service.js'
export type {
  WindowsCommandResult,
  WindowsCommandRunner,
  WindowsServiceAction,
  WindowsServiceCommand,
  WindowsServiceExecutorOptions,
  WindowsServiceLayout,
  WindowsServicePlan,
  WindowsServicePlanOptions,
} from './windows-service.js'
export { DpapiCredentialProtector } from './credential-protector.js'
export type { CredentialProtector, DpapiCredentialProtectorOptions } from './credential-protector.js'
export {
  createMacosLaunchdService,
  escapeLaunchdXml,
  executeLaunchdPlan,
} from './macos-launchd.js'
export type {
  CreateLaunchdServiceOptions,
  LaunchdArchitecture,
  LaunchdCommandOperation,
  LaunchdOperation,
  LaunchdOperationExecutor,
  LaunchdPlan,
  LaunchdPlanName,
  LaunchdPlanStep,
  LaunchdRemoveFileOperation,
  LaunchdScope,
  LaunchdServiceDefinition,
  LaunchdServicePlans,
  LaunchdWriteFileOperation,
} from './macos-launchd.js'
export {
  createLinuxServicePlan,
  executeLinuxServicePlan,
  linuxServicePaths,
  renderLinuxServiceFiles,
} from './linux-service.js'
export type {
  Command as LinuxServiceCommand,
  CommandResult as LinuxServiceCommandResult,
  CommandRunner as LinuxServiceCommandRunner,
  LinuxServicePaths,
  LinuxServicePlan,
} from './linux-service.js'
export { parseExecutorCliArgs } from './cli-args.js'
export type { ExecutorCliArgs, ServiceAction, ServiceMode } from './cli-args.js'
export { readInstallerSession } from './installer-session.js'
export type { InstallerSession } from './installer-session.js'
export { readExecutorCredential, readExecutorRuntimeConfig } from './executor-config.js'
export type { ExecutorRuntimeConfig } from './executor-config.js'
export {
  bootstrapEnvironment,
  defaultManagedRoot,
  installationRequest,
  redeemInstallation,
  reportInstallation,
  waitForApproval,
  writeInstallerSession,
} from './installer-flow.js'
export type { BootstrapEnvironment } from './installer-flow.js'
