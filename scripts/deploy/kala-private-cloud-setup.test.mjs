import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const root = resolve(import.meta.dirname, '../..')
const image = (name, digit) => `ghcr.io/example/${name}@sha256:${digit.repeat(64)}`

function run(args, env, allowFailure = false) {
  const result = spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8' })
  if (result.status !== 0 && !allowFailure) throw new Error(`setup failed: ${result.stderr}`)
  return result
}

test('fresh setup rejects every storage choice without creating configuration or Compose resources', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'kala-setup-fresh-'))
  const bundle = join(scratch, 'bundle')
  run(['scripts/release/build-private-cloud-bundle.mjs', '--output', bundle, '--revision', '1'.repeat(40), '--runtime-image', image('runtime', 'a'), '--ingress-image', image('ingress', 'b'), '--dashboard-image', image('dashboard', 'c')], process.env)

  const bin = join(scratch, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'openssl'), `#!/usr/bin/env node
const fs=require('node:fs');const args=process.argv.slice(2);
for(const name of ['-keyout','-out']) {const index=args.indexOf(name);if(index>=0)fs.writeFileSync(args[index+1],'test-pem')}
`)
  writeFileSync(join(bin, 'docker'), `#!/usr/bin/env node
const args=process.argv.slice(2), fs=require('node:fs');
fs.appendFileSync(process.env.DOCKER_CALLS,JSON.stringify(args)+'\\n');
if(args.includes('ps')&&args.includes('json')) for(const service of ['runtime-host','runtime-ingress','dashboard']) console.log(JSON.stringify({Service:service,ID:'fixture-'+service,State:'running',Health:'healthy'}));
if(args.includes('config')&&args.includes('json')) console.log(JSON.stringify({volumes:{}}));
`)
  chmodSync(join(bin, 'openssl'), 0o755)
  chmodSync(join(bin, 'docker'), 0o755)

  const catalog = { version: 1, defaultModel: 'test:small', providers: [{ id: 'test', wire: 'openai', baseUrl: 'https://model.example.test/v1', credentialRef: 'file:llm_api_key', models: [{ id: 'small', label: 'Small', contextWindow: 4096 }] }] }
  const catalogFile = join(scratch, 'catalog.json')
  writeFileSync(catalogFile, JSON.stringify(catalog))
  for (const [name, value] of [['model-key', 'model-test-credential'], ['client-id', 'external-client-id'], ['client-secret', 'external-client-secret']]) {
    writeFileSync(join(scratch, name), value, { mode: 0o600 })
  }

  const cli = join(bundle, 'kala-private-cloud.mjs')
  const baseArgs = [cli, 'setup', '--bundle', bundle, '--identity', 'external', '--provider-catalog', catalogFile, '--llm-api-key-file', join(scratch, 'model-key'), '--oidc-issuer', 'https://id.example.test', '--oidc-discovery-origin', 'https://id.example.test', '--oidc-client-id-file', join(scratch, 'client-id'), '--oidc-client-secret-file', join(scratch, 'client-secret')]
  const storageCases = [
    { name: 'implicit', args: [] },
    { name: 'nfs', args: ['--storage', 'nfs', '--acknowledge-legacy-storage'] },
    { name: 'local-volume', args: ['--storage', 'local-volume', '--acknowledge-legacy-storage'] },
    { name: 'external-nfs', args: ['--storage', 'external-nfs', '--acknowledge-legacy-storage'] },
    { name: 'postgres-s3', args: ['--storage', 'postgres-s3', '--acknowledge-evaluation', '--acknowledge-external-backup'] },
  ]

  for (const storage of storageCases) {
    const config = join(scratch, `config-${storage.name}`)
    const dockerCalls = join(scratch, `docker-${storage.name}.jsonl`)
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, KALA_PRIVATE_CLOUD_OPERATOR_ROOT: join(scratch, `operator-${storage.name}`), DOCKER_CALLS: dockerCalls }
    const result = run([...baseArgs, '--config-dir', config, ...storage.args], env, true)
    assert.notEqual(result.status, 0, `fresh setup must reject ${storage.name} storage`)
    assert.match(result.stderr, /fresh|init-config|setup/iu)
    assert.equal(existsSync(config), false, `${storage.name} setup rejection must not create configuration`)
    assert.equal(existsSync(dockerCalls), false, `${storage.name} setup rejection must not invoke Docker`)
  }
})
