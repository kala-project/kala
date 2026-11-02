#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'

const marker = '  # Optional public-origin Console environment override.\n'

export function renderIdentityConsoleCaddy(template, environment, publicOrigin) {
  const origin = new URL(publicOrigin)
  if (origin.protocol !== 'https:' || origin.origin !== publicOrigin) {
    throw new Error('Public origin must be a canonical HTTPS origin without a path or credentials')
  }
  if (!environment || Array.isArray(environment) || typeof environment !== 'object' ||
      typeof environment.clientid !== 'string' || !environment.clientid.trim()) {
    throw new Error('An existing Console environment with its authoritative clientid is required')
  }
  if (environment.issuer !== publicOrigin) {
    throw new Error('Existing issuer must already match the public origin; issuer changes are not supported')
  }
  if (environment.api !== publicOrigin && environment.api !== publicOrigin.replace(/^https:/u, 'http:')) {
    throw new Error('Existing API must have the same authority as the public origin')
  }
  if (!template.includes(marker) || template.indexOf(marker) !== template.lastIndexOf(marker) ||
      template.includes('@consoleEnvironment')) {
    throw new Error('Expected an unmodified single-origin template with exactly one override marker')
  }
  const metadata = JSON.stringify({ ...environment, api: publicOrigin })
  if (metadata.includes('{$')) {
    throw new Error('Console metadata must not contain Caddy environment substitutions')
  }
  const route = [
    '  # tlsMode disabled serves h2c but may generate an HTTP Console API URL.',
    '  @consoleEnvironment path /ui/console/assets/environment.json',
    '  handle @consoleEnvironment {',
    '    header Content-Type application/json',
    '    header Cache-Control "no-store"',
    `    respond ${JSON.stringify(metadata)} 200`,
    '  }',
    '',
  ].join('\n')
  return template.replace(marker, marker + route)
}

async function readEnvironment(path) {
  if (path !== '-') return readFile(path, 'utf8')
  process.stdin.setEncoding('utf8')
  let input = ''
  for await (const chunk of process.stdin) input += chunk
  return input
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: {
      'public-origin': { type: 'string' },
      environment: { type: 'string' },
    } })
    if (!values['public-origin'] || !values.environment) {
      throw new Error('Usage: render-identity-console-caddy.mjs --public-origin https://identity.example --environment console-environment.json')
    }
    const [template, environment] = await Promise.all([
      readFile(new URL('../../deploy/private-cloud/identity-local/single-origin.Caddyfile', import.meta.url), 'utf8'),
      readEnvironment(values.environment),
    ])
    process.stdout.write(renderIdentityConsoleCaddy(template, JSON.parse(environment), values['public-origin']))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
