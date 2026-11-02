import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { createPostgresControlPlaneDatabase, migrateControlPlane, readControlPlaneMigrations } from '../persistence/postgres.js'

const exec = promisify(execFile)
const integration = process.env.KALA_RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip
const docker = (...args: string[]) => exec('sudo', ['-n', 'docker', ...args])

integration('Dedicated interrupted initialization on real control PostgreSQL', () => {
  it('continues after Owner commit/process death only with matching protected identity, without rebootstrap or credential changes', async () => {
    const name = `kala-owner-resume-${randomUUID()}`
    const scratch = await mkdtemp(join(tmpdir(), 'kala-owner-resume-'))
    const passwordFile = join(scratch, 'owner-password')
    const databaseFile = join(scratch, 'database-url')
    const databasePassword = randomUUID()
    const ownerPassword = `fixture-owner-${randomUUID()}`
    let child: ReturnType<typeof spawn> | undefined
    let database: ReturnType<typeof createPostgresControlPlaneDatabase> | undefined
    try {
      await docker('run', '-d', '--rm', '--name', name, '--label', `dev.kala.test.project=${name}`,
        '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=256m',
        '--env', `POSTGRES_PASSWORD=${databasePassword}`, '--env', 'POSTGRES_DB=runlab_control',
        '--publish', '127.0.0.1::5432', 'postgres:16-alpine')
      const port = (await docker('inspect', '--format', '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}', name)).stdout.trim()
      const url = `postgres://postgres:${databasePassword}@127.0.0.1:${port}/runlab_control`
      database = createPostgresControlPlaneDatabase({ connectionString: url })
      for (let attempt = 0; ; attempt++) {
        try { await database.query('SELECT 1'); break } catch (error) {
          if (attempt === 59) throw error
          await new Promise((r) => setTimeout(r, 100))
        }
      }
      await migrateControlPlane(database, await readControlPlaneMigrations(resolve('migrations')))
      await writeFile(passwordFile, ownerPassword, { mode: 0o600 })
      await writeFile(databaseFile, url, { mode: 0o600 })
      const environment = { ...process.env, KALA_DEPLOYMENT_CONFIG: resolve('../../deploy/aspire/deployment.json'),
        KALA_INGRESS_DATABASE_URL: '', KALA_INGRESS_DATABASE_URL_REF: '', KALA_INGRESS_DATABASE_URL_FILE: databaseFile,
        KALA_INGRESS_MIGRATIONS_DIR: resolve('migrations'), KALA_DEDICATED_OWNER_PASSWORD_FILE: passwordFile,
        KALA_DEDICATED_OWNER_PASSWORD: '', KALA_DEDICATED_ORGANIZATION_NAME: 'Resume fixture', KALA_DEDICATED_OWNER_EMAIL: '' }
      const invoke = (args = ['--verify-existing'], extra = {}) => exec(process.execPath,
        [resolve('dist/src/bin/bootstrap-dedicated-owner.js'), ...args], { env: { ...environment, ...extra } })
      await expect(invoke()).rejects.toThrow('expected active installation')
      // Actual built service commits in a separate process, then dies before its operator can start applications.
      child = spawn(process.execPath, ['--input-type=module', '-e', `
        import { readFile } from 'node:fs/promises';
        import { createPostgresControlPlaneDatabase } from ${JSON.stringify(pathToFileURL(resolve('dist/src/persistence/postgres.js')).href)};
        import { DedicatedOwnerBootstrapService } from ${JSON.stringify(pathToFileURL(resolve('dist/src/auth/dedicated-owner.js')).href)};
        const db = createPostgresControlPlaneDatabase({connectionString:(await readFile(process.env.KALA_INGRESS_DATABASE_URL_FILE,'utf8')).trim()});
        await new DedicatedOwnerBootstrapService(db).bootstrap({password:(await readFile(process.env.KALA_DEDICATED_OWNER_PASSWORD_FILE,'utf8')).trim(),organizationName:process.env.KALA_DEDICATED_ORGANIZATION_NAME});
        process.stdout.write('COMMITTED\\n'); setInterval(()=>{},1000);
      `], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
      await new Promise<void>((done, reject) => {
        const timeout = setTimeout(() => reject(new Error('Owner commit did not complete')), 15_000)
        child!.once('error', reject)
        child!.once('exit', () => { clearTimeout(timeout); reject(new Error('Owner fixture exited before commit acknowledgement')) })
        child!.stdout!.on('data', (data: Buffer) => { if (data.toString().includes('COMMITTED')) { clearTimeout(timeout); done() } })
      })
      child.kill('SIGKILL')
      expect((await once(child, 'exit'))[1]).toBe('SIGKILL')
      const before = (await database.query('SELECT principal_id,organization_id,password_hash,password_salt,scrypt_n,scrypt_r,scrypt_p FROM dedicated_owner_credentials')).rows
      await expect(invoke([])).rejects.toThrow('already bootstrapped')
      await writeFile(passwordFile, 'fixture-wrong-owner-password')
      await expect(invoke()).rejects.toThrow('protected password')
      await writeFile(passwordFile, ownerPassword)
      await expect(invoke(undefined, { KALA_DEDICATED_ORGANIZATION_NAME: 'Wrong organization' })).rejects.toThrow('expected active installation')
      await database.query("UPDATE organization_memberships SET role='viewer'")
      await expect(invoke()).rejects.toThrow('expected active installation')
      await database.query("UPDATE organization_memberships SET role='owner'")
      const resumed = JSON.parse((await invoke()).stdout)
      expect(resumed.event).toBe('dedicated_owner_verified')
      expect(resumed.organizationId).toBe(before[0]!.organization_id)
      expect((await database.query('SELECT principal_id,organization_id,password_hash,password_salt,scrypt_n,scrypt_r,scrypt_p FROM dedicated_owner_credentials')).rows).toEqual(before)
      expect((await database.query('SELECT count(*)::int AS count FROM organizations')).rows[0]!.count).toBe(1)
    } finally {
      if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await database?.close()
      await docker('rm', '--force', name).catch(() => undefined)
      await rm(scratch, { recursive: true, force: true })
    }
  }, 90_000)
})
