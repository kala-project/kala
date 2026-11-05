import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { Agent, get } from 'node:https'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '../..')
const requireHost = createRequire(join(root, 'packages/host/package.json'))
const sdkRequire = createRequire(requireHost.resolve('@aws-sdk/client-s3'))

export function createAuthority(directory, name, bridge, additionalIp) {
  const privateAddress = /^(?:172\.(?:1[6-9]|2[0-9]|3[01])\.\d{1,3}\.\d{1,3}|192\.0\.2\.1|198\.51\.100\.1)$/u
  if (!/^[a-z0-9-]+$/u.test(name) || [bridge, additionalIp].some((ip) => ip !== undefined && !privateAddress.test(ip))) throw new Error('CA name and private bridge address must be bounded')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const ca = join(directory, 'ca.pem')
  const caKey = join(directory, 'ca-key.pem')
  const leaf = join(directory, 'leaf.pem')
  const leafKey = join(directory, 'leaf-key.pem')
  const request = join(directory, 'leaf.csr')
  const extensions = join(directory, 'leaf.ext')
  openssl(['req', '-x509', '-newkey', 'rsa:3072', '-nodes', '-days', '2', '-subj', `/CN=${name}-${randomBytes(8).toString('hex')}`,
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
    '-keyout', caKey, '-out', ca])
  openssl(['req', '-new', '-newkey', 'rsa:3072', '-nodes', '-subj', '/CN=localhost', '-keyout', leafKey, '-out', request])
  writeFileSync(extensions, `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1${bridge ? `,IP:${bridge}` : ''}${additionalIp ? `,IP:${additionalIp}` : ''}\n`, { flag: 'wx', mode: 0o600 })
  openssl(['x509', '-req', '-in', request, '-CA', ca, '-CAkey', caKey, '-CAcreateserial', '-days', '2', '-extfile', extensions, '-out', leaf])
  return { ca, leaf, leafKey }
}

export function s3Client(endpoint, region, credentials, ca) {
  const { S3Client } = requireHost('@aws-sdk/client-s3')
  const { NodeHttpHandler } = sdkRequire('@smithy/node-http-handler')
  if (new URL(endpoint).protocol !== 'https:') throw new Error('S3 acceptance must use HTTPS')
  return new S3Client({
    endpoint, region, credentials, forcePathStyle: true, maxAttempts: 2,
    requestHandler: new NodeHttpHandler({ httpsAgent: new Agent({ ca: readFileSync(ca), rejectUnauthorized: true }) }),
  })
}

export async function verifyHttps(url, ca) {
  return new Promise((resolveResponse, reject) => {
    const request = get(url, { ca: readFileSync(ca), timeout: 10_000 }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { body += chunk; if (body.length > 1024 * 1024) request.destroy(new Error('TLS response too large')) })
      response.on('end', () => response.statusCode === 200 ? resolveResponse(body) : reject(new Error('verified HTTPS endpoint returned ' + response.statusCode)))
    })
    request.on('timeout', () => request.destroy(new Error('verified HTTPS timeout')))
    request.on('error', reject)
  })
}

function openssl(args) {
  const result = spawnSync('openssl', args, { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) throw new Error('openssl could not issue a bounded private acceptance CA: ' + result.stderr)
}
