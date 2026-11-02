import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { loadGatewayProductDeployment } from './product-deployment.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

describe('Gateway product deployment selection', () => {
  it('selects Dedicated only from the canonical versioned file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gateway-deployment-')); roots.push(root)
    const path = join(root, 'deployment.json')
    await writeFile(path, JSON.stringify({ schemaVersion: 1, architecture: 'platform', tenancy: 'single-tenant', runtimeProfile: 'full' }))
    await expect(loadGatewayProductDeployment(path)).resolves.toMatchObject({ variant: 'dedicated' })
  })

  it('fails closed without a file and rejects Portable', async () => {
    await expect(loadGatewayProductDeployment(undefined)).rejects.toThrow('KALA_DEPLOYMENT_CONFIG is required')
    const root = await mkdtemp(join(tmpdir(), 'gateway-deployment-')); roots.push(root)
    const path = join(root, 'deployment.json')
    await writeFile(path, JSON.stringify({ schemaVersion: 1, architecture: 'portable', runtimeProfile: 'full' }))
    await expect(loadGatewayProductDeployment(path)).rejects.toThrow('does not support Portable')
  })
})
