import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { startExecutor } from '../client.js'
import { shellTool } from '../tools/bash.js'

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
  tools: [shellTool],
})

const shutdown = async (): Promise<void> => {
  await executor.close()
  process.exit(0)
}

process.once('SIGINT', () => void shutdown())
process.once('SIGTERM', () => void shutdown())

await executor.ready
