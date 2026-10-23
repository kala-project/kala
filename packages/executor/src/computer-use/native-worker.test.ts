import { describe, expect, it } from 'vitest'
import { createNativeWorker } from './native-worker.js'

const script = `
const readline = require('node:readline');
readline.createInterface({input:process.stdin}).on('line',line=>{
  const r=JSON.parse(line);
  if(r.operation==='hang') return;
  process.stdout.write(JSON.stringify({id:r.id,ok:r.operation!=='fail',error:'explicit native failure',pid:process.pid})+'\\n');
});
`
describe('persistent native worker using a real child process', () => {
  it('reuses one process and returns per-request errors without corrupting framing', async () => {
    const worker = createNativeWorker(process.execPath, ['-e', script], process.env, 2000)
    try {
      const first = await worker.request({ operation: 'status' })
      await expect(worker.request({ operation: 'fail' })).rejects.toThrow('explicit native failure')
      expect((await worker.request({ operation: 'status' })).pid).toBe(first.pid)
    } finally { await worker.close() }
  })

  it('waits for cancelled process exit before restarting and never replays an action', async () => {
    const worker = createNativeWorker(process.execPath, ['-e', script], process.env, 2000)
    try {
      const first = await worker.request({ operation: 'status' })
      const cancel = new AbortController()
      const pending = worker.request({ operation: 'hang' }, cancel.signal)
      const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      await new Promise((done) => setTimeout(done, 30))
      cancel.abort()
      await rejected
      expect(() => process.kill(Number(first.pid), 0)).toThrow()
      expect((await worker.request({ operation: 'status' })).pid).not.toBe(first.pid)
    } finally { await worker.close() }
  })

  it('bounds request size and terminates a timed-out worker', async () => {
    const worker = createNativeWorker(process.execPath, ['-e', script], process.env, 100)
    try {
      await expect(worker.request({ text: 'x'.repeat(33_000) })).rejects.toThrow('bounds')
      await expect(worker.request({ operation: 'hang' })).rejects.toThrow('timed out')
    } finally { await worker.close() }
  })
})
