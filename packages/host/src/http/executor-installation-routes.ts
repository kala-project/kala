import type { IncomingMessage, ServerResponse, Server as HttpServer } from 'node:http'
import { ZodError } from 'zod'

import { schema, type ExecutorInstallStatus, type PlatformTenancy } from '@agent-kernel/shared'

import { authenticateDashboardHandshake, type AuthConfig, type DashboardActor } from '../auth-control.js'
import type { AuditLogger } from '../audit-log.js'
import { ExecutorInstallationError, type ExecutorInstallationStorage } from '../store/executor-installation.js'
import type { ExecutorIdentityStorage } from '../store/executor-identity.js'
import { claimRoute } from './routes.js'
import { validatedPublicOrigin } from './public-access-gate.js'

export function attachExecutorInstallationRoutes(server: HttpServer, options: {
  store: ExecutorInstallationStorage
  identities?: ExecutorIdentityStorage
  auth?: AuthConfig
  tenancy: PlatformTenancy
  audit?: AuditLogger
  windowsReleaseAssetsReady?: () => boolean
}): void {
  const claimAttempts = new Map<string, { count: number; resetAt: number }>()
  server.on('request', async (req, res) => {
    if (res.headersSent || res.writableEnded) return
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname
    if (path === '/install/invite.ps1') {
      claimRoute(req)
      if (url.search) { sendError(res, 400, 'query_not_allowed'); return }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.setHeader('allow', 'GET, HEAD'); sendError(res, 405, 'method_not_allowed'); return }
      if (!options.windowsReleaseAssetsReady?.()) { sendError(res, 410, 'windows_release_assets_unavailable'); return }
      const origin = requestOrigin(req)
      if (!isSecureInstallRequest(req, origin)) { sendError(res, 400, 'https_required'); return }
      const body = renderInvitePowerShellBootstrap(origin)
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
      res.end(req.method === 'HEAD' ? undefined : body)
      return
    }
    if ((path === '/install' || path === '/install.ps1') && req.method === 'GET') {
      claimRoute(req)
      const shell = path === '/install'
      if (!shell && !options.windowsReleaseAssetsReady?.()) { sendError(res, 410, 'windows_release_assets_unavailable'); return }
      const origin = requestOrigin(req)
      if (!isSecureInstallRequest(req, origin)) { sendError(res, 400, 'https_required'); return }
      const body = shell ? renderShellBootstrap(origin) : renderPowerShellBootstrap(origin)
      res.writeHead(200, { 'content-type': shell ? 'text/x-shellscript; charset=utf-8' : 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
      res.end(body)
      return
    }

    if (path === '/api/executor-install-capabilities') {
      claimRoute(req)
      applyCors(req, res)
      if (req.method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
      }
      if (req.method !== 'GET') { sendError(res, 405, 'method_not_allowed'); return }
      const authorization = authorizeManagement(req, options.tenancy, options.auth)
      if (!authorization.ok) { sendError(res, authorization.status, authorization.error); return }
      const capabilities = {
        platforms: {
          linux: { available: true },
          macos: { available: true },
          windows: { available: options.windowsReleaseAssetsReady?.() === true },
        },
      }
      sendJson(res, 200, capabilities)
      return
    }

    const installSessionMatch = path.match(/^\/install\/session(?:\/([^/]+)(?:\/(events|redeem|status))?)?$/u)
    const installSession = Boolean(installSessionMatch)
    const match = path.match(/^\/api\/executor-installs(?:\/([^/]+)(?:\/(approve|reject|events|redeem|status))?)?$/u)
    if (!match && !installSession) return
    claimRoute(req)
    if (match) {
      applyCors(req, res)
      if (req.method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
      }
    }
    const idValue = match?.[1] ?? installSessionMatch?.[1]
    const id = idValue ? decodeURIComponent(idValue) : undefined
    const action = match?.[2] ?? installSessionMatch?.[2]

    if ((id === 'claim' || (installSession && !id)) && !action && req.method === 'POST') {
      const origin = requestOrigin(req)
      if (!isSecureInstallRequest(req, origin)) { sendError(res, 400, 'https_required'); return }
      const claimKey = clientAddress(req)
      if (!allowClaimAttempt(claimAttempts, claimKey)) { sendError(res, 429, 'setup_code_rate_limited'); return }
      void readJson(req).then(async (body) => {
        const setupCode = typeof (body as { setupCode?: unknown }).setupCode === 'string' ? (body as { setupCode: string }).setupCode : ''
        const claimed = await options.store.claim(setupCode)
        if (!claimed) { sendError(res, 401, 'invalid_or_consumed_setup_code'); return }
        claimAttempts.delete(claimKey)
        const env = bootstrapEnvironment(origin, claimed.install, claimed.bootstrap)
        if (header(req, 'accept') === 'text/x-shellscript') {
          res.writeHead(200, { 'content-type': 'text/x-shellscript; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
          res.end(Object.entries(env).map(([key, value]) => `export ${key}=${quoteSh(value)}`).join('\n'))
          return
        }
        sendJson(res, 200, { env })
      }).catch((error) => handleError(res, error))
      return
    }

    if (id && action === 'events' && req.method === 'POST') {
      void handleClientEvent(req, res, options.store, id)
      return
    }
    if (id && action === 'redeem' && req.method === 'POST') {
      void handleRedeem(req, res, options.store, options.identities, id)
      return
    }
    if (id && action === 'status' && req.method === 'GET') {
      try {
        const bootstrap = bearer(req) ?? url.searchParams.get('bootstrap') ?? undefined
        if (!await options.store.authenticate(id, bootstrap)) { sendError(res, 401, 'invalid_installation_credential'); return }
        const snapshot = await options.store.get(id)
        if (!snapshot) { sendError(res, 404, 'installation_not_found'); return }
        sendJson(res, 200, snapshot)
      } catch (error) { handleError(res, error) }
      return
    }

    const authorization = authorizeManagement(req, options.tenancy, options.auth)
    if (!authorization.ok) { sendError(res, authorization.status, authorization.error); return }

    try {
      if (!id && req.method === 'POST') {
        void readJson(req).then(async (body) => {
          const input = schema.CreateExecutorInstallSchema.parse(body)
          if (input.platform === 'windows' && !options.windowsReleaseAssetsReady?.()) { sendError(res, 422, 'windows_release_assets_unavailable'); return }
          const created = await options.store.create(input, scopedIdempotencyKey(header(req, 'idempotency-key'), authorization.actor), tenantAttribution(authorization.actor))
          const origin = requestOrigin(req)
          const command = installCommand(origin, input.platform, input.mode, created.setupCode)
          options.audit?.log({ action: 'executor_install.create', actor: authorization.actor, outcome: 'ok', metadata: { id: created.install.id } })
          sendJson(res, 201, { ...created.install, command, setupCode: created.setupCode })
        }).catch((error) => handleError(res, error))
        return
      }
      if (!id) { sendError(res, 405, 'method_not_allowed'); return }
      if (!action && req.method === 'GET') {
        const snapshot = await options.store.get(id)
        if (!snapshot) { sendError(res, 404, 'installation_not_found'); return }
        const accessError = executorInstallAccessError(authorization.actor, snapshot)
        if (accessError) { sendError(res, 403, accessError); return }
        sendJson(res, 200, snapshot); return
      }
      if (!action && req.method === 'PATCH') {
        void readJson(req).then(async (body) => {
          const snapshot = await options.store.get(id)
          if (!snapshot) { sendError(res, 404, 'installation_not_found'); return }
          const accessError = executorInstallAccessError(authorization.actor, snapshot)
          if (accessError) { sendError(res, 403, accessError); return }
          const updated = await options.store.update(id, schema.UpdateExecutorInstallSchema.parse(body))
          if (!updated) { sendError(res, 409, 'installation_not_editable'); return }
          sendJson(res, 200, updated)
        }).catch((error) => handleError(res, error)); return
      }
      if (!action && req.method === 'DELETE') {
        const snapshot = await options.store.get(id)
        if (!snapshot) { sendError(res, 404, 'installation_not_found'); return }
        const accessError = executorInstallAccessError(authorization.actor, snapshot)
        if (accessError) { sendError(res, 403, accessError); return }
        sendJson(res, 200, { ok: true, id, deleted: await options.store.delete(id) }); return
      }
      if ((action === 'approve' || action === 'reject') && req.method === 'POST') {
        const snapshot = await options.store.get(id)
        if (!snapshot) { sendError(res, 404, 'installation_not_found'); return }
        const accessError = executorInstallAccessError(authorization.actor, snapshot)
        if (accessError) { sendError(res, 403, accessError); return }
        const updated = action === 'approve' ? await options.store.approve(id) : await options.store.reject(id)
        if (!updated) { sendError(res, 409, 'installation_not_pending'); return }
        options.audit?.log({ action: `executor_install.${action}`, actor: authorization.actor, outcome: 'ok', metadata: { id } })
        sendJson(res, 200, updated); return
      }
      if (action === 'events' && req.method === 'GET') {
        const snapshot = await options.store.get(id)
        if (!snapshot) { sendError(res, 404, 'installation_not_found'); return }
        const accessError = executorInstallAccessError(authorization.actor, snapshot)
        if (accessError) { sendError(res, 403, accessError); return }
        const after = Number(header(req, 'last-event-id') ?? url.searchParams.get('after') ?? -1)
        const events = await options.store.events(id, Number.isSafeInteger(after) ? after : -1)
        sendJson(res, 200, { events }); return
      }
      sendError(res, 405, 'method_not_allowed')
    } catch (error) { handleError(res, error) }
  })
}

function tenantAttribution(actor: DashboardActor): { organizationId: string; principal: string; organizationRole: 'owner' | 'admin' | 'member' | 'viewer' } | undefined {
  return actor.kind === 'ingress'
    ? { organizationId: actor.organizationId, principal: actor.principal, organizationRole: actor.role }
    : undefined
}

function scopedIdempotencyKey(key: string | undefined, actor: DashboardActor): string | undefined {
  if (!key) return undefined
  return actor.kind === 'ingress' ? `${actor.organizationId}:${key}` : key
}

function executorInstallAccessError(actor: DashboardActor, snapshot: { organizationId?: string }): string | undefined {
  if (actor.kind !== 'ingress') return undefined
  if (!snapshot.organizationId) return 'tenant_attribution_missing'
  return snapshot.organizationId === actor.organizationId ? undefined : 'tenant_forbidden'
}

async function handleClientEvent(req: IncomingMessage, res: ServerResponse, store: ExecutorInstallationStorage, id: string): Promise<void> {
  try {
    const body = await readJson(req) as { bootstrap?: unknown; status?: unknown; errorCode?: unknown; metadata?: unknown }
    const bootstrap = typeof body.bootstrap === 'string' ? body.bootstrap : bearer(req)
    if (!bootstrap) { sendError(res, 401, 'installation_credential_required'); return }
    const status = schema.ExecutorInstallStatusSchema.parse(body.status) as ExecutorInstallStatus
    const event = schema.ExecutorInstallEventSchema.pick({ errorCode: true, metadata: true }).partial().parse({ errorCode: body.errorCode, metadata: body.metadata })
    sendJson(res, 200, await store.reportClient(id, bootstrap, status, event.errorCode, event.metadata))
  } catch (error) { handleError(res, error) }
}

async function handleRedeem(req: IncomingMessage, res: ServerResponse, store: ExecutorInstallationStorage, identities: ExecutorIdentityStorage | undefined, id: string): Promise<void> {
  try {
    if (!identities) throw new ExecutorInstallationError('executor_identity_store_not_configured', 503)
    const body = await readJson(req) as { bootstrap?: unknown; workspaceId?: unknown; label?: unknown }
    const bootstrap = typeof body.bootstrap === 'string' ? body.bootstrap : bearer(req)
    const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId.trim() : ''
    if (!bootstrap || !workspaceId) throw new ExecutorInstallationError('invalid_redeem_request', 400)
    const snapshot = await store.redeem(id, bootstrap, workspaceId)
    const token = await identities.provisionWorkspace(workspaceId, typeof body.label === 'string' ? body.label.trim() : undefined, snapshot.id)
    sendJson(res, 200, { installationId: snapshot.id, workspaceId, token })
  } catch (error) { handleError(res, error) }
}

export function authorizeSensitiveExecutorManagement(req: IncomingMessage, tenancy: PlatformTenancy, auth: AuthConfig | undefined): { ok: true; actor: DashboardActor } | { ok: false; status: number; error: string } {
  const result = authorizeManagement(req, tenancy, auth)
  if (!result.ok) return result
  if (result.actor.kind === 'anonymous') return { ok: false, status: 401, error: 'operator_authentication_required' }
  if (result.actor.kind === 'ingress' && !['owner', 'admin'].includes(result.actor.role)) return { ok: false, status: 403, error: 'admin_required' }
  return result
}

function authorizeManagement(req: IncomingMessage, tenancy: PlatformTenancy, auth: AuthConfig | undefined): { ok: true; actor: DashboardActor } | { ok: false; status: number; error: string } {
  const result = authenticateDashboardHandshake({ role: 'dashboard', clientVersion: 'http', ...(bearer(req) ? { token: bearer(req) } : {}) }, req, auth)
  if (!result.ok) return { ok: false, status: 401, error: result.reason }
  if (tenancy === 'multi-tenant' && (result.actor.kind !== 'ingress' || !['owner', 'admin'].includes(result.actor.role))) return { ok: false, status: 403, error: 'admin_required' }
  if (tenancy === 'single-tenant' && result.actor.kind === 'anonymous' && (auth?.github?.required || auth?.sharedToken)) return { ok: false, status: 401, error: 'operator_authentication_required' }
  return result
}

function bootstrapEnvironment(origin: string, snapshot: { id: string; mode: string; platform: string; privilegeMode: string; workspaceRoot: string; label?: string }, bootstrap: string): Record<string, string> {
  return {
    HOST_URL: origin,
    EXECUTOR_INSTALL_ID: snapshot.id,
    EXECUTOR_INSTALL_BOOTSTRAP: bootstrap,
    EXECUTOR_INSTALL_MODE: snapshot.mode,
    EXECUTOR_PRIVILEGE_MODE: snapshot.privilegeMode,
    EXECUTOR_INSTALL_PLATFORM: snapshot.platform,
    EXECUTOR_INSTALL_ROOT: snapshot.workspaceRoot,
    KALA_RELEASE_BASE_URL: `${origin}/install/assets`,
    KALA_RELEASE_TRUST: 'host',
    KALA_RELEASE_ASSETS_URL: `${origin}/install/assets`,
    ...(snapshot.label ? { EXECUTOR_INSTALL_LABEL: snapshot.label } : {}),
  }
}
function installCommand(origin: string, platform: string, mode: string, setupCode: string): string {
  return platform === 'windows'
    ? `$env:KALA_SETUP_CODE=${quotePs(setupCode)}; $env:KALA_INSTALL_MODE=${quotePs(mode)}; irm ${quotePs(`${origin}/install.ps1`)} | iex`
    : `curl -fsSL ${quoteSh(`${origin}/install`)} | KALA_SETUP_CODE=${quoteSh(setupCode)} KALA_INSTALL_MODE=${quoteSh(mode)} sh`
}
function renderShellBootstrap(origin: string): string {
  return `#!/bin/sh\nset -eu\ncode=\${KALA_SETUP_CODE:-}\nif [ -z "$code" ]; then printf 'Kala setup code: ' >&2; IFS= read -r code; fi\ncase "$code" in *[!A-Fa-f0-9-]*|'') echo 'Invalid setup code' >&2; exit 1;; esac\ncommand -v bash >/dev/null 2>&1 || { echo 'Kala installer: bash is required' >&2; exit 1; }\ncommand -v curl >/dev/null 2>&1 || { echo 'Kala installer: curl is required' >&2; exit 1; }\ninstaller=\$(mktemp)\ntrap 'rm -f "$installer"' EXIT HUP INT TERM\nprintf '\\nKala Executor setup\\n'\nprintf '[1/4] Downloading verified installer...\\n'\ncurl --fail --silent --show-error --location --retry 3 --retry-connrefused -o "$installer" ${quoteSh(`${origin}/install/assets/run.sh`)} || { echo 'Kala installer: failed to download installer asset' >&2; exit 1; }\nprintf '[2/4] Validating setup code...\\n'\nclaim=\$(curl --fail --silent --show-error --location --retry 3 --retry-connrefused -X POST -H 'content-type: application/json' -H 'accept: text/x-shellscript' --data "{\\"setupCode\\":\\"$code\\"}" ${quoteSh(`${origin}/install/session`)}) || { echo 'Kala installer: setup code is invalid, expired, or already used' >&2; exit 1; }\neval "$claim"\nprintf '[3/4] Installing Executor...\\n'\nCOMPONENT=executor bash "$installer" --internal-installer\n`
}
function renderPowerShellBootstrap(origin: string): string {
  return `$ErrorActionPreference = 'Stop'
function Assert-KalaInstallPrivileges([string]$mode) {
  if ($mode -eq 'service') {
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Windows service installation requires an elevated Administrator PowerShell. Open PowerShell with Run as administrator, then run the installation command again.' }
  }
}
Assert-KalaInstallPrivileges $env:KALA_INSTALL_MODE
$code = $env:KALA_SETUP_CODE
if ([string]::IsNullOrWhiteSpace($code)) { $code = Read-Host 'Kala setup code' }
if ([string]::IsNullOrWhiteSpace($code)) { throw 'Kala setup code is required' }
$installer = Join-Path ([IO.Path]::GetTempPath()) ('runlab-bootstrap-' + [guid]::NewGuid() + '.ps1')
try {
  Write-Host ''
  Write-Host 'Kala Executor setup'
  Write-Host '[1/4] Downloading verified installer...'
  Invoke-WebRequest -UseBasicParsing -Uri ${quotePs(`${origin}/install/assets/install-executor.ps1`)} -OutFile $installer
  Write-Host '[2/4] Validating setup code...'
  $claim = Invoke-RestMethod -Method Post -ContentType 'application/json' -Headers @{ Accept = 'application/json' } -Body (@{ setupCode = $code } | ConvertTo-Json -Compress) -Uri ${quotePs(`${origin}/install/session`)}
  if ($null -eq $claim -or $null -eq $claim.env) { throw 'Kala Host returned an invalid installation session' }
  Assert-KalaInstallPrivileges $claim.env.EXECUTOR_INSTALL_MODE
  $properties = $claim.env.PSObject.Properties
  if ($null -eq $properties -or $properties.Count -eq 0) { throw 'Kala Host returned an empty installation environment' }
  $properties | ForEach-Object { [Environment]::SetEnvironmentVariable($_.Name, [string]$_.Value, 'Process') }
  Write-Host '[3/4] Starting Executor...'
  & $installer --internal-installer
  if ($LASTEXITCODE -ne 0) { throw "Kala Executor installer exited with code $LASTEXITCODE" }
} finally {
  Remove-Item $installer -Force -ErrorAction SilentlyContinue
}
`
}
function renderInvitePowerShellBootstrap(origin: string): string {
  const expectedAssets = `${origin}/install/assets`
  return `$ErrorActionPreference = 'Stop'
$expectedHost = ${quotePs(origin)}
$expectedAssets = ${quotePs(expectedAssets)}
$hostUrl = if ($env:HOST_URL) { $env:HOST_URL.TrimEnd('/') } else { '' }
$assetBase = if ($env:KALA_RELEASE_BASE_URL) { $env:KALA_RELEASE_BASE_URL.TrimEnd('/') } else { '' }
if ($hostUrl -cne $expectedHost -or $assetBase -cne $expectedAssets -or $env:KALA_RELEASE_TRUST -ne 'host') { throw 'Invite installer URLs must match the trusted ingress origin' }
$hostUri = [Uri]$hostUrl
if ($hostUri.UserInfo -or $hostUri.Query -or $hostUri.Fragment -or ($hostUri.Scheme -ne 'https' -and -not ($hostUri.Scheme -eq 'http' -and $hostUri.IsLoopback))) { throw 'Invite installation requires HTTPS' }
if ($env:EXECUTOR_INVITE -notmatch '^ak_invite_[A-Za-z0-9_-]+$') { throw 'A valid Executor invite is required' }
if (@('temporary', 'service') -notcontains $env:KALA_INVITE_INSTALL_MODE) { throw 'KALA_INVITE_INSTALL_MODE must be temporary or service' }
if ($env:KALA_INVITE_INSTALL_MODE -eq 'service') {
  $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Windows service installation requires an elevated Administrator PowerShell' }
}
$installer = Join-Path ([IO.Path]::GetTempPath()) ('kala-invite-bootstrap-' + [guid]::NewGuid() + '.ps1')
try {
  $installerUri = $expectedAssets + '/install-executor.ps1'
  $response = Invoke-WebRequest -UseBasicParsing -Uri $installerUri -OutFile $installer -PassThru
  $finalUri = if ($response.BaseResponse.ResponseUri) { $response.BaseResponse.ResponseUri } elseif ($response.BaseResponse.RequestMessage) { $response.BaseResponse.RequestMessage.RequestUri } else { [Uri]$installerUri }
  if ($finalUri.AbsoluteUri -cne $installerUri) { throw 'Installer redirect left the trusted ingress asset URL' }
  & $installer --invite-installer
  if ($LASTEXITCODE -ne 0) { throw "Kala Executor installer exited with code $LASTEXITCODE" }
} finally {
  Remove-Item $installer -Force -ErrorAction SilentlyContinue
  Remove-Item Env:EXECUTOR_INVITE -ErrorAction SilentlyContinue
}
`
}
function allowClaimAttempt(attempts: Map<string, { count: number; resetAt: number }>, key: string): boolean {
  const now = Date.now()
  const current = attempts.get(key)
  if (!current || current.resetAt <= now) { attempts.set(key, { count: 1, resetAt: now + 60_000 }); return true }
  if (current.count >= 5) return false
  current.count += 1
  return true
}
function clientAddress(req: IncomingMessage): string { return header(req, 'cf-connecting-ip') ?? header(req, 'x-real-ip') ?? req.socket.remoteAddress ?? 'unknown' }
function requestOrigin(req: IncomingMessage): string { return validatedPublicOrigin(req) ?? `http://${req.headers.host ?? 'localhost'}` }
function isSecureInstallRequest(req: IncomingMessage, origin: string): boolean {
  return validatedPublicOrigin(req) !== undefined || isSecureInstallOrigin(origin)
}
function isSecureInstallOrigin(origin: string): boolean {
  try {
    const url = new URL(origin)
    return url.protocol === 'https:' || (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'))
  } catch { return false }
}
function bearer(req: IncomingMessage): string | undefined { const value = header(req, 'authorization'); return value?.startsWith('Bearer ') ? value.slice(7) : undefined }
function header(req: IncomingMessage, name: string): string | undefined { const value = req.headers[name]; return Array.isArray(value) ? value[0] : value }
function quoteSh(value: string): string { return `'${value.replaceAll("'", "'\\''")}'` }
function quotePs(value: string): string { return `'${value.replaceAll("'", "''")}'` }
function applyCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = header(req, 'origin')
  const publicOrigin = validatedPublicOrigin(req)
  if (origin && publicOrigin) {
    res.setHeader('access-control-allow-origin', publicOrigin)
    res.setHeader('access-control-allow-credentials', 'true')
    res.setHeader('vary', 'origin')
  }
  res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS')
  res.setHeader('access-control-allow-headers', header(req, 'access-control-request-headers') ?? 'authorization,content-type,idempotency-key')
  res.setHeader('access-control-max-age', '600')
}
function sendJson(res: ServerResponse, status: number, body: unknown): void { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)) }
function sendError(res: ServerResponse, status: number, error: string): void { sendJson(res, status, { error }) }
function handleError(res: ServerResponse, error: unknown): void {
  if (res.writableEnded) return
  if (error instanceof ExecutorInstallationError) { sendError(res, error.status, error.message); return }
  if (error instanceof ZodError || error instanceof SyntaxError) { sendError(res, 400, 'invalid_request'); return }
  // An I/O or persistence fault is not a malformed client request. Do not
  // disclose local filenames or operating-system errors to the caller.
  sendError(res, 500, 'internal_error')
}
async function readJson(req: IncomingMessage): Promise<unknown> { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {} }
