import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { startExecutor } from '../client.js'
import { shellTool } from '../tools/bash.js'
import { skillFileTool } from '../tools/skill-file.js'

const [host, workspaceRoot, receiptStorePath] = process.argv.slice(2)

if (!host || !workspaceRoot || !receiptStorePath) {
  throw new Error('expected host, workspace root, and receipt store path')
}

await writeFile(join(workspaceRoot, 'executor.pid'), String(process.pid))

const executor = startExecutor({
  host,
  workspaceId: 'workspace-crash-regression',
  workspaceName: 'crash-regression',
  executorId: 'executor-crash-regression',
  sandboxRoots: [workspaceRoot],
  receiptStorePath,
  arenaKeeperIdentityFile: process.env.ARENA_TEST_KEEPER,
  tools: [shellTool, {
    name: 'skill_file',
    async run(input, ctx) {
      const result = await skillFileTool.run(input, ctx)
      if (input.action !== 'read') {
        await writeFile(join(workspaceRoot, 'skill-final-effect-finished'), '')
        await new Promise<never>(() => undefined)
      }
      return result
    },
  }],
})

const shutdown = async (): Promise<void> => {
  await executor.close()
  process.exit(0)
}

process.once('SIGINT', () => void shutdown())
process.once('SIGTERM', () => void shutdown())

await executor.ready
