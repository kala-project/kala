import { timingSafeEqual } from 'node:crypto'
import type { DesktopInputAction, DesktopScreenshot, DesktopStatus } from './desktop-driver.js'

export const COMPANION_MAX_REQUEST = 32 * 1024
export const COMPANION_MAX_RESPONSE = 46 * 1024 * 1024
export const COMPANION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
export const COMPANION_TOKEN = /^[0-9a-f]{64}$/
export type CompanionOperation = 'acquire' | 'status' | 'screenshot' | 'input' | 'release-inputs' | 'release' | 'cancel'
export type CompanionRequest = {
  version: 1; id: string; owner: string; token: string; operation: CompanionOperation; action?: DesktopInputAction; target?: string
}

function record(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid companion message')
}
function fields(value: Record<string, unknown>, required: string[], optional: string[] = []) {
  if (required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) throw new Error('Invalid companion message fields')
}
function integer(value: unknown, limit = 1_000_000): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Math.abs(value) > limit) throw new Error('Invalid bounded desktop coordinate/delta')
}

export function validateCompanionAction(value: unknown): asserts value is DesktopInputAction {
  record(value)
  const type = value.type
  if (type === 'move' || type === 'click' || type === 'button' || type === 'scroll') {
    const extra = type === 'click' ? ['button'] : type === 'button' ? ['button', 'down'] : type === 'scroll' ? ['deltaX', 'deltaY'] : []
    fields(value, ['type', 'x', 'y', ...extra], type === 'click' ? ['clickCount'] : [])
    integer(value.x); integer(value.y)
    if (type === 'click' || type === 'button') {
      if (!['left', 'middle', 'right'].includes(value.button as string)) throw new Error('Invalid desktop button')
      if (type === 'button' && typeof value.down !== 'boolean') throw new Error('Invalid desktop button state')
      if (type === 'click' && value.clickCount !== undefined && value.clickCount !== 1 && value.clickCount !== 2) throw new Error('Invalid desktop click count')
    }
    if (type === 'scroll') { integer(value.deltaX, 12_000); integer(value.deltaY, 12_000) }
  } else if (type === 'drag') {
    fields(value, ['type', 'fromX', 'fromY', 'toX', 'toY'])
    for (const key of ['fromX', 'fromY', 'toX', 'toY']) integer(value[key])
  } else if (type === 'type') {
    fields(value, ['type', 'text'])
    if (typeof value.text !== 'string' || value.text.length > 512
        || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value.text)
        || Buffer.from(value.text, 'utf8').toString('utf8') !== value.text) throw new Error('Invalid bounded Unicode desktop text')
  } else if (type === 'key') {
    fields(value, ['type', 'key'])
    if (typeof value.key !== 'string' || value.key.length > 80) throw new Error('Invalid desktop key')
    const parts = value.key.toLowerCase().split('+')
    const mods: Record<string, string> = { ctrl: 'ctrl', control: 'ctrl', alt: 'alt', shift: 'shift', meta: 'meta', win: 'meta', super: 'meta' }
    const mapped = parts.slice(0, -1).map((part) => mods[part])
    const last = parts.at(-1)!
    const named = /^(enter|return|escape|esc|tab|space|backspace|delete|insert|home|end|pageup|pagedown|arrowleft|left|arrowup|up|arrowright|right|arrowdown|down|f([1-9]|1[0-9]|2[0-4]))$/
    if (parts.length > 5 || mapped.some((part) => !part) || new Set([...mapped, ...(mods[last] ? [mods[last]] : [])]).size !== mapped.length + (mods[last] ? 1 : 0)
        || (!/^[a-z0-9]$/.test(last) && !named.test(last) && !mods[last])) throw new Error('Invalid desktop shortcut')
  } else throw new Error('Unknown desktop action')
}

export function validateCompanionRequest(value: unknown): asserts value is CompanionRequest {
  record(value)
  fields(value, ['version', 'id', 'owner', 'token', 'operation'], ['action', 'target'])
  if (value.version !== 1 || typeof value.id !== 'string' || !COMPANION_ID.test(value.id)
      || typeof value.owner !== 'string' || !COMPANION_ID.test(value.owner)
      || typeof value.token !== 'string' || !COMPANION_TOKEN.test(value.token)
      || !['acquire', 'status', 'screenshot', 'input', 'release-inputs', 'release', 'cancel'].includes(value.operation as string)) throw new Error('Invalid companion request')
  if (value.operation === 'input') validateCompanionAction(value.action)
  else if (value.action !== undefined) throw new Error('Unexpected companion action')
  if (value.operation === 'cancel') {
    if (typeof value.target !== 'string' || !COMPANION_ID.test(value.target)) throw new Error('Invalid companion cancellation')
  } else if (value.target !== undefined) throw new Error('Unexpected companion cancellation')
}

export function authenticateCompanion(supplied: string, expected: string): boolean {
  return COMPANION_TOKEN.test(supplied) && COMPANION_TOKEN.test(expected)
    && timingSafeEqual(Buffer.from(supplied, 'hex'), Buffer.from(expected, 'hex'))
}

export function validateCompanionStatus(value: unknown): asserts value is DesktopStatus {
  record(value)
  fields(value, ['available', 'platform'], ['reason'])
  if (typeof value.available !== 'boolean' || typeof value.platform !== 'string' || value.platform.length > 32
      || (value.reason !== undefined && (typeof value.reason !== 'string' || value.reason.length > 2048))) throw new Error('Invalid companion desktop status')
}

export function validateCompanionScreenshot(value: unknown): asserts value is DesktopScreenshot {
  record(value)
  fields(value, ['mimeType', 'base64', 'width', 'height', 'originX', 'originY'])
  if (value.mimeType !== 'image/png' || typeof value.base64 !== 'string' || value.base64.length > 44_739_244
      || value.base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.base64)) throw new Error('Invalid companion PNG')
  integer(value.width, 32768); integer(value.height, 32768); integer(value.originX); integer(value.originY)
  if (value.width <= 0 || value.height <= 0 || value.width * value.height > 64_000_000) throw new Error('Invalid companion image dimensions')
  const image = Buffer.from(value.base64, 'base64')
  if (image.length < 33 || image.length > 32 * 1024 * 1024 || image.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
      || image.readUInt32BE(8) !== 13 || image.toString('ascii', 12, 16) !== 'IHDR'
      || image.readUInt32BE(16) !== value.width || image.readUInt32BE(20) !== value.height) throw new Error('Invalid companion PNG metadata')
}

/** Bounded newline framing; chunks are concatenated once rather than quadratically. */
export function companionFrames(limit: number, receive: (value: unknown) => void, fail: () => void) {
  let chunks: Buffer[] = []
  let size = 0
  let failed = false
  return (chunk: Buffer) => {
    if (failed) return
    let start = 0
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start)
      const end = newline < 0 ? chunk.length : newline
      const part = chunk.subarray(start, end)
      size += part.length
      if (size > limit || chunks.length >= 4096) { failed = true; chunks = []; fail(); return }
      chunks.push(part)
      if (newline < 0) return
      try {
        const frame = Buffer.concat(chunks, size)
        chunks = []; size = 0
        const text = frame.toString('utf8')
        if (Buffer.from(text, 'utf8').compare(frame) !== 0) throw new Error('Invalid UTF-8')
        receive(JSON.parse(text))
      } catch { failed = true; chunks = []; fail(); return }
      start = newline + 1
    }
  }
}
