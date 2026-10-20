import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

function prototypeApi(): Plugin {
  return {
    name: 'kala-prototype-api',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = new URL(request.url ?? '/', 'http://localhost')
        response.setHeader('cache-control', 'no-store, max-age=0')
        const sendJson = (payload: unknown): void => {
          response.setHeader('content-type', 'application/json')
          response.end(JSON.stringify(payload))
        }
        if (url.pathname === '/runtime/capabilities') {
          sendJson({
            product: 'portable',
            deployment: { mode: 'portable' },
            capabilities: { agent: true, workspace: true, operations: true, artifacts: true, pipeline: true },
          })
          return
        }
        if (url.pathname === '/models') {
          sendJson({
            models: [{
              ref: 'openai:gpt-5.6',
              id: 'gpt-5.6',
              label: 'GPT 5.6',
              provider: 'OpenAI',
              providerId: 'openai',
              contextWindow: 1_000_000,
            }],
            defaultModel: 'openai:gpt-5.6',
          })
          return
        }
        if (url.pathname === '/settings') {
          sendJson({
            providers: [{ id: 'mock', label: 'Placeholder provider', wire: 'openai', baseUrl: 'https://placeholder.invalid', configured: false, models: [{ id: 'placeholder-model', contextWindow: 128000 }] }],
            defaultModel: 'placeholder-model',
            hooks: [],
            versions: { host: 'prototype', protocol: 'placeholder' },
            paths: {
              claudeSettings: '/placeholder/claude/settings.json',
              codexConfig: '/placeholder/codex/config.toml',
              manualModels: '/placeholder/models.json',
              hooksConfig: '/placeholder/hooks.json',
              sessionsDir: '/placeholder/sessions',
            },
            mcp: { supported: false, note: 'Placeholder data only.' },
          })
          return
        }
        if (url.pathname === '/auth/executor-pairings') {
          sendJson({ pairings: [] })
          return
        }
        if (url.pathname === '/auth/executor-identities') {
          sendJson({
            identities: [
              { workspaceId: 'workspace-studio', executorId: 'executor-studio', createdAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-10-01T08:00:00.000Z' },
              { workspaceId: 'workspace-labs', executorId: 'executor-labs', createdAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-10-01T07:00:00.000Z' },
            ],
          })
          return
        }
        if (url.pathname === '/push/activity') {
          sendJson({ ok: true })
          return
        }
        if (url.pathname === '/user/session-tabs') {
          sendJson(request.method === 'GET' ? { content: JSON.stringify({ pinned: ['prototype-active'], open: ['prototype-active', 'prototype-attention'] }) } : { ok: true })
          return
        }
        if (url.pathname === '/runtime/admission/messages' && request.method === 'POST') {
          let body = ''
          request.on('data', (chunk) => { body += String(chunk) })
          request.on('end', () => {
            const operationId = (JSON.parse(body || '{}') as { operationId?: string }).operationId ?? 'prototype-operation'
            sendJson({
              accepted: true,
              duplicate: false,
              operationId,
              sequence: 99,
              state: 'committed',
              routeGeneration: 0,
            })
          })
          return
        }
        if (url.pathname.startsWith('/runtime/attachments')) {
          sendJson({})
          return
        }
        next()
      })
    },
  }
}

export default defineConfig({
  root: resolve(__dirname, 'src/prototype'),
  publicDir: resolve(__dirname, 'public'),
  define: {
    'import.meta.env.VITE_KALA_PROTOTYPE': JSON.stringify('1'),
  },
  plugins: [react(), prototypeApi()],
  resolve: {
    alias: {
      'virtual:pwa-register': resolve(__dirname, 'src/prototype/pwa-register-stub.ts'),
      '@agent-kernel/kernel': resolve(__dirname, '../kernel/src/index.ts'),
      '@agent-kernel/shared/enhancement': resolve(__dirname, '../shared/src/enhancement.ts'),
      '@agent-kernel/shared/context-policy': resolve(__dirname, '../shared/src/context-policy/index.ts'),
      '@agent-kernel/shared/context-usage': resolve(__dirname, '../shared/src/context-usage/index.ts'),
      '@agent-kernel/shared/push': resolve(__dirname, '../shared/src/push.ts'),
      '@agent-kernel/shared/workspace-exec': resolve(__dirname, '../shared/src/workspace-exec.ts'),
      '@agent-kernel/shared': resolve(__dirname, '../shared/src/browser.ts'),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 4179,
    strictPort: true,
  },
  build: {
    outDir: resolve(__dirname, 'dist-prototype'),
    emptyOutDir: true,
  },
})
