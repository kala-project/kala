import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { parseProductDeploymentConfig, productVariant, type ProductDeploymentConfig } from '@agent-kernel/shared'

export async function loadGatewayProductDeployment(configPath: string | undefined): Promise<{
  config: ProductDeploymentConfig
  variant: 'dedicated' | 'private-cloud'
}> {
  const path = configPath?.trim()
  if (!path) throw new Error('KALA_DEPLOYMENT_CONFIG is required for the Platform Gateway')
  const parsed: unknown = JSON.parse(await readFile(resolve(path), 'utf8'))
  const config = parseProductDeploymentConfig(parsed)
  const variant = productVariant(config)
  if (variant === 'portable') throw new Error('the Runtime ingress Gateway does not support Portable deployment')
  return { config, variant }
}
