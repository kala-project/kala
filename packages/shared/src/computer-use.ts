import { z } from 'zod'

const coordinate = z.number().int().min(-32768).max(32767)
const button = z.enum(['left', 'middle', 'right'])
export const COMPUTER_TYPE_MAX_LENGTH = 512
export const ComputerInputActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('move'), x: coordinate, y: coordinate }).strict(),
  z.object({ type: z.literal('click'), x: coordinate, y: coordinate, button, clickCount: z.union([z.literal(1), z.literal(2)]).optional() }).strict(),
  z.object({ type: z.literal('button'), x: coordinate, y: coordinate, button, down: z.boolean() }).strict(),
  z.object({ type: z.literal('scroll'), x: coordinate, y: coordinate, deltaX: z.number().int().min(-12000).max(12000), deltaY: z.number().int().min(-12000).max(12000) }).strict(),
  z.object({ type: z.literal('key'), key: z.string().min(1).max(100).regex(/^[A-Za-z0-9+_ -]+$/u) }).strict(),
  z.object({ type: z.literal('type'), text: z.string().min(1).max(COMPUTER_TYPE_MAX_LENGTH).refine((text) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text), 'Control characters other than newline and tab are not allowed') }).strict(),
  z.object({ type: z.literal('drag'), fromX: coordinate, fromY: coordinate, toX: coordinate, toY: coordinate }).strict(),
])
export type ComputerInputAction = z.infer<typeof ComputerInputActionSchema>

const identity = {
  requestId: z.string().min(1).max(128),
  workspaceId: z.string().min(1).max(128),
  sessionId: z.string().min(1).max(128),
}
const lease = z.string().uuid()
export const ComputerRequestSchema = z.discriminatedUnion('operation', [
  z.object({ ...identity, operation: z.literal('status') }).strict(),
  z.object({ ...identity, operation: z.literal('start'), consent: z.literal(true), allowAgent: z.boolean() }).strict(),
  z.object({ ...identity, operation: z.literal('renew'), leaseId: lease }).strict(),
  z.object({ ...identity, operation: z.literal('stop'), leaseId: lease }).strict(),
  z.object({ ...identity, operation: z.literal('capture'), leaseId: lease }).strict(),
  z.object({ ...identity, operation: z.literal('input'), leaseId: lease, action: ComputerInputActionSchema }).strict(),
  z.object({ ...identity, operation: z.literal('agent'), leaseId: lease, allowAgent: z.boolean() }).strict(),
])
export type ComputerRequest = z.infer<typeof ComputerRequestSchema>
export const ComputerScreenshotSchema = z.object({
  mimeType: z.literal('image/png'),
  base64: z.string().min(1).max(6 * 1024 * 1024).regex(/^[A-Za-z0-9+/]+={0,2}$/u),
  width: z.number().int().min(1).max(32768),
  height: z.number().int().min(1).max(32768),
  originX: coordinate,
  originY: coordinate,
}).strict()
export type ComputerScreenshot = z.infer<typeof ComputerScreenshotSchema>

export type ComputerStatus = {
  available: boolean
  platform: string
  reason?: string
  active: boolean
  sessionId?: string
  allowAgent: boolean
  expiresAt?: number
}
export type ComputerResponse = {
  requestId: string
  status?: ComputerStatus
  leaseId?: string
  screenshot?: ComputerScreenshot
  error?: { code: 'unavailable' | 'denied' | 'busy' | 'expired' | 'invalid_request' | 'execution_error'; message: string }
}

export const ComputerResponseSchema: z.ZodType<ComputerResponse> = z.object({
  requestId: z.string(),
  status: z.object({
    available: z.boolean(), platform: z.string(), reason: z.string().optional(),
    active: z.boolean(), sessionId: z.string().optional(), allowAgent: z.boolean(),
    expiresAt: z.number().optional(),
  }).strict().optional(),
  leaseId: lease.optional(),
  screenshot: ComputerScreenshotSchema.optional(),
  error: z.object({
    code: z.enum(['unavailable', 'denied', 'busy', 'expired', 'invalid_request', 'execution_error']),
    message: z.string(),
  }).strict().optional(),
}).strict().refine((response) => response.status !== undefined || response.screenshot !== undefined || response.error !== undefined, 'A desktop response must include a status, screenshot, or error')

export const COMPUTER_SCREENSHOT_KIND = 'kala.computer-use.screenshot.v1'
export function parseComputerScreenshotResult(content: string): ComputerScreenshot | undefined {
  if (!content.startsWith(`{"kind":"${COMPUTER_SCREENSHOT_KIND}"`) || content.length > 7 * 1024 * 1024) return undefined
  let value: unknown
  try { value = JSON.parse(content) } catch { return undefined }
  const result = z.object({ kind: z.literal(COMPUTER_SCREENSHOT_KIND), screenshot: ComputerScreenshotSchema }).strict().safeParse(value)
  return result.success ? result.data.screenshot : undefined
}
