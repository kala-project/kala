// Executed inside disposable native acceptance containers, never a live instance.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const role = process.env.KALA_EXECUTION_PROBE_ROLE
const phase = process.env.KALA_EXECUTION_PROBE_PHASE
assert(['runtime', 'gateway', 'dashboard'].includes(role))
assert(['before', 'after'].includes(phase))
assert.equal(process.getuid(), 65532)
const status = fs.readFileSync('/proc/self/status', 'utf8')
assert.match(status, /^NoNewPrivs:\s+1$/m)
assert.match(status, /^CapEff:\s+0+$/m)
assert.match(status, /^CapBnd:\s+0+$/m)
assert.throws(() => fs.writeFileSync('/app/.bounded-root-write', 'forbidden'), { code: 'EROFS' })
const temporary = '/tmp/.bounded-direct-execution'
fs.writeFileSync(temporary, '#!/nodejs/bin/node\nprocess.exit(0)\n', { mode: 0o700 })
assert.equal(spawnSync(temporary).error?.code, 'EACCES')
fs.unlinkSync(temporary)
const cgroupMemory = ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes'].find(fs.existsSync)
assert(cgroupMemory)
const memoryMax = Number(fs.readFileSync(cgroupMemory, 'utf8').trim())
assert(Number.isSafeInteger(memoryMax) && memoryMax > 0)
const cgroupPids = ['/sys/fs/cgroup/pids.max', '/sys/fs/cgroup/pids/pids.max'].find(fs.existsSync)
assert(cgroupPids)
const pidsMax = Number(fs.readFileSync(cgroupPids, 'utf8').trim())
assert(Number.isSafeInteger(pidsMax) && pidsMax > 0)
const result = { role, phase, uid: process.getuid(), noNewPrivileges: true, capabilitiesEmpty: true,
  imageRootWriteDenied: true, temporaryDirectExecutionDenied: true, memoryMax, pidsMax }

if (role === 'runtime') {
  const scratch = '/app/packages/host/.runtime-tmp'
  const marker = path.join(scratch, '.bounded-reconstruction-marker')
  const capacity = fs.statfsSync(scratch)
  assert(capacity.blocks * capacity.bsize <= 512 * 1024 ** 2)
  assert.equal(fs.statSync(scratch).uid, 65532)
  assert.equal(fs.statSync(scratch).mode & 0o777, 0o700)
  if (phase === 'after') assert.equal(fs.existsSync(marker), false)
  else fs.writeFileSync(marker, 'disposable-only')
  const executable = path.join(scratch, '.bounded-direct-execution')
  fs.writeFileSync(executable, '#!/nodejs/bin/node\nprocess.exit(0)\n', { mode: 0o700 })
  assert.equal(spawnSync(executable).error?.code, 'EACCES')
  fs.unlinkSync(executable)
  Object.assign(result, { scratchCapacityBytes: capacity.blocks * capacity.bsize, scratchPrivate: true,
    scratchDirectExecutionDenied: true, ...(phase === 'after' ? { oldScratchAbsent: true } : {}) })
  if (phase === 'before') {
    const cli = process.env.COPILOT_CLI_PATH
    assert.equal(cli, '/app/copilot-runtime/copilot-runtime')
    const library = path.join(path.dirname(cli), 'runtime.node')
    for (const file of [cli, library]) {
      const stat = fs.statSync(file)
      assert.equal(stat.uid, 0)
      assert.equal(stat.mode & 0o222, 0)
    }
    const baseDirectory = path.join(scratch, 'bounded-sdk-auth-probe')
    fs.mkdirSync(baseDirectory, { mode: 0o700 })
    const { CopilotClient, RuntimeConnection } = await import('@github/copilot-sdk')
    const client = new CopilotClient({ mode: 'empty', baseDirectory,
      connection: RuntimeConnection.forStdio({ path: cli, args: ['--no-remote-export'] }) })
    try {
      await client.start()
      const authentication = await client.getAuthStatus()
      assert.equal(authentication.isAuthenticated, false)
      Object.assign(result, { immutableSdkPairStarted: true, sdkAuthenticated: false })
    } finally { await client.stop() }
  }
}
console.log(JSON.stringify(result))
