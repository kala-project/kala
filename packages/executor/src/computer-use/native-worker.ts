import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { companionFrames } from './companion-protocol.js'

/** One bounded JSON-line worker per interactive driver, not one process per action. */
export function createNativeWorker(file: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number, bootstrap?: string) {
  let child: ChildProcessWithoutNullStreams | undefined
  let pending: { id: string; resolve(value: Record<string, unknown>): void; reject(error: Error): void } | undefined
  let closed = false
  let stopping = Promise.resolve()
  const stop = (error: Error, exited = false) => {
    const previous = child
    child = undefined
    const request = pending
    pending = undefined
    if (previous && !exited) {
      stopping = new Promise<void>((done) => previous.once('close', () => done()))
      previous.kill('SIGKILL')
    }
    void stopping.then(() => request?.reject(error))
    return stopping
  }
  const start = () => {
    if (closed) throw new Error('Native desktop worker is closed')
    if (child) return child
    const current = spawn(file, args, { env, windowsHide: true, shell: false, stdio: 'pipe' })
    child = current
    let diagnostic = ''
    current.stderr.on('data', (data: Buffer) => {
      if (diagnostic.length < 2048) diagnostic += data.toString('utf8').slice(0, 2048 - diagnostic.length)
    })
    current.stdin.on('error', () => {
      if (child === current) stop(new Error('Cannot write to native desktop worker'))
    })
    current.on('error', (error: NodeJS.ErrnoException) => {
      if (child === current) stop(new Error(`Cannot start native desktop worker (${error.code ?? 'unknown'}). Use Windows PowerShell 5.1 or OS-vendor Python3/python3-pyatspi.`))
    })
    current.on('close', () => {
      if (child === current) stop(new Error(`Native desktop worker exited: ${diagnostic.trim() || 'desktop connection lost'}`), true)
    })
    current.stdout.on('data', companionFrames(46 * 1024 * 1024, (value) => {
      if (child !== current) return
      if (!value || typeof value !== 'object' || Array.isArray(value)) { stop(new Error('Invalid native worker response')); return }
      const result = value as Record<string, unknown>
      if (!pending || result.id !== pending.id || typeof result.ok !== 'boolean') { stop(new Error('Unexpected native worker response')); return }
      const request = pending
      pending = undefined
      if (result.ok) request.resolve(result)
      else request.reject(new Error(typeof result.error === 'string' ? result.error.slice(0, 2048) : 'Native desktop operation failed'))
    }, () => stop(new Error('Native desktop worker response exceeded bounds or was malformed'))))
    // Fixed bundled source, before any request data. Avoid Windows' 32K argv limit.
    if (bootstrap) current.stdin.write(`${Buffer.from(bootstrap, 'utf8').toString('base64')}\n`)
    return current
  }
  return {
    async request(request: object, signal?: AbortSignal): Promise<Record<string, unknown>> {
      if (signal?.aborted) throw new DOMException('Native desktop operation cancelled', 'AbortError')
      await stopping
      if (signal?.aborted) throw new DOMException('Native desktop operation cancelled', 'AbortError')
      if (pending) throw new Error('Native desktop worker already has a pending operation')
      const frame = `${JSON.stringify({ ...request, id: randomUUID() })}\n`
      if (Buffer.byteLength(frame) > 32 * 1024) throw new Error('Native desktop request exceeded bounds')
      const current = start()
      return await new Promise((resolve, reject) => {
        const onAbort = () => stop(new DOMException('Native desktop operation cancelled', 'AbortError'))
        const timer = setTimeout(() => stop(new Error(`Native desktop worker timed out (${timeoutMs}ms)`)), timeoutMs)
        const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort) }
        pending = {
          id: (JSON.parse(frame) as { id: string }).id,
          resolve: (result) => { cleanup(); resolve(result) },
          reject: (error) => { cleanup(); reject(error) },
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        current.stdin.write(frame)
        if (signal?.aborted) onAbort()
      })
    },
    close() { closed = true; return stop(new Error('Native desktop worker closed')) },
  }
}
