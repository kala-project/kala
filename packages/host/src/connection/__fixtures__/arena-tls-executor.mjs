import { startExecutor } from '../../../../executor/src/client.js'
import { arenaGitProbeTool } from '../../../../executor/src/tools/arena-git-probe.js'
import { arenaGitStatusTool } from '../../../../executor/src/tools/arena-git-status.js'

const [host, workspace, keeper, journal] = process.argv.slice(2)
if (!host || !workspace || !keeper || !journal) throw new Error('Missing isolated TLS Executor fixture paths')

const handle = startExecutor({
  host,
  workspaceId: 'arena-tls-fixture-workspace',
  executorId: 'arena-tls-fixture-executor',
  sandboxRoots: [workspace],
  arenaKeeperIdentityFile: keeper,
  receiptStorePath: journal,
  tools: [arenaGitProbeTool, arenaGitStatusTool],
  logger: {
    debug() {},
    info() {},
    warn(details) { process.stdout.write(`executor-warning:${JSON.stringify(details)}\n`) },
  },
})
await handle.ready
process.stdout.write('ready\n')
