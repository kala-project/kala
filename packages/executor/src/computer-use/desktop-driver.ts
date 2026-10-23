import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { WINDOWS_DESKTOP_SCRIPT } from './windows-desktop-script.js'

export type DesktopInputAction =
  | { type: 'move'; x: number; y: number }
  | { type: 'click'; x: number; y: number; button: 'left' | 'middle' | 'right'; clickCount?: 1 | 2 }
  | { type: 'button'; x: number; y: number; button: 'left' | 'middle' | 'right'; down: boolean }
  | { type: 'scroll'; x: number; y: number; deltaX: number; deltaY: number }
  | { type: 'key'; key: string }
  | { type: 'type'; text: string }
  | { type: 'drag'; fromX: number; fromY: number; toX: number; toY: number }

export type DesktopScreenshot = {
  mimeType: 'image/png'; base64: string; width: number; height: number; originX: number; originY: number
}
export type DesktopStatus = { available: boolean; platform: string; reason?: string }
export type DesktopCommandOptions = {
  env: NodeJS.ProcessEnv; signal?: AbortSignal; stdin?: string; timeoutMs: number; maxOutputBytes: number
}
export type DesktopCommandRunner = (file: string, args: readonly string[], options: DesktopCommandOptions) => Promise<Buffer>
export type DesktopDriverOptions = {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  /** Test seam only. Production uses bounded, shell-free native subprocesses. */
  run?: DesktopCommandRunner
  timeoutMs?: number
}

const MAX_IMAGE = 32 * 1024 * 1024
const BUTTONS = { left: '1', middle: '2', right: '3' } as const
const NAMED_KEYS: Record<string, [string, number]> = {
  enter: ['Return', 13], return: ['Return', 13], escape: ['Escape', 27], esc: ['Escape', 27],
  tab: ['Tab', 9], space: ['space', 32], backspace: ['BackSpace', 8], delete: ['Delete', 46],
  insert: ['Insert', 45], home: ['Home', 36], end: ['End', 35], pageup: ['Prior', 33],
  pagedown: ['Next', 34], arrowleft: ['Left', 37], left: ['Left', 37],
  arrowup: ['Up', 38], up: ['Up', 38], arrowright: ['Right', 39], right: ['Right', 39],
  arrowdown: ['Down', 40], down: ['Down', 40],
}
const MODIFIERS: Record<string, [string, number]> = {
  ctrl: ['ctrl', 17], control: ['ctrl', 17], alt: ['alt', 18],
  shift: ['shift', 16], meta: ['super', 91], win: ['super', 91], super: ['super', 91],
}

function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Desktop operation cancelled', 'AbortError')
}

/** Never includes request text, screenshots, command arguments or full stderr in diagnostics. */
export const runDesktopCommand: DesktopCommandRunner = (file, args, options) => new Promise((resolve, reject) => {
  try { aborted(options.signal) } catch (error) { reject(error); return }
  const child = spawn(file, [...args], {
    env: options.env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
    // Own a process group so cancellation also terminates the fixed Linux pipeline.
    detached: process.platform !== 'win32',
  })
  const chunks: Buffer[] = []
  let size = 0
  let stderr = ''
  let failure: Error | undefined
  const stop = (error: Error) => {
    failure ??= error
    if (process.platform !== 'win32' && child.pid) {
      try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
    } else child.kill('SIGKILL')
  }
  const onAbort = () => stop(new DOMException('Desktop operation cancelled', 'AbortError'))
  const timer = setTimeout(() => stop(new Error(`Native desktop command timed out (${options.timeoutMs}ms)`)), options.timeoutMs)
  options.signal?.addEventListener('abort', onAbort, { once: true })
  child.stdout.on('data', (chunk: Buffer) => {
    size += chunk.length
    if (size > options.maxOutputBytes) stop(new Error('Native desktop output exceeds safety limit'))
    else chunks.push(chunk)
  })
  child.stderr.on('data', (chunk: Buffer) => {
    if (stderr.length < 2048) stderr += chunk.toString('utf8').slice(0, 2048 - stderr.length)
  })
  child.on('error', (error: NodeJS.ErrnoException) => {
    failure ??= new Error(error.code === 'ENOENT'
      ? `Missing native desktop dependency: ${file}. Linux requires OS-vendor xdotool/scrot and base-system bash/coreutils; Windows requires Windows PowerShell 5.1.`
      : `Cannot launch native desktop command: ${error.code ?? 'unknown error'}`)
  })
  child.stdin.on('error', () => { /* Process exit/error is handled below. */ })
  child.on('close', (code) => {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
    if (failure) reject(failure)
    else if (code !== 0) reject(new Error(`Native desktop command failed (${code}): ${stderr.replace(/[\r\n]+/g, ' ').trim() || 'desktop unavailable'}`))
    else resolve(Buffer.concat(chunks))
  })
  child.stdin.end(options.stdin ?? '')
  if (options.signal?.aborted) onAbort()
})

function parseKey(key: string): { linux: string; windows: number[]; linuxKeys: string[] } {
  if (typeof key !== 'string' || key.length > 80) throw new Error('Invalid key shortcut')
  const parts = key.split('+')
  if (parts.length > 5 || parts.some((part) => !part)) throw new Error('Invalid key shortcut')
  const modifiers = parts.slice(0, -1).map((part) => MODIFIERS[part.toLowerCase()])
  if (modifiers.some((part) => !part)) throw new Error('Only Ctrl, Alt, Shift and Meta may prefix a key')
  const last = parts.at(-1)!
  let final = NAMED_KEYS[last.toLowerCase()] ?? MODIFIERS[last.toLowerCase()]
  if (!final && /^[a-z0-9]$/i.test(last)) final = [last.toLowerCase(), last.toUpperCase().charCodeAt(0)]
  if (!final && /^f([1-9]|1[0-9]|2[0-4])$/i.test(last)) final = [last.toUpperCase(), 111 + Number(last.slice(1))]
  if (!final) throw new Error('Unsupported key; use type for arbitrary Unicode text')
  const keys = [...modifiers, final] as [string, number][]
  if (new Set(keys.map((part) => part[1])).size !== keys.length) throw new Error('Duplicate shortcut modifier')
  return { linux: keys.map((part) => part[0]).join('+'), windows: keys.map((part) => part[1]), linuxKeys: keys.map((part) => part[0]) }
}

function textKeys(text: string): string[] {
  const ascii: Record<string, string> = {
    ' ': 'space', '\n': 'Return', '\r': 'Return', '\t': 'Tab',
    '!': 'exclam', '"': 'quotedbl', '#': 'numbersign', '$': 'dollar', '%': 'percent',
    '&': 'ampersand', "'": 'apostrophe', '(': 'parenleft', ')': 'parenright', '*': 'asterisk',
    '+': 'plus', ',': 'comma', '-': 'minus', '.': 'period', '/': 'slash', ':': 'colon',
    ';': 'semicolon', '<': 'less', '=': 'equal', '>': 'greater', '?': 'question', '@': 'at',
    '[': 'bracketleft', '\\': 'backslash', ']': 'bracketright', '^': 'asciicircum', '_': 'underscore',
    '`': 'grave', '{': 'braceleft', '|': 'bar', '}': 'braceright', '~': 'asciitilde',
  }
  return [...new Set(Array.from(text, (char) => ascii[char] ?? (/^[a-z0-9]$/i.test(char) ? char : `U${char.codePointAt(0)!.toString(16).padStart(4, '0')}`)))]
}

function integer(value: unknown, limit = 1_000_000): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Math.abs(value) > limit) throw new Error('Desktop coordinates/deltas must be bounded integers')
}

function validate(action: DesktopInputAction): void {
  if (!action || typeof action !== 'object') throw new Error('Invalid desktop action')
  switch (action.type) {
    case 'move': case 'click': case 'button': case 'scroll':
      integer(action.x); integer(action.y)
      if (action.type === 'click' || action.type === 'button') {
        if (!Object.hasOwn(BUTTONS, action.button)) throw new Error('Invalid mouse button')
        if (action.type === 'button' && typeof action.down !== 'boolean') throw new Error('Invalid button state')
        if (action.type === 'click' && action.clickCount !== undefined && action.clickCount !== 1 && action.clickCount !== 2) throw new Error('Invalid click count')
      }
      if (action.type === 'scroll') { integer(action.deltaX, 12_000); integer(action.deltaY, 12_000) }
      break
    case 'drag':
      integer(action.fromX); integer(action.fromY); integer(action.toX); integer(action.toY)
      break
    case 'key': parseKey(action.key); break
    case 'type':
      if (typeof action.text !== 'string' || action.text.length > 512
          || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(action.text)
          || Buffer.from(action.text, 'utf8').toString('utf8') !== action.text) throw new Error('Text must contain at most 512 valid UTF-16 code units and no control characters except newline/tab')
      break
    default: throw new Error('Unknown desktop action')
  }
}

function png(image: Buffer, originX: number, originY: number): DesktopScreenshot {
  if (image.length < 33 || image.length > MAX_IMAGE || image.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
      || image.readUInt32BE(8) !== 13 || image.toString('ascii', 12, 16) !== 'IHDR') throw new Error('Native screenshot is not a bounded PNG')
  const width = image.readUInt32BE(16), height = image.readUInt32BE(20)
  if (!width || !height || width > 32768 || height > 32768 || width * height > 64_000_000) throw new Error('Screenshot dimensions exceed safety limit')
  return { mimeType: 'image/png', base64: image.toString('base64'), width, height, originX, originY }
}

/**
 * Controls only the existing logged-in desktop. Never starts an X server/browser.
 * Linux requires X11 (Wayland/XWayland is rejected), xdotool, scrot, base-system
 * bash/cat and the user's DISPLAY/XAUTHORITY. Windows services require an
 * external user-session bridge.
 * Screenshot bytes stay in bounded process memory; no files or clipboard are used.
 * Scroll deltas are wheel units (120 per notch); positive Y scrolls down.
 */
export function createDesktopDriver(options: DesktopDriverOptions = {}) {
  const platform = options.platform ?? process.platform
  const env = { ...(options.env ?? process.env) }
  if (platform === 'linux') {
    if (!env.XAUTHORITY) env.XAUTHORITY = join(env.HOME ?? homedir(), '.Xauthority')
    // xdotool decodes text using the subprocess locale, not Node's UTF-8 encoder.
    env.LC_ALL = 'C.UTF-8'
  }
  const run = options.run ?? runDesktopCommand
  const timeoutMs = options.timeoutMs ?? 15_000
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) throw new Error('Invalid desktop timeout')
  let closed = false
  let closing = false
  let tail: Promise<unknown> = Promise.resolve()
  const heldButtons = new Set<'left' | 'middle' | 'right'>()
  let pendingKeys: string[] = []
  let pendingWindowsKeys: number[] = []
  let pendingText = ''
  let scrotChecked = false

  const command = (file: string, args: readonly string[], signal?: AbortSignal, maxOutputBytes = 4096, stdin?: string) =>
    run(file, args, { env, signal, maxOutputBytes, timeoutMs, stdin })
  const ps = async (request: object, signal?: AbortSignal, image = false): Promise<Record<string, unknown>> => {
    // SystemRoot is provided by the native Windows process environment, not a request.
    const executable = join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const output = await command(executable, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(WINDOWS_DESKTOP_SCRIPT, 'utf16le').toString('base64'),
    ], signal, image ? 46 * 1024 * 1024 : 4096, JSON.stringify(request))
    let result: Record<string, unknown>
    try { result = JSON.parse(output.toString('utf8').replace(/^\uFEFF/, '')) as Record<string, unknown> }
    catch { throw new Error('Invalid native desktop response') }
    if (result.ok !== true) throw new Error('Native desktop did not confirm success')
    return result
  }
  const assertPlatform = () => {
    if (platform !== 'linux' && platform !== 'win32') throw new Error(`Native desktop is unsupported on ${platform}`)
    if (platform === 'linux') {
      if (env.XDG_SESSION_TYPE?.toLowerCase() === 'wayland' || env.WAYLAND_DISPLAY) throw new Error('Wayland is unsupported. Log into an existing X11/Xorg desktop session.')
      if (!env.DISPLAY?.trim()) throw new Error('No interactive X11 DISPLAY. Run Executor in the logged-in desktop session with DISPLAY and XAUTHORITY.')
    }
  }
  const geometry = async (signal?: AbortSignal) => {
    let raw: string
    try { raw = (await command('xdotool', ['getdisplaygeometry'], signal)).toString('utf8').trim() }
    catch (error) {
      if (signal?.aborted) throw error
      throw new Error(`Cannot access the existing X11 desktop. Check the logged-in user's DISPLAY and XAUTHORITY. ${error instanceof Error ? error.message : 'Native X11 command failed'}`)
    }
    const match = /^(\d+)\s+(\d+)$/.exec(raw)
    if (!match) throw new Error('Cannot access X11 desktop geometry; check DISPLAY and XAUTHORITY')
    const width = Number(match[1]), height = Number(match[2])
    if (!width || !height || width > 32768 || height > 32768 || width * height > 64_000_000) throw new Error('X11 desktop dimensions exceed safety limit')
    return { width, height }
  }
  const checkScrot = async (signal?: AbortSignal) => {
    if (scrotChecked) return
    const version = (await command('scrot', ['--version'], signal)).toString('utf8')
    const match = /\b(\d+)\.(\d+)(?:\.\d+)?\b/.exec(version)
    if (!match || Number(match[1]) < 1 || (Number(match[1]) === 1 && Number(match[2]) < 7)) {
      throw new Error('scrot >= 1.7 is required for protected in-memory PNG capture. Install the current OS-vendor scrot package.')
    }
    scrotChecked = true
  }
  const serialize = <T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    if (closing) return Promise.reject(new Error('Desktop driver is closed'))
    const work = tail.then(async () => {
      try {
        aborted(signal)
        if (closed) throw new Error('Desktop driver is closed')
        return await operation()
      } catch (error) {
        if (signal?.aborted) {
          try { await release() } catch (cleanup) { throw new AggregateError([error, cleanup], 'Cancelled desktop operation could not release input') }
        }
        throw error
      }
    })
    tail = work.catch(() => {})
    return work
  }
  const release = async () => {
    if (!heldButtons.size && !pendingKeys.length && !pendingText) return
    if (platform === 'win32') {
      await ps({ operation: 'release', buttons: [...heldButtons], keys: [...pendingWindowsKeys].reverse(), text: pendingText })
    } else if (platform === 'linux') {
      // Try every release even if one native call fails.
      const failures: unknown[] = []
      for (const button of heldButtons) {
        try { await command('xdotool', ['mouseup', BUTTONS[button]]) } catch (error) { failures.push(error) }
      }
      if (pendingKeys.length) {
        try {
          const keys = pendingKeys.slice().reverse()
          if (pendingText) {
            // Only generated keysyms enter script mode; never raw request text.
            if (keys.some((key) => !/^[a-zA-Z0-9_]+$/.test(key))) throw new Error('Invalid generated cleanup keysym')
            await command('xdotool', ['-'], undefined, 4096, `keyup ${keys.join(' ')}\n`)
          } else await command('xdotool', ['keyup', ...keys])
        } catch (error) { failures.push(error) }
      }
      if (failures.length) throw new Error('Failed to release native desktop input; reconnect to the interactive desktop and close again')
    }
    heldButtons.clear(); pendingKeys = []; pendingWindowsKeys = []; pendingText = ''
  }
  return {
    status: (): Promise<DesktopStatus> => serialize(async () => {
      try {
        assertPlatform()
        if (platform === 'win32') await ps({ operation: 'status' })
        else {
          await geometry()
          await checkScrot()
        }
        return { available: true, platform }
      } catch (error) { return { available: false, platform, reason: error instanceof Error ? error.message : 'Desktop unavailable' } }
    }),
    screenshot: (signal?: AbortSignal): Promise<DesktopScreenshot> => serialize(async () => {
      assertPlatform()
      if (platform === 'win32') {
        const result = await ps({ operation: 'screenshot' }, signal, true)
        const bounds = result.bounds
        if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(Number.isSafeInteger)
            || typeof result.base64 !== 'string' || result.base64.length > 44_739_244 || !/^[A-Za-z0-9+/]*={0,2}$/.test(result.base64)) throw new Error('Invalid native screenshot response')
        const shot = png(Buffer.from(result.base64, 'base64'), bounds[0] as number, bounds[1] as number)
        if (shot.width !== bounds[2] || shot.height !== bounds[3]) throw new Error('Desktop geometry changed during capture; retry')
        return shot
      }
      const bounds = await geometry(signal)
      await checkScrot(signal)
      // Imlib reopens /dev/stdout: Node's socket-backed stdio cannot be reopened.
      // A fixed pipeline gives scrot a real pipe; pipefail preserves its errors.
      const shot = png(await command('/bin/bash', [
        '--noprofile', '--norc', '-p', '-o', 'pipefail', '-c', 'scrot --silent - | cat',
      ], signal, MAX_IMAGE), 0, 0)
      if (shot.width !== bounds.width || shot.height !== bounds.height) throw new Error('X11 geometry changed during capture; retry')
      return shot
    }, signal),
    input: (action: DesktopInputAction, signal?: AbortSignal): Promise<void> => {
      // Validate and copy before queuing, so callers cannot mutate queued requests.
      try { validate(action) } catch (error) { return Promise.reject(error) }
      const copy = action.type === 'type' ? { ...action, text: action.text.replace(/\r\n?/g, '\n') } : { ...action }
      return serialize(async () => {
        assertPlatform()
        const keys = copy.type === 'key' ? parseKey(copy.key) : undefined
        try {
          if (platform === 'linux') {
            const bounds = await geometry(signal)
            const points = copy.type === 'drag' ? [[copy.fromX, copy.fromY], [copy.toX, copy.toY]]
              : 'x' in copy ? [[copy.x, copy.y]] : []
            if (points.some(([x, y]) => x! < 0 || y! < 0 || x! >= bounds.width || y! >= bounds.height)) throw new Error('Coordinates outside the X11 root desktop')
          }
          if (copy.type === 'key') {
            pendingKeys = keys!.linuxKeys
            pendingWindowsKeys = keys!.windows
          }
          if (copy.type === 'type') {
            pendingText = copy.text
            pendingKeys = [...textKeys(copy.text), 'shift', 'ctrl', 'alt', 'super']
            pendingWindowsKeys = [13, 9]
          }
          if (copy.type === 'button' && copy.down) heldButtons.add(copy.button)
          if (copy.type === 'click') heldButtons.add(copy.button)
          if (copy.type === 'drag') heldButtons.add('left')
          if (platform === 'win32') {
            const native = copy.type === 'drag' ? { ...copy, x: copy.fromX, y: copy.fromY } : copy
            await ps({ operation: 'input', action: { ...native, ...(copy.type === 'click' ? { clickCount: copy.clickCount ?? 1 } : {}) }, keys: keys?.windows ?? [] }, signal)
          } else {
            const xdo = (args: string[], stdin?: string) => command('xdotool', args, signal, 4096, stdin).then(() => {})
            const move = async (x: number, y: number) => {
              // Vendor --sync waits for motion forever if the pointer is already there.
              await xdo(['mousemove', String(x), String(y)])
              const actual = (await command('xdotool', ['getmouselocation', '--shell'], signal)).toString('utf8')
              const actualX = /^X=(-?\d+)$/m.exec(actual), actualY = /^Y=(-?\d+)$/m.exec(actual)
              if (!actualX || !actualY) throw new Error('Cannot verify the native X11 pointer position')
              if (Number(actualX[1]) !== x || Number(actualY[1]) !== y) throw new Error('X11 pointer did not reach the requested coordinates; check for an application pointer grab')
            }
            switch (copy.type) {
              case 'move': await move(copy.x, copy.y); break
              case 'button':
                await move(copy.x, copy.y)
                await xdo([copy.down ? 'mousedown' : 'mouseup', BUTTONS[copy.button]])
                break
              case 'click':
                await move(copy.x, copy.y)
                await xdo(['click', '--repeat', String(copy.clickCount ?? 1), '--delay', '60', BUTTONS[copy.button]])
                break
              case 'scroll':
                await move(copy.x, copy.y)
                for (const [delta, positive, negative] of [[copy.deltaY, '5', '4'], [copy.deltaX, '7', '6']] as const) {
                  if (delta) await xdo(['click', '--repeat', String(Math.max(1, Math.round(Math.abs(delta) / 120))), '--delay', '0', delta > 0 ? positive : negative])
                }
                break
              case 'key': await xdo(['key', '--clearmodifiers', keys!.linux]); break
              case 'type':
                // Temporary Unicode keymaps need xdotool's normal delivery delay.
                await xdo(['type', '--clearmodifiers', '--delay', /[^\x00-\x7f]/.test(copy.text) ? '12' : '0', '--file', '-'], copy.text)
                break
              case 'drag':
                await move(copy.fromX, copy.fromY)
                await xdo(['mousedown', '1'])
                for (let step = 1; step <= 12; step++) {
                  await move(Math.round(copy.fromX + (copy.toX - copy.fromX) * step / 12), Math.round(copy.fromY + (copy.toY - copy.fromY) * step / 12))
                }
                await xdo(['mouseup', '1'])
                break
            }
          }
          aborted(signal)
          pendingKeys = []; pendingWindowsKeys = []; pendingText = ''
          if (copy.type === 'button' && !copy.down) heldButtons.delete(copy.button)
          if (copy.type === 'click') heldButtons.delete(copy.button)
          if (copy.type === 'drag') heldButtons.delete('left')
        } catch (error) {
          try { await release() } catch (cleanup) {
            throw new AggregateError([error, cleanup], `Desktop operation failed and input cleanup failed: ${error instanceof Error ? error.message : 'native desktop unavailable'}`)
          }
          throw error
        }
      }, signal)
    },
    close: (): Promise<void> => {
      closing = true
      const work = tail.then(async () => { await release(); closed = true })
      tail = work.catch(() => {})
      return work
    },
    /** Lease revocation cleanup without closing the process-lifetime driver. */
    releaseInputs: (): Promise<void> => serialize(release),
  }
}
