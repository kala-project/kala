import { parseProductDeploymentConfig, productVariant, type ProductDeploymentConfig, type ProductVariant, type RuntimeCapabilities, type RuntimeCapabilitiesPayload } from '@agent-kernel/shared'
import { useEffect, useState } from 'react'
import { resolveHostEndpoint } from './host-endpoint.js'

const SAFE_CAPABILITIES: RuntimeCapabilities = { agent: true, workspace: true, operations: false, artifacts: false, pipeline: false }
export type RuntimeDeploymentState = { capabilities: RuntimeCapabilities; product: ProductVariant | null; deployment: ProductDeploymentConfig | null; evaluationUrl?: string; loaded: boolean; unauthorized?: boolean; error?: string }

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

function isCapabilities(value: unknown): value is RuntimeCapabilities {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return ['agent', 'workspace', 'operations', 'artifacts', 'pipeline'].every((key) => typeof candidate[key] === 'boolean')
}

function isPayload(value: unknown): value is RuntimeCapabilitiesPayload {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  try {
    const deployment = parseProductDeploymentConfig(candidate.deployment)
    return candidate.product === productVariant(deployment) && isCapabilities(candidate.capabilities)
  } catch {
    return false
  }
}

function evaluationUrl(payload: RuntimeCapabilitiesPayload): string | undefined {
  return resolvePublicHttpUrl(payload.integrations?.evaluation?.url)
}

export function resolvePublicHttpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  const candidate = value.trim()
  try {
    const url = candidate.startsWith('/') && !candidate.startsWith('//')
      ? new URL(candidate, typeof window === 'undefined' ? 'http://localhost' : window.location.origin)
      : new URL(candidate)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return url.toString().replace(/\/$/u, '')
  } catch { return undefined }
}

export async function loadRuntimeDeployment(
  host: string,
  signal?: AbortSignal,
  fetcher: Fetcher = fetch,
): Promise<RuntimeDeploymentState> {
  try {
    const response = await fetcher(`${host}/runtime/capabilities`, { cache: 'no-store', signal })
    if (response.status === 401) return { capabilities: SAFE_CAPABILITIES, product: 'private-cloud', deployment: null, loaded: true, unauthorized: true }
    if (!response.ok) return { capabilities: SAFE_CAPABILITIES, product: null, deployment: null, loaded: true, error: `Runtime capabilities request failed (${response.status})` }
    const payload: unknown = await response.json()
    return isPayload(payload)
      ? { capabilities: payload.capabilities, product: payload.product, deployment: payload.deployment, ...(evaluationUrl(payload) ? { evaluationUrl: evaluationUrl(payload) } : {}), loaded: true }
      : { capabilities: SAFE_CAPABILITIES, product: null, deployment: null, loaded: true }
  } catch (error) {
    if (signal?.aborted) return { capabilities: SAFE_CAPABILITIES, product: null, deployment: null, loaded: false }
    return { capabilities: SAFE_CAPABILITIES, product: null, deployment: null, loaded: true, error: error instanceof Error ? error.message : 'Runtime capabilities request failed' }
  }
}

export function useRuntimeDeployment(): RuntimeDeploymentState {
  const [host] = useState(() => resolveHostEndpoint().url)
  const [deployment, setDeployment] = useState<RuntimeDeploymentState>({ capabilities: SAFE_CAPABILITIES, product: null, deployment: null, loaded: false })
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let failures = 0
    const refresh = async () => {
      const next = await loadRuntimeDeployment(host, controller.signal)
      if (controller.signal.aborted) return
      setDeployment(next)
      if (next.error) {
        timer = setTimeout(() => {
          failures++
          void refresh()
        }, Math.min(1_000 * 2 ** failures, 30_000))
      }
    }
    void refresh()
    return () => {
      controller.abort()
      if (timer) clearTimeout(timer)
    }
  }, [host])
  return deployment
}

export function useRuntimeCapabilities(): RuntimeCapabilities {
  return useRuntimeDeployment().capabilities
}
