import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    fileParallelism: false,
    pool: 'forks',
    singleFork: true,
  },
  resolve: {
    alias: {
      '@agent-kernel/host': resolve(__dirname, '../host/src/index.ts'),
      '@agent-kernel/kernel': resolve(__dirname, '../kernel/src/index.ts'),
      '@agent-kernel/shared/enhancement': resolve(__dirname, '../shared/src/enhancement.ts'),
      '@agent-kernel/shared/context-policy': resolve(__dirname, '../shared/src/context-policy/index.ts'),
      '@agent-kernel/shared/context-usage': resolve(__dirname, '../shared/src/context-usage/index.ts'),
      '@agent-kernel/shared/node-telemetry': resolve(__dirname, '../shared/src/node-telemetry.ts'),
      '@agent-kernel/shared/runtime-logger': resolve(__dirname, '../shared/src/runtime-logger.ts'),
      '@agent-kernel/shared/token-estimation': resolve(__dirname, '../shared/src/token-estimation.ts'),
      '@agent-kernel/shared/push': resolve(__dirname, '../shared/src/push.ts'),
      '@agent-kernel/shared/workspace-exec': resolve(__dirname, '../shared/src/workspace-exec.ts'),
      '@agent-kernel/shared': resolve(__dirname, '../shared/src/index.ts'),
    },
  },
})
