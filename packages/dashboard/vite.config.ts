import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { resolve } from 'node:path'

function argValue(argv: readonly string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === name) return argv[i + 1]
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1)
  }
  return undefined
}

const dashboardPort = Number(argValue(process.argv, '--port') ?? 5288)
const HOST_URL = process.env.HOST_URL ?? (dashboardPort === 3000 ? 'http://localhost:3001' : 'http://localhost:3000')
const requestedTestWorkers = Number(process.env.KALA_TEST_WORKERS ?? 1)
const testWorkers = Number.isSafeInteger(requestedTestWorkers) && requestedTestWorkers > 0
  ? requestedTestWorkers
  : 1
const HOST_HTTP_ROUTES = [
  '/auth',
  '/models',
  '/settings',
  '/runtime',
  '/docs',
  '/artifacts',
  '/eval',
  '/enhancement',
  '/router',
  '/admin/socket.io',
] as const

export default defineConfig({
  build: {
    // Profiling builds keep production minification/chunking while emitting maps
    // beside the artifact for local CDP attribution. Release builds remain map-free.
    sourcemap: process.env.KALA_PROFILE_SOURCEMAP === '1' ? 'hidden' : false,
  },
  plugins: [
    react(),
    // Service worker for PWA installability + offline shell + Web Push handler.
    // - registerType: 'prompt' + skipWaiting: false keeps activation fenced by
    //   initPwa. The app activates a waiting build automatically: drafts are
    //   durable per Session, while keeping mixed generations alive can leave a
    //   connected-looking Dashboard unable to submit actions.
    // - injectManifest strategy: our sw.js needs a hand-written push /
    //   notificationclick handler; workbox is loaded inside it for precache.
    //   generateSW cannot express both custom push and precache cleanly.
    // - navigateFallbackDenylist MUST exclude everything that talks to the
    //   host: /socket.io, HOST_HTTP_ROUTES, /push, /events, /admin/socket.io.
    //   Otherwise the SW intercepts long-lived socket.io upgrades and API
    //   calls with the cached shell — silently breaks the whole dashboard.
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'prompt',
      injectRegister: null,
      manifest: false,
      injectManifest: {
        // Precache only the navigation shell. Hashed feature chunks (Monaco,
        // Mermaid, Shiki languages/themes, Settings, etc.) stay truly on-demand
        // instead of turning every PWA update into a ~16 MiB install.
        globPatterns: ['index.html', '**/index-*.css', '**/*.{svg,png,webmanifest,woff,woff2}'],
        // The entry filename is hash-generated and added below; broad index-*.js
        // matching accidentally precached lazy Shiki/shared chunks as well.
        globIgnores: ['**/mermaid*.js', '**/cytoscape*.js', '**/SessionFilesPanel-*.js', '**/SettingsDialog-*.js'],
        manifestTransforms: [async (entries) => {
          const html = await import('node:fs/promises').then((fs) => fs.readFile(resolve(__dirname, 'dist/index.html'), 'utf8'))
          const entry = html.match(/src="\/(assets\/index-[^"]+\.js)"/u)?.[1]
          return { manifest: entry && !entries.some((item) => item.url === entry) ? [...entries, { url: entry, revision: null }] : entries, warnings: [] }
        }],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
      },
      devOptions: {
        // Never run the SW in `vite dev` — it caches the HMR shell and hides
        // rebuilds. Test PWA behaviour against `vite preview` or a release.
        enabled: false,
        type: 'module',
      },
    }),
  ],
  resolve: {
    alias: {
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
    port: 5288,
    proxy: {
      '/socket.io': {
        target: HOST_URL,
        ws: true,
        changeOrigin: true,
        configure(proxy) {
          const useHostOrigin = (request: import('node:http').ClientRequest): void => {
            request.setHeader('origin', HOST_URL)
          }
          proxy.on('proxyReq', useHostOrigin)
          proxy.on('proxyReqWs', useHostOrigin)
        },
      },
      ...Object.fromEntries(
        HOST_HTTP_ROUTES.map((route) => [
          route,
          {
            target: HOST_URL,
            changeOrigin: true,
          },
        ]),
      ),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    globals: false,
    setupFiles: ['src/test/setup.ts'],
    fileParallelism: testWorkers > 1,
    pool: 'forks',
    singleFork: testWorkers === 1,
    maxWorkers: testWorkers,
  },
})
