import { readJsonFile, writeJsonFile } from '../persistence/atomic-json-file.js'

export type LoginState = { codeVerifier: string; state: string; oidcNonce?: string; redirectUri: string; expiresAt: number; ssoConnectionId?: string; organizationInviteHash?: string; ownerBootstrapHash?: string }
export interface LoginStateStore { put(nonce: string, state: LoginState): Promise<void>; take(nonce: string): Promise<LoginState | undefined> }
export type LoginStateStoreKind = 'file' | 'postgres'

export function resolveLoginStateStoreKind(env: NodeJS.ProcessEnv): LoginStateStoreKind {
  const value = env.KALA_INGRESS_LOGIN_STATE_STORE_KIND?.trim().toLowerCase()
  if (!value) return 'file'
  if (value === 'file' || value === 'postgres') return value
  throw new Error('KALA_INGRESS_LOGIN_STATE_STORE_KIND must be file or postgres')
}

export class FileLoginStateStore implements LoginStateStore {
  private states = new Map<string, LoginState>()
  private mutation = Promise.resolve()
  constructor(readonly path: string, private readonly maxEntries = 1_000) {}
  async load(): Promise<void> {
    const body = await readJsonFile<{ schemaVersion: 1; states: Record<string, LoginState> }>(this.path)
    if (!body) return
    if (body.schemaVersion !== 1) throw new Error('unsupported login state store')
    this.states = new Map(Object.entries(body.states).filter(([, state]) => state.expiresAt > Date.now()))
    await this.persist()
  }
  async put(nonce: string, state: LoginState): Promise<void> {
    await this.serialize(async () => {
      this.prune()
      if (this.states.size >= this.maxEntries) throw new Error('too many pending login attempts')
      this.states.set(nonce, state); await this.persist()
    })
  }
  async take(nonce: string): Promise<LoginState | undefined> {
    return this.serialize(async () => {
      const state = this.states.get(nonce); this.states.delete(nonce); await this.persist()
      return state && state.expiresAt > Date.now() ? state : undefined
    })
  }
  private serialize<T>(fn: () => Promise<T>): Promise<T> { const result = this.mutation.then(fn, fn); this.mutation = result.then(() => undefined, () => undefined); return result }
  private prune(): void { const now = Date.now(); for (const [nonce, state] of this.states) if (state.expiresAt <= now) this.states.delete(nonce) }
  private async persist(): Promise<void> {
    await writeJsonFile(this.path, { schemaVersion: 1, states: Object.fromEntries(this.states) })
  }
}
