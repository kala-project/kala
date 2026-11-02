import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const dashboard = dirname(dirname(fileURLToPath(import.meta.url)))
export const systemdBudget = [
  'MemoryMax=2304M', 'MemoryHigh=2048M', 'MemorySwapMax=0',
  'CPUQuota=100%', 'TasksMax=64', 'RuntimeMaxSec=600',
  'OOMPolicy=kill', 'KillMode=control-group', 'TimeoutStopSec=5', 'LimitCORE=0',
]

export function buildSteps(args = []) {
  const prototype = args.includes('--prototype')
  return [
    ['--max-old-space-size=768', join(dirname(require.resolve('typescript/package.json')), 'lib/tsc.js'), '--noEmit', '-p', prototype ? 'tsconfig.prototype.json' : 'tsconfig.json'],
    ['--max-old-space-size=1536', join(dirname(require.resolve('vite/package.json')), 'bin/vite.js'), 'build', ...(prototype ? ['--config', 'vite.prototype.config.ts'] : []), ...args.filter((arg) => arg !== '--prototype')],
  ]
}

// Pass names, never secret values, on systemd-run's command line.
export function inheritedEnvironment(env) {
  return Object.keys(env).filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)).map((name) => `--setenv=${name}`)
}

async function run(command, args, { unit } = {}) {
  const child = spawn(command, args, {
    cwd: dashboard, stdio: 'inherit',
    env: { ...process.env, GOMAXPROCS: '1', UV_THREADPOOL_SIZE: '1' },
  })
  const interrupt = (signal) => {
    // Only the transient unit created by this invocation is eligible for stop.
    if (unit) spawnSync('systemctl', ['--user', 'stop', unit], { stdio: 'ignore', timeout: 7000 })
    child.kill(signal)
  }
  const onInt = () => interrupt('SIGINT')
  const onTerm = () => interrupt('SIGTERM')
  process.on('SIGINT', onInt); process.on('SIGTERM', onTerm)
  try {
    return await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code) => resolve(code ?? 1))
    })
  } finally {
    process.off('SIGINT', onInt); process.off('SIGTERM', onTerm)
  }
}

async function main() {
  const args = process.argv.slice(2)
  const inside = args[0] === '--inside-build-budget'
  if (inside) args.shift()
  const mode = process.env.KALA_BUILD_SYSTEMD ?? 'auto'
  if (!['auto', 'required', 'off'].includes(mode)) throw new Error('KALA_BUILD_SYSTEMD must be auto, required, or off')
  if (!inside && mode !== 'off') {
    const available = process.platform === 'linux'
      && spawnSync('systemd-run', ['--version'], { stdio: 'ignore', timeout: 2000 }).status === 0
      && spawnSync('systemctl', ['--user', 'show-environment'], { stdio: 'ignore', timeout: 2000 }).status === 0
    if (available) {
      const unit = `kala-dashboard-build-${process.pid}-${randomUUID().slice(0, 8)}.service`
      console.info('[build-budget] Hard total-memory cap: 2304 MiB; swap disabled; one CPU; isolated build unit.')
      return run('systemd-run', [
        '--user', `--unit=${unit}`, '--wait', '--pipe', '--collect',
        ...systemdBudget.flatMap((property) => ['-p', property]),
        `--working-directory=${dashboard}`, ...inheritedEnvironment(process.env),
        process.execPath, fileURLToPath(import.meta.url), '--inside-build-budget', ...args,
      ], { unit })
    }
    if (mode === 'required') throw new Error('A Linux systemd user manager is required for the hard build cap but is unavailable; enable one or use KALA_BUILD_SYSTEMD=off inside your own resource-limited CI/container.')
    console.warn('[build-budget] No systemd user manager: Node heaps and compiler concurrency are bounded, but total process memory is NOT hard-capped. Use a resource-limited CI/container for a hard cap.')
  } else if (!inside) {
    console.warn('[build-budget] External resource isolation selected; this runner limits heaps/concurrency, NOT total process memory.')
  }
  for (const [index, step] of buildSteps(args).entries()) {
    console.info(`[build-budget] ${index === 0 ? 'Typecheck (768 MiB heap)' : 'Vite (1536 MiB heap)'}; sequential, compiler concurrency=1.`)
    const code = await run(process.execPath, step)
    if (code !== 0) return code
  }
  return 0
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code }).catch((error) => {
    console.error(`[build-budget] ${error.message}`)
    process.exitCode = 1
  })
}
