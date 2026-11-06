import { startExecutor } from '../../../executor/src/client.ts'
import { arenaGitInitTool } from '../../../executor/src/tools/arena-git-mutation.ts'
import { arenaGitProbeTool } from '../../../executor/src/tools/arena-git-probe.ts'

const handle = startExecutor({
  host: process.env.ARENA_TEST_HOST,
  workspaceId: process.env.ARENA_TEST_WORKSPACE,
  executorId: process.env.ARENA_TEST_EXECUTOR,
  sandboxRoots: [process.env.ARENA_TEST_ROOT],
  receiptStorePath: process.env.ARENA_TEST_RECEIPTS,
  arenaKeeperIdentityFile: process.env.ARENA_TEST_KEEPER,
  tools: [arenaGitInitTool, arenaGitProbeTool],
})

await handle.ready
process.stdout.write('ready\n')
