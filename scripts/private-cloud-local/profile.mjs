import { resolve } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'

const root = resolve(import.meta.dirname, '../..')
const deploymentEnv = resolve(process.env.KALA_DEPLOYMENT_ENV ?? resolve(root, 'deploy/private-cloud/.secrets/deployment.env'))
const identityDeploymentEnv = resolve(process.env.KALA_IDENTITY_ENV ?? resolve(root, 'deploy/identity/.secrets/deployment.env'))
if (existsSync(deploymentEnv)) {
  for (const line of readFileSync(deploymentEnv, 'utf8').split(/\r?\n/u)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/u)
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2]
  }
}
const profiles = {
  local: ['deploy/private-cloud/compose.yaml', 'deploy/private-cloud/compose.dev.yaml', 'deploy/private-cloud/compose.storage-nfs.yaml', 'deploy/private-cloud/compose.local.yaml'],
  cloudflare: ['deploy/private-cloud/compose.yaml', 'deploy/private-cloud/compose.dev.yaml', 'deploy/private-cloud/compose.storage-nfs.yaml', 'deploy/private-cloud/compose.cloudflare.yaml'],
  acceptance: ['deploy/private-cloud/compose.yaml', 'deploy/private-cloud/compose.dev.yaml', 'deploy/private-cloud/compose.storage-nfs.yaml', 'deploy/private-cloud/compose.local.yaml', 'deploy/private-cloud/local/compose.acceptance.yaml'],
  'local-volume': ['deploy/private-cloud/compose.yaml', 'deploy/private-cloud/compose.dev.yaml', 'deploy/private-cloud/compose.storage-local.yaml', 'deploy/private-cloud/compose.local.yaml'],
  'postgres-s3': ['deploy/private-cloud/compose.yaml', 'deploy/private-cloud/compose.dev.yaml', 'deploy/private-cloud/compose.storage-local.yaml', 'deploy/private-cloud/compose.local.yaml', 'deploy/private-cloud/compose.storage-postgres-s3.yaml', 'deploy/private-cloud/compose.storage-postgres-s3.dev.yaml'],
  'external-nfs': ['deploy/private-cloud/compose.yaml', 'deploy/private-cloud/compose.dev.yaml', 'deploy/private-cloud/compose.storage-external-nfs.yaml', 'deploy/private-cloud/compose.cloudflare.yaml'],
}
process.env.KALA_RUNTIME_IMAGE ??= 'kala-private-cloud-runtime:dev'
process.env.KALA_INGRESS_IMAGE ??= 'kala-private-cloud-ingress:dev'
process.env.KALA_DASHBOARD_IMAGE ??= 'kala-private-cloud-dashboard:dev'

export function selectedProfile() { return process.env.KALA_PROFILE ?? 'local' }
export function composeFiles(profile = selectedProfile()) {
  const files = profiles[profile]
  if (!files) throw new Error(`unknown KALA_PROFILE ${profile}; expected ${Object.keys(profiles).join(', ')}`)
  return files.map((file) => resolve(root, file))
}
export function composeArgs(profile = selectedProfile()) {
  return [...(existsSync(deploymentEnv) ? ['--env-file', deploymentEnv] : []), ...composeFiles(profile).flatMap((file) => ['-f', file]), ...(profile === 'acceptance' ? ['--profile', 'acceptance'] : [])]
}
export { root, deploymentEnv, identityDeploymentEnv }
