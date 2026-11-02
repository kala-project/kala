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
    alias: [
      { find: '@agent-kernel/host', replacement: resolve(__dirname, '../host/src/index.ts') },
      { find: '@agent-kernel/kernel', replacement: resolve(__dirname, '../kernel/src/index.ts') },
      { find: '@agent-kernel/shared/enhancement', replacement: resolve(__dirname, '../shared/src/enhancement.ts') },
      { find: '@agent-kernel/shared/context-policy', replacement: resolve(__dirname, '../shared/src/context-policy/index.ts') },
      { find: '@agent-kernel/shared/context-usage', replacement: resolve(__dirname, '../shared/src/context-usage/index.ts') },
      { find: '@agent-kernel/shared/push', replacement: resolve(__dirname, '../shared/src/push.ts') },
      { find: '@agent-kernel/shared/runtime-logger', replacement: resolve(__dirname, '../shared/src/runtime-logger.ts') },
      { find: '@agent-kernel/shared/token-estimation', replacement: resolve(__dirname, '../shared/src/token-estimation.ts') },
      { find: /^@agent-kernel\/shared$/, replacement: resolve(__dirname, '../shared/src/index.ts') },
    ],
  },
})
