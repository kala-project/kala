import { z } from 'zod'

const name = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,31}$/u)
const command = z.string().min(1).max(8192).refine(value => !/[\0\r\n]/u.test(value))
const argument = z.string().max(8192).refine(value => !value.includes('\0'))
export const McpPatchOperationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('replace'), name, command, args: z.array(argument).max(64) }).strict(),
  z.object({ op: z.literal('delete'), name }).strict(),
])
export const ExecutorMcpPatchSchema = z.object({
  requestId: z.string().uuid(),
  editToken: z.string().min(1).max(4096),
  expectedRevision: z.string().regex(/^[1-9][0-9]{0,39}$/u),
  operations: z.array(McpPatchOperationSchema).min(1).max(32),
}).strict().refine(input => new Set(input.operations.map(operation => operation.name)).size === input.operations.length, 'duplicate MCP operation')

export const WorkspaceMcpPatchSchema = ExecutorMcpPatchSchema.safeExtend({
  workspaceId: z.string().min(1).max(512).refine(value => !/[\u0000-\u001f\u007f/\\]/u.test(value)),
})
export type McpPatchOperation = z.infer<typeof McpPatchOperationSchema>
export type ExecutorMcpPatchRequest = z.infer<typeof ExecutorMcpPatchSchema>
export type ExecutorMcpPatchAck = {
  ok: boolean
  revision?: string
  duplicate?: boolean
  requestResultRevision?: string
  currentRevision?: string
  error?: string
}
