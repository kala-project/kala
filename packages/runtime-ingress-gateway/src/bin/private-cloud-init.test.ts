import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { grantControlWriter, resolveControlPlaneInitConfig } from './init-control-plane.js'
import { initializePrivateCloudControlPlane } from './private-cloud-init.js'

describe('control-plane migration connection configuration', () => {
  it('uses an owner URL file and requires a pre-created external database without an admin credential', async () => {
    const config = await resolveControlPlaneInitConfig({
      KALA_INGRESS_DATABASE_URL_FILE: '/run/secrets/control-owner-url',
      KALA_INGRESS_REQUIRE_EXISTING_DATABASE: '1',
    }, async (path) => {
      expect(path).toBe('/run/secrets/control-owner-url')
      return 'postgresql://migration-owner:secret@db/control\n'
    })

    expect(config).toEqual({
      databaseUrl: 'postgresql://migration-owner:secret@db/control',
      requireExistingDatabase: true,
    })
  })

  it('fails closed on ambiguous direct and file credentials', async () => {
    await expect(resolveControlPlaneInitConfig({
      KALA_INGRESS_DATABASE_URL: 'postgresql://direct/db',
      KALA_INGRESS_DATABASE_URL_FILE: '/run/secrets/control-owner-url',
      KALA_INGRESS_REQUIRE_EXISTING_DATABASE: '1',
    })).rejects.toThrow('mutually exclusive')
  })
})

describe('external control database writer grants', () => {
  it('grants DML and sequence use but never schema ownership or DDL', async () => {
    const statements: string[] = []
    await grantControlWriter({ query: async (sql) => { statements.push(sql) } }, 'kala_control_writer')
    expect(statements).toEqual([
      'GRANT CONNECT ON DATABASE runlab_control TO "kala_control_writer"',
      'GRANT USAGE ON SCHEMA public TO "kala_control_writer"',
      'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "kala_control_writer"',
      'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "kala_control_writer"',
    ])
    await expect(grantControlWriter({ query: async () => { throw new Error('query must not run') } }, 'writer";DROP TABLE organizations;--')).rejects.toThrow('simple lowercase')
  })
})

describe('Private Cloud control-plane initialization', () => {
  it('migrates, restores control-data ownership, then imports a legacy JSON directory without putting the password in an argument', async () => {
    const events: string[] = []
    const invocations: Array<{ scriptPath: string; environment: NodeJS.ProcessEnv }> = []

    await initializePrivateCloudControlPlane({
      environment: {
        KALA_INGRESS_PACKAGE_ROOT: '/image/ingress',
        KALA_INGRESS_CONTROL_DATA_DIR: '/control-data',
        KALA_INGRESS_CONTROL_POSTGRES_PASSWORD_FILE: '/secrets/postgres',
      },
      dependencies: {
        readSecret: async (path) => {
          expect(path).toBe('/secrets/postgres')
          return 'p@ssword\n'
        },
        runScript: async (scriptPath, environment) => {
          events.push(`run:${scriptPath}`)
          invocations.push({ scriptPath, environment })
        },
        chownTree: async (path, uid, gid) => {
          events.push(`chown:${path}:${uid}:${gid}`)
        },
        isFile: async (path) => {
          events.push(`is-file:${path}`)
          return true
        },
      },
    })

    expect(events).toEqual([
      'run:/image/ingress/dist/src/bin/init-control-plane.js',
      'chown:/control-data:65532:65532',
      'is-file:/control-data/tenant-directory.json',
      'run:/image/ingress/dist/src/bin/import-json-control.js',
    ])
    expect(invocations.map(({ scriptPath }) => scriptPath)).not.toContain('p@ssword')
    expect(new URL(invocations[0]!.environment.KALA_INGRESS_ADMIN_DATABASE_URL!).password).toBe('p%40ssword')
    expect(new URL(invocations[0]!.environment.KALA_INGRESS_DATABASE_URL!).pathname).toBe('/runlab_control')
    expect(invocations[1]!.environment).toMatchObject({
      KALA_INGRESS_JSON_DIRECTORY: '/control-data/tenant-directory.json',
      KALA_INGRESS_JSON_SESSIONS: '/control-data/login-states.json.sessions',
      KALA_INGRESS_JSON_BACKUP_PREFIX: '/control-data/pre-postgres',
    })
  })

  it('does not run the legacy importer when the directory file is absent', async () => {
    const scripts: string[] = []
    await initializePrivateCloudControlPlane({
      dependencies: {
        readSecret: async () => 'password',
        runScript: async (scriptPath) => { scripts.push(scriptPath) },
        chownTree: async () => undefined,
        isFile: async () => false,
      },
    })
    expect(scripts).toEqual(['/app/packages/runtime-ingress-gateway/dist/src/bin/init-control-plane.js'])
  })
})

describe('Private Cloud production image contract', () => {
  it('uses the Node entrypoint for initialization and absolute Node paths for health checks', async () => {
    const root = fileURLToPath(new URL('../../../../', import.meta.url))
    const compose = await readFile(`${root}/deploy/private-cloud/compose.yaml`, 'utf8')
    const initService = compose.match(/  control-plane-init:\n(?<body>[\s\S]*?)\n  runtime-host:/u)?.groups?.body

    expect(initService).toContain('command: [packages/runtime-ingress-gateway/dist/src/bin/private-cloud-init.js]')
    expect(initService).not.toContain('/bin/sh')
    expect(initService).not.toContain('chown ')
    expect(compose.match(/test: \[CMD, \/nodejs\/bin\/node, -e,/gu)).toHaveLength(3)
    // Production images run as 65532; a different volume owner makes first install fail.
    expect(compose).toContain('chown -R 65532:65532 /tenant /control')
    expect(compose).toContain('chown -R 65532:65532 /host /gateway')
    expect(compose).toContain('cp /run/kala-provider-catalog.json /host/runtime-provider-catalog.json')
    expect(compose).toContain('KALA_RUNTIME_HOST_LLM_CATALOG_FILE: /run/kala-secrets/runtime-provider-catalog.json')
    expect(compose).not.toContain(':/etc/kala/runtime-provider-catalog.json:ro')
    expect(compose).toContain('KALA_INGRESS_MIGRATIONS_DIR: /app/packages/runtime-ingress-gateway/migrations')
    expect(compose).toContain('headers:{host:origin.host}')
    expect(compose).toContain("new URL(process.env.KALA_PUBLIC_URLS.split(',')[0])")

    const dashboardImage = await readFile(`${root}/deploy/private-cloud/images/Dockerfile.dashboard`, 'utf8')
    expect(dashboardImage).toContain('find packages/dashboard/dist -type d -exec chmod 755 {} +')
    expect(dashboardImage).toContain('find packages/dashboard/dist -type f -exec chmod 644 {} +')

    for (const dockerfile of ['Dockerfile.runtime-service', 'Dockerfile.dashboard', 'Dockerfile.runtime-ingress-gateway']) {
      const contents = await readFile(`${root}/deploy/private-cloud/images/${dockerfile}`, 'utf8')
      expect(contents).toContain('ENTRYPOINT ["/nodejs/bin/node"]')
      expect(contents).toContain('USER 65532:65532')
    }
  })
})
