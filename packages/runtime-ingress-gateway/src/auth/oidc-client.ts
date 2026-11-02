import * as oidc from 'openid-client'

import type { AuthenticatedIdentity } from '../assignments/store.js'

export type OidcAuthentication = { identity: AuthenticatedIdentity; refreshToken?: string; accessTokenExpiresAt?: number }
export type OidcRefreshResult = { refreshToken?: string; accessTokenExpiresAt?: number }
export type OidcClient = {
  authorizationUrl(redirectUri: string, options?: { prompt?: 'login'; loginHint?: string; idpHint?: string; nonce?: string }): Promise<{ url: URL; codeVerifier: string; state: string }>
  callback(currentUrl: URL, redirectUri: string, codeVerifier: string, state: string, nonce?: string): Promise<OidcAuthentication>
  refresh(refreshToken: string): Promise<OidcRefreshResult>
  revokeRefreshToken(refreshToken: string): Promise<void>
}

/** Standard Authorization Code + PKCE adapter; compatible with self-hosted ZITADEL and other OSS OIDC providers. */
export async function createOidcClient(options: {
  issuer: URL
  clientId: string
  clientSecret?: string
  scope?: string
  discoveryOrigin?: URL
  allowInsecureHttp?: boolean
}): Promise<OidcClient> {
  const customFetch = options.discoveryOrigin ? internalDiscoveryFetch(options.issuer, options.discoveryOrigin) : undefined
  const config = await oidc.discovery(
    options.issuer,
    options.clientId,
    options.clientSecret,
    undefined,
    {
      ...(customFetch ? { [oidc.customFetch]: customFetch } : {}),
      ...(options.allowInsecureHttp ? { execute: [oidc.allowInsecureRequests] } : {}),
    },
  )
  return {
    async authorizationUrl(redirectUri, authorizationOptions) {
      const codeVerifier = oidc.randomPKCECodeVerifier()
      const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier)
      const state = oidc.randomState()
      const url = oidc.buildAuthorizationUrl(config, {
        redirect_uri: redirectUri,
        scope: options.scope ?? 'openid profile email offline_access',
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        state,
        ...(authorizationOptions?.nonce ? { nonce: authorizationOptions.nonce } : {}),
        ...(authorizationOptions?.prompt ? { prompt: authorizationOptions.prompt } : {}),
        ...(authorizationOptions?.loginHint ? { login_hint: authorizationOptions.loginHint } : {}),
        // ZITADEL owns federation. The gateway supplies only a server-resolved
        // provider id, never an arbitrary browser-provided value.
        ...(authorizationOptions?.idpHint ? { idp_hint: authorizationOptions.idpHint } : {}),
      })
      return { url, codeVerifier, state }
    },
    async callback(currentUrl, redirectUri, codeVerifier, state, nonce) {
      const tokens = await oidc.authorizationCodeGrant(config, currentUrl, { pkceCodeVerifier: codeVerifier, expectedState: state, ...(nonce ? { expectedNonce: nonce } : {}) })
      const claims = tokens.claims()
      if (!claims?.sub) throw new Error('OIDC response is missing subject')
      const accessToken = tokens.access_token
      const userInfo = accessToken ? await oidc.fetchUserInfo(config, accessToken, claims.sub).catch(() => undefined) : undefined
      if (claims.iss !== undefined && claims.iss !== options.issuer.href && claims.iss !== options.issuer.href.replace(/\/$/u, '')) {
        throw new Error('OIDC issuer mismatch')
      }
      void redirectUri // validated by the provider during token exchange
      const displayName = typeof userInfo?.name === 'string' && userInfo.name.trim() ? userInfo.name.trim()
        : typeof claims.name === 'string' && claims.name.trim() ? claims.name.trim()
          : typeof userInfo?.preferred_username === 'string' && userInfo.preferred_username.trim() ? userInfo.preferred_username.trim()
            : typeof claims.preferred_username === 'string' && claims.preferred_username.trim() ? claims.preferred_username.trim()
              : undefined
      const verifiedEmail = selectVerifiedEmail(claims, userInfo)
      const username = trustedStringClaim(claims, userInfo, ['preferred_username'])
      const upstreamProviderId = trustedStringClaim(claims, userInfo, [
        'urn:zitadel:iam:user:metadata:idp_id',
        'urn:zitadel:iam:user:metadata:idpId',
        'idp_id',
      ])
      return {
        identity: {
          issuer: options.issuer.href.replace(/\/$/u, ''),
          subject: claims.sub,
          ...(displayName ? { displayName } : {}),
          ...(username ? { username } : {}),
          ...(verifiedEmail ? { email: verifiedEmail.email, emailVerified: verifiedEmail.verified } : {}),
          ...(upstreamProviderId ? { upstreamProviderId } : {}),
        },
        ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
        ...(tokens.expiresIn() !== undefined ? { accessTokenExpiresAt: Date.now() + tokens.expiresIn()! * 1_000 } : {}),
      }
    },
    async refresh(refreshToken) {
      const tokens = await oidc.refreshTokenGrant(config, refreshToken)
      return {
        ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
        ...(tokens.expiresIn() !== undefined ? { accessTokenExpiresAt: Date.now() + tokens.expiresIn()! * 1_000 } : {}),
      }
    },
    async revokeRefreshToken(refreshToken) {
      await oidc.tokenRevocation(config, refreshToken, { token_type_hint: 'refresh_token' })
    },
  }
}

export function selectVerifiedEmail(
  claims: Record<string, unknown>,
  userInfo: Record<string, unknown> | undefined,
): { email: string; verified: boolean } | undefined {
  if (typeof userInfo?.email === 'string' && userInfo.email.trim()) {
    return { email: userInfo.email.trim(), verified: userInfo.email_verified === true }
  }
  if (typeof claims.email === 'string' && claims.email.trim()) {
    return { email: claims.email.trim(), verified: claims.email_verified === true }
  }
  return undefined
}

function trustedStringClaim(
  claims: Record<string, unknown>,
  userInfo: Record<string, unknown> | undefined,
  names: readonly string[],
): string | undefined {
  for (const name of names) {
    const value = userInfo?.[name] ?? claims[name]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function internalDiscoveryFetch(publicIssuer: URL, internalOrigin: URL): oidc.CustomFetch {
  return async (input, options) => {
    const requestUrl = new URL(input)
    const target = requestUrl.origin === publicIssuer.origin
      ? new URL(`${requestUrl.pathname}${requestUrl.search}`, internalOrigin).href
      : input
    return fetch(target, {
      method: options.method,
      headers: {
        ...options.headers,
        ...(requestUrl.origin === publicIssuer.origin
          ? { 'x-zitadel-instance-host': publicIssuer.host, 'x-zitadel-public-host': publicIssuer.host }
          : {}),
      },
      body: options.body as BodyInit | null | undefined,
      redirect: options.redirect,
      ...(options.signal ? { signal: options.signal } : {}),
    })
  }
}
