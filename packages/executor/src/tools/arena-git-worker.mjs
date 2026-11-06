import { spawn } from 'node:child_process'

process.on('disconnect', () => {})
process.once('message', ({ cwd, args, input }) => {
  process.disconnect?.()
  if (process.env.KALA_ARENA_TEST_PAUSE_GIT === 'probe-rev-parse'
    && args.includes('--show-toplevel')) process.kill(process.pid, 'SIGSTOP')
  const git = spawn('/usr/bin/git', args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1',
    },
  })
  if (process.env.KALA_ARENA_TEST_PAUSE_GIT === 'worktree-add'
    && args.includes('worktree') && args.includes('add') && git.pid) {
    try { process.kill(git.pid, 'SIGSTOP') } catch {}
  }
  git.stdin.on('error', () => {})
  git.stdin.end(input ?? '')
  git.stdout.pipe(process.stdout)
  git.stderr.pipe(process.stderr)
  git.on('error', () => { process.exitCode = 127 })
  git.on('close', (code) => { process.exitCode = code ?? 127 })
})
