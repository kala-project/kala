import { expect, it } from 'vitest'
import { ExecutorCapabilitiesSchema } from './schema/executor.js'
import { WorkspaceMcpPatchSchema } from './mcp-settings.js'

it('retains the declared patch wire version through announcement parsing and preserves legacy negotiation', () => {
  const legacy = { schemaVersion: 1, features: { backgroundShell: false, filePicker: false, overflowFiles: false, workspaceSandbox: true } }
  expect(ExecutorCapabilitiesSchema.parse({ ...legacy, mcpConfigProtocol: 'patch-v1' })).toHaveProperty('mcpConfigProtocol', 'patch-v1')
  expect(ExecutorCapabilitiesSchema.parse(legacy)).not.toHaveProperty('mcpConfigProtocol')
  expect(ExecutorCapabilitiesSchema.safeParse({ ...legacy, mcpConfigProtocol: 'patch-v2' }).success).toBe(false)
})

it('rejects protocol fields hidden inside operations and route-ambiguous workspace identities', () => {
  const request = { requestId: '00000000-0000-4000-8000-000000000001', workspaceId: 'workspace', expectedRevision: '1', editToken: 'ticket',
    operations: [{ op: 'delete', name: 'filesystem' }] }
  expect(WorkspaceMcpPatchSchema.safeParse(request).success).toBe(true)
  expect(WorkspaceMcpPatchSchema.safeParse({ ...request, operations: [{ ...request.operations[0], command: 'secret' }] }).success).toBe(false)
  expect(WorkspaceMcpPatchSchema.safeParse({ ...request, workspaceId: 'nested/workspace' }).success).toBe(false)
})
