import { describe, expect, it, vi } from 'vitest'
import {
  createDesktopDriver, runDesktopCommand,
  type DesktopCommandOptions, type DesktopInputAction,
} from './desktop-driver.js'
import { WINDOWS_DESKTOP_SCRIPT } from './windows-desktop-script.js'

const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7UkAAAAASUVORK5CYII=', 'base64')
const env = { DISPLAY: ':9', XAUTHORITY: '/home/example/.Xauthority', HOME: '/home/example' }

function linux() {
  let pointerX = 0, pointerY = 0
  const run = vi.fn(async (file: string, args: readonly string[], _options: DesktopCommandOptions) => {
    if (file === 'xdotool' && args[0] === 'getdisplaygeometry') return Buffer.from('1 1\n')
    if (file === 'xdotool' && args[0] === 'mousemove') { pointerX = Number(args[1]); pointerY = Number(args[2]) }
    if (file === 'xdotool' && args[0] === 'getmouselocation') return Buffer.from(`X=${pointerX}\nY=${pointerY}\nSCREEN=0\nWINDOW=123\n`)
    if (file === 'scrot' && args[0] === '--version') return Buffer.from('scrot version 1.10.1\n')
    if (file === '/bin/bash') return image
    return Buffer.alloc(0)
  })
  return { run, driver: createDesktopDriver({ platform: 'linux', env, run }) }
}

function windows() {
  const run = vi.fn(async (_file: string, _args: readonly string[], options: DesktopCommandOptions) => {
    const request = JSON.parse(options.stdin!) as { operation: string }
    return Buffer.from(JSON.stringify({
      ok: true, bounds: [-100, -200, 1, 1], ...(request.operation === 'screenshot' ? { base64: image.toString('base64') } : {}),
    }))
  })
  return { run, driver: createDesktopDriver({ platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, run }) }
}

describe('native desktop driver (injected unit tests, not platform acceptance)', () => {
  it('rejects unsupported platforms and Wayland without native commands', async () => {
    const run = vi.fn()
    expect(await createDesktopDriver({ platform: 'darwin', run }).status()).toEqual({
      available: false, platform: 'darwin', reason: 'Native desktop is unsupported on darwin',
    })
    const driver = createDesktopDriver({ platform: 'linux', env: { ...env, WAYLAND_DISPLAY: 'wayland-0' }, run })
    expect(await driver.status()).toMatchObject({ available: false, reason: expect.stringContaining('Wayland') })
    await expect(driver.screenshot()).rejects.toThrow('Wayland')
    expect(run).not.toHaveBeenCalled()
  })

  it('requires a logged-in X11 DISPLAY and exposes useful dependency errors', async () => {
    const driver = createDesktopDriver({ platform: 'linux', env: {} })
    expect(await driver.status()).toMatchObject({ available: false, reason: expect.stringContaining('DISPLAY') })
    const { driver: missing, run } = linux()
    run.mockRejectedValueOnce(new Error('Missing native desktop dependency: xdotool'))
    expect(await missing.status()).toMatchObject({ available: false, reason: expect.stringContaining('xdotool') })
  })

  it('supplies explicit X11 credentials, returns PNG metadata, and never names a screenshot file', async () => {
    const { run, driver } = linux()
    expect(await driver.status()).toEqual({ available: true, platform: 'linux' })
    expect(await driver.screenshot()).toEqual({
      mimeType: 'image/png', base64: image.toString('base64'), width: 1, height: 1, originX: 0, originY: 0,
    })
    expect(run).toHaveBeenCalledWith('/bin/bash', [
      '--noprofile', '--norc', '-p', '-o', 'pipefail', '-c', 'scrot --silent - | cat',
    ], expect.objectContaining({
      env: { ...env, LC_ALL: 'C.UTF-8' }, maxOutputBytes: 32 * 1024 * 1024, timeoutMs: 15_000,
    }))
  })

  it('sets the standard Xauthority path explicitly when absent', async () => {
    const { run } = linux()
    await createDesktopDriver({ platform: 'linux', env: { DISPLAY: ':1', HOME: '/home/alice' }, run }).status()
    expect(run.mock.calls[0]?.[2].env.XAUTHORITY).toBe('/home/alice/.Xauthority')
  })

  it('refuses old scrot before attempting capture that could create a file', async () => {
    const { run, driver } = linux()
    run.mockImplementation(async (file, args) => Buffer.from(file === 'xdotool' ? '1 1' : 'scrot version 0.8'))
    await expect(driver.screenshot()).rejects.toThrow('scrot >= 1.7')
    expect(run.mock.calls.some(([file]) => file === '/bin/bash')).toBe(false)
  })

  it.each([
    { type: 'move', x: NaN, y: 0 },
    { type: 'move', x: 0.5, y: 0 },
    { type: 'move', x: Infinity, y: 0 },
    { type: 'move', x: 1_000_001, y: 0 },
    { type: 'click', x: 0, y: 0, button: '__proto__' },
    { type: 'click', x: 0, y: 0, button: 'left', clickCount: 3 },
    { type: 'button', x: 0, y: 0, button: 'left', down: 'true' },
    { type: 'scroll', x: 0, y: 0, deltaX: 12_001, deltaY: 0 },
    { type: 'drag', fromX: 0, fromY: 0, toX: 0, toY: '0' },
    { type: 'key', key: 'Ctrl+$(evil)' },
    { type: 'key', key: 'A+B' },
    { type: 'key', key: 'Ctrl+Control+a' },
    { type: 'key', key: '--clearmodifiers' },
    { type: 'type', text: 'a'.repeat(513) },
    { type: 'type', text: '\0' },
    { type: 'type', text: '\ud800' },
    { type: 'type', text: '\x1b' },
    { type: 'unknown' },
    null,
  ])('rejects invalid input before any process starts: %j', async (action) => {
    const { run, driver } = linux()
    await expect(driver.input(action as DesktopInputAction)).rejects.toThrow()
    expect(run).not.toHaveBeenCalled()
  })

  it('checks Linux root coordinate bounds without moving the pointer', async () => {
    const { run, driver } = linux()
    await expect(driver.input({ type: 'move', x: -1, y: 0 })).rejects.toThrow('outside')
    expect(run.mock.calls.map(([, args]) => args[0])).toEqual(['getdisplaygeometry'])
  })

  it('keeps Unicode text exclusively on stdin, never process argv or shell source', async () => {
    const { run, driver } = linux()
    await driver.input({ type: 'key', key: 'Ctrl+Shift+L' })
    await driver.input({ type: 'type', text: '中文 😀 $(not-a-command)\r\nnext' })
    expect(run).toHaveBeenCalledWith('xdotool', ['key', '--clearmodifiers', 'ctrl+shift+l'], expect.anything())
    expect(run).toHaveBeenCalledWith('xdotool', ['type', '--clearmodifiers', '--delay', '12', '--file', '-'], expect.objectContaining({ stdin: '中文 😀 $(not-a-command)\nnext' }))
    expect(run.mock.calls.flatMap(([, args]) => args).join(' ')).not.toContain('中文')
  })

  it.each(['linux', 'win32'] as const)('accepts exactly 512 UTF-16 units and rejects 513 before native input on %s', async (platform) => {
    const { driver, run } = platform === 'linux' ? linux() : windows()
    const text = 'Ab9-中é文😀|'.repeat(51) + '界Z'
    expect(text.length).toBe(512)
    expect(Array.from(text).length).toBe(461)
    await expect(driver.input({ type: 'type', text })).resolves.toBeUndefined()
    const count = run.mock.calls.length
    await expect(driver.input({ type: 'type', text: text + 'x' })).rejects.toThrow('512')
    expect(run).toHaveBeenCalledTimes(count)
  })

  it('does not expose a sensitive typed string in argv, including interrupted cleanup', async () => {
    const { run, driver } = linux()
    const sensitive = 'PrivatePassword-中文-😀-$HOME'
    const base = run.getMockImplementation()!
    run.mockImplementation(async (file, args, options) => {
      if (args[0] === 'type') throw new DOMException('interrupted', 'AbortError')
      return base(file, args, options)
    })
    await expect(driver.input({ type: 'type', text: sensitive })).rejects.toMatchObject({ name: 'AbortError' })
    const typeCall = run.mock.calls.find(([, args]) => args[0] === 'type')!
    expect(typeCall[1]).toEqual(['type', '--clearmodifiers', '--delay', '12', '--file', '-'])
    expect(typeCall[2].stdin).toBe(sensitive)
    const cleanup = run.mock.calls.at(-1)!
    expect(cleanup[1]).toEqual(['-'])
    expect(cleanup[2].stdin).toMatch(/^keyup (?:[a-zA-Z0-9_]+ )*[a-zA-Z0-9_]+\n$/)
    expect(run.mock.calls.every(([, args]) => !args.includes(sensitive) && !args.some((arg) => arg.includes('PrivatePassword')))).toBe(true)
  })

  it('moves before click, scroll and button input and releases explicit holds on shutdown', async () => {
    const { run, driver } = linux()
    await driver.input({ type: 'click', x: 0, y: 0, button: 'right', clickCount: 2 })
    await driver.input({ type: 'scroll', x: 0, y: 0, deltaX: -120, deltaY: 240 })
    await driver.input({ type: 'button', x: 0, y: 0, button: 'left', down: true })
    await driver.close()
    const args = run.mock.calls.map(([, args]) => args)
    expect(args).toContainEqual(['click', '--repeat', '2', '--delay', '60', '3'])
    expect(args).toContainEqual(['click', '--repeat', '2', '--delay', '0', '5'])
    expect(args).toContainEqual(['click', '--repeat', '1', '--delay', '0', '6'])
    expect(args.at(-1)).toEqual(['mouseup', '1'])
    await expect(driver.input({ type: 'move', x: 0, y: 0 })).rejects.toThrow('closed')
    // close is Executor shutdown only; lease stops should not close the driver.
  })

  it('interpolates an existing-desktop drag and releases its button', async () => {
    const { run, driver } = linux()
    await driver.input({ type: 'drag', fromX: 0, fromY: 0, toX: 0, toY: 0 })
    const args = run.mock.calls.map(([, args]) => args)
    expect(args.filter(([kind]) => kind === 'mousemove')).toHaveLength(13)
    expect(args).toContainEqual(['mousedown', '1'])
    expect(args.at(-1)).toEqual(['mouseup', '1'])
  })

  it('verifies repeated same-coordinate moves/clicks/buttons/scrolls/drag endpoints without vendor --sync', async () => {
    const { driver, run } = linux()
    const base = run.getMockImplementation()!
    run.mockImplementation(async (file, args, options) => {
      if (args.includes('--sync')) throw new Error('Vendor xdotool would wait forever for a new motion event')
      return base(file, args, options)
    })
    const actions: DesktopInputAction[] = [
      { type: 'move', x: 0, y: 0 }, { type: 'move', x: 0, y: 0 },
      ...(['left', 'middle', 'right'] as const).map((button): DesktopInputAction => ({ type: 'click', x: 0, y: 0, button })),
      { type: 'button', x: 0, y: 0, button: 'left', down: true },
      { type: 'button', x: 0, y: 0, button: 'left', down: false },
      { type: 'scroll', x: 0, y: 0, deltaX: 120, deltaY: 120 },
      { type: 'scroll', x: 0, y: 0, deltaX: -120, deltaY: -120 },
      { type: 'drag', fromX: 0, fromY: 0, toX: 0, toY: 0 },
    ]
    for (const action of actions) await expect(driver.input(action)).resolves.toBeUndefined()
    const moves = run.mock.calls.filter(([, args]) => args[0] === 'mousemove')
    const confirmations = run.mock.calls.filter(([, args]) => args[0] === 'getmouselocation')
    expect(moves).toHaveLength(22)
    expect(confirmations).toHaveLength(moves.length)
    expect(moves.every(([, args]) => args.join(' ') === 'mousemove 0 0')).toBe(true)
  })

  it.each([
    ['X=1\nY=0\nSCREEN=0\n', 'did not reach'],
    ['invalid native position', 'Cannot verify'],
  ])('fails explicitly if native pointer position cannot be confirmed', async (position, message) => {
    const { driver, run } = linux()
    const base = run.getMockImplementation()!
    run.mockImplementation(async (file, args, options) => args[0] === 'getmouselocation' ? Buffer.from(position) : base(file, args, options))
    await expect(driver.input({ type: 'move', x: 0, y: 0 })).rejects.toThrow(message)
    expect(run).toHaveBeenCalledWith('xdotool', ['mousemove', '0', '0'], expect.anything())
  })

  it('releases lease input without closing the driver or preventing another lease', async () => {
    const { run, driver } = linux()
    await driver.input({ type: 'button', x: 0, y: 0, button: 'left', down: true })
    await driver.releaseInputs()
    expect(run).toHaveBeenLastCalledWith('xdotool', ['mouseup', '1'], expect.anything())
    await expect(driver.screenshot()).resolves.toMatchObject({ mimeType: 'image/png' })
    await driver.input({ type: 'key', key: 'Shift' })
    expect(run).toHaveBeenLastCalledWith('xdotool', ['key', '--clearmodifiers', 'shift'], expect.anything())
  })

  it('rejects already-cancelled screenshot and input without commands', async () => {
    const { run, driver } = linux()
    const signal = AbortSignal.abort()
    await expect(driver.screenshot(signal)).rejects.toMatchObject({ name: 'AbortError' })
    await expect(driver.input({ type: 'move', x: 0, y: 0 }, signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(run).not.toHaveBeenCalled()
  })

  it('releases potentially pressed buttons after cancellation using an uncancelled command', async () => {
    const { run, driver } = linux()
    const abort = new AbortController()
    const base = run.getMockImplementation()!
    run.mockImplementation(async (file, args, options) => {
      if (args[0] === 'mousedown') {
        abort.abort()
        throw new DOMException('cancelled', 'AbortError')
      }
      return base(file, args, options)
    })
    await expect(driver.input({ type: 'button', x: 0, y: 0, button: 'left', down: true }, abort.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(run).toHaveBeenLastCalledWith('xdotool', ['mouseup', '1'], expect.objectContaining({ signal: undefined }))
  })

  it('releases shortcut keys after interrupted native key delivery', async () => {
    const { run, driver } = linux()
    const base = run.getMockImplementation()!
    run.mockImplementation(async (file, args, options) => {
      if (args[0] === 'key') throw new Error('interrupted')
      return base(file, args, options)
    })
    await expect(driver.input({ type: 'key', key: 'Ctrl+Shift+A' })).rejects.toThrow('interrupted')
    expect(run).toHaveBeenLastCalledWith('xdotool', ['keyup', 'a', 'shift', 'ctrl'], expect.anything())
  })

  it('also releases existing held input when a screenshot is cancelled before starting', async () => {
    const { run, driver } = linux()
    await driver.input({ type: 'button', x: 0, y: 0, button: 'left', down: true })
    await expect(driver.screenshot(AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' })
    expect(run).toHaveBeenLastCalledWith('xdotool', ['mouseup', '1'], expect.objectContaining({ signal: undefined }))
  })

  it('surfaces cleanup failures and retries outstanding cleanup on close', async () => {
    const { run, driver } = linux()
    const base = run.getMockImplementation()!
    run.mockImplementation(async (file, args, options) => {
      if (args[0] === 'mousedown' || args[0] === 'mouseup') throw new Error('desktop lost')
      return base(file, args, options)
    })
    await expect(driver.input({ type: 'button', x: 0, y: 0, button: 'left', down: true })).rejects.toBeInstanceOf(AggregateError)
    await expect(driver.close()).rejects.toThrow('release')
    run.mockImplementation(base)
    await expect(driver.close()).resolves.toBeUndefined()
    expect(run).toHaveBeenLastCalledWith('xdotool', ['mouseup', '1'], expect.anything())
  })

  it('serializes commands, snapshots queued action data and honors queued cancellation', async () => {
    const { run, driver } = linux()
    const base = run.getMockImplementation()!
    let unblock!: () => void
    const blocked = new Promise<void>((resolve) => { unblock = resolve })
    run.mockImplementation(async (file, args, options) => {
      if (args[0] === 'getdisplaygeometry') await blocked
      return base(file, args, options)
    })
    const first = driver.screenshot()
    const action = { type: 'type' as const, text: 'original' }
    const second = driver.input(action)
    action.text = 'mutated'
    const abort = new AbortController()
    const third = driver.input({ type: 'move', x: 0, y: 0 }, abort.signal)
    const thirdResult = expect(third).rejects.toMatchObject({ name: 'AbortError' })
    await Promise.resolve()
    expect(run).toHaveBeenCalledTimes(1)
    abort.abort(); unblock()
    await first; await second; await thirdResult
    expect(run).toHaveBeenLastCalledWith('xdotool', ['type', '--clearmodifiers', '--delay', '0', '--file', '-'], expect.objectContaining({ stdin: 'original' }))
  })

  it('rejects invalid and oversized PNG captures', async () => {
    const { run, driver } = linux()
    const base = run.getMockImplementation()!
    run.mockImplementation(async (file, args, options) => {
      if (file === '/bin/bash') return Buffer.from('not a png')
      return base(file, args, options)
    })
    await expect(driver.screenshot()).rejects.toThrow('PNG')
    const huge = Buffer.from(image)
    huge.writeUInt32BE(32769, 16)
    run.mockImplementation(async (file, args, options) => {
      if (file === '/bin/bash') return huge
      return base(file, args, options)
    })
    await expect(driver.screenshot()).rejects.toThrow('dimensions')
  })

  it('preserves negative Windows virtual origins and uses only a fixed encoded script', async () => {
    const { driver, run } = windows()
    expect(await driver.status()).toEqual({ available: true, platform: 'win32' })
    expect(await driver.screenshot()).toMatchObject({ originX: -100, originY: -200, width: 1, height: 1 })
    await driver.input({ type: 'type', text: "'; Write-Host evil; 中文 😀" })
    const [, args, options] = run.mock.calls.at(-1)!
    expect(args.slice(0, 4)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand'])
    expect(Buffer.from(args[4]!, 'base64').toString('utf16le')).toBe(WINDOWS_DESKTOP_SCRIPT)
    expect(args.join(' ')).not.toContain('Write-Host evil')
    expect(JSON.parse(options.stdin!)).toMatchObject({ operation: 'input', action: { text: "'; Write-Host evil; 中文 😀" } })
  })

  it('maps Windows shortcuts and default click count explicitly', async () => {
    const { driver, run } = windows()
    await driver.input({ type: 'key', key: 'Ctrl+L' })
    expect(JSON.parse(run.mock.calls.at(-1)![2].stdin!)).toMatchObject({ keys: [17, 76] })
    await driver.input({ type: 'click', x: -100, y: -200, button: 'left' })
    expect(JSON.parse(run.mock.calls.at(-1)![2].stdin!)).toMatchObject({ action: { clickCount: 1 } })
  })

  it('releases native Unicode key packets after an interrupted Windows text request', async () => {
    const { driver, run } = windows()
    const base = run.getMockImplementation()!
    run.mockImplementation(async (file, args, options) => {
      const request = JSON.parse(options.stdin!)
      if (request.operation === 'input') throw new DOMException('cancelled', 'AbortError')
      return base(file, args, options)
    })
    await expect(driver.input({ type: 'type', text: '中文 😀' })).rejects.toMatchObject({ name: 'AbortError' })
    expect(JSON.parse(run.mock.calls.at(-1)![2].stdin!)).toMatchObject({
      operation: 'release', text: '中文 😀', keys: [9, 13], buttons: [],
    })
  })

  it('reports Session 0 / locked desktop failure, with no successful screenshot fallback', async () => {
    const { driver, run } = windows()
    run.mockRejectedValue(new Error('Session 0 is non-interactive. Configure a logged-in user-session bridge.'))
    expect(await driver.status()).toMatchObject({ available: false, reason: expect.stringContaining('Session 0') })
    await expect(driver.screenshot()).rejects.toThrow('Session 0')
    run.mockRejectedValue(new Error('Input desktop inaccessible or locked'))
    expect(await driver.status()).toMatchObject({ available: false, reason: expect.stringContaining('locked') })
  })

  it('rejects a malformed native Windows response', async () => {
    const { driver, run } = windows()
    run.mockResolvedValue(Buffer.from('{"ok":false}'))
    await expect(driver.screenshot()).rejects.toThrow('confirm')
    run.mockResolvedValue(Buffer.from('{"ok":true,"bounds":[0,0,1,1],"base64":"not png"}'))
    await expect(driver.screenshot()).rejects.toThrow('response')
  })

  it('retains critical Windows source guards and correctly aligned native input layout', () => {
    expect(WINDOWS_DESKTOP_SCRIPT).toContain('session==0')
    expect(WINDOWS_DESKTOP_SCRIPT).toContain('info.Data.SessionState!=0')
    expect(WINDOWS_DESKTOP_SCRIPT).toContain('OpenInputDesktop(0,false,0x101)')
    expect(WINDOWS_DESKTOP_SCRIPT).toContain('GetThreadDesktop(GetCurrentThreadId())')
    expect(WINDOWS_DESKTOP_SCRIPT).toContain('[StructLayout(LayoutKind.Sequential)] struct INPUT')
    expect(WINDOWS_DESKTOP_SCRIPT).toContain('[StructLayout(LayoutKind.Explicit)] struct UNION')
    expect(WINDOWS_DESKTOP_SCRIPT).toContain('Marshal.SizeOf(typeof(INPUT))) != 1')
    expect(WINDOWS_DESKTOP_SCRIPT).toContain('dwFlags=4u|(up?2u:0u)')
    expect(WINDOWS_DESKTOP_SCRIPT).toContain('if(!complete) foreach(char c in text)')
    expect(WINDOWS_DESKTOP_SCRIPT).toContain('CopyFromScreen(b[0],b[1]')
  })

  it('requires an authoritative unlocked WTSInfoEx state even when the input desktop remains Default', () => {
    expect(WINDOWS_DESKTOP_SCRIPT).toContain('WTSQuerySessionInformation(IntPtr.Zero,session,25,out buffer,out bytes)')
    expect(WINDOWS_DESKTOP_SCRIPT).toContain('bytes<Marshal.SizeOf(typeof(WTSINFOEX))')
    expect(WINDOWS_DESKTOP_SCRIPT).toContain('info.Level!=1 || info.Data.SessionId!=(uint)session')
    expect(WINDOWS_DESKTOP_SCRIPT).toContain('info.Data.SessionState!=0')
    expect(WINDOWS_DESKTOP_SCRIPT).toContain('info.Data.SessionFlags!=1')
  })

  it('uses PowerShell 5.1-compatible .NET unsigned key-array casts for both input and release', () => {
    expect(WINDOWS_DESKTOP_SCRIPT).not.toContain('[ushort')
    expect(WINDOWS_DESKTOP_SCRIPT.match(/\[System\.UInt16\[\]\]/g)).toHaveLength(2)
  })

  it('submits Unicode typing as one counted native batch instead of interleavable per-character calls', () => {
    expect(WINDOWS_DESKTOP_SCRIPT).toContain('var input=new List<INPUT>(text.Length*2)')
    expect(WINDOWS_DESKTOP_SCRIPT).toContain('Send(input.ToArray())')
    expect(WINDOWS_DESKTOP_SCRIPT).toContain('Marshal.SizeOf(typeof(INPUT))) != (uint)input.Length')
    expect(WINDOWS_DESKTOP_SCRIPT).toContain('wScan=c, dwFlags=4')
    expect(WINDOWS_DESKTOP_SCRIPT).toContain('wScan=c, dwFlags=6')
  })
})

describe('bounded shell-free desktop subprocess runner', () => {
  const options = { env: process.env, timeoutMs: 2_000, maxOutputBytes: 4096 }

  it('returns stdout and reports missing executables', async () => {
    await expect(runDesktopCommand(process.execPath, ['-e', "process.stdout.write('ok')"], options)).resolves.toEqual(Buffer.from('ok'))
    await expect(runDesktopCommand('./nonexistent-native-desktop-executable', [], options)).rejects.toThrow('Missing native desktop dependency')
  })

  it('terminates cancelled and timed-out processes', async () => {
    const abort = new AbortController()
    const pending = runDesktopCommand(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { ...options, signal: abort.signal })
    abort.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await expect(runDesktopCommand(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { ...options, timeoutMs: 100 })).rejects.toThrow('timed out')
  })

  it('caps stdout and diagnostic stderr', async () => {
    await expect(runDesktopCommand(process.execPath, ['-e', "process.stdout.write('x'.repeat(8192))"], { ...options, maxOutputBytes: 64 })).rejects.toThrow('safety limit')
    let message = ''
    try {
      await runDesktopCommand(process.execPath, ['-e', "process.stderr.write('x'.repeat(8192));process.exitCode=1"], options)
    } catch (error) { message = (error as Error).message }
    expect(message).toContain('failed')
    expect(message.length).toBeLessThan(2200)
  })

  it.skipIf(process.platform === 'win32')('preserves failures from the screenshot side of a real OS pipeline', async () => {
    await expect(runDesktopCommand('/bin/bash', [
      '--noprofile', '--norc', '-p', '-o', 'pipefail', '-c', 'exit 7 | cat',
    ], options)).rejects.toThrow('failed (7)')
  })

  it.skipIf(process.platform === 'win32')('does not import shell functions or startup hooks into the fixed pipeline', async () => {
    await expect(runDesktopCommand('/bin/bash', [
      '--noprofile', '--norc', '-p', '-o', 'pipefail', '-c', 'printf ok | cat',
    ], { ...options, env: { ...process.env, 'BASH_FUNC_cat%%': '() { exit 19; }', BASH_ENV: '/dev/stdin' }, stdin: 'exit 23' })).resolves.toEqual(Buffer.from('ok'))
  })

  it.skipIf(process.platform === 'win32')('cancels descendants retaining stdout instead of leaving pipeline workers alive', async () => {
    const started = performance.now()
    await expect(runDesktopCommand(process.execPath, ['-e', `
      require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: ['ignore', 1, 2] });
      setTimeout(() => {}, 30000);
    `], { ...options, signal: AbortSignal.timeout(150) })).rejects.toMatchObject({ name: 'AbortError' })
    expect(performance.now() - started).toBeLessThan(2000)
  })
})
