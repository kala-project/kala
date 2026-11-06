import { startExecutor } from '../../../executor/src/client.ts'
import { skillFileTool } from '../../../executor/src/tools/skill-file.ts'
import { memoryTool } from '../../../executor/src/tools/memory.ts'

const handle = startExecutor({
  host: process.env.LEARNING_TEST_HOST,
  workspaceId: process.env.LEARNING_TEST_WORKSPACE,
  executorId: process.env.LEARNING_TEST_EXECUTOR,
  sandboxRoots: [process.env.LEARNING_TEST_ROOT],
  receiptStorePath: process.env.LEARNING_TEST_RECEIPTS,
  arenaKeeperIdentityFile: process.env.LEARNING_TEST_KEEPER,
  tools: [skillFileTool, memoryTool],
})

await handle.ready
process.stdout.write('ready\n')
