import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { s3Client } from './private-cloud-hosted-tls.mjs'

const root = resolve(import.meta.dirname, '../..')
const requireHost = createRequire(join(root, 'packages/host/package.json'))

export async function verifyExternalRestore({ config, backup, postgresImage, stop, start, verifyRead }) {
  const { ListObjectsV2Command, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, GetBucketVersioningCommand } = requireHost('@aws-sdk/client-s3')
  const deployment = Object.fromEntries(readFileSync(join(config, 'deployment.env'), 'utf8').split(/\r?\n/u)
    .map((line) => line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/u)).filter(Boolean).map((match) => [match[1], match[2]]))
  if (!/^postgres@sha256:[0-9a-f]{64}$/u.test(postgresImage)) throw new Error('External restore requires the verified official PostgreSQL image digest')
  const endpoint = new URL(deployment.KALA_S3_ENDPOINT)
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) throw new Error('External S3 backup must use an authenticated HTTPS authority')
  const image = spawnSync('docker', ['buildx', 'imagetools', 'inspect', postgresImage], { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024 })
  if (image.status !== 0 || !image.stdout.includes('Name:      docker.io/library/' + postgresImage) || !image.stdout.includes('Digest:    ' + postgresImage.split('@')[1])) throw new Error('Official PostgreSQL image digest could not be verified against Docker Hub')
  const bucket = deployment.KALA_S3_BUCKET
  const accessKeyId = required('PRIVATE_CLOUD_EXTERNAL_S3_BACKUP_ACCESS_KEY_ID')
  const secretAccessKey = required('PRIVATE_CLOUD_EXTERNAL_S3_BACKUP_SECRET_ACCESS_KEY')
  const runtimeKey = readFileSync(join(config, 'secrets', 'runtime_s3_access_key_id'), 'utf8').trim()
  const claimKey = readFileSync(join(config, 'secrets', 'installation_claim_s3_access_key_id'), 'utf8').trim()
  if ([runtimeKey, claimKey].includes(accessKeyId)) throw new Error('External S3 backup must use a separate recovery identity')
  const ca = join(config, 's3-ca.pem')
  const s3 = s3Client(endpoint.href, deployment.KALA_S3_REGION, { accessKeyId, secretAccessKey }, ca)
  mkdirSync(backup, { recursive: false, mode: 0o700 })
  try {
    await stop()
    const versioning = await s3.send(new GetBucketVersioningCommand({ Bucket: bucket }))
    if (versioning.Status) throw new Error('External restore cannot certify an S3 bucket with retained object versions')
    const objects = new Map()
    let totalBytes = 0
    let token
    do {
      const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }))
      for (const entry of page.Contents ?? []) {
        if (!entry.Key || !Number.isSafeInteger(entry.Size) || entry.Size < 0 || entry.Size > 32 * 1024 * 1024 || objects.size >= 1000) throw new Error('External S3 backup exceeds bounded acceptance limits')
        const content = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: entry.Key }))
        const bytes = Buffer.from(await content.Body.transformToByteArray())
        if (bytes.length !== entry.Size) throw new Error('External S3 backup did not read an exact object')
        totalBytes += bytes.length
        if (totalBytes > 128 * 1024 * 1024) throw new Error('External S3 backup exceeds bounded acceptance memory')
        objects.set(entry.Key, bytes)
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined
      if (page.IsTruncated && !token) throw new Error('External S3 backup pagination is incomplete')
    } while (token)
    const applicationObjects = [...objects.keys()].filter((key) => !key.startsWith('_kala/'))
    if (!objects.has('_kala/installation-claim.json') || !applicationObjects.length) throw new Error('External S3 backup lacks the installation claim or business objects written during acceptance')
    const client = (accessKeyId, secretAccessKey) => s3Client(endpoint.href, deployment.KALA_S3_REGION, { accessKeyId, secretAccessKey }, ca)
    const runtime = client(runtimeKey, readFileSync(join(config, 'secrets', 'runtime_s3_secret_access_key'), 'utf8').trim())
    const claim = client(claimKey, readFileSync(join(config, 'secrets', 'installation_claim_s3_secret_access_key'), 'utf8').trim())
    try {
      const marker = '_kala/installation-claim.json'
      const readMarker = await runtime.send(new GetObjectCommand({ Bucket: bucket, Key: marker }))
      if (!Buffer.from(await readMarker.Body.transformToByteArray()).equals(objects.get(marker))) throw new Error('Runtime cannot read the exact external S3 installation claim')
      let deleted = false
      try { await runtime.send(new DeleteObjectCommand({ Bucket: bucket, Key: marker })); deleted = true } catch (error) {
        if (error?.$metadata?.httpStatusCode !== 403) throw error
      }
      if (deleted) {
        await s3.send(new PutObjectCommand({ Bucket: bucket, Key: marker, Body: objects.get(marker) }))
        throw new Error('Runtime identity can delete the reserved installation claim')
      }
      const forbiddenKey = `runlab-rc-forbidden-${randomBytes(12).toString('hex')}`
      let written = false
      try { await claim.send(new PutObjectCommand({ Bucket: bucket, Key: forbiddenKey, Body: 'forbidden' })); written = true } catch (error) {
        if (error?.$metadata?.httpStatusCode !== 403) throw error
      }
      if (written) {
        await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: forbiddenKey }))
        throw new Error('Installation-claim identity can write application objects')
      }
    } finally { runtime.destroy(); claim.destroy() }

    const databases = [
      ['control', readFileSync(join(config, 'secrets', 'control_postgres_migration_owner_url'), 'utf8').trim()],
      ['runtime', readFileSync(join(config, 'secrets', 'runtime_postgres_owner_url'), 'utf8').trim()],
    ]
    for (const [name, url] of databases) {
      const roles = name === 'control' ? [deployment.KALA_CONTROL_DML_ROLE] : [deployment.KALA_RUNTIME_DML_ROLE, deployment.KALA_RUNTIME_READER_ROLE]
      for (const role of roles) {
        if (!/^[a-z_][a-z0-9_]*$/u.test(role ?? '')) throw new Error('External PostgreSQL workload role name is invalid')
        const sql = `SELECT (NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls AND NOT has_database_privilege(oid, current_database(), 'CREATE') AND NOT has_schema_privilege(oid, 'public', 'CREATE') AND NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member = oid) AND NOT EXISTS (SELECT 1 FROM pg_class WHERE relowner = oid)) FROM pg_roles WHERE rolname = '${role}'`
        if (postgres(postgresImage, backup, name, url, ['psql', '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql]).trim() !== 't') throw new Error(`External ${name} PostgreSQL workload role is not least-privileged`)
      }
    }
    for (const [name, url] of databases) {
      postgres(postgresImage, backup, name, url, ['pg_dump', '-Fc', '--schema=public', '-f', `/backup/${name}.dump`])
      const count = postgres(postgresImage, backup, name, url, ['psql', '-At', '-c', "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'"]).trim()
      if (!/^[1-9][0-9]*$/u.test(count)) throw new Error(`External ${name} PostgreSQL backup lacks real migrated data`)
    }

    for (const key of applicationObjects) await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
    const deleted = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: applicationObjects[0] }))
    if (deleted.Contents?.some((entry) => entry.Key === applicationObjects[0])) throw new Error('External S3 destructive mutation was not observed')
    for (const [name, url] of databases) {
      postgres(postgresImage, backup, name, url, ['psql', '-v', 'ON_ERROR_STOP=1', '-c', 'DROP SCHEMA public CASCADE'])
      const count = postgres(postgresImage, backup, name, url, ['psql', '-At', '-c', "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'"]).trim()
      if (count !== '0') throw new Error('External PostgreSQL destructive mutation was not observed')
    }
    for (const [name, url] of databases) postgres(postgresImage, backup, name, url, ['pg_restore', '--no-owner', '--exit-on-error', '-d', 'service=acceptance', `/backup/${name}.dump`])
    for (const key of applicationObjects) await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: objects.get(key) }))
    for (const [key, bytes] of objects) {
      const restored = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
      if (!Buffer.from(await restored.Body.transformToByteArray()).equals(bytes)) throw new Error('External S3 object did not survive backup/restore: ' + key)
    }
    for (const [name, url] of databases) {
      const count = postgres(postgresImage, backup, name, url, ['psql', '-At', '-c', "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'"]).trim()
      if (!/^[1-9][0-9]*$/u.test(count)) throw new Error(`External ${name} PostgreSQL schema did not survive backup/restore`)
    }
    await start()
    await verifyRead()
  } finally {
    s3.destroy()
  }
}

function postgres(image, backup, name, connection, command) {
  const url = new URL(connection)
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.password) throw new Error('External PostgreSQL recovery URL is invalid')
  const username = decodeURIComponent(url.username)
  const database = decodeURIComponent(url.pathname.slice(1))
  const secret = decodeURIComponent(url.password)
  const sslmode = url.searchParams.get('sslmode') || 'prefer'
  if ([username, database, secret, sslmode].some((value) => /[\r\n]/u.test(value)) || !['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full'].includes(sslmode)) throw new Error('External PostgreSQL recovery credential is invalid')
  const service = `[acceptance]\nhost=${url.hostname}\nport=${url.port || 5432}\ndbname=${database}\nuser=${username}\nsslmode=${sslmode}\n`
  const pgpass = (value) => value.replace(/\\/gu, '\\\\').replace(/:/gu, '\\:')
  const password = [url.hostname, url.port || 5432, database, username, secret].map(pgpass).join(':') + '\n'
  writeFileSync(join(backup, `${name}.service`), service, { mode: 0o600 })
  writeFileSync(join(backup, `${name}.pgpass`), password, { mode: 0o600 })
  const result = spawnSync('docker', [
    'run', '--rm', '--network', 'host', '--user', `${process.getuid()}:${process.getgid()}`,
    '-v', `${backup}:/backup:rw`, '-e', `PGSERVICEFILE=/backup/${name}.service`, '-e', `PGPASSFILE=/backup/${name}.pgpass`,
    image, ...command, ...(['pg_dump', 'psql'].includes(command[0]) ? ['service=acceptance'] : []),
  ], { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(`External ${name} PostgreSQL ${command[0]} failed: ${result.stderr}`)
  return result.stdout
}

function required(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required for a real external PostgreSQL/S3 restore`)
  return value
}
