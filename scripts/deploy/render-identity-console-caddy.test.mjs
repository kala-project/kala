import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { renderIdentityConsoleCaddy } from './render-identity-console-caddy.mjs'

const template = await readFile(new URL('../../deploy/private-cloud/identity-local/single-origin.Caddyfile', import.meta.url), 'utf8')
const publicOrigin = 'https://identity.example:8443'
const environment = {
  api: 'http://identity.example:8443',
  issuer: publicOrigin,
  clientid: 'existing-console-client',
  exhausted: true,
  customer_portal: 'https://portal.example/path?label="quoted"',
}

test('corrects only the API scheme and preserves metadata and all original routes', () => {
  const rendered = renderIdentityConsoleCaddy(template, environment, publicOrigin)
  const response = rendered.split('\n').find(line => line.trim().startsWith('respond '))
  const metadata = JSON.parse(JSON.parse(response.trim().slice('respond '.length, -' 200'.length)))
  assert.deepEqual(metadata, { ...environment, api: publicOrigin })
  assert.equal(environment.api, 'http://identity.example:8443')
  assert(rendered.indexOf('@consoleEnvironment') < rendered.indexOf('@login'))
  assert(rendered.includes(template.slice(template.indexOf('  @login'))))
  assert(rendered.includes('header Cache-Control "no-store"'))
})

test('routes Kala Socket.IO administration to Gateway before the identity provider Admin API', () => {
  const rendered = renderIdentityConsoleCaddy(template, environment, publicOrigin)
  assert.match(rendered, /@socketAdmin path \/admin\/socket\.io \/admin\/socket\.io\/\*/u)
  assert.match(rendered, /handle @socketAdmin \{\s+reverse_proxy \{\$KALA_GATEWAY_ORIGIN\}\s+\}/u)
  assert(rendered.indexOf('handle @socketAdmin') < rendered.indexOf('handle @identity'))
  assert.match(rendered, /@identity path [^\n]* \/admin\/\* /u)
  assert.match(rendered, /handle @identity \{\s+reverse_proxy h2c:\/\/identity-zitadel:8080/u)
})

test('Dedicated browser front doors route native storage through the same Owner guard instead of the Dashboard fallback', () => {
  const rendered = renderIdentityConsoleCaddy(template, environment, publicOrigin, { dedicatedSiloConsole: true })
  assert(rendered.indexOf('handle @silo') < rendered.indexOf('handle @identity'))
  assert.match(rendered, /@silo path \/silo \/silo\/\*/u)
  assert.match(rendered, /forward_auth \{\$KALA_GATEWAY_ORIGIN\} \{\s+uri \/auth\/silo\/authorize\?/u)
  assert(rendered.includes('uri /auth/silo/authorize?\n        header_up -Connection\n        header_up -Upgrade'))
  assert.match(rendered, /uri strip_prefix \/silo/u)
  assert.match(rendered, /reverse_proxy silo:9001/u)
  assert(rendered.includes('header_up Cookie "(^|;[[:space:]]*)ak_session=[^;]*(;[[:space:]]*)?" "$1"'))
  assert(rendered.includes('header_down Set-Cookie "^(.*)$" "$1; Secure"'))
  assert(rendered.includes(template.slice(template.indexOf('  @login'))))
  assert(!renderIdentityConsoleCaddy(template, environment, publicOrigin).includes('@silo'))
  assert.throws(() => renderIdentityConsoleCaddy(template, environment, publicOrigin, { dedicatedSiloConsole: 'true' }), /explicit boolean/u)
})

test('refuses issuer, authority, client identity and configuration injection ambiguity', () => {
  const credentialOrigin = new URL(publicOrigin)
  credentialOrigin.username = 'fixture-user'
  credentialOrigin.password = 'fixture-password'
  for (const origin of ['http://identity.example:8443', publicOrigin + '/', publicOrigin + '/path', credentialOrigin.href.replace(/\/$/u, '')]) {
    assert.throws(() => renderIdentityConsoleCaddy(template, environment, origin), /Public origin/u)
  }
  for (const metadata of [
    { ...environment, issuer: 'https://other.example' },
    { ...environment, api: 'http://other.example:8443' },
    { ...environment, clientid: '' },
    { ...environment, customer_portal: '{$UNEXPECTED_ENV}' },
  ]) {
    assert.throws(() => renderIdentityConsoleCaddy(template, metadata, publicOrigin))
  }
  assert.throws(() => renderIdentityConsoleCaddy(
    renderIdentityConsoleCaddy(template, environment, publicOrigin), environment, publicOrigin,
  ), /unmodified/u)
})

test('CLI renders an existing environment from stdin without network or mutation', () => {
  const result = spawnSync(process.execPath, [
    new URL('./render-identity-console-caddy.mjs', import.meta.url).pathname,
    '--public-origin', publicOrigin, '--environment', '-',
  ], { input: JSON.stringify(environment), encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, renderIdentityConsoleCaddy(template, environment, publicOrigin))
  const dedicated = spawnSync(process.execPath, [
    new URL('./render-identity-console-caddy.mjs', import.meta.url).pathname,
    '--public-origin', publicOrigin, '--environment', '-', '--dedicated-silo-console',
  ], { input: JSON.stringify(environment), encoding: 'utf8' })
  assert.equal(dedicated.status, 0, dedicated.stderr)
  assert.equal(dedicated.stdout, renderIdentityConsoleCaddy(template, environment, publicOrigin, { dedicatedSiloConsole: true }))
  const missing = spawnSync(process.execPath, [
    new URL('./render-identity-console-caddy.mjs', import.meta.url).pathname,
  ], { encoding: 'utf8' })
  assert.equal(missing.status, 1)
  assert.equal(missing.stdout, '')
  assert.match(missing.stderr, /Usage:/u)
})
