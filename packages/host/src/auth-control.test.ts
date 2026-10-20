import { describe, expect, it, vi } from 'vitest'

import {
  authenticateExecutorToken,
  validateExecutorAnnouncement,
  authSettings,
} from './auth-control.js'
import { ExecutorIdentityStore } from './store/executor-identity.js'

describe('auth-control', () => {
  it('binds executor token scope to one workspace id', async () => {
    const identity = await authenticateExecutorToken(
      { role: 'executor', clientVersion: '0.1.0', token: 'secret' },
      { executorTokens: [{ token: 'secret', workspaceId: 'ws-1', label: 'prod' }] },
    )
    expect(identity).toMatchObject({ accepted: true, workspaceId: 'ws-1', label: 'prod' })
    expect(validateExecutorAnnouncement(identity, 'ws-1')).toEqual({ ok: true })
    expect(validateExecutorAnnouncement(identity, 'ws-2')).toEqual({ ok: false, reason: 'workspace_identity_mismatch' })
  })

  it('propagates only a stored credential installation binding', async () => {
    const store = new ExecutorIdentityStore('/tmp/not-used.json')
    vi.spyOn(store, 'resolveToken').mockImplementation((token) => token === 'bound-token'
      ? { tokenHash: 'hash', workspaceId: 'ws-bound', installId: 'install-bound', label: 'managed', createdAt: new Date(0).toISOString() }
      : token === 'legacy-token'
        ? { tokenHash: 'hash', workspaceId: 'ws-legacy', label: 'legacy', createdAt: new Date(0).toISOString() }
        : undefined)

    expect(await authenticateExecutorToken(
      { role: 'executor', clientVersion: '0.1.0', token: 'bound-token' },
      { executorIdentityStore: store },
    )).toMatchObject({ accepted: true, workspaceId: 'ws-bound', installId: 'install-bound' })
    expect(await authenticateExecutorToken(
      { role: 'executor', clientVersion: '0.1.0', token: 'legacy-token' },
      { executorIdentityStore: store },
    )).toMatchObject({ accepted: true, workspaceId: 'ws-legacy' })
    expect(await authenticateExecutorToken(
      { role: 'executor', clientVersion: '0.1.0', token: 'legacy-token' },
      { executorIdentityStore: store },
    )).not.toHaveProperty('installId')
    expect(await authenticateExecutorToken(
      { role: 'executor', clientVersion: '0.1.0', token: 'bound-token', invite: 'synthetic-expired-invite-for-test-only' },
      { executorIdentityStore: store },
    )).toMatchObject({ accepted: true, workspaceId: 'ws-bound', token: 'bound-token' })
  })

  it('rejects unknown executor tokens when scopes are configured', async () => {
    const identity = await authenticateExecutorToken(
      { role: 'executor', clientVersion: '0.1.0', token: 'wrong' },
      { executorTokens: [{ token: 'secret', workspaceId: 'ws-1' }] },
    )
    expect(identity).toEqual({ accepted: false, reason: 'auth_failed' })
  })

  it('requires invite or known token when a persistent executor identity store is configured', async () => {
    const store = new ExecutorIdentityStore('/tmp/not-used.json')

    expect(await authenticateExecutorToken(
      { role: 'executor', clientVersion: '0.1.0' },
      { executorIdentityStore: store },
    )).toEqual({ accepted: false, reason: 'auth_failed' })

    expect(await authenticateExecutorToken(
      { role: 'executor', clientVersion: '0.1.0', invite: 'ak_invite_test' },
      { executorIdentityStore: store },
    )).toEqual({ accepted: true, inviteToken: 'ak_invite_test' })
  })

  it('summarizes auth settings without secrets', () => {
    expect(authSettings({
      sharedToken: 'hidden',
      github: {
        required: true,
        clientId: 'id',
        clientSecret: 'secret',
        callbackUrl: 'https://host/auth/github/callback',
        sessionSecret: 'cookie-secret',
        usernameWhitelist: ['alice'],
      },
      executorTokens: [{ token: 'exec-hidden', workspaceId: 'ws-1' }],
    })).toEqual({
      dashboardAuthRequired: true,
      githubOAuth: {
        required: true,
        configured: true,
        usernameWhitelistEnabled: true,
        usernameWhitelist: ['alice'],
      },
      executorIdentity: {
        tokenScoped: true,
        tokenCount: 1,
        inviteCount: 0,
      },
    })
  })
})
