# Settings and Administration: Implementation Source of Truth

**Status:** proposed implementation contract, not an assertion of shipped behavior.

**Last source audit:** 2026-11-12. This document replaces the earlier Chinese draft at the same path. Product implementation, independent review, tests and deployment are separate gates.

## 1. Decisions and interpretation

Kala will have **one Settings surface**, with Personal, Instance/Organization, and Deployment sections. The existing Settings dialog and Organization administration overlay must not remain competing management products.

This specification covers all 16 existing Settings sections, all seven Administration tabs, and their adjacent account, workspace installation and Session configuration actions. It does not move Pipeline, scheduled tasks, Git, files or other business editors into Settings.

The implementation must preserve existing working configuration paths. A missing backend is work to complete, not permission to remove the associated form. A configuration is complete only when its entry point, actor, resource, validation, durable authority, consumer, application timing and verification are all defined.

Normative terms:

- **Existing:** traced to current source; not automatically verified on every deployment or OS.
- **Required:** part of the target design and acceptance gate.
- **Unsupported:** intentionally unavailable in the specified mode, with an explicit reason; never a successful no-op.
- **Blocked:** a required implementation or external verification is missing. It cannot be relabeled unsupported to make a release pass.
- **Operator:** an infrastructure-maintenance identity/channel, not a new browser organization role.

No product changes or deployment are authorized merely by the existence of this document. Subsequent implementation and deployment follow the explicitly requested execution sequence.

## 2. Problems the implementation must resolve

| ID | Verified current behavior | Required correction |
|---|---|---|
| G01 | Settings groups models and Executor access under Personal and uses a broad `canManage` flag. [S01] | Organize by task and authorize individual actions. |
| G02 | Dedicated advertises generic organization permissions while identity-mutation routes return `dedicated_single_owner`. [S02] | Hide unsupported team mutations; retain backend rejection. |
| G03 | `DedicatedModelSettings` and its write callbacks are composed only for Dedicated. Private Cloud can report `management: operator`. [S03] | Do not pretend Private Cloud model editing already works. Implement tenant-owned configuration before enabling it. |
| G04 | MCP GET returns names only; the UI initializes blank commands; PUT replaces the complete list. [S04] | Add revisioned keep/replace/delete semantics without disclosing command secrets. |
| G05 | Administration displays service accounts read-only, although management APIs exist. [S05] | Add create/list/revoke UI using the real API. |
| G06 | Contract, workspace, Pool and Webhook records lack a demonstrated complete management path. [S06] | Define supported resource operations and their consumers; expose incomplete paths as blockers. |
| G07 | Integration status is hardcoded to `local`, `session-jsonl`, and disabled telemetry. [S06] | Read actual adapters/configuration, with unknown distinct from disabled. |
| G08 | Socket administration combines tenant diagnostics and a Dedicated global native console. [S07] | Preserve tenant diagnostics without granting global access. |
| G09 | Connection overrides can target another Socket endpoint while HTTP settings requests use the current Origin. [S08] | Bind HTTP, Socket, authentication, drafts and caches to one verified target. |
| G10 | Hooks load from a file at Runtime startup, not from a live Web editor. [S09] | Preserve execution and specify file authority, provisioning and restart requirements. |
| G11 | Account Center implements login-session management, not every feature in the accepted account design. [S10][S14] | Preserve working actions; do not invent account-export/deletion APIs. |
| G12 | SILO can encounter Dashboard fallback; latency sampling lacks freshness and precise interpretation. [S11][S12] | Fix routing and measurement separately from navigation redesign. |
| G13 | Webhook worker startup explicitly accepts opt-in Private Cloud only. [S31] | Do not imply Dedicated has a working delivery service merely because a table exists. |

## 3. Product and authority boundaries

| Product | Business configuration | Infrastructure maintenance | Navigation |
|---|---|---|---|
| Portable | Existing local authentication and resource authorization | Existing local installation maintainer | Personal, applicable local instance tasks, supported local maintenance |
| Dedicated | The one canonically bound, authenticated Owner | The same Owner can use enabled product maintenance entrances; host/Compose operations still require the protected host channel | Personal, Instance, Deployment; no team identity management |
| Private Cloud | Membership in the current organization and resource/action permissions | Independent Operator/infrastructure channel | Personal and Organization; no global Deployment section |

Do not introduce a second Kala administrator account for Dedicated. Do not introduce a Private Cloud platform-wide Web super-admin or cross-organization operations console in this work.

Dedicated ownership must come from the server-validated product mode and immutable bound identity, not email, display name, client role flags or an arbitrary Owner membership. Profile changes do not change the authorization principal.

External systems retain their own authentication. Opening the storage console does not automatically log in or inject administrator credentials. The installation can explicitly share its existing storage administrator login with its canonically bound Dedicated Owner through the on-demand protected handoff in §14.3; organization membership alone never grants that access. Organization membership does not grant host root or database administration. The design does not claim that a real host root administrator is physically unable to access business data.

### 3.1 Existing role baseline

Preserve `ROLE_PERMISSIONS`; individual handlers can impose additional restrictions. [S27]

| Permission | Owner | Admin | Member | Viewer |
|---|---|---|---|---|
| `runtime:read` | yes | yes | yes | yes |
| `runtime:write` | yes | yes | yes | no |
| `workspace:manage` | yes | yes | no | no |
| `organization:manage` | yes | yes | no | no |
| `policy:manage` | yes | yes | no | no |
| Global deployment authority from organization role alone | no | no | no | no |

`/organization/ownership` additionally requires the current Owner. Admin's generic `organization:manage` must not bypass that check. Dedicated rejects these identity mutations regardless of the underlying permission set. [S02]

Ordinary authorized users retain model-catalog and workspace browsing. Browsing must not fetch enrollment secrets or administrator-only APIs.

## 4. Frozen information architecture

The following is the Dedicated navigation. Private Cloud substitutes Organization for Instance, inserts Members and invitations, and removes Deployment. Portable uses only genuinely supported branches.

```text
Settings                                      Return to conversation

Personal
  Appearance and interaction
  Notifications and devices
  This device's connection
  Account and login sessions

Instance configuration
  Models and Agent
  Workspaces and Executors
  Tools and integrations
  Data and execution policies
  Usage and access management
  Connection diagnostics

Deployment
  Service status and versions
  Object storage · SILO
  Other operations consoles
  Deployment configuration and diagnostics
```

Keep the product's main navigation. Settings has one secondary navigation, not another full application shell. Workspace detail and access-management subtasks use page tabs/details, not a third sidebar. The native SILO console may retain its own internal navigation; Kala must not recreate it.

### 4.1 Route contract

All paths below are **target hash routes**, not existing HTTP endpoints. Preserve pathname and query parameters, including the selected Session ID, when changing the hash.

| Route after `#/settings/` | Page/tab | Default/redirect |
|---|---|---|
| empty | Settings entry | Replace with `personal/interface` |
| `personal/interface` | Appearance, themes, readability, cache | none |
| `personal/notifications` | Notification preferences, Push devices | none |
| `personal/connection` | Target connection and Desktop update | none |
| `personal/account` | Existing Account Center content in Settings | reuse its actions, not its overlay shell |
| `organization/members` | Members, invitations, Owner transfer | Private Cloud only |
| `organization/models/providers` | Provider editor or authorized model catalog | `organization/models` redirects here |
| `organization/models/prompts` | Agent prompt slots | authorized configuration readers only |
| `organization/models/engines` | Agent engine availability | non-secret engine summary |
| `organization/workspaces` | Workspace and Executor list | no implicit first-workspace selection |
| `organization/workspaces/<id>/overview` | Registration, connections, Pool association | detail default |
| `organization/workspaces/<id>/access` | Scoped installation/access tasks | management permission required |
| `organization/workspaces/<id>/mcp` | That workspace's MCP configuration | no global MCP editor |
| `organization/integrations/search` | Serper configuration/status | integrations default |
| `organization/integrations/speech` | Speech configuration/status | none |
| `organization/integrations/hooks` | Loaded Hooks and maintenance source | no arbitrary Web command editor |
| `organization/integrations/skills` | Actual discovery status | no arbitrary extension installer |
| `organization/integrations/webhooks` | Supported organization Webhooks | Private Cloud opt-in gate |
| `organization/policies/execution` | Computer Use, preview, manual authorization | policies default |
| `organization/policies/attachments` | Upload attachment limit | none |
| `organization/policies/retention` | Session retention and cleaner state | none |
| `organization/access/usage` | Monthly usage and effective limits | access default |
| `organization/access/storage` | Scoped object usage / Portable cleanup | not the SILO console |
| `organization/access/service-accounts` | Create/list/revoke service accounts | none |
| `organization/access/sessions` | Organization login-session summary | not personal device revocation |
| `organization/access/audit` | Authorized organization audit | none |
| `organization/diagnostics` | Scoped connection diagnostics | none |
| `deployment/services` | Service health, versions, supported lifecycle | none |
| `deployment/storage` | Embedded SILO | Dedicated Owner only |
| `deployment/consoles` | IdP, Aspire, Socket.IO native entrances | no second SILO editor |
| `deployment/configuration` | Effective sources and maintenance instructions | no raw secret/config dump |

Use the literal `organization` route segment for both Dedicated and Private Cloud; its label changes, its resource identity does not. IDs must be decoded once and reject empty, overlong, control-character, slash and backslash values. Do not use display names as routing keys.

An unauthorized deep link renders Forbidden at that route, without fetching its data or silently switching to Personal. An unknown Settings subroute renders a Settings-local Not found. Bare group routes use the defaults above. Unsupported product-mode identity pages are not redirected to a destructive or unrelated task.

### 4.2 Routing and application lifecycle

Extend the existing hash router in `app-shell/section.ts` to recognize Settings before its current unknown-route-to-Agent fallback. Use one parsing/navigation contract; do not keep `settingsOpen`, `adminCenterOpen` and the hash as independent competing sources of truth. [S28]

Existing command-palette, speech-setup, account and operations shortcuts call a shared `openSettings(route)` adapter. The old organization shortcut maps to Members in Private Cloud; Dedicated no longer displays that shortcut. Existing HTTP `/admin` and `/settings` are not SPA routes and must not be hijacked.

On entry, remember the last valid non-Settings hash in `history.state`. Return to conversation restores it, or `#/agent` on a cold deep link. Never accept an external return URL. Back/forward must restore the Settings tab, not reopen a stale overlay.

Keep the application-level control connection, selected Session and ongoing Agent work alive. Do not remount the Session client or request writable ownership/history solely to display Settings. Mount only the active Settings task and its required data; a hidden iframe or management page must not keep running.

Draft navigation is guarded before internal navigation and on browser unload. Browser back/forward must preserve the draft in memory and render a leave confirmation rather than discard it. Cancel restores the current canonical route without adding an unbounded history loop. Secrets are memory-only and are cleared on logout/identity change; they are not persisted for unload recovery.

### 4.3 Visual and responsive contract

| Element | Required behavior |
|---|---|
| Page / section / card headings | Existing `text-2xl` / `text-lg` / `text-base` tokens, with distinct hierarchy |
| Body, fields, navigation | `text-sm`; auxiliary metadata may use `text-xs`, not primary controls |
| Desktop navigation | `14.5rem`; rows at least 40 CSS px and 44px for coarse pointers |
| Layout switch | Use the Settings container's available width: below `52rem`, replace the sidebar with a grouped section picker |
| Forms | One column by default; two columns only when the content pane itself is at least `42rem`; max content width `56rem` |
| SILO content | No normal form max-width; fill the available content pane, with a persistent Kala page header |
| Long values | `min-width: 0`, wrapping/copy affordance; never clip names, errors or primary buttons to hide overflow |
| Scrolling | Sidebar and active content have explicit scroll ownership; no full-screen Administration overlay above Settings |
| Accessibility | Keyboard navigation, visible focus, labeled fields, reachable help, status announcements; normal UI scaling preserved |

Page header shows the business title and current instance/organization/workspace. Technical IDs belong in expandable details. Errors, irreversible-action confirmations, one-time credentials and pending application states are visible, not tooltip-only.

## 5. Action authorization and capability discovery

Frontend visibility is not authorization. Every HTTP handler, Socket namespace, Executor action and console proxy rechecks its actor and target.

| Action family | Read | Write | Additional conditions |
|---|---|---|---|
| Personal preferences / own sessions | current user | current user | browser/OS support and own-device/session identity |
| Publicly usable model catalog / workspace browsing | authorized `runtime:read` | no implicit management right | only authorized resources; no secret-bearing configuration |
| Provider, default model, Agent prompt | Owner/Admin configuration access | Owner/Admin | management source permits Dashboard; handler, store and consumer exist |
| Computer Use / attachment / retention policy | authorized policy readers | `policy:manage` | product support; mandatory deployment restrictions remain binding |
| Executor invitations / workspace MCP | permitted workspace readers for non-secret summary | `workspace:manage` plus existing sensitive-management guards | trusted managed Executor, organization attribution and workspace access |
| Search / Speech | non-secret runtime status as currently supported | Owner/Admin sensitive management | organization-bound credential store |
| Members / organization invitations | organization-management access | `organization:manage` | Private Cloud only; never direct add-member in place of invitation |
| Owner transfer | current Owner | current Owner | existing eligible member, same organization, explicit confirmation |
| Usage / organization sessions / audit / service accounts | corresponding authorized management reader | only documented supported actions | browser management authentication for service accounts; no bearer-management bypass |
| Organization connection diagnostics | existing authorized organization administrator | no global-control implication | tenant-scoped snapshot only |
| Native deployment consoles | verified Dedicated Owner | external system's own permissions | service enabled and guarded route available |
| Infrastructure settings | authorized metadata reader, where applicable | independent Operator channel | never obtained by organization role mutation |

Portable continues its existing authentication and sensitive-management guards; do not invent an OIDC organization to reuse this matrix.

### 5.1 Required capability representation

Add typed capability metadata, not one `canManage` bit:

```ts
type SettingsCapability = {
  id: string
  scope: 'device' | 'account' | 'organization' | 'workspace' | 'session' | 'deployment'
  resourceId?: string
  supported: boolean
  canRead: boolean
  canWrite: boolean
  management: 'local-device' | 'dashboard' | 'operator' | 'identity-provider' | 'read-only'
  reasonCode?: string
  sourceRef?: string
}
```

`sourceRef` is a sanitized authorized reference, never a connection string, raw protected config or another tenant's path. Server-side composition derives capabilities from product mode, actor, source policy, handler/store wiring and actual feature support. A client cannot request a more privileged scope by supplying an ID.

Capability IDs use stable action names, including `models.read`, `models.configure`, `agent.configure`, `execution-policy.configure`, `workspace.browse`, `executor-invites.manage`, `mcp.configure`, `service-accounts.manage`, `ownership.transfer`, `webhooks.configure`, `diagnostics.read` and `silo.open`. They are not interchangeable with broad organization permissions.

Target metadata endpoints:

- Gateway `GET /organization/capabilities`: membership, organization actions, enabled deployment entrances and organization management-source policy.
- Runtime `GET /settings/capabilities`: supported configuration handlers/adapters and their action capabilities, using trusted ingress identity.
- Both require authentication, return `Cache-Control: no-store`, perform no model calls, object enumeration or external health probes, and load only when Settings needs them.

Merge by declared ownership of each capability, never boolean OR across servers. Missing/error metadata is Unknown, not permission denied or unsupported. Personal pages remain usable during Runtime failure; a failed management page has Retry without falling back to default values.

## 6. Complete migration and field inventory

### 6.1 Original entry points

| Existing Settings key | Destination |
|---|---|
| `interface` | Personal / Appearance |
| `notifications` | Personal / Notifications |
| `connection` | Personal / Connection |
| `models` | Models and Agent / Providers |
| `executorAccess` | Workspaces and Executors / Access |
| `management` | Embedded Object storage + Other consoles |
| `mcp` | Selected workspace / MCP |
| `agent` | Models and Agent / Prompts |
| `webSearch` | Tools / Search |
| `speech` | Tools / Speech |
| `security` | Execution policy; identity metadata links to Account |
| `socketAdmin` | Scoped diagnostics + applicable native console |
| `hooks` | Tools / Hooks |
| `runtime` | Models / Engines + Deployment / Services |
| `storage` | Usage / Storage; preserve Portable cleanup |
| `deployment` | Deployment / Services and versions |

| Existing Administration tab | Destination |
|---|---|
| Overview | Relevant usage/status summaries, not a second landing application |
| Members | Private Cloud Members/invitations |
| Workspaces | Workspace registry and detail |
| Executors | Associated registration/credential/connection information |
| Policies | Attachment and retention policy |
| Usage & security | Usage, access, organization sessions and audit |
| Integrations | Real feature pages and actual adapter status; remove hardcoded summaries |

### 6.2 Personal and device capabilities

| ID | Fields and operations to preserve | Authority/application |
|---|---|---|
| P01 | Chinese/English; system/light/dark | existing device preference keys; immediate |
| P02 | Built-in themes, Marketplace search/select/preview/apply/cancel preview | validated theme data only; never execute extension code; preview does not overwrite saved theme |
| P03 | UI scale, chat/code/file-preview/Session-tree/file-tree fonts, tool icon scale | preserve current ranges and conversion |
| P04 | Chat width, margins, line height, math scale, chapter/continuous reading, timestamp enum | existing device preferences |
| P05 | Tool tabs, Explorer, Inspector, top bar, pinned messages, offline workspaces, child-Agent visibility | preserve values/defaults and identity isolation |
| P06 | Streaming smoothing, expanded reasoning default, live tool-tail line count | display only; no tool/Session authority change |
| P07 | Screen wake behavior | real OS/browser support; no false enabled state |
| P08 | Memory-cache size, subscription keep-warm duration, durable cache toggle, count/size, persistence request/status, clear | browser cache authority; do not delete server Sessions, unsent drafts or other identities |
| P09 | Web/native notifications, categories, sound, native detail, badge | preferences and OS permission are separate |
| P10 | Push subscription, test, device list and existing removal | browser subscription and server device record agree; actual delivery result |
| P11 | Target source/override/reset and `/models` connection test | same verified HTTP/Socket target; see section 7 |
| P12 | Desktop version/check/download/update | existing native bridge and trusted release source; no dead Web-native buttons |
| P13 | Real profile, organization/role, own current/other sessions, single/all-device logout | reuse Account Center and `/auth/sessions`; no authorization-principal rewrite |
| P14 | Password/MFA/Passkey/profile self-service | actual configured IdP self-service entrance, not IdP administrator console |

Account export, account deletion and global Provider logout described elsewhere are not silently included as existing APIs. Track their separate implementation status. [S14]

### 6.3 Models, Agent and integrations

| ID | Fields and operations | Storage/consumer |
|---|---|---|
| A01 | Provider create/edit/delete: stable ID, label, OpenAI/Anthropic wire, Base URL, write-only key | existing tenant-encrypted model transaction; retain immutable in-flight adapters |
| A02 | Model create/edit/delete: Provider ID, stable model ID, label, optional positive integer context window | validated catalog and real Runtime model router |
| A03 | Instance/organization default, usable model catalog, separately selected Session model | default affects default resolution, not already persisted Session selection |
| A04 | Three prompt slots, names, contents, selected default slot, drafts | `tenant_agent_prompt_settings` by trusted organization ID |
| A05 | Computer Use, desktop preview, manual desktop authorization | same Agent settings object; do not overwrite prompt or unrelated fields |
| A06 | MCP name/command/args, add/replace/delete/preserve, confirmation | managed Executor's private configuration; revisioned ACK protocol in section 11 |
| A07 | Serper key create/replace/test/delete and update status | organization credential store; no fictional alternative Provider |
| A08 | Speech Endpoint/key/enabled/mode/two duration limits/test/delete | organization Speech credential store; distinguish microphone/HTTPS/service availability |
| A09 | Hooks event/command/optional match | controlled Unit file, existing HookRunner; startup application |
| A10 | Skills count/discovery roots/diagnostics | actual Runtime discovery; no arbitrary script installer |
| A11 | Engine availability/reasons/models/auth prerequisites | actual engine adapters; SDK authentication is not generic Provider configuration |

### 6.4 Workspace and Session capabilities

| ID | Fields and operations | Contract |
|---|---|---|
| W01 | Workspace stable ID/name/status, Runtime online view, Pool association/mode | associate registry and live sources without replacing their identity |
| W02 | Enrollment label/binding/create/copy command or Token/rename/regenerate/revoke/delete record/status | preserve `/auth/executor-invites`; creation/regeneration alone return plaintext; distinguish invitation and enrolled-device revocation |
| W03 | Linux/macOS/Windows, service/temporary, privileged/restricted, existing expert/pairing/progress options | existing shared installation form; chosen values reach installer, private config, service and real OS |
| W04 | Platform capabilities, trusted assets, existing update/reconnect/maintenance | no unsupported-platform command substitution |
| S01 | Session name/engine/execution mode/model/workspace/cwd/create options | keep Composer/Session detail authority, not instance-global fields |
| S02 | Approval `auto`/`ask`/`deny`/`allow_all` | preserve existing semantics and child restrictions |
| S03 | Selected tools, explicit tool upgrade, MCP descriptors and ordering | refresh definitions in place; never expand allowlists during config refresh [S19] |
| S04 | Existing tool-card/statistics preferences, storage view/cleanup/context export | preserve resource scope and existing destructive/export review |

Installer-plan tests are not proof of OS isolation. Preserve actual platform restrictions; do not advertise Linux `NoNewPrivileges` behavior on another OS without its implementation and acceptance. [S18][S20]

### 6.5 Organization, data and operations capabilities

| ID | Fields and operations | Contract |
|---|---|---|
| T01 | Private Cloud member roles/removal, invitation email/role/validity/copy/revoke, Owner transfer | real invitation flow, manual link delivery; Dedicated identity mutation unsupported |
| T02 | Attachment limit: existing 2/4/8/16 MiB choices | `/organization/attachment-policy`; upload enforcement must consume saved value |
| T03 | Session retention days, confirmation, cleaner status/scope | policy saving does not enable the maintenance cleaner |
| T04 | Artifact/audit/deleted-resource-grace retention reference | currently not independently enforced; backend rejects changes; no fake editor |
| T05 | Monthly Tokens/Sessions and contract/concurrency/seats/storage/workspace limits | distinguish effective enforcement, reported metadata, unknown and unlimited |
| T06 | Stored/reserved files/bytes, attachment/artifact breakdown, quota, measured time | organization object-metering index, not whole-bucket/disk enumeration |
| T07 | Portable local usage/sorting/cleanup plan/review/execute | retain local protocol; never apply local deletion to hosted storage |
| T08 | Service account name/scopes/expiry/create/list/revoke | existing browser-admin API; one-time Token; actual revocation |
| T09 | Webhook URL/topics/enabled/authorized signing-key binding/status | opt-in Private Cloud organization editor; section 13 defines platform restrictions |
| T10 | Organization login-session summary/service-account use/audit | authorized organization read; personal session DELETE is not organization-wide revocation |
| D01 | Scoped Socket counts/namespaces/transport/ping/time/manual refresh | preserve tenant fence and authorized readers |
| D02 | Portable Socket Admin password/init/mode/configured-effective/restart requirement | existing private config; hosted Gateway Owner mode has no local-password form |
| D03 | Runtime/services/versions/protocol/compatibility/update/blockers | local/external/slots adapters remain distinct |
| D04 | IdP/SILO/Aspire/Socket native entrance configuration | trusted deployment source; native applications open separately, never inside Settings |
| O01 | OIDC issuer/discovery/client/CA/public Origin/Owner bootstrap/internal auth/TLS | protected deployment configuration, never organization-role assignment |
| O02 | Supported contract/resource/Pool/source-policy maintenance | typed Operator contract, not arbitrary SQL |
| O03 | PG/S3/SecretResolver/Hooks mounts/telemetry/replicas/placement/resource limits | existing controlled infrastructure configuration |
| O04 | Images/assets/migration/upgrade/rollback/supported backup-restore | installation-specific maintenance; no Runtime self-upgrade |

## 7. Data loading, target identity and cache rules

### 7.1 Ownership and target consistency

Hosted configuration targets the current authenticated Origin. Changing a browser endpoint to another deployment must navigate to that deployment and complete its authentication before showing its settings. Do not forward the old deployment's cookies/Tokens to an arbitrary URL.

Portable/Desktop profiles retain multiple-target support. Resolve an immutable request context containing target Origin/profile, authenticated cache namespace, organization ID where applicable, workspace ID where applicable, and resource kind. HTTP requests, Socket events, drafts and query keys must use that context.

Query keys include the authenticated cache namespace and applicable target/resource IDs. They must not be just `['settings']` or workspace display name. Changing identity or organization cancels obsolete queries and removes secret-bearing drafts. Old request completions cannot populate the new identity's cache.

No universal `Session > workspace > organization > deployment` override algorithm is introduced. Deployment isolation and hard restrictions cannot be relaxed by child scopes; Session choices remain durable; MCP is workspace-bound; device preferences remain local.

### 7.2 Page-specific reads

Preserve legacy `GET /settings` response shape for old clients. Add **new typed, projected** Runtime `GET /settings/sections/<section>` responses rather than calling the old full settings producer and discarding fields.

| Runtime section | Data allowed | Excluded work |
|---|---|---|
| `models` | Authorized Provider metadata/default/source/revision, or public catalog projection | no storage scan, invitation snapshot, Hooks command dump |
| `agent` | Prompt slots and selected slot for authorized readers | no model calls |
| `execution` | Desktop/Computer Use policy and matching shared revision | no Session-history replay |
| `hooks` | Loaded non-secret summary and authorized maintenance reference | commands/match only for authorized maintainers |
| `engines` | Actual engine/model availability and sanitized prerequisites | no credential readback |
| `storage` | Scoped metering snapshot/quota/time | no bucket enumeration or directory scan |
| `diagnostics` | Authorized scoped connection snapshot | no global native-console credentials |
| `services` | Applicable lifecycle/version status | no implicit restart/update |

Add Gateway `GET /organization/settings-view?section=<section>` for `members`, `workspaces`, `policies`, `usage`, `sessions`, `audit` and `webhooks`. Each branch queries only the authorized projection in `organizations/postgres-store.ts`; do not call the twelve-query `administrationSnapshot()` first. Reuse existing scoped service-account API instead of mixing Tokens into the snapshot.

List projections use a bounded limit, default 50 and maximum 100, with opaque keyset cursors scoped to organization and section. Audit order is `(occurred_at DESC, id DESC)`, organization sessions `(last_seen_at DESC, id DESC)`, workspace list `(name ASC, id ASC)`. If a legacy service-account endpoint is unpaged, the new UI must not silently truncate it; add compatible optional paging before claiming large-list acceptance.

Personal preferences do not wait for Runtime settings. Each active task loads once, with manual refresh. Mutations invalidate only affected resources and their summaries. Reconnect refreshes affected active views once; focus and ordinary chat messages do not repeatedly refetch all settings.

## 8. Backend mapping and field validation

The following existing endpoints remain the mutation authority. Paths marked **new** are target additions, not available commands/APIs.

| Task | Existing API / required change | Authoritative store and consumer |
|---|---|---|
| Models/Providers | `/settings/providers` POST/PATCH/DELETE; `/settings/models` POST/PATCH/DELETE; `/settings/default-model` POST | `DedicatedModelSettings` transaction + Runtime model router; extend tenant composition explicitly for Private Cloud |
| Agent prompts | `/settings/agent-prompt` POST | `public.tenant_agent_prompt_settings`, existing ordered Session refresh |
| Execution policy | `/settings/desktop-access` POST | same Agent row; preserve all other fields |
| Search | `/settings/web-search` GET/PUT/DELETE; `/test` POST | existing organization-bound credential store and search consumer |
| Speech | `/settings/speech` GET/PUT/DELETE; `/test` POST | existing Speech credential store and token/transcription consumers |
| Workspace MCP | `/settings/mcp` GET/PUT retained; **new PATCH** | Executor private config and active MCP manager |
| Enrollment | existing `/auth/executor-invites` create/list/PATCH/revoke/DELETE/regenerate | existing enrollment and device-credential stores |
| Attachment / retention | `/organization/attachment-policy` GET/PUT retained; new `/organization/attachment-policy/configuration` GET and `/organization/retention` GET; existing retention PUT | control-plane organization/retention rows and actual enforcement/maintenance consumer |
| Team / ownership | existing `/organization/invites`, `/organization/members`, `/organization/ownership` | membership/invite transactions and authorization/session revocation |
| Service accounts | `/api/v1/service-accounts` GET/POST; item DELETE | `ServiceAccountService`, hashed Token and live authentication |
| Own login sessions | existing `/auth/sessions`, item DELETE, `/auth/logout-all` | existing browser session service |
| Webhooks | **new** `/organization/webhooks` GET/POST and item PATCH | controlled endpoint store + opt-in outbox worker |
| SILO | existing `/auth/silo/authorize`, `/silo/` guarded proxy | live Dedicated Owner session + native SILO identity |

### 8.1 Existing validators are normative

Reuse shared Zod/request parsers; do not implement a weaker frontend-only copy. [S29]

- Provider IDs/model IDs are stable create-time identifiers. Editing a label is not renaming an ID. Provider update uses `providerId`; model update identifies both `providerId` and `id`.
- Provider wire is `openai | anthropic`. The Runtime compiler rejects Base URLs with non-HTTP(S) protocols, embedded credentials, query or fragment. Do not silently add an HTTPS-only restriction that removes existing trusted local Provider support.
- Model `contextWindow` is optional, positive integer when supplied. Omitted values retain the current adapter semantics.
- Prompt slots are exactly `slot-1`, `slot-2`, `slot-3`; names are trimmed 1-80 characters; prompt is nonblank and at most 100,000 characters; selected slot must exist.
- Desktop update accepts the current strict three-field schema. Omitted optional fields preserve existing values; changing desktop policy cannot reset prompt slots.
- Serper key is trimmed, 8-512 characters. Explicit test uses the real existing test endpoint and may incur an external request; it is not periodic health polling.
- Speech uses the existing Azure Endpoint normalizer, trimmed 16-512-character key, `realtime | after_recording`, and integer minutes from 1 through `MAX_SPEECH_MAX_MINUTES`. Reuse the exported limit rather than another numeric constant.
- Existing configured Provider/Speech keys are preserved when unchanged. Normalize an empty edit field into omission. Creating an unconfigured resource without its required key must fail.
- Service account name is trimmed 1-200 characters. Scopes are a nonempty selection from `organization:read`, `organization:write`, `workspace:read`, `workspace:write`, `audit:read`. Default expiry is the service's configured default, currently 90 days; maximum currently 365 days. UI obtains or shares the server limits instead of hardcoding them. Item identity is the returned principal ID, not an internal Token-row ID. [S30]
- Organization invitations retain existing 1-30 day validity and default seven days; no claim of automatic email delivery.
- Attachment policy uses existing allowed byte sizes, not arbitrary MiB strings.

Secrets are never present in ordinary GET responses, error details, audit metadata or URLs. The exception is the deliberately issued one-time create/regenerate response for a credential/invitation, consumed only by its existing authorized workflow.

## 9. Save, concurrency and application protocol

### 9.1 Version authority

Add configuration versioning to the store that owns each configuration, not to browser storage. For hosted resources, add `settings_resource_versions` in each owning database through an explicit versioned migration:

```text
organization_id text
resource_kind text
resource_id text
revision bigint CHECK revision > 0
updated_at timestamptz
PRIMARY KEY (organization_id, resource_kind, resource_id)
```

This table contains no configuration values or secrets. Runtime resources use the Runtime PG database; Gateway policy resources use the control-plane database. Never pretend a transaction across those databases is atomic.

Resource groups: `models/catalog`, `agent/runtime` (shared prompt and desktop fields), `search/serper`, `speech/azure`, `policy/attachment`, `policy/retention`. Parent organization is derived from trusted authority. Initialize existing records at revision 1 under the same lock used by their real store. Keep the version row when a secret/configuration is deleted so deletion/recreation cannot reset the version.

Configuration data changes and revision increments must commit in the same database transaction. Credential store methods must accept the same transaction instead of doing an independent nested commit. Retention's existing version remains authoritative; its adapter maps it rather than maintaining an independently drifting second counter.

Portable keeps its actual existing authorities; it does not migrate credentials to JSON or require PG:

| Portable resource | Authority | Version/change transaction |
|---|---|---|
| Search/Speech credentials | Existing encrypted `KalaStateStore` SQLite | Add `settings_resource_versions` in that same SQLite database; `BEGIN IMMEDIATE` covers ciphertext, metadata and revision; retain version tombstones on deletion |
| Manual Provider/model configuration | Existing model JSON file | Top-level `_kalaSettings: { formatVersion: 1, revision: "<decimal>", contentHmac: "<opaque>" }`, replaced atomically with the complete configuration |
| Agent prompt/desktop configuration | Existing Agent settings JSON file | Same root metadata; shared revision for prompt and desktop fields |
| Device preferences | Existing browser keys | No fake server revision or PG dependency |

All supported JSON writers, including compatibility writers in `runtime-config.ts`, preserve and increment `_kalaSettings`. They serialize through the same local `KalaStateStore` SQLite `BEGIN IMMEDIATE` maintenance lock while reading, validating and atomically replacing the JSON file. SQLite is the lock authority here, not a second independently editable copy of JSON configuration. Candidate preparation that can be slow occurs before the lock, followed by locked reread/validation. Existing files without metadata initialize at revision 1 under this lock.

Store a SQLite high-water mark to distinguish first migration from removed metadata. Allocate `max(valid file revision, stored high-water mark) + 1`; atomically replace/fsync the JSON before committing the high-water mark. After a crash between rename and SQLite commit, validate the file/HMAC and advance the high-water mark to its revision under lock. Missing metadata after a known migration is a visible error, never a reset to 1. `contentHmac` covers canonical content excluding `_kalaSettings`, using protected local key material; it is not exposed as a raw secret-derived digest.

Manual JSON/managed-config edits require stopping the owning process. Arbitrary editors that ignore locks cannot receive a promised filesystem compare-and-swap guarantee. Add a focused target maintenance entry `packages/host/bin/kala-settings-file.ts import --resource models|agent --input <protected-file>`: it loads the existing installation's authority/key, validates the supplied content with existing parsers, and uses the same locked updater to allocate metadata. It is not a general arbitrary-path writer. Startup validates metadata and HMAC; an unmanaged edit fails with `settings_external_edit_requires_import`, not an unchanged revision over changed content. Missing/corrupt migrated metadata requires explicit recovery with the installation's preserved version information, not guessed success. Downgrades below metadata-preserving compatibility writers are not supported after versioned writes are enabled.

### 9.2 Wire protocol and backward compatibility

New projected reads return a typed envelope:

```ts
type ConfigurationRead<T> = {
  resource: { kind: string; id: string; organizationId?: string }
  revision: string                 // decimal integer; not a JS bigint serialized as number
  capabilities: SettingsCapability[]
  value: T                        // sanitized, section-specific DTO
  application: {
    state: 'applied' | 'pending' | 'failed' | 'unknown'
    desiredRevision: string
    effectiveRevision: string | null
    applyMode: 'immediate' | 'next-turn' | 'next-session' | 'executor-ack' | 'restart'
    scope: 'device' | 'unit' | 'workspace' | 'organization' | 'deployment'
    reasonCode?: string
  }
}
```

Return an opaque strong `ETag` bound to the complete resource revision. New-client mutations send `If-Match` from that read. Do not insert protocol fields into strict existing JSON bodies. A mismatched revision returns 412 `configuration_conflict` without writing. Missing preconditions on new-only operations return 428 `precondition_required`.

Legacy endpoints remain compatible with old bodies and response shapes during a named **legacy-write window**. An old-client mutation still takes the same resource lock and increments the authoritative version, but is explicitly last-writer-wins: it can overwrite a committed conditional writer. Do not claim universal stale-write protection during that window.

The backend deployment setting `settingsWriteProtocol` has exactly `legacy-compatible | conditional-required`. Start the schema-compatible rollout in `legacy-compatible`. After new UI and all serving configuration writers support preconditions, use `conditional-required` for shared configuration mutations. Then a legacy mutation without `If-Match` receives 428 `client_upgrade_required`; old clients retain reads and receive an explicit upgrade message, never false save success. Keep old JSON bodies/response DTOs for conditional callers. The post-migration rollback build must implement this same setting. C06's full stale-write guarantee closes only in `conditional-required`; the named compatibility window is not completion.

One form save is one resource transaction. There is no global Save all across models, policy, account and external systems. Agent prompt and execution policy share a version because they share the stored object; conditional stale edits conflict instead of overwriting one another.

### 9.3 Form and failure state machine

```text
loading -> clean -> dirty -> validating -> saving
saving -> clean/applied
saving -> saved-pending -> applied | application-failed
saving -> conflict | rejected | outcome-unknown
```

Rules:

1. Validate locally, then reauthorize/validate/compare version on the server.
2. Keep draft and field errors on 400/409/412/422. Conflict offers Reload server version or copy/reconcile changes; never automatic overwrite.
3. Before commit failure is Rejected. After commit propagation failure is Saved pending/failed, not unsaved.
4. Preserve current `503 { settingsSaved: true }` compatibility for Agent/desktop updates; normalize it to saved-pending in the new UI.
5. A network timeout after submitting is Outcome unknown. Reread resource revision and effective sanitized values; do not automatically replay create/delete/rotate/test. If a changed secret cannot be proven from status, show uncertainty and allow an explicit replacement, not a success claim.
6. Preserve one-time service-account/invitation results in memory until the user dismisses them. If a create response was lost, list records and explain that its secret cannot be recovered; explicitly revoke/recreate if required. Do not implement plaintext Token recovery to make retries convenient.
7. Canceling a fetch or navigating away does not prove a mutation was canceled. Reentry rereads the authority.
8. Disable duplicate in-flight submission for the same form, not the entire Settings application.

### 9.4 Application timing

| Resource | Required meaning of applied |
|---|---|
| Device preference | Browser persistence succeeded and current rendering/behavior uses it; storage failure is visible |
| Models | Correct immutable router snapshot published; in-flight calls retain their snapshot; subsequent calls use the intended revision |
| Default model | Used for subsequent default resolution; existing explicit Session selections remain unchanged |
| Agent settings | Existing ordered Session refresh reaches the documented safe boundary; do not mutate a half-completed tool/LLM operation |
| MCP | Candidate initialized, safely persisted, active catalog switched, and revision ACK received |
| Retention | Policy is available to the separately enabled maintenance consumer; not proof of immediate deletion |
| Hooks / infrastructure files | Correct process has loaded the version after controlled maintenance; not merely file existence |

Application scope must be truthful. Extend observations with `{ unitId, replicaId, observedAt, synchronization: 'disconnected' | 'synchronizing' | 'ready' }`; the published consumer snapshot carries its actual configuration revision. A Unit ACK is not organization-wide convergence.

Extend `postgres-notifications.ts` with explicit subscription lifecycle notifications. On known disconnect immediately transition consumers to disconnected and block ambiguous new model calls. Subscribe first, load configuration and revision atomically under the resource lock, then publish ready; reconnection remains synchronizing until that reread completes. Merely retrying LISTEN internally is insufficient. Preserve already-started immutable calls.

Agent refresh records each affected loaded Session's target revision and the completion of its existing ordered refresh. Busy Sessions remain pending until their next safe turn boundary; an unobserved/unloaded Session is not an invented ACK. Organization-wide applied requires a serving-membership observation plus matching acknowledgements from that set; otherwise report the identified local scope or unknown.

A release must test a second serving replica, an actual notification-connection interruption, reconnect and reconstruction. A simulated reload exception alone is not R10 evidence.

Do not introduce a new Session lease duration or change ownership/liveness behavior as part of Settings state reporting.

## 10. Model-management modes and migration

### 10.1 Dedicated

Keep the current encrypted credential ID `dedicated-model-settings:v1`, tenant key/AAD, existing catalog and secrets, transaction lock, notification channel and in-flight immutable snapshots. Do not rename or reseed the existing object. Adding a revision must not replace its ciphertext with an empty seed.

Provider/model deletion remains protected against default and persisted Session references. Provider/model IDs are immutable in the editor. Changing the default does not migrate existing Sessions. Do not substitute another model on deletion failure.

### 10.2 Private Cloud

Add explicit per-organization model-management policy in the control plane:

```text
organization_model_management:
  organization_id PRIMARY KEY
  desired_management: operator | dashboard
  effective_management: operator | dashboard
  desired_revision
  effective_revision
  state: active | preparing | awaiting_runtime | failed
  operation_id
  updated_at
```

Existing installations without a row retain `operator`; migration must not enable new tenant write rights. Dedicated's effective Dashboard management is preserved rather than downgraded by this default.

Dashboard-managed Private Cloud models require tenant-owned Runtime storage and routing. Reuse the validated catalog/adapter behavior behind an organization-scoped service; do not simply remove `product === 'dedicated'`, because the Dedicated initializer resolves and copies seed credentials.

For Private Cloud use a distinct organization-bound object `organization-model-settings:v1`. Enabling Dashboard management initializes an explicitly unconfigured tenant catalog; it must not copy shared deployment keys. Extend the new organization service to support Providers without an active default until the organization explicitly adds a Model and selects its default. This is a real unconfigured state: return no available default, disable dependent new calls with `model_not_configured`, and never fall back to a shared global key/model.

Runtime composition and the new section DTO must represent this nullable default explicitly; do not cast it into an existing nonempty-model schema. Existing Dedicated catalog behavior remains compatible.

Operator policy change uses the following **maintenance-only durable transition**, not an allegedly atomic cross-database write:

1. Plan binds the current effective policy revision, catalog dependencies and affected Unit/serving-replica membership. Apply commits desired mode/revision and operation ID to control PG with `state=preparing`; effective mode does not change.
2. Fence new configuration requests and new model calls for the transitioning organization. Every new hosted model call/configuration mutation checks the trusted policy state/revision; old ready caches cannot authorize a transition. A policy-read failure is explicit unavailability, not fallback to a global model.
3. Use the existing controlled maintenance/drain/checkpoint path to stop all affected serving replicas. Do not hard-kill active work to satisfy the plan. If safe quiescence cannot be verified, leave pending and do not activate. Unrelated organizations remain available.
4. The protected Runtime control API adds `POST /internal/settings/model-management/reconcile`, authenticated by the existing internal service credential and installation boundary, never browser identity. Exact body: `{ operationId, organizationId, unitId, expectedEffectivePolicyRevision, desiredPolicyRevision, management }`. Verify organization/Unit placement and pending operation. A rejected or unknown operation cannot provision keys.
5. Reconcile Runtime PG idempotently using `settings_model_policy_transitions(operation_id PRIMARY KEY, organization_id, policy_revision, management, catalog_revision, completed_at)`, in the same Runtime transaction as initialization/policy-fence metadata. Duplicate operation/revision returns its recorded result; conflicting reuse fails. No shared-key seed is copied.
6. Only after durable reconciliation may control PG advance effective mode/revision and enter `awaiting_runtime`. Start replicas with the trusted effective revision, then collect `{ operationId, organizationId, unitId, replicaId, policyRevision, management, catalogRevision, observedAt }`. They cannot serve until their policy/catalog snapshot matches. Mark active only after the required serving scope is ready; new replicas perform this same handshake.
7. Process/CLI failure resumes the persisted operation, not a new policy revision. A reconcile result without a control-plane commit is retried using the same operation ID. A failed startup stays awaiting_runtime/failed and fenced; it is not completed activation.
8. Reverting is another planned maintenance transition and new revision, not an update to an old effective counter. Retain the tenant catalog encrypted for re-enabling; do not delete it or route its referenced Sessions to another Provider. Reject incompatible Session/default references until explicitly resolved.

Add a typed policy reader/reconciler to Runtime composition/control API; this is new work, not an existing Unit command. The reader's control-PG authority is read-only and organization-bound in the service API. Mode transitions are not triggered by merely entering Settings. Enabling is rejected unless storage, CRUD, policy fencing, maintenance and reconciliation are installed.

Operator-managed catalog remains readable by authorized users and has a concrete protected catalog/credential-reference maintenance location. Catalog source and `canWrite` agree in UI, API and Runtime.

## 11. MCP protocol hardening

The current full-list PUT remains explicitly a legacy replacement operation. New UI must use **new PATCH `/settings/mcp`**, not reconstruct blank commands from the names-only GET.

### 11.1 Request and status

GET adds `revision`, `editProtocol: 'patch-v1'`, server-issued `requestId` and `editToken` only when the selected Executor supports it. Entries remain `{ name }`; commands/args can contain secrets and are never echoed.

```json
{
  "workspaceId": "example-workspace",
  "requestId": "executor-issued-uuid",
  "editToken": "opaque-authenticated-edit-ticket",
  "expectedRevision": "opaque-executor-revision",
  "operations": [
    { "op": "replace", "name": "search", "command": "/trusted/bin/server", "args": ["--mode", "local"] },
    { "op": "delete", "name": "old_server" }
  ]
}
```

Names omitted from `operations` are preserved exactly. `replace` creates a missing name or replaces that one complete command/args entry; `delete` requires the existing name. Reject duplicate names/operations, an empty operation list, unknown fields and a stale revision. Renaming is an explicit delete plus replace in the same transaction, confirmed as such.

Reuse current limits: request 64 KiB, at most 16 final servers, 64 args/server, 8 KiB/string, server name `^[A-Za-z][A-Za-z0-9_-]{0,31}$`, and existing null/newline constraints. Validate the final merged list, not just each patch operation.

### 11.2 Wire, persistence and concurrency

Add a declared shared Executor capability `mcpConfigProtocol: 'patch-v1'`, new `executor:mcp_patch` request/ACK types, and explicit status revision. Update the emitted announcement schema/round-trip tests; undeclared Zod fields are stripped. Do not infer support from Executor version strings.

The Executor applies under its existing serialized MCP configuration queue and one supported-writer interprocess lock:

1. Read the managed configuration using the existing ownership/private-file checks.
2. Read a monotonic revision from versioned top-level metadata, not a content hash that repeats after A-to-B-to-A. Verify the signed edit ticket, and check its durable receipt before comparing the current revision.
3. Compare expected revision and merge locally; Host does not retrieve commands.
4. Initialize the candidate with the existing 30-second deadline.
5. Pass the original full-file snapshot into the safe update helper, compare that snapshot under the supported-writer lock, preserve unrelated keys, and atomically rename the merged file. Arbitrary manual editors must stop the Executor first; do not promise atomic exclusion of editors ignoring locks.
6. Persist using the existing safe file helper, switch manager/catalog, retire the old manager when idle, then ACK the new revision.

Persist metadata outside strict per-server objects:

```text
_kalaManagedMcp:
  formatVersion: 1
  revision: decimal-string
  receipts: [{ requestId, ticketExpiresAt, requestHmac, resultRevision, committedAt }]
```

Create a separate owner-only, no-symlink `.mcp-config-integrity.key` in the protected managed-config directory, using exclusive creation, cryptographic randomness and durable file/directory sync before first metadata commit. Preserve it across restart/backup; metadata with a missing key fails closed rather than silently regenerating a new identity. No key/command-derived raw digest is returned to the browser.

`editToken` authenticates `{ requestId, workspaceId, installationId, issuedAt, expiresAt }` with that key. It expires after 24 hours; future/expired/foreign tickets are rejected before execution. Store every successful unexpired ticket receipt, up to 512; reject a new mutation with `deduplication_capacity_exceeded` when full rather than evict a still-valid receipt. Expired tickets cannot be made fresh without the key. Prune expired receipts during a locked update.

Repeating a valid ID and matching keyed request digest returns `{ duplicate: true, requestResultRevision, currentRevision }` without rerunning initialization. Different content with the same ticket/ID is rejected. A-to-B-to-delayed-A across restart is mandatory acceptance. Receipt metadata and revision commit in the same atomic replacement as configuration, and contain no plaintext command/request.

Legacy full PUT through the upgraded Executor also increments the monotonic revision and preserves all unexpired receipts. Old Executors without versioned metadata retain their explicit legacy mode; do not let an older non-preserving binary rewrite a migrated managed file. Such an Executor downgrade requires a separately reviewed compatibility/import procedure, not deletion of metadata.

An offline Executor returns an explicit unavailable result. Timeout after dispatch is outcome-unknown until revision/status is reread. Old Executors retain the legacy explicit full-replacement workflow; show a compatibility warning and confirmation, not a broken patch editor. Do not claim all-or-nothing rollback after a post-persistence process crash; startup reload reconciles disk authority and reports the resulting revision.

Existing Session tool selections, order, MCP descriptors and delegated tool locks remain unchanged until an authorized explicit tool upgrade. [S19]

## 12. Hooks and infrastructure configuration

### 12.1 Hooks

Hooks load from `<unitRoot>/config.toml`; Dedicated may use `KALA_RUNTIME_HOOKS_CONFIG`. Private Cloud must provision each Unit rather than use that shared override. Missing default file may mean no Hooks; missing/invalid explicitly configured file must fail visibly. [S09]

Supported events are `pre_tool_use`, `post_tool_use`, `session_start`, `session_end`. `session_end` follows current Session-deletion semantics, not every model turn. Preserve existing blocking/nonblocking HookRunner behavior.

The page shows loaded count/events, sanitized source, load timestamp/version and restart requirement. It must not show a Web Save command button. Authorized maintainer instructions identify the actual mounted file/configuration authority, schema validation, trusted image dependencies, safe reconstruction and execution verification.

Private Cloud Unit replacement must regenerate the same authorized configuration. A temporary file on one node is not a durable authority. Do not install an unreviewed shell/package at runtime to make a Hook execute.

The implemented controlled provisioning input is `KALA_RUNTIME_HOOKS_MANIFEST`, an absolute path to a mounted owner-only regular JSON file. It is mutually exclusive with Dedicated's `KALA_RUNTIME_HOOKS_CONFIG`. Its exact schema is:

```json
{
  "schemaVersion": 1,
  "revision": "7",
  "units": [
    {
      "unitId": "unit-a",
      "organizationId": "organization-a",
      "configFile": "/run/kala-unit-hooks/organization-a.toml",
      "contentSha256": "<64 lowercase hexadecimal SHA-256 characters>"
    }
  ]
}
```

Each source is an absolute, owner-only regular TOML file containing the approved complete configuration. Preserve the manifest/source set in protected installation mounts, not the disposable Unit root. During controlled Unit reconstruction the Runtime verifies exact fields, unique Unit bindings, trusted organization placement, source ownership/permissions and the declared digest, validates every Hook block, then atomically writes/fsyncs that Unit's fixed `<unitRoot>/config.toml` before opening online storage/consumers. A missing Unit entry explicitly provisions **no Hooks** and clears a former disposable copy; it does not inherit another organization's configuration or silently retain an old local file. A mismatch fails visibly without replacing the prior installed copy. Source changes require a newly reviewed manifest revision/digest and controlled drain/reconstruction; an operator-declared source revision is not a claim that arbitrary external editors are serialized by PG.

`hooksSummary` reports the actual process load timestamp, the mounted manifest's source revision where available, event names and restart application mode. It exposes neither commands, digest nor local source paths. An unmanaged legacy file is explicitly unversioned, not invented version/convergence evidence. The mounted input can be recreated on a replacement node; merely setting the variable without the persistent protected mounts does not close deployment acceptance. Commands must already be supported by the trusted image; Node-based lifecycle acceptance uses the existing runtime binary, without downloading dependencies.

### 12.2 What belongs to infrastructure, not ordinary instance forms

| Infrastructure object | Maintenance channel |
|---|---|
| OIDC issuer/client/discovery, public Origin, CA/TLS, initial Owner binding | existing installation and protected deployment inputs |
| PG/S3 endpoints/credentials/buckets, SecretResolver, internal authentication | protected deployment configuration and secret references |
| Replica count, placement, CPU/memory, proxy routes, telemetry export | installation-specific orchestration/configuration |
| Images/assets/migrations/upgrade/rollback/supported backup-restore | reviewed installation lifecycle procedure |
| Console enabling/routing/entrance addresses | trusted deployment source; not arbitrary organization URLs |
| Hook commands/mounts/dependencies | controlled Unit file and trusted build inputs |

Models, prompts, Computer Use toggles, workspace MCP, Serper/Speech keys, Executor installation options, attachment limits and Session retention are not removed from their ordinary authorized forms merely because they touch a backend.

## 13. Operator resource operations and Webhooks

### 13.1 Typed Operator command contract

The focused CLI entry point is `packages/runtime-ingress-gateway/src/bin/control-plane-settings.ts`, packaged with the existing trusted build, not a third-party administration product. The following is the required command interface; §25 distinguishes implemented operations from still-open consumer/maintenance gates:

```text
kala-control-plane-settings inspect --profile <protected-file> --organization <id> --resource <kind/id>
kala-control-plane-settings plan --profile <protected-file> --input <change.json> --out <plan.json>
kala-control-plane-settings apply --profile <protected-file> --plan <plan.json>
kala-control-plane-settings verify --profile <protected-file> --operation <id>
kala-control-plane-settings revert --profile <protected-file> --operation <id> --expected-revision <revision>
```

The protected profile binds installation identity, exact database authority, secret references and authorized resource kinds. Reject group/world-readable secret files; never put connection secrets on argv/stdout. A plan for installation A cannot run against B.

Frozen command data contracts:

```text
Profile:
  schemaVersion: 1
  installationIdFile: absolute protected path
  controlPlaneDatabaseUrlRef: protected resolver reference
  runtimeControlOrigin: reviewed private HTTP(S) Origin
  internalCredentialRef: protected resolver reference
  planSigningKeyRef: protected signing/MAC key reference
  allowedOrganizations: nonempty array of exact IDs
  allowedResourceKinds: array of the five enumerated resource kinds

Change:
  schemaVersion: 1
  operationId: UUID
  organizationId: exact ID
  resource: { kind, id }
  expectedRevision: decimal-string
  patch: resource-specific exact object

Plan:
  schemaVersion: 1
  operationId, installationFingerprint, organizationId, resource, expectedRevision
  patch, dependencies: [{ kind, id, revision, state }]
  effects: enumerated resource-specific effects
  reversible: boolean
  createdAt, expiresAt: ISO timestamps, maximum lifetime 15 minutes
  changeDigest: SHA-256 of canonical validated change
  signature: authenticated complete canonical plan using protected planSigningKeyRef
```

Reject unknown fields, wrong installation, expired/altered plan, unsupported resource, changed dependency, reused operation ID with another digest, and profile authorization mismatch. Recompute the validated change digest and signature before Apply; a path to a plan is not authorization.

Add Operator-only `settings_operator_operations(id UUID PRIMARY KEY, installation_fingerprint, organization_id, resource_kind, resource_id, plan_digest, expected_revision, resulting_revision, state, before_value, after_value, effects, created_at, updated_at, error_code)`. States are `applying`, `awaiting_runtime`, `applied`, `verified`, `failed`, `reverting`, `reverted`. Before/after values never contain plaintext secrets. Stable operation ID makes Apply/resume idempotent. Inspect/Plan do not mutate a business resource. Apply/Verify responses are `{ operationId, state, resource, revision, persisted, consumerVerification: 'verified' | 'pending' | 'not-applicable' | 'failed', reasonCode? }`.

CLI exits: 0 means the requested command completed with its declared semantics; 2 validation/profile/plan error; 3 revision/dependency conflict; 4 pending consumer/maintenance prerequisite; 5 application/unavailable failure. Apply may return persisted=true with exit 4; scripts must not treat it as verified. Revert requires the resource still at the operation's resulting revision, all inverse dependencies valid, and no irreversible effect; it creates a linked new operation/revision.

Operations are strict resource-specific schemas, not arbitrary table/column/SQL/file writes. Apply writes the resource, revision, audit and operation record in one owning-database transaction. Verify reports separately `persisted`, `consumerVerified`, `sideEffects`; a row update alone is not effective configuration. Revert creates a new revision and is refused for irreversible effects or unresolved references.

| Resource | Supported target changes | Mandatory verification |
|---|---|---|
| `model-management/<organizationId>` | Operator/Dashboard policy | tenant store/router readiness, no shared-secret copy, reference plan |
| `workspace/<workspaceId>` | Existing registry name/status and supported association | same organization/stable ID; active references and restore/archive effects checked |
| `pool/<poolId>` | Name, organization/workspace mode and valid workspace binding | same organization; reject binding changes incompatible with enrolled/live Executors |
| `entitlement/<organizationId>` | Existing contract term/tier and separately supported limits | existing SQL constraints and actual consuming admission path |
| `webhook-secret-binding/<bindingId>` | Organization-scoped label and protected resolver reference | worker-compatible namespace, resolver authorization; no secret plaintext output |

Exact patch schemas and effects:

| Kind | Allowed fields; omission/null | Required checks / revert |
|---|---|---|
| `model-management` | `management: 'operator' | 'dashboard'` only | Section 10 maintenance transition; no destructive catalog cleanup; revert is another transition |
| `workspace` | Optional `name` (trimmed 1-200), `status: 'active' | 'archived'`; no nulls, at least one field | Archival requires no live Executor/active Session reference; reject rather than silently disconnect/delete. Reactivation runs the workspace admission/quota check. Name uniqueness is organization-scoped. No organization/Unit reassignment |
| `pool` | Optional `name`, and an atomic pair `mode: 'organization' | 'workspace'`, `workspaceId: null | same-org-ID`; omitted pair preserves | Match existing mode/workspace constraint. Mode/binding changes require no enrolled Executor or pending enrollment-token references; reject otherwise. No cross-org move |
| `entitlement` | Optional `contractReference`, `supportTier: 'standard' | 'business' | 'enterprise'`, `startsAt`, `endsAt`, `graceEndsAt: ISO | null`, `seatLimit`, `concurrentSessionLimit`, `workspaceLimit`, `monthlyTokenLimit: decimal-string | null`, `storageBytesLimit: decimal-string | null`; omitted preserves | Terms obey existing ordering/uniqueness. Seat/concurrency/workspace positive safe integers; Token/bytes nonnegative arbitrary-precision decimals, null means unlimited. Reject lowering an enforced cap below current protected use without an explicit separately reviewed policy. Never delete existing data or kill Sessions. Report per-field enforcement, not a universal enforced claim |
| `webhook-secret-binding` | On create: `label` (trimmed 1-200), `secretRef` (strict worker-compatible reference); later only `label` | Reference immutable after creation. New reference requires new ID and endpoint rebind. Referenced bindings cannot be deleted/replaced; no automatic mass re-signing |

Existing contractual metadata whose enforcement is unproven remains `reported-only`; changing such a field is explicitly a metadata operation with consumerVerification=not-applicable, not a working admission-cap change. `enforcement` is computed by the installed consumer adapter and evidence, never accepted from the command input. An implementer may not arbitrarily enable a new quota policy to make a field look effective.

### 13.1.1 Database authority and grants

Versioned migrations and `init-control-plane.ts` must update the grant policy together; its broad ALL TABLES grant is not sufficient. Revoke inherited/PUBLIC and direct mutation authority where necessary and verify effective privileges before enabling these features:

| Database actor | Model policy | Secret bindings | Operator operations | Business endpoint/settings tables |
|---|---|---|---|---|
| Gateway browser-serving login | SELECT only | SELECT only, no browser reference readback | no writes; no ordinary browser read | only existing/required business DML |
| Dedicated/Private Cloud Settings Operator login | enumerated policy DML | enumerated binding DML | operation/audit DML | only approved resource fields, no unrelated ledger/identity mutation |
| Runtime policy service | trusted policy read via protected contract | none | only scoped reconcile acknowledgement via contract | Runtime-owned catalog/revisions and transition receipts only |
| Migration owner | schema ownership/DDL during maintenance | same | same | never reused as browser/Operator runtime login |

New Operator-owned tables must join the initializer's explicit exclusions. Runtime reconciliation never accepts a browser Cookie as maintenance authority. Tests use actual roles and effective privileges, not only inspection of GRANT text.

Do not implement generic organization deletion, identity rebinding, workspace file deletion or database repair through this CLI.

Contract fields must report `enforcement: enforced | reported-only | unknown`. Existing records and helper classes alone do not prove Runtime admission enforcement. A limit without an integrated consumer remains visibly reported-only and cannot be advertised as an operational cap. To make it configurable as a cap, wire and test that consumer before closing C05; do not quietly change an existing production limit's semantics during navigation migration.

### 13.2 Webhook business configuration

The worker is opt-in Private Cloud and requires a configured external resolver, allowed origins, installation identity, schema and worker privileges. Dedicated Webhook delivery is unsupported by this release; do not start a new worker there as an incidental Settings change. [S31][S32]

For enabled Private Cloud organizations, Owner/Admin configure endpoint URL, topics, enabled and an authorized signing-key binding. Operators configure allowed origins, worker deployment and secret bindings. Thus business URL/topic editing is not artificially moved into host operations.

Add `organization_webhook_secret_bindings(id, organization_id, label, secret_ref, revision, updated_at)` and nullable `webhook_endpoints.secret_binding_id` with an organization-constrained binding reference in a control-plane migration. The browser receives IDs/labels/configured status only. It submits `secretBindingId`, not a Bao path or secret. Resolve bindings server-side for that organization; the reference must satisfy the existing worker namespace `bao:organizations/<organizationId>/webhooks/`.

Bindings are immutable-reference snapshots, not live indirection. Endpoint create/rebind copies the binding's strict reference into the existing worker-compatible `secret_ref` and stores its binding ID in the same transaction. URL/enabled/reference changes preserve the existing generation trigger. A binding reference cannot be changed in place; rotation to another reference creates a new binding and explicit endpoint PATCH, advancing revision and generation.

Backfill an existing endpoint only when its current raw reference satisfies the organization namespace; deduplicate bindings only within that organization and keep the original reference/generation unchanged. Invalid legacy references remain disabled/blocked for explicit Operator repair, never substituted. Rotating secret material at an unchanged resolver path is external secret rotation, not automatic endpoint-generation invalidation; strict cancellation of old deliveries requires an explicit disable/rebind transition and separate material-version reference.

Target APIs:

| API | Contract |
|---|---|
| GET `/organization/webhooks` | sanitized, paged endpoints, delivery-state summary, capabilities/revision; no signing secret |
| GET `/organization/webhook-secret-bindings` | authorized binding IDs/labels only |
| POST `/organization/webhooks` | exact fields `url`, nonempty `topics`, `enabled`, `secretBindingId`; generated stable endpoint ID |
| PATCH `/organization/webhooks/<id>` | explicitly changed subset of those fields, conditional revision; no cross-organization IDs |

Topics come from the registered outbox event producers; reject unknown topics and do not accept arbitrary new event names. Validate destination using the worker's existing URL/origin policy; no credentials, arbitrary redirect destinations or browser-supplied resolver paths. Enabling requires installed worker support; otherwise return `webhook_delivery_unavailable`, not success-shaped delivery status.

Create/enable/topic changes serialize per organization in the control-plane transaction and enforce at most **100 enabled endpoints total**. This deliberately conservative cap cannot exceed the worker's 100-recipient per-topic ceiling. A violating change returns 409 `webhook_endpoint_limit_exceeded`; two concurrent creates cannot both pass. Pre-existing over-limit organizations display a blocked diagnostic and permit disable/remediation, not new enables or arbitrary automatic endpoint deletion.

Retain the existing `delivery_generation` invalidation for URL/secret/enabled changes. Disable is the removal action for this release: preserve historical deliveries, do not add physical deletion or automatic replay. Worker changes are at-least-once delivery; do not promise exactly once. Configuration save does not send a test business event.

## 14. Object storage console entry and login

### 14.1 Fixed user experience

`#/settings/deployment/storage` is a compact launch and login-information page. It must not embed another complete application's navigation or login form inside Settings. The user explicitly rejected the earlier embedded design.

```text
Object storage
Sign in with the storage administrator account.       Open console ↗

Administrator login                            Show login details
These credentials grant access to all object data in this instance.

Username and password appear with individual copy actions only after
the bound Dedicated Owner explicitly requests them.
```

It is not the organization storage-usage page. Keep concise login guidance and the instance-wide credential warning visible; additional scope explanation belongs in the existing HelpHint. Use structured labeled fields, wrapping actions and mobile-sized controls. Do not add a Console preflight/loading lifecycle, empty iframe, tiny technical disclosures or nested navigation.

Dedicated Owner plus `deploymentServices.siloConsolePath === '/silo/'` is the minimum entrance requirement. The fixed `/auth/silo/open` link opens a separate window with `noopener noreferrer`. Private Cloud users get no global storage console or credential access. If disabled, display a concise unavailable state. Mounting or resizing Settings must not fetch the native application or credentials.

The native console remains a trusted application in the same Origin, with its own administrator authentication and normal object-management UI. Kala neither recreates its forms nor automatically submits the displayed credentials.

### 14.2 Routing and authentication contract

The public ingress handles `/silo` and `/silo/*` **before** Gateway/Dashboard fallback:

1. Canonicalize `/silo` to `/silo/` without changing the configured public scheme/Origin.
2. Authorize every Console document, asset, API request and WebSocket upgrade via the live Dedicated Owner check. The authorization subrequest must be an ordinary HTTP request, even when the native request is a WebSocket upgrade: inside `forward_auth`, remove its `Connection` and `Upgrade` headers with `header_up -Connection` and `header_up -Upgrade`. Do not remove the original native request's upgrade headers. The authorization subrequest must also clear the original native query: Caddy uses `uri /auth/silo/authorize?` (explicit empty query). Keep Gateway's rejection of query-bearing authorization requests; do not loosen it. Preserve the original query unchanged on the actual SILO upstream request, including object prefix/upload/download/delete queries.
3. Strip exactly the `/silo` prefix before proxying to private Console port 9001, never S3 API port 9000.
4. Keep Console's browser-facing base/redirect URL at the public Origin plus `/silo/`.
5. Strip Kala authentication cookies before forwarding to SILO; retain only the native cookies needed for SILO. Prevent native `Set-Cookie` from overwriting Kala cookie names. Verify cookie Path and logout behavior under `/silo/`; use reviewed path normalization if required, not a blanket authentication bypass.
6. Do not expose private ports, inject credentials into native login, or include storage credentials in general settings/profile responses. Only the explicit, opt-in bound-Owner handoff in §14.3 may read the protected existing login.
7. Console upstream failure returns a real error; it never becomes a 200 Dashboard document.

All supported installation entrances must have this behavior. A retained browser compatibility forwarder must forward native `/silo/ws/<endpoint>` upgrades for its explicitly registered browser authorities to the same trusted identity/native-proxy chain, preserving Origin, cookies and query for downstream live authorization. Forwarding Socket.IO alone does not make the native Console usable. An alternate HTTP proxy that does not support Console routing must return an explicit unavailable response for `/silo/`, not Dashboard fallback. It must not redirect an authenticated HTTP request to an unverified external Origin.

**Native cookie policy is also an installation prerequisite.** At pinned `pgsty/silo-console@ef2dd2c41d21`, native login/logout derive `Secure` from native TLS/`GlobalPublicCerts`, not the external `X-Forwarded-Proto`. With canonical public HTTPS terminating before an HTTP Console upstream, the TLS terminator must append `Secure` to SILO's native `Set-Cookie` responses (including logout expiration), or use verified native upstream TLS. The scoped Caddy `/silo/` HTTPS reverse proxy uses `header_down Set-Cookie "^(.*)$" "$1; Secure"`; preserve native cookie value, Path, expiry, HttpOnly and SameSite behavior. Do not apply this transformation to unrelated services, expose HTTP cookie entrances, inject Kala authentication into Console, or remove native CSP/XFO. Acceptance must inspect actual browser cookies and native logout, not infer security from the browser-facing HTTPS URL. Native logout verification for this pinned Console submits JSON `{}`; an empty request body yielding422 is not proof that native logout is broken.

The current Caddy contract bounds established WebSockets to five minutes; upgrade authorization is not continuous revocation of an already established stream. Preserve that bound and document it honestly. Kala logout/revocation makes subsequent native requests fail the live check; there is no parent frame to manage. [S11][S33]

### 14.3 Explicit Dedicated Owner credential handoff

The user approved revealing the existing instance storage administrator login to this installation's canonically bound Dedicated Owner after an explicit action. This is a narrow deployment opt-in, not a new privilege for any arbitrary organization Owner/Admin.

- Gateway advertises only `siloCredentialsAvailable: true`, never a username/password, when Dedicated console access and both protected credential sources are configured.
- The operator mounts the authoritative existing username/password files read-only and sets `KALA_SILO_CONSOLE_USERNAME_FILE` and `KALA_SILO_CONSOLE_PASSWORD_FILE`. Both are required, with Dedicated mode and the enabled native route. Read through the existing secret-environment reader; do not generate a second account, copy credentials into source, change the existing password or use browser-selected paths.
- `POST /auth/silo/credentials` accepts only the configured same Origin and no query. Other methods/query forms fail405; a foreign or missing Origin fails403; an unauthenticated request fails401. An inactive/non-Owner identity is rejected. Private Cloud or unprovisioned instances return404 rather than exposing a global maintenance API.
- Validate the current browser session and active Owner membership before reading, then revalidate the same session, organization, Runtime unit and Owner membership after reading. Revocation or suspension during the read must prevent disclosure. Dedicated authentication continues to enforce the canonical immutable Owner binding.
- Return only `{ username, password }` with `Cache-Control: no-store`, `Pragma: no-cache` and `nosniff`. Missing/unreadable/invalid credentials return sanitized503, never file paths, partial values or a success-shaped placeholder. Never include secret values in URLs, logs, telemetry, generic settings/profile DTOs or persisted browser state.
- The UI requests credentials only after Show login details. Keep them only in local mounted-component memory, expose separately labeled read-only username/password fields and individual copy actions, and provide Hide login details. Conceal and abort on tab hiding, navigation/unmount, capability loss or target/identity change; ignore any late aborted response. A retry rereads the source instead of consulting a browser query cache. Clipboard writes occur only after the user explicitly selects the corresponding copy action.
- If the native console is available but credential sharing is not configured, keep the launch button usable and clearly direct the user to the deployment administrator. Errors are visible with retry available; do not display fictional credentials or imply that Kala login also authenticates storage.

Preserve native CSP/XFO and unrelated Dashboard policy; removing the iframe requires no protection stripping. Existing reviewed native settings need not change for this presentation correction. Standalone cached-shell recovery and native-route refusal remain required. Verify actual new-window navigation, native branding/login, protected credential retrieval and a login using those retrieved credentials; an HTTP200 alone is insufficient.

### 14.4 Existing installation preservation

The current Dedicated production uses the original Compose project and PG/SILO data. Its mounted ingress configuration may differ from the repository Caddyfile. Update the actual mounted site block while preserving identity/observability routes, TLS authorities, volumes, installation claim and credentials. Do not replace the file wholesale, run `down -v`, create another project or use the systemd installer as an in-place replacement. [S23]

Prior read-only evidence found an HTTP proxy routing gap and a different guarded HTTPS configuration. That does not prove the full root cause of the user's particular HTTPS navigation. Real browser navigation through the supported public entrance remains mandatory.

## 15. Latency and diagnostics

Device-to-Service is browser Socket.IO `client:connection_ping` to browser ACK reception: an application RTT including browser/proxy/Runtime scheduling, not ICMP or model latency. Runtime directly acknowledges the ping. [S12]

Show Device-to-Service and Service-to-Executor separately with sample time/freshness. Do not call their independent sum a measured end-to-end RTT. A stale/failed sample is not zero or proof of disconnection.

On connection/recovery take a controlled sample; allow manual measurement. Only while an expanded diagnostic panel is visible may it sample every five seconds, for at most two minutes per explicit opening. Stop on close/hidden/disconnect, and share one Provider rather than one timer per indicator. Ordinary Settings pages do not poll.

Diagnose the actual browser route: LAN versus public/VPN entrance, cold versus warm, idle versus active Agent, browser scheduling versus proxy/Runtime scheduling. Local health checks do not prove user-path latency or complete the root-cause task.

## 16. UI implementation structure

Use existing React, query, UI components, i18n and routing dependencies; no new router, component framework or third-party console download is required.

Target files/components:

| Responsibility | Implementation location |
|---|---|
| Parse Settings hash / compatibility with existing app sections | `app-shell/section.ts` plus a focused Settings route module |
| Page shell, one navigation definition, responsive picker | new `features/settings/SettingsPage.tsx` and typed navigation module |
| Existing Settings API callers and forms | retain/refactor current `sections/*`; separate form content from dialog shell |
| Organization tasks | extract existing `AdminCenter` task components without its fixed overlay and broad snapshot loader |
| Account task | reuse `AccountCenter` actions/content without nesting its full overlay |
| SILO page | new focused Settings section, fixed-origin frame and explicit state handling |
| Wire schemas | shared types and Zod definitions before callers/Executor implementations |
| Gateway projections/capabilities/Webhook management | existing edge/organization/API modules; parameterized tenant-scoped store methods |
| Runtime projections/versioned writes | existing HTTP routes, composition and owning stores; no new database authority |

Do not copy the existing `Record<string, any>` Administration snapshot into new typed code. Define narrow section DTOs and validate trust-boundary input. No `as any` workaround for nullable model state or strict request parsing.

## 17. Compatibility and rollout

1. **Deploy a schema-compatible bridge build before expansion.** Current Gateway/Runtime guards require exact packaged migration versions; additive DDL alone does not make old images rollback-compatible. First build/test an explicitly identified Gateway+Runtime bridge pair that accepts both the current schema and the exact reviewed expanded migration set, preserves metadata/revisions and honors `settingsWriteProtocol`. Do not replace exact guards with an unbounded minimum-version check.
2. **Expand schema and wire support.** Operator-run migrations for externally managed production; constructors must not execute new DDL on browser requests. Keep existing table/credential identities. The bridge pair is the post-expansion rollback target; record its immutable digests before migration.
3. **Implement and test backend adapters.** Capability metadata cannot advertise write support until the actual handler/store/consumer is connected. Keep legacy APIs and old UI working during the named compatibility window.
4. **Implement the new page behind a reversible UI rollout flag.** Freeze `settingsLayout: 'legacy' | 'unified'` in the trusted Dashboard deployment bootstrap; it selects layout only, not authentication/storage. Default existing deployments to legacy until enabled. Old shortcuts map to the new route when unified.
5. **Verify all applicable capability IDs and product branches.** Missing OS, real-service or ingress evidence stays unverified; screenshots, mocks and command plans do not replace it.
6. **Enable the new layout and conditional-write requirement only after compatible writers are ready.** Keep an explicit old-client upgrade response and a compatible UI rollback path; do not restore an unconditional writer under a claimed universal conflict guarantee.
7. **Deploy with installation-specific rollback.** Record bridge and release image digests, reviewed configuration diff and schema acceptance sets. After expansion do not restore the original pre-bridge binaries. No database restoration may silently discard settings/business writes made since upgrade. Image rollback does not undo Webhook delivery, deleted objects or changed secrets.

Do not fold unrelated Session, shell-approval, storage-authority or release refactors into this change. Preserve pre-existing uncommitted fixes and their test evidence. A frontend rollback cannot run against a destructively incompatible migration.

## 18. Delivery blockers

| Gate | Required implementation and closure |
|---|---|
| C01 | Action capabilities, product/role/resource checks and deep-link behavior agree; direct API calls cannot bypass them |
| C02 | Dedicated model editor preserved; approved Private Cloud tenant catalog/store/router and source-policy switch work without shared-key copy |
| C03 | MCP patch protocol/schema/Executor persistence/revision/ACK/dedup; legacy compatibility; unchanged servers preserved |
| C04 | Service-account create/list/revoke UI uses principal IDs and real one-time Tokens |
| C05 | Typed Operator management for supported resource objects, honest enforcement state and actual consumer verification |
| C06 | Resource versions, conflict preservation, commit-versus-apply errors, outcome-unknown handling and replica synchronization |
| C07 | Real integration sources, registry/live association, scoped usage and honest unknown states |
| C08 | All 16 Settings/7 Administration entries and 51 capabilities remain reachable with correct target and preferences |
| C09 | Separate native console entry, explicit authorized credential handoff and actual routing/auth/login/API/asset/WS behavior; no Settings iframe |
| C10 | Correct RTT meaning/freshness/bounded sampling; unresolved real-path root cause remains explicitly open |
| C11 | Hooks and infrastructure config survive supported reconstruction/Unit replacement and actually execute |
| C12 | Private Cloud Owner-only transfer UI preserves server restrictions and invalidates affected old sessions/connections |

The complete migration cannot be called finished with applicable C01-C12 still blocked. Partial rollout must identify its precise scope and retain old functionality; it is not permission to announce full completion.

## 19. Required UT, integration and E2E cases

Use the existing test runners and browser fixtures; do not install new tooling merely to write this feature. Add tests for changed behavior, not constants or screenshots as correctness proxies.

| ID | Required case and observable result |
|---|---|
| R01 | Dedicated Owner sees Instance/Deployment but no team mutations; normal/unauthenticated actors cannot reach deployment data by deep link/API |
| R02 | Private Cloud Owner/Admin/Member/Viewer produce the exact allowed navigation/actions; Member/Viewer can browse authorized models/workspaces without invitation APIs |
| R03 | Direct Settings deep link, refresh, browser back/forward, unknown path and return preserve query Session selection and do not reopen overlays |
| R04 | Opening/closing Settings during a running Session does not interrupt execution, reacquire unrelated Session ownership or replay history |
| R05 | Form draft survives conflict/navigation cancellation; secret fields never enter localStorage, URLs, logs or cross-identity cache |
| R06 | Two clients edit prompt/desktop fields based on one revision: first succeeds, second conflicts, no unrelated field loss |
| R07 | Successful commit plus failed Session/config propagation appears saved-pending; lost HTTP response is outcome-unknown, not automatic repeat |
| R08 | Provider/model create/edit/default/delete reaches actual Runtime endpoint; default change leaves existing Session selection unchanged; referenced deletion rejected |
| R09 | Private Cloud organization A configuration cannot affect B; policy default preserves Operator source; enable never copies global credentials |
| R10 | Cross-replica model update/reconnect/reconstruction uses correct revision; unavailable synchronization blocks ambiguous new calls |
| R11 | MCP edits one server and preserves others; delete/replace/invalid args/stale revision/offline/failed candidate leave accurate state |
| R12 | MCP A then B then delayed A across restart/legacy PUT returns A's receipt and current revision without rerunning; expired/full-history/conflicting-ticket cases fail explicitly; old Executor remains in explicit legacy mode |
| R13 | Enrollment create/rename/copy/regenerate/revoke/delete retain distinct behavior; advanced installation options reach real supported OS/service |
| R14 | Search/Speech real authorized test consumes the intended organization's credential; blank preserves, explicit deletion changes future behavior |
| R15 | Attachment limit controls an actual upload; retention is not labeled enabled when the maintenance consumer is off |
| R16 | Service-account create returns one-time Token, usable scoped API succeeds, revoke rejects subsequent use; bearer cannot administer accounts |
| R17 | Owner transfer rejects Admin/foreign/nonmember targets; affected browser sessions and sockets lose old authority |
| R18 | Operator Plan cannot apply to another installation/revision; exact schemas, expiry/signature/idempotency/revert checks; real Gateway role cannot mutate Operator-owned tables; Verify distinguishes metadata from consumer effect |
| R19 | Webhook requires opt-in Private Cloud/allowed origin/scoped immutable binding; rebind advances generation; 100-endpoint limit survives concurrent creation; no secret readback |
| R20 | Hooks pre/post/start/delete events actually execute with existing semantics; explicit invalid config fails; Unit reconstruction restores correct config |
| R21 | Actual separate-window console control loads through the supported public Origin; explicit Owner credential retrieval, independent native login, representative authorized bucket/object action and logout work |
| R22 | SILO unauthorized/expired Kala login, wrong upstream, Dashboard fallback, frame policy rejection and upstream failure produce correct failure states |
| R23 | SILO native cookies cannot overwrite Kala cookies; assets/API/WS remain fenced; no public 9000/9001, no credential injection or lost ingress routes |
| R24 | SILO ordinary rerender does not reload frame; explicit refresh/leave warn; inactive page has no frame/network work |
| R25 | RTT displays independent samples and freshness; close/hidden/timeout stops bounded sampling; idle Settings do not poll |
| R26 | 320/390px, medium container, desktop, zoom, long names/URLs/multiple invitations and keyboard navigation preserve accessible actions |
| R27 | Appearance/theme preview/cache/notifications/Desktop/Portable branches preserve existing values and real operation |
| R28 | Source-based contract coverage maps every P/A/W/S/T/D/O ID to page/API/store/consumer/test or explicit product-mode unsupported reason |
| R29 | Expanded schemas start with the recorded bridge rollback images; original incompatible images are not selected; rollback preserves post-upgrade writes and write protocol |
| R30 | Portable Search/Speech ciphertext+revision commit atomically in SQLite; JSON metadata survives all supported writers and crash-safe replacement; unsupported live manual edits are not claimed as CAS |
| R31 | Model-policy transition crashes between each control/Runtime PG step resume idempotently; new calls/writes remain fenced; no shared-key fallback or stale-mode serving |

Evidence records include source/build identity, product/actor, resource IDs without private content, request shape with secrets removed, revisions, persistence/application results, browser origin, OS/service where relevant, and reconstruction/rollback outcome.

## 20. Deployment and acceptance sequence

The main agent/deployment maintainer, not the implementation subagent, performs production upgrade:

1. Review the final diff and test evidence against this SoT; challenge unresolved capability gates before building.
2. Use existing locked dependencies and trusted images/assets. Release provenance/signing requirements remain applicable; do not install unknown software or mislabel a dirty source tree as an official release.
3. Inspect the actual installation/project, image IDs, mounted ingress source and durable storage identities read-only. Save protected rollback inputs without printing secrets.
4. Apply only compatible, explicitly reviewed migrations through the correct authority. Never switch deployment product/installer.
5. Build/stage the required components, validate rendered configuration without exposing credentials, and recreate only affected services with the same project/volumes.
6. Verify real authenticated Settings and running-Session continuity; use the actual supported browser Origin, not only container-local health.
7. Confirm the separate native console entry, credential handoff and authorization plus representative persisted setting application. Restore previous compatible images/configuration if a release gate fails.
8. Report exactly what was deployed, verified, unverified or rolled back. Do not convert a UI screenshot/HTTP 200 into business acceptance.

The original data identity, Owner binding, PG/S3 storage, Session fixes and trusted TLS configuration are invariants, not migration inputs to regenerate.

## 21. Review and implementation handoff

The requested work order is fixed:

1. Main agent completes this English implementation SoT and checks source/reference coverage.
2. One read-only review subagent challenges it for contradictory requirements, missing contracts, unsafe migration, fake configurability, scope ambiguity and insufficient evidence.
3. Main agent resolves the findings in this SoT. Any remaining external prerequisite is a named release blocker, not an implementer's free choice.
4. One separate implementation subagent implements the hardened contract and runs UT/E2E without changing production or discarding existing dirty changes.
5. Main agent evaluates its evidence, completes any necessary integration work, and performs the controlled deployment in section 20.

Review findings must name the affected clause, concrete failure scenario and required correction. Merely suggesting "add tests" or "clarify permissions" is insufficient. Implementation must not silently narrow the design; report a blocker before removing a required path.

### 21.1 Independent challenge disposition

These are specification corrections, not claims that their implementations/tests already pass:

| Review concern | Binding resolution |
|---|---|
| Expanded schemas reject original rollback images | Section 17 bridge-build acceptance sets and recorded compatible rollback pair; R29 |
| Cross-database model-mode activation race | Section 10 durable maintenance transition, fencing, reconcile receipt and replica handshake; R31 |
| Gateway inherits mutation rights over Operator tables | Section 13.1.1 explicit grants and real-role effective-privilege checks |
| Portable credentials incorrectly treated as files | Section 9 SQLite credential transactions vs JSON metadata/recovery; R30 |
| MCP arbitrary external-edit CAS not implementable | Section 11 supported-writer lock/full snapshot and stopped manual-maintenance contract |
| One-receipt MCP dedup fails after later writes/restart | Section 11 monotonic revision, authenticated expiring tickets and durable unexpired receipt set; R12 |
| Unconditional old writers defeat universal CAS | Section 9 named legacy-write window and conditional-required completion gate |
| Operator schemas leave field/effect decisions unspecified | Section 13 exact Profile/Change/Plan/operation/patch/grant/exit/revert contracts |
| Webhook binding mutation bypasses delivery generation | Section 13 immutable reference binding, explicit endpoint rebind/backfill |
| 101st Webhook recipient blocks existing deliveries | Section 13 transactional 100-enabled-endpoint cap and remediation |
| Consumer state does not observe subscription loss/identity | Section 9 lifecycle callbacks and revision-correlated Unit/replica observations; R10 |

## 22. Non-goals and explicit prohibitions

- No second Dedicated Kala administrator, no new Private Cloud Web platform-admin product.
- No runtime arbitrary shell/SQL/container control panel, no arbitrary extension installer.
- No automatic shared-secret import into an organization's self-managed catalog.
- No hidden relaxation of shell approval, delegated tool locks, tenant isolation or Session ownership.
- No independently editable artifact/audit/grace retention until an actual supported consumer exists.
- No Dedicated Webhook worker invented by UI configuration.
- No new general-purpose backup/restore promise beyond the actual installation's support.
- No "Contact Operator" placeholder replacing an existing working form or a missing required management operation.
- No embedded native console substituted for the required separate-window entry and explicit login handoff.
- No claim that documentation, mocked tests or a single product mode prove the complete migration.

## 23. Definition of completion

Every existing entry has one destination. Every applicable capability has a real, authorized configuration or maintenance path, durable authority, correct application semantics and evidence. All applicable C gates pass. UT/integration/E2E cover the changed paths and real acceptance covers external/OS/public-ingress dependencies.

An honestly blocked gate remains blocked until resolved; it is not a reason to claim the product is complete. Current source-only/evaluation limitations remain limitations even after the UI becomes clearer.

## 24. Source and existing-contract index

Line anchors identify the audited snapshot and must be rechecked as implementation changes. New endpoints/commands above are proposals, not inferred existing APIs.

[S01]: ../../../packages/dashboard/src/features/settings/SettingsDialog.tsx#L82
[S02]: ../../../packages/runtime-ingress-gateway/src/edge/server.ts#L995
[S03]: ../../../packages/host/bin/kala-runtime-service.ts#L288
[S04]: ../../../packages/host/src/http/mcp-settings-routes.ts#L31
[S05]: ../../../packages/runtime-ingress-gateway/src/edge/server.ts#L852
[S06]: ../../../packages/runtime-ingress-gateway/src/organizations/postgres-store.ts#L207
[S07]: ../../../packages/dashboard/src/features/settings/sections/SocketAdminSection.tsx#L15
[S08]: ../../../packages/dashboard/src/features/settings/sections/ConnectionSection.tsx#L11
[S09]: ../../../packages/host/src/tenant-runtime/runtime-hooks.ts#L7
[S10]: ../../../packages/dashboard/src/features/account/AccountCenter.tsx#L17
[S11]: ../../../deploy/aspire/README.md#L14
[S12]: ../../../packages/dashboard/src/app.tsx#L3964
[S13]: ../../../packages/dashboard/src/features/settings/sections/InterfaceSection.tsx#L96
[S14]: ./account-center.md
[S15]: ../../../packages/host/src/llm/dedicated-model-settings.ts#L14
[S16]: ../../../packages/host/src/tenant-runtime/postgres-agent-settings.ts#L16
[S17]: ../deployment-mode-contract.md
[S18]: ../../../packages/dashboard/src/features/explorer/ConnectWorkspaceDialog.tsx#L36
[S19]: ../../../packages/host/src/store/session.ts#L2990
[S20]: ./capability-regression-audit.md
[S21]: ../../operations/private-cloud-postgres-s3-profile.md
[S22]: ../../../packages/dashboard/src/features/settings/sections/StorageSection.tsx#L23
[S23]: ../../operations/dedicated-legacy-data-migration.md#production-startup-and-recovery-boundary
[S24]: ../../../packages/host/src/http/routes.ts#L661
[S25]: ../../../packages/shared/src/protocol.ts#L2043
[S26]: ../../../packages/dashboard/src/features/admin/AdminCenter.tsx#L20
[S27]: ../../../packages/runtime-ingress-gateway/src/organizations/store.ts#L37
[S28]: ../../../packages/dashboard/src/app-shell/section.ts#L15
[S29]: ../../../packages/shared/src/schema/dashboard-inbound.ts#L549
[S30]: ../../../packages/runtime-ingress-gateway/src/api/service-accounts.ts#L5
[S31]: ../../../packages/runtime-ingress-gateway/src/bin/webhook-worker.ts#L23
[S32]: ../../../packages/runtime-ingress-gateway/migrations/0008_webhook_deliveries.sql#L22
[S33]: ../../../deploy/aspire/Caddyfile#L10

Existing [UI guidelines](./ui-guidelines.md), [capability regression audit](./capability-regression-audit.md), [account design](./account-center.md), [deployment-mode contract][S17] and [Private Cloud delivery restrictions][S21] remain constraints. This document does not erase their runtime, safety or delivery requirements.

## 25. Local implementation evidence and outstanding release blockers

**This is an incomplete implementation snapshot, not completion of this contract and not authorization to deploy the unified migration.** The trusted Gateway layout choice defaults to `legacy`; `KALA_SETTINGS_LAYOUT=unified` opts into the new shell. This switch does not disable the independently upgraded Executor MCP protocol. Existing Session stability/performance changes were present before this implementation and have been preserved, not reattributed.

Validation used the dirty/uncommitted working tree based on `7c3c09054517b5efede993151a62812296095168`, including new untracked implementation files. It is not a signed/committed release identity. No bridge or product image digest was built or deployed.

### 25.1 Implemented source paths

- Dashboard: `features/settings/SettingsPage.tsx`, `routes.ts`, `navigation.ts`, `OrganizationTask.tsx`, and the Service Accounts, MCP patch and SILO task components. The shell uses the existing forms, account actions, exact hash parsing, query-preserving return navigation, scoped capability merge and active-only Runtime/Gateway projections. A Radix confirmation retains canceled drafts and one-time service-account results. Cross-Origin/non-root active targets are explicitly blocked rather than silently mixing current-Origin HTTP with a different Socket target. Complete Portable/Desktop multi-target support is still outstanding.
- Device preference persistence: `lib/prefs.ts`, `lib/theme.ts`, `theme/vscode-theme.ts`, `host-endpoint.ts`, `i18n/index.ts` and the shared `PreferencePersistenceNotice` surface failed browser writes in both Settings shells. Failed boolean/number/string/scheme/target writes do not publish or optimistically apply a saved value; errors remain until the affected keys succeed. Language can still change for the current page when persistence fails, with an explicit unsaved warning. This is not a new claim of atomicity across multiple browser preference keys or durable browser-storage permission.
- RTT: the existing single `ConnectionStatusProvider` now measures independent Device-to-Service and Service-to-Executor samples, never their sum. Each has a timestamp and 15-second freshness classification. One shared five-second schedule runs only for an explicitly open diagnostic panel, for at most two minutes; close, entry unmount, hidden document, disconnect or failed probe stops it. Ordinary closed Settings do not poll. Pending probes do not overlap and hidden/obsolete ACKs are ignored. Probe failures do not assert transport disconnection. New Settings diagnostics refresh their projection, while the legacy form retains its existing `/settings` behavior.
- Runtime: direct section producers in `server.ts`, `bin/kala-host.ts` and `bin/kala-runtime-service.ts`; authenticated projection/capability routes; prompt/execution shared logical identity without including prompt contents in execution reads; command-free hosted hooks load summaries; sanitized skill summaries.
- Revision authorities: Runtime migration 34 and `tenant-runtime/settings-revisions.ts` put encrypted Search/Speech/model and Agent mutations under transaction-owned resource versions. Portable SQLite 5 provides the same credential/version atomicity, including deletion tombstones. `store/settings-file.ts` serializes JSON writers with that installation's SQLite maintenance transaction; authenticated metadata, durable rename/fsync, high-water recovery and the fixed-resource `kala-settings-file import` command are implemented. The Portable composition prepares and persists a candidate before publishing a model router; subsequent new model calls notice changed persisted revisions, while already-started calls retain their adapter.
- Conditional HTTP/UI: `settings-preconditions.ts` supplies strong authority/organization/resource-bound ETags and exact `legacy-compatible | conditional-required` deployment parsing. The HTTP comparison passes the expected revision into the transaction/SQLite lock; it is not the final concurrency check. The legacy-write window advances versions without claiming protection from unconditional old writers. Models/Agent/execution projected reads produce `ConfigurationRead`; Search/Speech retain existing status DTOs with ETags. The unified forms use a mounted target/resource-bound client, retain conflicts, distinguish committed-but-unverified and unknown outcomes, and reread the resource without replaying mutations. An intervening revision during post-save readback cannot silently rebase remaining drafts. Entry rereads, role-scoped cache keys and identity-keyed form remounts prevent cached/new-target draft mixing. Complete control-plane CAS and consumer convergence remain outstanding below.
- Gateway: scoped PG collection producers with bounded, organization/task-bound keyset pagination; capabilities; service-account limits and pagination. Actual control-plane adapters use a transaction and organization row lock for service-account creation. Owner transfer reuses the existing server operation rather than introducing another ownership authority. The UI confirms an existing member, blocks duplicate submission, keeps rejected confirmation/error visible, guards the active operation and suppresses stale post-unmount navigation. A successful transfer explicitly clears unload guards before reauthentication; it does not bypass server revocation.
- MCP: shared strict request/announcement schema, Host PATCH dispatch with declared-capability negotiation, and Executor monotonic revisions, protected ticket key, 24-hour bound tickets, durable unexpired receipts, 512-receipt fail-closed capacity, supported-writer serialization, full-file comparison and atomic config replacement. Untouched commands/arguments are not read back. Upgraded legacy replacements preserve receipts and advance the revision. An older Executor is explicitly shown as legacy complete replacement.
- Subscription lifecycle: `postgres-notifications.ts` reports disconnected/synchronizing/ready and waits for the reconstruction reread before ready. Dedicated new model calls are fenced during known loss; already-started immutable calls are not intentionally changed. Rereads use the existing credential lock.
- Hooks: `runtime-hooks-provisioning.ts` validates the protected mounted manifest/source set and regenerates the bound Unit's fixed configuration before online resources start. Another organization cannot inherit those Hooks; absent entries explicitly reconstruct an empty configuration. Digest/placement/permission failures do not replace the old copy. The process reports observed load time/source revision/restart semantics without exposing commands or private paths. Native-process acceptance covers reconstructed commands and the actual existing Session create/delete and pre/post-tool lifecycle paths, preserving blocking pre-Hook and nonblocking post-Hook semantics.
- SILO: fixed same-Origin `/silo/` preflight and iframe, bounded document inspection, enforced CSP/XFO precedence, native-document/route verification, precise failure states, explicit refresh/leave warning and stable iframe identity. Aspire carries only the native supported MINIO CSP setting from §14.3. No proxy header stripping, Console download, credential injection or production edit was performed.

### 25.2 Exact local validation

All commands below were run from the repository root, with scratch paths inside the repository.

```sh
pnpm --filter @agent-kernel/shared build
pnpm --filter @agent-kernel/dashboard typecheck
pnpm --filter @agent-kernel/host typecheck
pnpm --filter @agent-kernel/executor typecheck
pnpm --filter @agent-kernel/runtime-ingress-gateway typecheck
pnpm --filter @agent-kernel/dashboard lint:style
pnpm --filter @agent-kernel/host build
pnpm --filter @agent-kernel/executor build
pnpm --filter @agent-kernel/runtime-ingress-gateway build

TMPDIR="$PWD/.settings-test-work" pnpm --dir packages/shared exec vitest run \
  src/mcp-settings.test.ts
TMPDIR="$PWD/.settings-test-work" pnpm --dir packages/executor exec vitest run \
  src/mcp-settings-protocol.test.ts src/mcp-client.test.ts src/executor-config.test.ts
TMPDIR="$PWD/.settings-test-work" pnpm --dir packages/dashboard exec vitest run \
  src/connection-status.test.tsx src/lib/prefs.test.ts src/lib/theme.test.tsx \
  src/theme/vscode-theme.test.ts src/host-endpoint.test.ts src/i18n/i18n.test.tsx \
  src/features/settings/routes.test.ts src/features/settings/sections/SiloSection.test.tsx \
  src/features/settings/sections/ServiceAccountsSection.test.tsx \
  src/features/settings/SettingsDialog.test.tsx src/features/admin/AdminCenter.test.tsx \
  src/session-routing.test.tsx
TMPDIR="$PWD/.settings-test-work" pnpm --dir packages/host exec vitest run \
  src/http/settings-projections.test.ts src/http/mcp-settings-routes.test.ts \
  src/http/routes.test.ts src/tenant-runtime/postgres-notifications.test.ts \
  src/postgres-migrations.test.ts
TMPDIR="$PWD/.settings-test-work" pnpm --dir packages/runtime-ingress-gateway exec vitest run \
  src/api/service-accounts.test.ts src/organizations/settings-view.test.ts \
  src/organizations/postgres-store.test.ts src/edge/server.test.ts \
  src/persistence/postgres.test.ts

node scripts/dashboard/verify-settings-local.mjs
```

Results: shared 2, Executor 18, Dashboard 167, Host 30 and the targeted Gateway tests passed. The Dashboard count includes two focused service-account lost-response/one-time-Token tests, 36 shared connection-status tests, browser-storage failure/retry cases and Owner-transfer confirmation/rejection. All listed typechecks, style lint and backend builds passed. After the identity-constraint repair below, the full Gateway source-only suite passed 245 tests (26 opt-in integration tests skipped in that command). Its command is `TMPDIR="$PWD/.settings-test-work" pnpm --dir packages/runtime-ingress-gateway exec vitest run --exclude '**/dist/**'`. An initial unfiltered run also picked up pre-existing compiled `dist/src/*.test.js` copies and failed four compiled tests on nonexistent source-relative paths. Source-only filtering, rather than weakening a source test, excludes these compiled copies; normal backend builds subsequently regenerated their ordinary output.

Real isolated PostgreSQL integration also passed (existing local `postgres:16-alpine`, no image download, production connection or LXC access):

```sh
env -u DOCKER_CONTEXT DOCKER_HOST=unix:///var/run/docker.sock \
  KALA_RUN_POSTGRES_INTEGRATION=1 TMPDIR="$PWD/.settings-test-work" \
  pnpm --dir packages/host exec vitest run \
  src/tenant-runtime/postgres-state.integration.test.ts
env -u DOCKER_CONTEXT DOCKER_HOST=unix:///var/run/docker.sock \
  KALA_RUN_POSTGRES_INTEGRATION=1 TMPDIR="$PWD/.settings-test-work" \
  pnpm --dir packages/runtime-ingress-gateway exec vitest run \
  src/bin/control-schema-upgrade.integration.test.ts \
  src/organizations/settings.integration.test.ts
```

Host: six passed, including two live model consumers, actual termination of the notification backend, immediate new-call rejection during disconnect, held reconstruction reread remaining fenced, reconnect and encrypted-state reconstruction. This first selector does **not** establish full configuration-revision/serving-membership convergence. Gateway: five passed, including actual collection SQL/pagination/isolation, transactional concurrent service-account quota, real persisted Token authentication/revocation, exact 12/13 guard acceptance, existing browser-session preservation and atomic same-organization Owner transfer/authorization-version advancement. The fixture containers are removed by their test cleanup. Separately, `src/edge/server.test.ts` exercises the real loopback Gateway with fictional OIDC, a file session authority and live upgraded browser connections: transfer revokes both identities' cookies on all tested devices and immediately closes their proxy connections despite a 60-second authorization-recheck interval; an unrelated organization's cookie/connection remains usable. This is not real-IdP, PG-session-authority or public-ingress acceptance.

The browser helper launches existing sandbox-enabled Chrome/156.0.8078.4 with a repository-local profile and fictional loopback HTTP authorities. Ten behavioral checks passed: no broad settings snapshot on personal pages; actual browser-storage failure/visible error/preserved value and explicit retry surviving reload; projected model load; one-time Token retention on canceled navigation; principal-ID revocation; no iframe reload/horizontal overflow during 390/831/832/1100/1440px resize; query preservation; real loopback WebSocket ACKs with separate segment RTTs and one five-second sample; no further application probes after closing diagnostics; Owner-transfer cancellation followed by an exact existing-member HTTP submission and untrapped reauthentication navigation. Evidence is `.settings-test-work/browser/evidence.json`, with corresponding `settings-<width>.png` and `connection-diagnostics.png` screenshots. The helper closes its servers/browser and removes its own per-process profile. It exercises real Settings React components, local HTTP/WebSocket requests and browser framing, **not real native SILO, real OIDC, a real Session/Executor authority, real PG transactions or public HTTPS acceptance**.

At the first snapshot the normal `pnpm --filter @agent-kernel/dashboard build` encountered an **ignored local generated** Desktop preview publication mismatch (`0.2.0~rc.19` versus package `0.4.2`); it was not checked-in release metadata. The main agent subsequently resolved the prerequisite by running the **unmodified normal** Kernel/shared/Dashboard builders in a clean source snapshot that excludes ignored previews, reuses existing dependency links and preserves production's existing Desktop-unavailable state. Its first-snapshot receipt is `settings-dashboard-clean-k221_bqb/clean-source-receipt.json` in the session artifacts; it must be repeated against the eventual final source. No old binary was relabeled, no unsigned Desktop rebuilt, and no publication guard bypassed. Historical standalone Vite compilation used:

```sh
GOMAXPROCS=1 UV_THREADPOOL_SIZE=1 NODE_OPTIONS=--max-old-space-size=1536 \
  pnpm --dir packages/dashboard exec vite build \
  --outDir ../../.settings-test-work/dashboard-build --emptyOutDir
```

Its log is `.settings-test-work/dashboard-vite-build.log`; it is not substituted for the main agent's normal clean-source build and was not deployed.

The continued authority/conditional-client batch was validated separately:

```sh
pnpm --filter @agent-kernel/shared build
pnpm --filter @agent-kernel/host typecheck
pnpm --filter @agent-kernel/dashboard typecheck
pnpm --filter @agent-kernel/dashboard lint:style
TMPDIR="$PWD/.settings-test-work" pnpm --dir packages/host exec vitest run \
  src/http/settings-preconditions.test.ts src/http/settings-projections.test.ts \
  src/http/routes.test.ts src/store/settings-file.test.ts \
  src/store/settings-file-cli.test.ts src/store/state-store.test.ts \
  src/runtime-config.test.ts src/web-search/credential-store.test.ts \
  src/speech/credential-store.test.ts src/dag/store.test.ts
TMPDIR="$PWD/.settings-test-work" pnpm --dir packages/dashboard exec vitest run \
  src/features/settings/configuration-client.test.ts \
  src/features/settings/sections/AgentSection.test.tsx \
  src/features/settings/sections/SecuritySection.test.tsx
env -u DOCKER_CONTEXT DOCKER_HOST=unix:///var/run/docker.sock \
  KALA_RUN_POSTGRES_INTEGRATION=1 TMPDIR="$PWD/.settings-test-work" \
  pnpm --dir packages/host exec vitest run \
  src/tenant-runtime/settings-revisions.integration.test.ts \
  src/tenant-runtime/postgres-state.integration.test.ts src/postgres-migrations.test.ts
TMPDIR="$PWD/.settings-test-work" node scripts/dashboard/verify-settings-local.mjs
```

Results: **68 Host tests, 14 Dashboard tests, 17 actual-PG/migration tests and 13 sandboxed browser checks passed**; the listed types/shared build/style checks passed. These overlapping selectors are not added to the earlier totals. New evidence includes actual two-process SQLite CAS, a child-process exit after JSON rename/before SQLite commit and recovery, packaged protected import, actual SQLite4 bridge → SQLite5 → post-upgrade bridge writes/reopen, real DML-only Runtime login permissions, same-transaction ciphertext/version rollback, Speech key-preserving partial edits, tombstones and locked Agent edits. HTTP tests use actual loopback sockets and SQLite rather than replacing the store with a mock, including a write between header comparison and locked commit.

The browser helper now also loads the **actual Host HTTP routes and real isolated Portable SQLite/JSON authorities** for prompt/execution edits. It proves conditional conflict with a retained textarea, cancelable explicit reload, a successful revision-aware save without invented Session application, and actual post-commit truncated-response loss with retained draft and explicit reconstruction. The fixture has no loaded Sessions and reports application unknown. Its other authorities remain fictional loopback fixtures, not production/native SILO/IdP/public TLS evidence. Browser transport can independently retry an empty reused connection; preconditions prevent a second commit. The deliberate partial-response fault tests the application's unknown-outcome state without asserting that all browsers promise no transport retries. The application never automatically reissues the mutation.

The subsequent Hooks batch passed:

```sh
pnpm --filter @agent-kernel/shared build
pnpm --filter @agent-kernel/host typecheck
TMPDIR="$PWD/.settings-test-work" pnpm --dir packages/host exec vitest run \
  src/tenant-runtime/runtime-hooks-provisioning.test.ts \
  src/tenant-runtime/runtime-hooks.test.ts src/extensions/hooks.test.ts
TMPDIR="$PWD/.settings-test-work" pnpm --dir packages/host exec vitest run \
  src/server.test.ts src/loop.test.ts \
  -t 'native (pre_tool_use|post_tool_use|session_start)'
TMPDIR="$PWD/.settings-test-work" pnpm --dir packages/shared exec vitest run \
  src/settings-configuration.test.ts
TMPDIR="$PWD/.settings-test-work" pnpm --dir packages/dashboard exec vitest run \
  src/features/settings
pnpm --filter @agent-kernel/host build
pnpm --filter @agent-kernel/dashboard typecheck
pnpm --filter @agent-kernel/dashboard lint:style
git --no-pager diff --check
```

Results: **18 Hook source/provisioning/native-runner tests, three focused native lifecycle tests, one shared wire round-trip and all 118 Settings UI tests passed**, with types/style/Host build passing. The focused lifecycle selector deliberately skips 244 unrelated server/loop tests; it is not a full-suite result. The larger Settings selector found and fixed a coupled legacy compatibility regression: old Web Search servers may acknowledge PUT/DELETE with204, which remains supported; new conditional clients use the actual fresh status DTO. Reconstruction tests remove the disposable Unit root, reprovision from protected source, and execute all four actual OS commands. The server/loop selectors execute real Node child processes through Session create/delete and tool dispatch rather than substituting successful mock outcomes. This local Linux evidence is not a claim that the installation's manifests/mounts/image dependencies or physical Windows/macOS services have been accepted.

### 25.3 Schema and bridge status: implemented authority foundations, not full rollout authorization

Runtime source now packages schema **36**, Portable SQLite packages **5**, and control packages **17**. Runtime35 introduces durable model-policy reconciliation/fences and append-only drain/startup receipts (§25.10); Runtime36 adds operation-bound maintenance holds, actual workspace-admission authority and serving-consumer observations (§25.13). Migration14 introduces attachment-policy revision authority; retention retains its existing counter (§25.6). Migration15 introduces immutable Webhook bindings, endpoint revisions and the transactional cap (§25.8). Migration16 introduces the Operator journal/resource counters and default-Operator model-policy authority (§25.9); migration17 fences competing control workspace mutations during a prepared maintenance operation. A coupled defect found by real PG acceptance required control migration **13**: `UNIQUE NULLS NOT DISTINCT (issuer,subject)` allowed only one `service_account` principal globally. Migration13 uses ordinary uniqueness; existing checks still require both identity fields for humans and neither for service accounts, so human identity uniqueness is preserved while distinct service-account principals become possible. Migration13 itself creates no tables and grants no new privileges.

The current Gateway is a **source-tested write-aware bridge accepting exactly control12/control13/control14/control15/control16/control17**, validating complete consecutive migration names and checksums for each. It rejects 11/18, gaps, name changes and checksum drift; the migrator also rejects changed migration names. Real PG tests exercise12 and13 before expanding through17, preserve existing data, and perform post-upgrade legacy/conditional writes through the bridge and an actual restricted Gateway login. Native admission/binding/revocation also runs on baseline12 and expanded17. Original guards and earlier16-only bridges reject17. This is not a bridge for any later unreviewed migration.

Source-derived identities below were obtained with an in-memory SQL collector and existing checksum functions, **without connecting to any production database**; compare against the installation's preserved full histories before release:

| Authority | Existing last migration | Packaged checksum |
|---|---|---|
| Runtime 33 | `stored_session_list_summaries` (pre-existing Session-summary change) | `8c2ba7454860aa668508858485cd34020df4b9bcf419dab3e4831d1dd9641bd3` |
| Runtime 34 | `authoritative_settings_resource_versions` | `48394947737b8cddcaeb0fee37c7a1f8da66fa35eb7642b7529868a9b6184192` |
| Runtime 35 | `durable_organization_model_policy_transitions` | `35e86cc9b014bb7a56a85958059d37cc9255c2469e8166994d19027d6511c35b` |
| Runtime 36 | `durable_operational_settings_consumers` | `1df0545f4c3976e0277952b5110eab170bcdbefa4bef88646defab6afa7a5c96` |
| Portable SQLite 5 | `settings_resource_versions` | `b86b7620fb5916a3b4a87331f800e67fef70d1c5d63046a8fde231f76e86cdad` |
| Control 12 | `0012_organization_attachment_limit.sql` | `4e550a8b856e12d60a93dfed780e9499c184f40e498877a43bbb8f50fee516c7` |
| Control 13 | `0013_service_account_principal_identity.sql` | `31568836aeccc3025d0549652167d761969f09c016efc82a202b6db32a20b4de` |
| Control 14 | `0014_authoritative_settings_resource_versions.sql` | `81647ac965ce6a7c181f03010e7de7489ab3b981664b58375053c70ce0cd0d90` |
| Control 15 | `0015_immutable_webhook_bindings.sql` | `10ecb0338412d625770ffe21a1a3f56b1d9b85397c5ee86feca48cb9a86ca4f9` |
| Control 16 | `0016_operator_settings_authority.sql` | `b96d609259abb5815fab93d87e3c4d5c7fac034f250e86d031c35cc361f9689e` |
| Control 17 | `0017_workspace_operation_fences.sql` | `ebf7961738f01f15a0976cd8e2ddcfc8af0703df4e6a0079520c3a3129ef0995` |

All **Runtime1–33/control1–12** source names/checksums were compared in full to the main agent's preserved `settings-schema-histories.before.json`; all 45 identities matched. No installation database was contacted for that comparison. Runtime guard accepts exactly complete reviewed **33/34/35/36** histories, not a version minimum. Actual PG acceptance runs a baseline33 bridge, expands through36 without rewriting old ciphertext/history, then performs conditional and legacy writes through the same revision-aware implementation. Runtime33 legacy reads/writes work; conditional mutations fail closed until the authority table exists. Agent revision observation also retains explicit unversioned operation on33 rather than preventing existing Session dispatch.

Portable supports explicit `KALA_SETTINGS_SCHEMA_MODE=bridge|upgrade` (`upgrade` is the normal default). **Bridge mode must be selected before the first pre-expansion Portable open**: it retains SQLite4 and existing unversioned JSON/credential behavior without manufacturing wire revisions; new conditional operations/imports remain unavailable. After a reviewed upgrade to5, that same bridge recognizes the exact5 history and every supported old/new writer preserves/increments metadata, even if the process started before expansion. Tests preserve original ciphertext across expansion and perform post-upgrade writes/reopen through bridge mode. JSON with versioned metadata alongside a4 authority fails closed. Stopped-process backup/restore must preserve the matching SQLite/JSON/master-key set; restoring only a downgraded schema/file is not rollback.

There is **no built/recorded bridge image identity**. Build instructions for the main agent, not commands executed or verified image identities here:

```sh
docker build --pull=false -f deploy/private-cloud/images/Dockerfile.runtime-ingress-gateway \
  -t kala-settings-control-bridge:local .
docker build --pull=false -f deploy/private-cloud/images/Dockerfile.runtime-service \
  -t kala-settings-runtime-bridge:local .
```

Before any matching expansion, build/record/test immutable bridge images on all exact supported histories, deploy the compatible Gateway first and Runtime second on unchanged Runtime33/control12 with `KALA_SETTINGS_WRITE_PROTOCOL=legacy-compatible`, and preserve those images as rollback targets. Keep the layout legacy. Runtime must reach the approved internal Gateway through `KALA_RUNTIME_AUTHORITY_ORIGIN` and the existing protected service credential; it must not use a browser identity or public-origin relay for these authority calls. Expand only the reviewed matched migration set after image acceptance, then deploy/verify all revision-aware writers and explicitly transition to `conditional-required`. After expansion, rollback keeps the compatible bridge and expanded database/metadata at their new versions; do not select original old-schema-only Runtime/Gateway images, downgrade counters, delete JSON metadata or recreate the nulls-not-distinct constraint. The current scoped Runtime33–36/control12–17 bridge is **not** a bridge for later migrations; those exact histories/grants/compatibility tests must be delivered before applying later DDL. Both Runtime35 and control16 are required for new model-management transitions; operational maintenance additionally requires Runtime36/control17. Earlier35/16-only or34/15-only bridges are not rollback targets after36/17.

For the remaining Settings expansions, §17 remains a hard prerequisite: implement the exact reviewed expanded history plus the metadata-preserving/write-protocol-aware bridge pair; verify both histories and post-upgrade writes in isolated databases; record compatible image identities; deploy that bridge first; only then expand. Original Runtime33/control12-only images must not be described as rollback-safe after future expansions. Do not weaken exact-version guards or apply the missing Settings DDL to compensate for unfinished bridge work.

Executor MCP metadata has a separate downgrade boundary: the config and `.mcp-config-integrity.key` are protected installation state. Pre-protocol writers are not supported rollback targets once versioned writes occur. A crashed writer can leave `.mcp-config.lock`, which deliberately fails closed rather than inventing a stale-lock lease. Stopped-process recovery/Windows/macOS service behavior still needs acceptance; never remove a live writer's lock or its key/receipts as an automatic retry.

### 25.4 Current source evidence and remaining installation acceptance

Section25.13 supersedes the earlier inspection-only/source-incomplete checkpoints. The requested source adapters, durable holds, serving-set association and full51-action mapping are implemented and locally exercised. No C01–C12 gate is declared universally closed: immutable packaging and supported-installation acceptance are still separate requirements.

| Gate | Outstanding implementation/acceptance |
|---|---|
| C01/C08 | All51 actions are mapped across48 actual-producer product/role/source-policy/Webhook combinations, with23 explicit legacy16+seven entry checks (§25.13). Actual Portable App bootstrap, immutable target switching, scoped form transport, draft cancellation and immediate control-socket fencing have unit/browser evidence. Native OS/Push/Desktop and final installation entrance acceptance remain separate; the matrix does not execute physical-OS actions. |
| C02 | Private Cloud organization composition, fresh protected Gateway policy authority, durable Runtime35 reconciliation/fences/receipts, actual native drain/startup handshake and resumable Operator control/Runtime transitions are implemented (§25.10). Restricted-role/two-database/native HTTP acceptance includes real CLI SIGKILL after Runtime reconciliation commit, response loss, inverse/new revisions, retained encrypted catalogs, required-member disappearance, racing progress and actual LISTEN loss/reconstruction (§25.13). Immutable packaged rollback and public installation acceptance remain open; bounded crash cases are not exhaustive failure injection at every instruction. |
| C03 | Local patch/dedup/legacy tests pass; real OS/service crash recovery, full managed-installation upgrade/downgrade boundary and complete transport/application acceptance remain open. |
| C04 | UI, API/service regression tests, loopback interaction and real PG-backed Token authentication/revoke pass. Actual public authenticated/scoped API acceptance still belongs to the supported installation, and migration 13 requires the separately recorded bridge rollout. |
| C05 | Typed CLI, Profile-bound authenticated Plan, owning-database journal/audit/inverse transactions, exact restricted roles and real CLI acceptance exist. Operation-bound Runtime holds now survive inspection→control commit and process death; lifecycle, membership, Session and Workspace-effect admissions are fenced until actual consumption. Workspace/pool/contract consumers and verification use fresh protected authority, including actual Native invitation/enrollment/rotation/reconnect/tool-effect admission (§25.13). Deployment must install the reviewed migrations/grants/internal authority route and accepted images. |
| C06 | Runtime/Portable revisions, model/Agent reads, both write-protocol modes, retained conflict/unknown drafts, JSON/SQLite/import/crash boundaries, attachment/retention CAS and write-aware source bridges are tested. Complete current serving membership and generation/token/origin/observer/sequence association now drive honest convergence (§25.13), without new Session leases. Physical-OS durability/ACLs and packaged rollback remain gates. The legacy compatibility window intentionally does not claim universal stale-write protection. |
| C07 | Actual installed-adapter sources and distinct configured/health observations replace hardcoded statuses. Runtime model/Agent observations are joined against all current serving memberships; missing/stale/disconnected consumers cannot yield applied. Two actual native Agent consumers, busy-turn deferral, loss/reconnect, generation replacement and stale-publication fencing are locally exercised. Unsupported external integration health remains unknown, not connected (§25.13). |
| C09 | Local iframe behavior and supported native CSP are implemented. Main-agent isolated same-digest native login/cross-origin evidence is independent evidence; actual public-Origin Owner/native login/object/API/assets/WS/cookie/logout acceptance remains the main agent's gate. Private HTTP relays do not close it. |
| C10 | Independent RTT meaning, timestamp/freshness and bounded shared sampling are implemented with 36 connection-status tests and a real-browser loopback WebSocket fixture. Actual user-path latency diagnosis (public/VPN/LAN, cold/warm, idle/active scheduling) remains open; loopback measurements do not close it. |
| C11 | Protected mounted per-Unit provisioning, reconstruction after deleting the disposable root, actual native Hook commands and existing Session/tool lifecycle execution are implemented/tested above. The supported installation must still provide/review persistent protected mounts and trusted image dependencies and exercise its controlled replacement path. An unmanaged ephemeral file or a load summary alone does not close that deployment evidence. |
| C12 | Confirmation/cancel/rejected draft, duplicate-submit and successful reauthentication navigation have local UI/browser evidence. Real PG tests exercise atomic role/version changes, and separate loopback Gateway tests prove both identities' old cookies/live proxy connections are revoked while another organization is unaffected. Actual supported public-Origin/IdP/PG-session/full Socket.IO acceptance remains open. |
| R19 | Opt-in Private Cloud immutable bindings, protected Operator binding creation, immutable delivery snapshots/rebind generations, transactional100-enabled cap and remediation are implemented with actual PG/worker/browser acceptance (§25.8). Production worker/resolver/origin policy acceptance remains installation-specific. |
| R10/R29/R31 | Real PG consumer loss/reconnect/reconstruction, serving-membership convergence and write-aware Runtime33–36/control12–17 bridges exercise exact histories and post-expansion writes. Separate CLI SIGKILL cases cover durable model reconciliation and workspace hold-before-control-commit reconstruction; Portable JSON tests cover independent writer processes and crash recovery. Immutable packaged baseline/expanded rollback and supported-OS filesystem/service acceptance remain open; source evidence is not an immutable image identity or an exhaustive crash matrix. |

The existing real-public-HTTPS identity-routing defect and its carefully scoped repair remain exclusively the main agent's deployment work. This implementation did not inspect/change production, LXC, production credentials or real user Sessions; it did not commit, push or start another agent.

**Deployment recommendation:** keep the default legacy layout until the main agent completes the protected installation gates. Expansion from control12/Runtime33 to control17/Runtime36 requires verified, recorded compatible Gateway and Runtime bridge images first; source verification alone does not authorize DDL. The component set includes Gateway/control migrator, initializer/restricted-role grants/Operator CLI/Webhook worker, Runtime/Host migrator and authority client, Dashboard, compatible managed Executor/MCP protocol, protected Hooks mounts and applicable supported native SILO/precise identity-ingress configuration. The main agent alone packages images or performs production deployment.

### 25.5 Subsequent source batches — still not final acceptance

Subsections25.5–25.12 preserve incremental historical checkpoints. Their then-missing source/adapters are superseded by the completed source and current acceptance boundary in §25.13; do not treat an earlier “unimplemented” statement as the final source status.

- Extracted the existing Dedicated live catalog implementation into `llm/tenant-model-settings.ts`, retaining the Dedicated seed-copy initializer, encrypted transaction, conditional revision, immutable in-flight adapters, LISTEN loss/reconnect fencing and post-commit publication. `OrganizationModelSettings` uses a separate `organization-model-settings:v1` credential/channel/prefix; its constructor accepts **no deployment catalog or shared-secret resolver**. It starts with an empty catalog and `defaultModel: null`, checks the tenant-store binding, requires an expanded revision authority for initialization/mutations, and requires explicit policy guards. Those guards are **not yet backed by the complete control/Runtime maintenance protocol**, so the new authority is deliberately not composed into serving Private Cloud Runtime. New organization routing matches exact references and rejects absent/unknown models without shared/default fallback. Typed projected values can represent null; only the legacy form adapter maps null to its existing empty-string presentation.
- Added exact resource-specific Operator Profile/Change/Plan validators and authenticated canonical-plan primitives. Plans bind installation/effective database host, port, database and role/Runtime Origin, scope, complete dependencies/effects/reversibility, validated change digest and a maximum 15-minute lifetime. Apply-side authentication rechecks scope, expiry, full MAC and digest. Protected POSIX file readers use no-follow/nonblocking opens, current ownership, no group/world access, bounded bytes and unchanged inode/metadata; resolver failures are sanitized. This is a tested foundation, **not an implemented Operator CLI or journal**. Windows protected-file handling fails closed rather than pretending POSIX mode bits prove Windows ACLs.
- Replaced the Gateway initializer's blanket public-table/sequence grants with an explicit existing-business allowlist and explicit append-only audit/usage/Outbox grants. Reviewed future policy/binding tables are read-only; Operator operations have no Gateway access; old direct column grants are removed and inherited/PUBLIC excess fails closed. Real existing-schema fixtures verify actual Gateway SQL permissions, the restored business/ledger append path, lack of authority over unknown future tables/sequences, and rejection of PUBLIC policy mutation. These fixture table definitions are **privilege probes**, not delivered Settings migrations or an Operator role.
- Unified Agent/execution forms now preserve read-only inspection without enabled writes for readers. Portable target requests capture immutable origin, credentials and cache scope; only the enumerated routes are allowed. Hosted cross-origin targets remain refused. Remote Portable requests omit browser cookies and reject redirects/escapes; same-origin credentials never come from a stale caller header. Credential changes isolate query scope without putting Tokens in query keys. Old target projected queries are cancelled/removed, draft trees remount, and old conditional readbacks cannot repopulate another task. The control socket is unavailable immediately on host/Token changes, before effect cleanup; no Session lease, timeout or ownership rule was added.
- Reused MCP, invite, diagnostics, deployment and Aspire request paths now consume that mounted immutable request context. Native relative management links resolve against the selected target. Settings no longer falls back to a possibly former Session socket for target diagnostics/storage.
- Worker signing-key references now share strict organization namespace/path/field validation with the new Operator schema; prefix-only traversal/missing-field/foreign references are rejected before resolver dispatch. **Immutable binding storage/API/rebind generations and the transactional cap remain unimplemented R19 work.**

Latest reproducible evidence (all scratch stays under the repository):

```sh
pnpm --filter @agent-kernel/shared build
TMPDIR="$PWD/.settings-test-work" pnpm --dir packages/shared exec vitest run src/settings-operator.test.ts
TMPDIR="$PWD/.settings-test-work" pnpm --dir packages/runtime-ingress-gateway exec vitest run --exclude '**/dist/**' src/settings src/bin/webhook-worker.test.ts
env -u DOCKER_CONTEXT DOCKER_HOST=unix:///var/run/docker.sock \
  KALA_RUN_POSTGRES_INTEGRATION=1 TMPDIR="$PWD/.settings-test-work" \
  pnpm --dir packages/host exec vitest run src/tenant-runtime/postgres-state.integration.test.ts \
  src/tenant-runtime/settings-revisions.integration.test.ts src/llm/runtime-provider-catalog.test.ts
env -u DOCKER_CONTEXT DOCKER_HOST=unix:///var/run/docker.sock \
  KALA_RUN_POSTGRES_INTEGRATION=1 TMPDIR="$PWD/.settings-test-work" \
  pnpm --dir packages/runtime-ingress-gateway exec vitest run --exclude '**/dist/**' src/bin/control-schema-upgrade.integration.test.ts src/bin/private-cloud-init.test.ts
env -u DOCKER_CONTEXT DOCKER_HOST=unix:///var/run/docker.sock \
  KALA_TEST_WEBHOOK_DELIVERY=1 TMPDIR="$PWD/.settings-test-work" \
  pnpm --dir packages/runtime-ingress-gateway exec vitest run --exclude '**/dist/**' src/webhooks/outbox-worker.test.ts
TMPDIR="$PWD/.settings-test-work" pnpm --dir packages/dashboard exec vitest run \
  src/features/settings src/session-routing.test.tsx src/use-session-cache.test.tsx
TMPDIR="$PWD/.settings-test-work" node scripts/dashboard/verify-settings-local.mjs
pnpm --filter @agent-kernel/host build
pnpm --filter @agent-kernel/runtime-ingress-gateway build
pnpm --filter @agent-kernel/dashboard typecheck
pnpm --filter @agent-kernel/dashboard lint:style
git --no-pager diff --check
```

Observed batches: shared schemas **5** tests; Operator/profile/worker namespace **9** tests; Host actual PG/catalog regression **15** tests; Gateway schema/grant/init **7** tests; existing actual PG/HTTP governance-worker **9** tests; Dashboard Settings/Session selectors **187** tests. The worker suite has its own `KALA_TEST_WEBHOOK_DELIVERY` opt-in: the generic PG flag alone skips it and is not evidence that it passed.

The sandbox-enabled Chrome fixture now passes **15** checks, including two distinct real loopback Portable HTTP/SQLite/JSON authorities. It proves per-target Bearer dispatch without browser cookies, cancelled delayed reads and discarded former drafts, and an actual conditional save only to the selected authority. Evidence remains `.settings-test-work/browser/evidence.json`; added screenshot `portable-target-isolation.png`. These are fictional local identities and loopback Origins, **not** native SILO, real IdP/public HTTPS or physical Desktop acceptance. All schemas/checksums in §25.3 remain unchanged by these batches; there is still no new expanded-policy/Operator schema or compatible packaged bridge identity.

### 25.6 Control policy revisions and retained conditional forms

This subsequent source batch supersedes §25.5's schema/15-check snapshot, **not the outstanding §25.4 source gates**. Layout remains disabled by default.

- Retention reads, preconditions, unsupported-field validation, the existing bigint counter update and actor audit share one row-locked transaction. No second retention counter is introduced. Decimal revisions remain strings, including beyond JavaScript's safe integer range.
- Control14 adds `settings_resource_versions` and initializes existing attachment policies at revision1. A fixed advisory schema fence is acquired in shared mode by compatibility readers/writers and exclusively **before any DDL** by the migrator. This prevents a process that observed the old schema from committing an unversioned write after expansion. Actual PG acceptance found a batched12→14 lock-order deadlock when the fence was taken only inside14 (13's identity DDL could block the writer's audit); acquiring it before the complete migration batch resolves that defect.
- Attachment value/revision/audit commit together. New organizations initialize metadata under their organization lock. Gateway grants allow SELECT/INSERT/UPDATE on version rows but prohibit deleting tombstones. Pre-expansion bridge reads retain the legacy DTO without an invented revision; conditional attachment writes fail503 until the authority exists.
- Added the projected attachment GET listed in §8 and retention GET, with no-store strong ETags binding the configured public Origin, organization, resource and revision. The original attachment GET/PUT and retention PUT bodies/response shapes remain compatible. Store CAS is authoritative; weak/wildcard/list/foreign-authority preconditions fail412. Unknown/unobserved consumer application remains explicit rather than claiming upload/cleaner convergence.
- Gateway now parses the exact `KALA_SETTINGS_WRITE_PROTOCOL=legacy-compatible|conditional-required` setting before external initialization and forwards it into both locked stores. Required mode rejects a missing precondition with428 `client_upgrade_required`; conditional callers keep their legacy JSON bodies. Legacy UI surfaces the upgrade explanation rather than save success. No product activation or environment change was made.
- Unified policy tasks reuse the existing `Policies` forms and the same conditional client as Runtime settings. Their value/ETag pair is read together, conflicts and lost responses retain drafts, explicit reconstruction is cancelable, failed reconstruction does not unmount the draft, and mutations are never replayed. A post-commit intervening writer cannot be silently rebased by a second automatic load. A bounded30-second request signal classifies uncertain submitted writes conservatively. Policy route/read/write capabilities are action-specific, not inferred solely from Owner role.
- Task queries now include the authenticated target scope, role and policy subtask; teardown also removes former organization/invite/deployment queries. React StrictMode's simulated cleanup no longer destroys the reinstated active target cache. Actual browser coverage runs inside StrictMode.

Reproducible commands (no dependency installation):

```sh
TMPDIR="$PWD/.settings-test-work" pnpm --dir packages/runtime-ingress-gateway exec vitest run --exclude '**/dist/**'
env -u DOCKER_CONTEXT DOCKER_HOST=unix:///var/run/docker.sock \
  KALA_RUN_POSTGRES_INTEGRATION=1 TMPDIR="$PWD/.settings-test-work" \
  pnpm --dir packages/runtime-ingress-gateway exec vitest run --exclude '**/dist/**' \
  src/bin/control-schema-upgrade.integration.test.ts src/organizations/settings.integration.test.ts
TMPDIR="$PWD/.settings-test-work" pnpm --dir packages/dashboard exec vitest run \
  src/features/settings src/features/admin/AdminCenter.test.tsx \
  src/session-routing.test.tsx src/use-session-cache.test.tsx
env -u DOCKER_CONTEXT DOCKER_HOST=unix:///var/run/docker.sock \
  KALA_RUN_POSTGRES_INTEGRATION=1 TMPDIR="$PWD/.settings-test-work" \
  node scripts/dashboard/verify-settings-local.mjs
pnpm --filter @agent-kernel/runtime-ingress-gateway build
pnpm --filter @agent-kernel/dashboard typecheck
pnpm --filter @agent-kernel/dashboard lint:style
git --no-pager diff --check
```

Final policy batch results: all **258** Gateway source unit tests passed (28 separately gated integration cases skipped), **seven** real PG cases passed, **203** selected Dashboard cases passed, and **19** sandboxed Chrome checks passed. The separately enabled real delivery-worker suite passed **nine** cases. The later overlapping conditional-client selector passed **11** cases, including rejection of a second concurrent mutation before dispatch; repeat the full Dashboard selector for its updated total. Counts overlap previous selectors and must not be summed. Gateway Vitest selectors explicitly exclude compiled `dist` tests to avoid double-counting. Complete source histories and the successful comparison of all45 preserved baseline identities are recorded in `.settings-test-work/settings-schema-histories.source.json`; that receipt does not identify a packaged bridge image.

The browser helper optionally creates its own isolated `postgres:16-alpine` fixture, uses the actual Gateway HTTP handler/authenticated fictional file-session authority and actual `PostgresOrganizationStore`, and removes the fixture afterward. It proves retention conflict/reload/save, commit-plus-truncated-response uncertainty without replay, and attachment conditional persistence. Its single namespaced TS loader preserves one coherent Gateway module graph; separate `tsImport` graphs would create distinct error-class identities and are not production module behavior. Evidence is `.settings-test-work/browser/evidence.json` and `retention-real-postgres.png`. This is real loopback/PG/SQLite behavior, **not actual public HTTPS, real IdP, native SILO, cleaner execution, uploaded-object acceptance or production evidence**. Normal final Dashboard packaging must still be repeated by the main agent against the completed clean source.

### 25.7 Per-Unit graceful maintenance prerequisite

The Runtime service now distinguishes `quiesceUnit` from the existing immediate suspension/lease-loss retirement. Quiescence synchronously withdraws one Unit, shares its actual checkpoint wait, then closes it and releases its existing placement/membership. It never loads an absent Unit just to drain it. Pending first loads are included, failed checkpoints remain fenced, ordinary catalog reconciliation cannot clear a maintenance fence, and explicit resume cannot supersede a newer concurrent quiescence. The registry fence survives close until explicit resume. Existing lease-loss close still interrupts an unfinished checkpoint instead of converting it into a successful drain.

The native loopback Unit now returns the same in-flight drain promise to concurrent callers; the former second-call early return was not evidence that its first checkpoint had completed. Existing protected lifecycle `action=resume` uses the explicit resume path; no unauthenticated maintenance endpoint was introduced.

```sh
TMPDIR="$PWD/.settings-test-work" pnpm --dir packages/host exec vitest run \
  src/tenant-runtime/unit.test.ts src/tenant-runtime/service.test.ts \
  src/tenant-runtime/control-api.test.ts
pnpm --filter @agent-kernel/host typecheck
```

Result: **36** cases and Host typecheck passed. This includes real Socket.IO/Host/LLM-fixture execution: an in-flight call remains connected while its Unit waits, another organization's HTTP endpoint remains available, the checkpoint is released before retirement, and explicit reconstruction restores routing. Additional cases exercise activation/quiescence and resume/newer-fence races and failed checkpoints. No Session lease duration, tool allowlist or ownership protocol changed.

This is a prerequisite, **not completion of C02**. Durable policy authority, protected fresh policy reads, cross-database transition/reconcile receipts, startup acknowledgements and actual Private Cloud composition remain implementable source gates in §25.4. No new schema was added by this batch; the exact bridge histories in §25.3 remain unchanged. Layout remains disabled, and no production or image-packaging action was taken.

### 25.8 Immutable Webhook business configuration and actual local browser acceptance

Control migration15 is `0015_immutable_webhook_bindings.sql`, SHA-256 `10ecb0338412d625770ffe21a1a3f56b1d9b85397c5ee86feca48cb9a86ca4f9`. Existing migration identities remain unchanged: the regenerated `.settings-test-work/settings-schema-histories.source.json` matches all33 Runtime and12 control baseline rows preserved by the main agent. This source-tested bridge accepts exactly Runtime33/34, control12/13/14/15 and the explicit Portable4/5 modes. It still has **no packaged immutable bridge identity** and is not rollout authorization.

The new authority backfills valid organization-local references without changing their JSON or delivery generation, disables invalid legacy references with a repair diagnostic, and adds immutable signing-key bindings, endpoint revisions and a serialized100-enabled cap. The database independently rejects a bound endpoint whose reference differs from its immutable binding. Rebinding, URL changes and disable/re-enable advance delivery generations. Existing worker generation fencing remains intact. Unknown legacy topics can be disabled but cannot be re-enabled as newly accepted topics.

The opt-in Private Cloud Gateway composition validates installation/recovery/schema/origin prerequisites and exposes paged sanitized endpoint and binding projections, registered producer topics and scoped conditional item PATCH. Same-origin mutation, fresh role checks and the exact existing worker destination policy apply. Dedicated rejects installing this authority. `KALA_WEBHOOK_MANAGEMENT_ENABLED=1` is the specified business-editor opt-in, not proof of worker readiness and not activation of the unfinished Settings layout. Configured support is never presented as a worker heartbeat.

The real form uses the immutable organization/Origin request authority, binding IDs rather than references, changed-subset PATCH with returned ETags, bounded explicit pagination, response identity validation, retained drafts and a synchronous duplicate-save fence. Failed reconstruction preserves the old draft; response loss never replays the mutation. Saving sends no synthetic business event. Delivery counts are historical, explicitly not consumer readiness.

Validated commands:

```sh
TMPDIR="$PWD/.settings-test-work" pnpm --dir packages/dashboard exec vitest run \
  src/features/settings/sections/WebhooksSection.test.tsx src/features/settings/target-request.test.ts
env -u DOCKER_CONTEXT DOCKER_HOST=unix:///var/run/docker.sock \
  KALA_RUN_POSTGRES_INTEGRATION=1 TMPDIR="$PWD/.settings-test-work" \
  pnpm --dir packages/runtime-ingress-gateway exec vitest run --exclude '**/dist/**' \
  src/webhooks/settings.integration.test.ts src/bin/control-schema-upgrade.integration.test.ts \
  src/organizations/settings.integration.test.ts
env -u DOCKER_CONTEXT DOCKER_HOST=unix:///var/run/docker.sock \
  KALA_TEST_WEBHOOK_DELIVERY=1 TMPDIR="$PWD/.settings-test-work" \
  pnpm --dir packages/runtime-ingress-gateway exec vitest run --exclude '**/dist/**' src/webhooks/outbox-worker.test.ts
env -u DOCKER_CONTEXT DOCKER_HOST=unix:///var/run/docker.sock \
  KALA_RUN_POSTGRES_INTEGRATION=1 TMPDIR="$PWD/.settings-test-work" node scripts/dashboard/verify-settings-local.mjs
TMPDIR="$PWD/.settings-test-work" pnpm --dir packages/runtime-ingress-gateway exec vitest run --exclude '**/dist/**'
pnpm --filter @agent-kernel/runtime-ingress-gateway build
pnpm --filter @agent-kernel/dashboard typecheck
pnpm --filter @agent-kernel/dashboard lint:style
```

Results: **11** focused Dashboard cases, **16** actual PG cases including nine new Webhook cases, **nine** actual worker cases, **22** sandbox-enabled Chrome checks, and **258** Gateway unit cases passed;37 separately gated cases were skipped in the last unit-only selector, not counted as passed. Typecheck/style/Gateway build passed. The first browser run exposed a missing allowlisted request route; that real defect was fixed and covered by target-request tests before successful acceptance. The Portable draft fixture now waits for observable dirty/save state before requesting reconstruction.

Browser evidence remains `.settings-test-work/browser/evidence.json`; added `webhooks-390.png` and `webhooks-1440.png`. The fixture uses actual local PostgreSQL, actual Gateway browser-session/role/Origin handling and sandboxed Chrome156, with fictional identities and a loopback Origin. It proves create/no-test-event, CAS retention, post-commit truncated response handling, member downgrade denial and responsive layout. It is **not** public HTTPS, real IdP or production worker evidence. The binding-maintainer role in these tests is not the completed C05 Operator CLI/authority. C05, C02 and live C07 consumer observations remain source gates; layout remains disabled.

### 25.9 Typed Operator journal, CLI and separately restricted database identity

Control migration16 is `0016_operator_settings_authority.sql`, SHA-256 `b96d609259abb5815fab93d87e3c4d5c7fac034f250e86d031c35cc361f9689e`. It adds the Operator-only journal and default-Operator model-policy rows, monotonic pool/entitlement counters and metadata-preserving workspace revision triggers. Existing writers, including compatibility Gateway writers, advance those counters. Token/storage limits use exact PostgreSQL numeric values; positive safe-integer limits retain exact legacy numeric DTOs. The owning-row triggers and source-tested bridge preserve both old behavior and new metadata across supported rollback writes.

`kala-control-plane-settings` now implements protected-file Inspect/Plan/Apply/Verify/Revert, complete authenticated plan binding, fresh dependency comparison, organization/resource scopes, scoped installation/database identity, durable operation-ID deduplication, atomic resource/revision/audit/journal commit, and linked inverse operations at a new revision. Expired/altered/wrong-installation plans remain rejected. Creation of an immutable signing binding is irreversible; changing its reference is rejected. Pool rebind rejects newly appearing enrollment references; workspace archival refuses to proceed without the protected reference/maintenance authority. Metadata-only Verify explicitly reports `not-applicable`, not consumer effectiveness. Operational effects remain pending without the actual installed consumer observation. A real binding delivery at the matching endpoint generation can supply delivery evidence; saving never manufactures one.

The initializer accepts a **distinct** `KALA_SETTINGS_OPERATOR_ROLE`, removes direct table/column grants before granting only enumerated resource columns and journal/audit operations, and validates effective authority. Real-role tests reject inherited/excess authority and prove that the browser-serving Gateway cannot read the Operator journal or mutate model policy/bindings. No migration owner credential is reused by the CLI.

Validated:

```sh
env -u DOCKER_CONTEXT DOCKER_HOST=unix:///var/run/docker.sock \
  KALA_RUN_POSTGRES_INTEGRATION=1 TMPDIR="$PWD/.settings-test-work" \
  pnpm --dir packages/runtime-ingress-gateway exec vitest run --exclude '**/dist/**' \
  src/settings/operator.integration.test.ts src/webhooks/settings.integration.test.ts \
  src/bin/control-schema-upgrade.integration.test.ts src/organizations/settings.integration.test.ts
TMPDIR="$PWD/.settings-test-work" pnpm --dir packages/runtime-ingress-gateway exec vitest run --exclude '**/dist/**'
pnpm --filter @agent-kernel/runtime-ingress-gateway build
pnpm --filter @agent-kernel/host typecheck
TMPDIR="$PWD/.settings-test-work" pnpm --dir packages/host exec vitest run src/http/settings-projections.test.ts
```

Results: **24** actual PG cases including **eight** new Operator cases passed. The new suite spawns the actual separate CLI process with protected fictional profile/secret/plan files and a real restricted PostgreSQL login; it exercises all five commands, explicit exit4 for persisted-but-unverified Apply, installation claims, scope denial and new-revision Revert. Actual failure injection proves row/counter/audit/journal rollback together. The full Gateway unit selector passes **260**, with45 separately gated cases skipped; the actual worker selector still passes **nine** after16. Gateway build, Host typecheck and **two** focused Host projection cases pass. The latter preserve an explicitly nullable projected default while retaining the legacy `/models` empty-string wire; they do not prove Private Cloud model-policy composition.

Two related decimal-accounting tests prevent large budget/threshold values from rounding through JavaScript Number. Safe legacy values remain numbers; larger exact values are decimal strings. This does **not** install a quota-admission consumer or reclassify reported-only metadata as enforced.

**Still open source gates, not external blockers:** C02's protected policy read/reconcile/activation/startup protocol and actual Private Cloud composition; the Runtime workspace-reference endpoint used by archive maintenance; and real consumer observations for operational Operator effects. Model-management Apply deliberately returns an explicit maintenance-unavailable failure rather than changing effective policy unsafely. Therefore this batch is **not full C05/C02 completion** and does not authorize enabling the layout or migrating production. No packaged bridge digest, production action or physical-OS acceptance is claimed. The exact source receipt now includes control1–16 and still matches all45 preserved baseline identities; images limited to15 are not rollback targets after16.

### 25.10 Durable model-policy authority and actual Private Cloud composition

This batch supersedes §25.9's statement that model-policy composition is missing; it does **not** close its separate workspace/operational-consumer gates. The shared strict wire contract, protected Gateway reader, uncached identity-bound Runtime policy client, Runtime35 durable encrypted reconciliation/fences/append-only drain and startup receipts, actual pre-routing handshake and typed Operator coordinator are now wired into the serving source. Fresh policy failure or an in-progress transition fences model calls, writes and projected configuration/capabilities. The explicit `null` default remains unconfigured; no deployment model/key is copied or used as fallback.

Operator Apply commits desired revision/operation/required serving identities and audit in control PG before any Runtime effects. The coordinator gracefully drains each persisted required identity, reconciles the encrypted tenant authority/monotonic fence/receipt in one Runtime transaction, advances control effective policy to awaiting-runtime, resumes with the exact operation, and requires actual startup observations before activation. A vanished/expired required member is not a drain ACK. Unit maintenance is owned by its operation: an unrelated model or ordinary lifecycle resume cannot clear that in-process fence. Failed/unreachable maintenance remains pending; inverse maintenance creates another operation/revision and retains the exact encrypted organization catalog.

Full parsed Profile digest is authenticated in each Plan, including every approved additional Runtime Origin and protected credential reference. Protected transport checks exact approved Origins **before** resolving credentials, rejects redirects, bounds response bytes and sanitizes upstream failures. Real loopback tests prove an unapproved/redirect Origin receives no service credential. Model provider/model deletion's existing persisted-Session-reference guard now covers both hosted products, without changing Session selected models or tool allowlists.

Reproducible validation, with no production access:

```sh
pnpm --filter @agent-kernel/shared build
pnpm --filter @agent-kernel/host typecheck
pnpm --filter @agent-kernel/runtime-ingress-gateway build
pnpm --dir packages/runtime-ingress-gateway exec tsc -p tsconfig.integration.json
TMPDIR="$PWD/.settings-test-work" pnpm --dir packages/runtime-ingress-gateway exec vitest run \
  --exclude '**/dist/**' src/settings/operator-plan.test.ts src/settings/model-policy-transport.test.ts
env -u DOCKER_CONTEXT DOCKER_HOST=unix:///var/run/docker.sock \
  KALA_RUN_POSTGRES_INTEGRATION=1 TMPDIR="$PWD/.settings-test-work" \
  pnpm --dir packages/runtime-ingress-gateway exec vitest run --exclude '**/dist/**' \
  src/settings/model-policy.integration.test.ts src/settings/operator.integration.test.ts
```

The bounded cross-database fixture uses actual control and Runtime PostgreSQL, separately restricted roles, the existing pinned SILO image for actual required S3 stores, native Unit lifecycle/HTTP and a reconstructed separate CLI process using protected fictional files. **Seven** model/maintenance and **nine** Operator cases pass; **six** plan/transport cases pass. The model fixture proves lost responses after Runtime reconciliation commit and actual startup, resume of the same durable operation, linked inverse/re-enable, preserved ciphertext, explicit empty/null configuration, fresh consumer verification after actual LISTEN termination/recovery and rejection of browser identity on protected native endpoints. A persisted native Session model reference prevents both incompatible policy planning and Private Cloud Provider deletion; concurrent Apply/progress of one operation produces one transition receipt and one activation audit. Additional cases prove reconstructed progress after control preparation, a lost durable drain acknowledgement, interruption before Runtime reconciliation and before startup; fresh capabilities stay fenced, and the same operation yields one reconciliation receipt and activation audit. A required unavailable replica remains in the durable drain set after its actual membership is released; no drain receipt or policy activation is fabricated. Workspace inspection proves actual suspended-Unit references and fail-closed archival (§25.12), not completed durable workspace maintenance. These bounded reconstructions are not hard process termination at every instruction boundary, a complete multi-process/multi-member crash matrix or an immutable packaged rollback test. Cross-package integration source has its own explicit no-emit typecheck; the normal Gateway build no longer attempts to emit imported Host source into its source tree.

### 25.11 Installed integration sources and actual ordered local Agent observations

The old control-store literals claiming local secrets/session-JSONL artifacts and absent telemetry are removed. A scoped Gateway endpoint and Runtime projected integration section now report installed adapter sources separately, with explicit nullable configured state, independent health, observation time and reason. Installed does **not** mean connected. Gateway cannot claim Runtime-owned artifact health; unavailable resolver/worker/delivery health stays unknown. Error-reporting/ticketing have no wired adapter and are reported as such, not as an editable fictional integration. Portable and hosted credential source observations come from their actual SQLite/PostgreSQL composition. The Settings integrations task displays these observations through the immutable target request context; the legacy Admin tab no longer interprets an unknown string as boolean “connected.” No credential/path/DSN is exposed.

Agent PG writes emit tenant-scoped invalidation in the same transaction. Each actual subscriber serializes reconciliation, reports disconnected/synchronizing/ready, and rereads after every LISTEN reconnect. Native Runtime wires these notifications into the existing ordered prompt/Desktop policy refresh, preserving child instructions, MCP selection and allowlists. Actual completed refreshes capture a stable before/after authority revision; busy Sessions remain pending until the next safe turn. The projection lists only genuinely loaded root-Session observations and reports local scope/unknown overall rather than fabricating ACKs for unobserved/unloaded Sessions or other serving replicas. Notification loss immediately invalidates effective/ACK readback; a historical matching revision is not readiness.

```sh
env -u DOCKER_CONTEXT DOCKER_HOST=unix:///var/run/docker.sock \
  KALA_RUN_POSTGRES_MIGRATION_INTEGRATION=1 TMPDIR="$PWD/.settings-test-work" \
  pnpm --dir packages/host exec vitest run src/tenant-runtime/postgres-agent-settings.integration.test.ts
TMPDIR="$PWD/.settings-test-work" pnpm --dir packages/host exec vitest run \
  src/server.test.ts src/tenant-runtime/service.test.ts src/http/settings-projections.test.ts
TMPDIR="$PWD/.settings-test-work" pnpm --dir packages/dashboard exec vitest run \
  src/features/settings/IntegrationStatus.test.tsx src/features/admin/AdminCenter.test.tsx
TMPDIR="$PWD/.settings-test-work" pnpm --dir packages/runtime-ingress-gateway exec vitest run \
  --exclude '**/dist/**' src/edge/server.test.ts
pnpm --filter @agent-kernel/dashboard typecheck
pnpm --filter @agent-kernel/dashboard lint:style
```

The new actual-PG case passes with a baseline33 unversioned write, expansion to35, DML-only Runtime login, **two real native HTTP/Session consumers**, committed updates, actual notification-backend termination, a write during the gap and reconstruction. A real Socket.IO model turn is held while a new revision commits; its Session observation remains pending without interrupting the turn, and the next safe turn receives the new revision. These two consumers use local Session authorities and are not a claim that two distributed Session owners or full serving-set convergence was exercised. The existing native server/Session selector passes **193** cases, including allowlist/child/MCP preservation. Integration UI/legacy Admin pass **12** cases; Gateway loopback source/authorization/health separation passes **40** cases. Listed builds/types/style checks pass. Logs are `.settings-test-work/current-{agent-consumer,host-server,gateway-server,policy}-tests.log`.

Remaining implementable source gates remain explicit in §25.4, especially workspace-reference maintenance, operational Operator consumer verification and complete serving-set/action-role coverage. The layout remains disabled. No image, deployment, production/LXC/credential action, commit, push or additional agent was performed.

### 25.12 Suspended workspace-reference inspection and deployment configuration sources

**Historical intermediate checkpoint:** the inspection-only limitation and unfinished-source statements in this subsection describe the earlier35/16 snapshot. Section25.13 records their implemented36/17 replacement; they are not current deployment instructions.

The protected native `/internal/settings/workspace-references` endpoint now reads the actual Runtime PG authority. It requires the exact installation/organization/Unit/workspace identity, service credential and absence of browser identity. A repeatable-read transaction checks authoritative suspension, no live replica memberships, durable Session projections and unresolved Workspace effects. The revision hashes that actual snapshot. Idle/unknown persisted Sessions remain active references; expiration or disappearance of a membership is never interpreted as their completion. The native fixture first observes503 while active, performs the real graceful drain, persists authoritative suspension and then observes the durable blockers.

**This is an inspection snapshot, not a durable reservation.** A concurrent explicit lifecycle resume is not excluded across the subsequent control-PG transaction. Accordingly it returns `maintenanceHeld: false`; the typed Operator refuses archival with exit4/`workspace_maintenance_reservation_unavailable`, even when the snapshot has no active references. The actual separately restricted Operator fixture proves that this refusal leaves every workspace active. The response is not a feature flag or evidence that maintenance passed. An operation-bound durable hold and actual workspace admission consumer are still required source work; do not remove this refusal based on an instantaneous empty snapshot.

The former `deployment/configuration` fallback is replaced with a real typed read-only adapter. Portable composition reports its actual protected model/Agent JSON authorities, encrypted SQLite and loaded Hooks; native composition reports its actual tenant model/Agent/credential stores and loaded protected Hooks. It exposes fixed sanitized source references, observed time and separate nullable desired/local-effective revisions, never raw files, loaded Hook commands, secrets, DSNs or guessed Session/replica application. Approved maintenance examples are locally allowlisted references to the existing protected import/Operator CLI; the browser cannot execute or submit them. Missing observations explicitly remain unavailable. The route uses the existing page-projected services endpoint and immutable target context, not the broad settings snapshot.

Current reproducible checks, in addition to §§25.10–25.11:

```sh
env -u DOCKER_CONTEXT DOCKER_HOST=unix:///var/run/docker.sock \
  KALA_RUN_POSTGRES_INTEGRATION=1 TMPDIR="$PWD/.settings-test-work" \
  pnpm --dir packages/host exec vitest run src/tenant-runtime/settings-revisions.integration.test.ts
TMPDIR="$PWD/.settings-test-work" pnpm --dir packages/executor exec vitest run \
  src/mcp-config.test.ts src/mcp-settings-protocol.test.ts
TMPDIR="$PWD/.settings-test-work" pnpm --dir packages/host exec vitest run \
  src/tenant-runtime/runtime-hooks-provisioning.test.ts src/tenant-runtime/runtime-hooks.test.ts \
  src/extensions/hooks.test.ts src/tenant-runtime/service.test.ts src/http/settings-projections.test.ts
TMPDIR="$PWD/.settings-test-work" pnpm --dir packages/dashboard exec vitest run \
  src/features/settings/DeploymentConfiguration.test.tsx src/features/settings/IntegrationStatus.test.tsx \
  src/features/settings/routes.test.ts src/features/settings/target-request.test.ts
env -u DOCKER_CONTEXT DOCKER_HOST=unix:///var/run/docker.sock \
  KALA_RUN_POSTGRES_INTEGRATION=1 TMPDIR="$PWD/.settings-test-work" \
  node scripts/dashboard/verify-settings-local.mjs
env -u DOCKER_CONTEXT DOCKER_HOST=unix:///var/run/docker.sock \
  KALA_RUN_POSTGRES_INTEGRATION=1 KALA_TEST_WEBHOOK_DELIVERY=1 TMPDIR="$PWD/.settings-test-work" \
  pnpm --dir packages/runtime-ingress-gateway exec vitest run --exclude '**/dist/**' --maxWorkers=2
env -u DOCKER_CONTEXT DOCKER_HOST=unix:///var/run/docker.sock \
  KALA_RUN_POSTGRES_INTEGRATION=1 KALA_RUN_POSTGRES_MIGRATION_INTEGRATION=1 TMPDIR="$PWD/.settings-test-work" \
  pnpm --dir packages/host exec vitest run --maxWorkers=2 src/postgres-migrations.integration.test.ts \
  src/tenant-runtime/model-policy-state.integration.test.ts src/tenant-runtime/postgres-agent-settings.integration.test.ts \
  src/tenant-runtime/settings-revisions.integration.test.ts
pnpm --filter @agent-kernel/shared build
pnpm --filter @agent-kernel/executor build
pnpm --filter @agent-kernel/host build
pnpm --filter @agent-kernel/host typecheck
pnpm --filter @agent-kernel/dashboard typecheck
pnpm --filter @agent-kernel/dashboard lint:style
```

Results: the corrected Runtime33/34/35 real-PG revisions/bridge suite passes **three**; Executor MCP/config passes **11**; Hooks/native maintenance/projections pass **40**; Dashboard source/routing/target cases pass **14**. The **complete Gateway suite now passes316 with no skips**, including seven actual model/maintenance, nine Operator, actual worker delivery and all other separately gated PG suites. The combined Runtime migrations/model-state/Agent/revisions selector passes **17**, all four suites exercised. These supersede the earlier unit-only263/51-skipped and smaller model/Operator selectors. The first complete run exposed the contract authorization fixture's obsolete two-migration hand-built schema; it now uses the real complete migrator/history and proves all three principals' temporal admission plus protected background rechecks on control16, rather than inventing the missing column. The sandboxed Chrome156 fixture passes **23**, including actual page-projected SQLite-serialized JSON revision rendering with unknown effective state; evidence remains `.settings-test-work/browser/evidence.json`. The fixture remains fictional loopback HTTP, not production/native SILO/public HTTPS/real IdP evidence. Listed build/type/style commands pass. Authoritative current complete-suite logs are `.settings-test-work/current-all-gateway-real-tests.log` and `.settings-test-work/current-all-runtime-settings-pg-tests.log`; earlier failing/narrower logs are retained, not counted as current success.

All45 production-preserved baseline version/name/checksum identities were compared again with the current source receipt and match exactly. Runtime35/control16/SQLite5 checksums and bridge packaging/rollback constraints remain §25.3; no migration statement changed in this batch. The Runtime revisions fixture's old expectation34 was corrected to35; all three real cases now run under `KALA_RUN_POSTGRES_INTEGRATION=1` rather than being silently skipped under the migration-only flag. Failed cross-package emit artifacts have been removed from Host source; cross-package tests retain their separate no-emit typecheck.

This evidence does **not** close the remaining source gates in §25.4. The unified layout stays disabled. Immutable bridge packaging, old/new packaged rollback, native/public TLS Owner acceptance and production rollout belong exclusively to the main agent; no such action was performed here.

### 25.13 Completed source adapters, durable maintenance and final local acceptance

This subsection supersedes the source-incomplete35/16 checkpoint in §25.12. The requested operation-bound hold, operational consumers, serving-set association, full51-action coverage and actual Portable App entry are now implemented, not optional substitutes or metadata-only success. The normal layout default remains `legacy`; the main agent controls installation acceptance and activation.

#### Durable workspace hold and actual operational consumers

`tenant-runtime/workspace-references.ts` now reserves the inspected suspended Unit/workspace for the exact installation, organization and durable Operator operation. It serializes against actual Workspace admission, rechecks references in the reservation transaction and persists the reference snapshot/revision before returning. There is no expiring “maintenance lease.” A matching repeated operation recovers its existing hold; another identity/revision cannot steal it. Active/unknown durable Sessions and unresolved Workspace effects still block reservation; disappearing replica membership is not proof of completion.

Runtime36 SQL guards fence lifecycle resume/reassignment, live membership admission, active Session projection and Workspace-effect admission while held. Terminal Session bookkeeping can finish without reopening admission. Control17 independently rejects competing workspace mutations during the durably prepared operation. The restricted Operator prepares its journal, acquires the Runtime hold, rechecks the full plan/dependencies, commits the control change and invokes the real Runtime consumer. A lost reservation/consumer response remains pending; reconstructed `verify` resumes that same operation without duplicate activation/audit or mutation replay. Consuming archival atomically installs Runtime workspace-admission state and marks the hold committed; an actual linked inverse installs a newer active revision before admission reopens. A stopped operator cannot leave a window where lifecycle resume bypasses the held reservation.

Workspace/pool/contract verification uses the installed protected native authority client, not a local success constant. Pool binding is enforced by fresh Gateway admission on actual Native enrollment, reconnect and tool-effect authorization; contract activity also reaches the existing real principal admission path. A durable registry record is never an online signal. The UI joins the exact workspace/device identities with the Native live snapshot and pages the registry without replacing either identity.

Native invitations preserve the existing seven-day Native lifetime rather than the old control routing hint's fifteen-minute placeholder. New canonical bindings are organization+Native-invite scoped and idempotent: the same hash cannot reset usage/revocation. Create/regenerate mirror exact expiration; rotation retains private enrollment/invite metadata; regeneration can re-enroll the same revoked Native ID into one registry row. Invitation-record deletion preserves an already enrolled credential, whereas explicit revoke/regenerate revoke the bound credential. Historical pre17 routing hints retain their original compatibility semantics only after Native independently validates the invitation; new17 bindings enforce exact expiration. Native sensitive-management and browser Origin/role guards remain in force.

The actual control/Runtime PG fixture uses separately restricted roles, real native Unit lifecycle/HTTP/Socket.IO and the existing pinned SILO image only for required isolated S3 stores. It verifies:

- Loss after durable reservation leaves the control workspace active and the Runtime hold held; actual lifecycle resume, organization reassignment and active Session admission fail closed.
- A separate restricted CLI is actually `SIGKILL`ed after reservation/before control commit. Another CLI reconstructs from the protected profile/journal, commits once, consumes the hold and produces one applied audit event.
- Actual post-consumption response loss remains pending until reread; archival denies real admission and a linked inverse at a new revision restores it.
- A second separate CLI is actually `SIGKILL`ed after durable Runtime model reconciliation. Durable progress/startup response loss reconstructs the same model-policy transition, retaining encrypted organization configuration and never falling back to shared keys.
- Real Native enrollment, pool reassignment restrictions, contract denial/inverse, reconnect, credential rotation/regeneration and record-versus-device revocation consume current authority rather than historical control readiness.

These are real process/database boundaries, not exhaustive SIGKILL injection at every instruction or immutable packaged rollback evidence.

#### Serving-set convergence and immutable Portable targets

`tenant-runtime/settings-serving-set.ts` joins observations against **all current existing serving memberships**, scoped by organization/Unit/resource/replica/generation. Publications must match the existing membership token/origin and a live generation; observer IDs and monotonic publication sequences reject displaced/stale writes. A membership renewal without a current observation, missing consumer or disconnected subscriber yields unknown; a current mismatched/synchronizing consumer yields pending. Applied requires every current consumer ready at the desired revision. Model/Agent native composition publishes actual local consumer observations. This adds no Session ownership lease, timeout or allowlist expansion.

The real-PG Agent fixture runs two actual native HTTP/Session consumers. It verifies their complete serving-set convergence, a real held model turn deferring its Session refresh until the next safe turn, actual LISTEN-backend termination/write-during-gap/recovery, membership generation replacement and rejected stale publication. A real independent consumer cannot disappear from the required model drain set merely because membership expires/releases.

Portable now opts into the unified shell through actual Runtime bootstrap metadata and the normal Dashboard `App`, not only a directly mounted test component. Hosted Runtime metadata cannot override authenticated Gateway layout authority. Bootstrap URL parsing is pure across React StrictMode's double initializer; credential removal occurs in a layout effect after both captures, preventing the previously observed credential-loss bug. Selected target changes fence/cancel old reads and remount drafts. Native invitation delete/regenerate, restart/abort/polling, Push/device operations and connection probes now use the same immutable selected request transport. An explicit different connection-test draft does not receive the selected target's cookies or bearer.

#### Full inventory and behavior coverage

`settings/action-matrix.integration.test.ts` exercises the **actual Runtime capability producer, actual Gateway capability producer, ownership-aware merge, hash parser and navigation registry**: all51 inventory entries across48 product×role×model-source×Webhook combinations, plus all16 Settings and seven Admin legacy destinations (**71 cases**). Dedicated Owner/SILO and Private Cloud Owner-transfer privileges are checked separately; an organization role does not acquire Operator authority. Contextual personal/Session/Operator entries remain contextual rather than being fabricated as organization capabilities.

| Inventory | Source/action evidence in addition to the matrix |
|---|---|
| P01–P14 | Existing Interface/Notifications/Connection/Account/native bridges, `SettingsDialog.test.tsx`, `app-toolbar.test.tsx`, immutable transport/UI observation tests and browser storage-failure/retry/reload. Physical Push/OS/IdP delivery remains separate acceptance. |
| A01–A11 | Reused model/Agent/execution/Search/Speech/MCP/Hook/engine forms; real PG/SQLite CAS, model transition/consumer tests, actual native Hooks lifecycle, Executor patch/dedup tests and browser conflict/lost-response readback. |
| W01–W04 | Scoped registry/detail APIs, actual Native live join and HTTP invitation mirroring; real Native enrollment/rotation/reconnect/pool admission tests. Shared installation behavior is retained; installer-plan assertions do not prove physical OS isolation. |
| S01–S04 | Existing Composer/Session detail remains authoritative; native server/Session regressions retain model/tool/child/MCP allowlists and ordered safe-turn refresh. Settings does not request new Session ownership merely to render. |
| T01–T10 | Real PG/Gateway role/invitation/Owner/service-account/attachment/retention/usage/storage/audit/Webhook authorities; actual worker delivery and browser conditional-write/Owner-confirmation/Webhook lifecycle evidence. Unsupported retention fields remain rejected, not fake editors. |
| D01–D04 | Actual scoped diagnostics/native transport tests, typed source observations, services/native entrances and guarded fixed same-Origin SILO iframe. Local RTT ACKs are not a public user-path diagnosis. |
| O01–O04 | Protected deployment source boundary and typed Profile/Plan/Change/apply/revert/verify CLI, exact real-role grants and maintenance journal. Browser organization roles cannot mutate infrastructure or perform upgrades. |

Real paged PG tests found and fixed microsecond timestamp loss in member/pool/browser-session/audit cursors; all four now retain full PG precision and cannot silently omit same-timestamp rows. The browser fixture renders all55 actual paged PG pools, distinguishes historical registration from liveness and opens an exact scoped workspace detail. UI tests independently reject foreign workspace/device pairs and prevent viewer-only registry enumeration.

#### Reproducible final checks and artifacts

All commands below use existing locked dependencies; no dependency/image download or installation was needed. Scratch and browser profiles stay inside `.settings-test-work`. Docker invocations target only uniquely owned disposable local fixtures with `--pull never`; tests remove them. Source suites exclude emitted `dist` tests rather than double-counting stale compiled test copies.

```sh
TMPDIR="$PWD/.settings-test-work" pnpm --dir packages/shared exec vitest run --exclude '**/dist/**'

env -u DOCKER_CONTEXT DOCKER_HOST=unix:///var/run/docker.sock \
  KALA_RUN_POSTGRES_INTEGRATION=1 KALA_TEST_WEBHOOK_DELIVERY=1 TMPDIR="$PWD/.settings-test-work" \
  pnpm --dir packages/runtime-ingress-gateway exec vitest run --exclude '**/dist/**' --maxWorkers=2

env -u DOCKER_CONTEXT DOCKER_HOST=unix:///var/run/docker.sock \
  KALA_RUN_POSTGRES_INTEGRATION=1 KALA_RUN_POSTGRES_MIGRATION_INTEGRATION=1 TMPDIR="$PWD/.settings-test-work" \
  pnpm --dir packages/host exec vitest run --maxWorkers=2 \
  src/postgres-migrations.integration.test.ts src/tenant-runtime/model-policy-state.integration.test.ts \
  src/tenant-runtime/postgres-agent-settings.integration.test.ts src/tenant-runtime/settings-revisions.integration.test.ts

TMPDIR="$PWD/.settings-test-work" pnpm --dir packages/host exec vitest run --maxWorkers=2 \
  src/store/state-store.test.ts src/store/settings-file.test.ts src/store/settings-file-cli.test.ts \
  src/runtime-config.test.ts src/http/settings-preconditions.test.ts src/http/mcp-settings-routes.test.ts \
  src/http/settings-projections.test.ts src/store/executor-identity.test.ts \
  src/tenant-runtime/model-policy-client.test.ts src/tenant-runtime/runtime-hooks-provisioning.test.ts \
  src/tenant-runtime/runtime-hooks.test.ts src/extensions/hooks.test.ts src/tenant-runtime/service.test.ts src/server.test.ts

TMPDIR="$PWD/.settings-test-work" pnpm --dir packages/host exec vitest run \
  src/store/executor-identity.test.ts src/tenant-runtime/model-policy-client.test.ts src/http/executor-installation-routes.test.ts
TMPDIR="$PWD/.settings-test-work" pnpm --dir packages/executor exec vitest run src/mcp-config.test.ts src/mcp-settings-protocol.test.ts
TMPDIR="$PWD/.settings-test-work" pnpm --dir packages/dashboard exec vitest run \
  src/features/settings src/runtime-capabilities.test.ts src/session-routing.test.tsx src/app-toolbar.test.tsx

env -u DOCKER_CONTEXT DOCKER_HOST=unix:///var/run/docker.sock \
  KALA_RUN_POSTGRES_INTEGRATION=1 TMPDIR="$PWD/.settings-test-work" node scripts/dashboard/verify-settings-local.mjs

pnpm --filter @agent-kernel/shared build
pnpm --filter @agent-kernel/host build
pnpm --filter @agent-kernel/host typecheck
pnpm --filter @agent-kernel/executor build
pnpm --filter @agent-kernel/runtime-ingress-gateway build
pnpm --dir packages/runtime-ingress-gateway exec tsc -p tsconfig.integration.json
pnpm --filter @agent-kernel/dashboard typecheck
pnpm --filter @agent-kernel/dashboard lint:style
git --no-pager diff --check
```

Final results: **95 Shared;391 complete Gateway;17 actual Runtime PG/migration/consumer;282 focused Host;11 Executor;226 Dashboard tests passed.** The extra Native identity/installation selector passes **24 with one pre-existing gated case skipped**; that skip is not claimed as physical OS acceptance. The Gateway suite has no skips and includes10 actual cross-database model/operational cases, restricted Operator/bridge cases,71 inventory cases and actual Webhook delivery. Shared's old plan fixture was corrected to include the now-required protected-profile digest; the schema was not relaxed. All listed builds/typechecks/style checks pass, including the dedicated no-emit cross-package integration check.

The sandbox-enabled **Chrome/156.0.8078.4** browser fixture passes **25 checks** against real loopback HTTP/Socket.IO/SQLite and, with the flag above, actual Gateway/PostgreSQL. It verifies the actual normal Portable App entry, selected-target credential isolation, storage failure/retry/reload, projected source observations,55-row registry pagination/detail, real conditional CAS and lost committed response, one-time credential navigation, Owner confirmation and actual Webhook create/edit/conflict/lost-response/revoke lifecycle. Its Vite fixture explicitly pre-crawls the real App/lazy dependencies to prevent development optimizer reloads during mutation; it waits for enabled form controls before physical keyboard replacement. Unimplemented fixture API routes return404 instead of falling through to a developer-configured Runtime proxy. It does not fake a successful ACK or mutation.

Authoritative logs: `.settings-test-work/final-{shared-tests,gateway-tests,runtime-pg-tests,host-unit-tests,native-identity-tests,executor-tests,dashboard-tests,browser}.log`; build/type/style logs use `final-{shared-build,host-build,host-types,executor-build,gateway-build,integration-types,dashboard-types,dashboard-style}.log`. Browser evidence/screenshots are `.settings-test-work/browser/evidence.json` and adjacent PNGs. These are fictional loopback identities/native-document fixtures, **not** real SILO/public TLS/IdP/production Owner acceptance. Failed earlier iterations are not counted as current success.

#### Exact bridge, rollout ordering and remaining external evidence

The final compiled-source receipt `.settings-test-work/settings-schema-histories.source.json` records Runtime1–36/control1–17. All45 preserved Runtime1–33/control1–12 baseline version/name/checksum entries were again compared with `assert.deepEqual` and match. New identities, SQLite5 and reproducible bridge build commands are §25.3. No original migration was rewritten. `bin/control-schema-upgrade.integration.test.ts`, native operational/model fixtures, Host migration/revisions suites and Portable SQLite/JSON tests exercise baseline, exact expansion, post-expansion writes, retained ciphertext/counters and source-bridge reopen/rollback behavior under actual restricted roles. Control initializer grants remain exact allowlists; Runtime36 tables are Runtime DML authority, Operator-only control tables remain inaccessible to Gateway, and control17's fixed-search-path trigger function is not PUBLIC-executable.

Main-only deployment order: build/record immutable final Gateway and Runtime bridge images; accept them on baseline control12/Runtime33; deploy Gateway bridge before Runtime bridge with the approved `KALA_RUNTIME_AUTHORITY_ORIGIN`/existing protected credential; retain `legacy-compatible` protocol and legacy layout; expand the exact reviewed control17/Runtime36 set with reviewed grants; accept old/new image behavior and post-upgrade writes; then transition all writers deliberately to `conditional-required` and activate layout after installation acceptance. Rollback retains the compatible36/17-aware images and expanded schema/counters/JSON/MCP integrity state. Original33/12-only and earlier35/16-only digests are **not rollback targets** after36/17. There is no destructive schema downgrade.

Only external evidence remains open:

1. Main-agent immutable image packaging, final clean normal Dashboard build, baseline/expanded image/rollback rehearsal and controlled installation rollout. Earlier clean-source normal builds do not validate this final source snapshot; ignored old Desktop previews must remain untouched, not relabeled or bypassed.
2. Actual supported public HTTPS ingress/CA/IdP/Owner/native SILO login/object/API/assets/WS/cookie/logout acceptance. The main agent's isolated same-digest native CSP/browser and precise Caddy TLS/real-IdP candidate evidence is valuable but is not activation of production ingress or final production acceptance. The supported `MINIO_BROWSER_CONTENT_SECURITY_POLICY` with enforcing `frame-ancestors 'self'` remains required; no proxy header stripping or external-link-only substitution is authorized.
3. Supported physical OS/service/Push/Desktop/ACL/filesystem durability and trusted installation-asset acceptance; installation-specific protected mounts, SecretResolver, worker egress, native Hook dependencies and controlled replacement/backup-restore. Locally unavailable physical systems are not simulated as passing.
4. Actual user-path latency diagnosis across public/VPN/LAN, cold/warm and idle/active scheduling. Independent real RTT meanings and bounded loopback sampling are implemented/tested; one ACK sample is not that diagnosis.

No production/LXC/production-credential/real-user-Session access, immutable image build, deployment, commit, push or additional agent/workflow was performed by this implementation agent. Existing Session stability/performance changes remain integrated and retained.

### 25.14 Narrow installed-acceptance follow-up: deployment status and Personal RTT panel

The main agent deployed the preceding snapshot and independently reported real public HTTPS/Owner/native SILO acceptance. This subsection records **source-only follow-up fixes**, not a new production receipt or replacement for that evidence. The main agent appends its exact image/installation receipt separately.

**Deployment404 root cause:** `DeploymentSection` calls `/runtime/deployment/status`, originally the Dedicated slot-operator endpoint. `KALA_DEPLOYMENT_CONFIG` selects product architecture; it does not install a systemd slot operator or its status file. A supported externally managed/legacy Compose Runtime therefore explicitly returns `{"error":"Runtime route not found"}`. Gateway already had actual externally managed readiness at `/runtime/deployment/health`, but the canonical status path was only proxied, so the browser unnecessarily saw the unsupported-controller404 before its fallback. This was an adapter-contract mismatch, not a requirement to migrate the preserved Compose installation.

Gateway now resolves the canonical status read against the actual installed source. Valid native slot-controller status is preserved unchanged. An explicit Native unsupported-route404 selects the existing authenticated external-readiness implementation: actual protected Runtime readiness and, when configured, actual Dashboard HTML readiness, with independently reported Gateway/Runtime/Dashboard checks. It returns `kind: external` rather than fabricated slots, PIDs or deployment receipts. Genuine controller failures, malformed/unclassified404s and transport failures fail503 or preserve their non404 failure; they do not silently become healthy external status. Existing role/tenant/authentication checks remain in force, native probes carry only the protected handoff, and browser cookies are not forwarded. No schema, grant or installation topology changes.

**Personal RTT root cause:** unified `SettingsPage` rendered only `ConnectionSection`'s endpoint/HTTP-test controls. It mounted no connection-health entry/panel. The existing application-level `ConnectionStatusProvider` consequently remained in its intentional closed-dialog mode: one initial control ACK, then no five-second diagnostic schedule. The socket was not the wrong namespace; the required visible diagnostics consumer was missing. The old browser fixture opened a standalone popover and therefore had not exercised this actual Settings path.

The normal `App` now supplies `PersonalConnectionPanel` from the existing shared connection-health provider, and `SettingsPage` mounts it only on `personal/connection`. Its independent Device→Service and, when an actual workspace/ready route exists, Service→Executor rows reuse the actual existing control/Executor sockets, timestamps, freshness, history and measurements. A cold entry without a selected workspace measures only the control leg, never invents an Executor sample or obtains Session ownership to produce one. The inline entry participates in the **one shared** five-second/two-minute schedule even without an open dialog. Hidden-tab/failure stops, explicit manual measurement and unmount cleanup remain enforced. Opening a popover concurrently does not create another polling schedule; leaving the page stops application probes without closing the control socket.

**Native cookie/query prerequisites:** §14.2 now explicitly requires `Secure` native login/logout cookies at the canonical HTTPS boundary when upstream Console uses HTTP. `deploy/aspire/Caddyfile`, the existing authoritative public HTTPS proxy configuration, appends `Secure` only to SILO `Set-Cookie`, matching the main agent's independently accepted directive. Its `forward_auth` URI also explicitly clears the authorization subrequest query; otherwise native object APIs inherit their query into the strict Gateway authorization endpoint and fail405. The actual SILO upstream query remains intact, and Gateway's query rejection is unchanged. Native CSP/XFO, cookie values, Path/expiry/HttpOnly/SameSite and all other service responses are preserved. No identity-provider routing, Compose project, credentials or runtime topology was changed by this follow-up. The main agent separately reports completed public native bucket/object CRUD plus exact-byte download, fixture cleanup and logout; that production receipt is not a test performed by this source agent. Pinned native upload probes use the object path in `prefix` and the multipart field name as byte count; incorrect probe payload500s and empty-body logout422s must not be presented as native product failures.

Exact changed-file set relative to the preceding implementation handoff:

1. `packages/dashboard/src/app.tsx`
2. `packages/dashboard/src/features/settings/SettingsPage.tsx`
3. `packages/dashboard/src/connection-status.test.tsx`
4. `packages/runtime-ingress-gateway/src/edge/server.ts`
5. `packages/runtime-ingress-gateway/src/edge/server.test.ts`
6. `scripts/dashboard/verify-settings-local.mjs`
7. `deploy/aspire/Caddyfile`
8. `deploy/aspire/lifecycle_caddy_test.py`
9. `docs/architecture/dashboard/settings-administration-design.md`

Reproducible focused validation:

```sh
TMPDIR="$PWD/.settings-test-work" pnpm --config.verify-deps-before-run=warn --dir packages/dashboard exec vitest run \
  src/connection-status.test.tsx src/app-toolbar.test.tsx src/features/settings/observations.test.tsx
TMPDIR="$PWD/.settings-test-work" pnpm --config.verify-deps-before-run=warn --dir packages/runtime-ingress-gateway exec vitest run \
  --exclude '**/dist/**' src/edge/server.test.ts
pnpm --config.verify-deps-before-run=warn --filter @agent-kernel/dashboard typecheck
pnpm --config.verify-deps-before-run=warn --filter @agent-kernel/dashboard lint:style
pnpm --config.verify-deps-before-run=warn --filter @agent-kernel/runtime-ingress-gateway build
TMPDIR="$PWD/.settings-test-work" PYTHONPATH=deploy/aspire python3 -m unittest lifecycle_caddy_test.CaddySiloRouteTests
env -u DOCKER_CONTEXT DOCKER_HOST=unix:///var/run/docker.sock \
  KALA_RUN_POSTGRES_INTEGRATION=1 TMPDIR="$PWD/.settings-test-work" node scripts/dashboard/verify-settings-local.mjs
env -u DOCKER_CONTEXT DOCKER_HOST=unix:///var/run/docker.sock docker run --pull never --rm --network none \
  --env KALA_PUBLIC_HOSTNAME=fixture.invalid \
  --mount "type=bind,source=$PWD/deploy/aspire/Caddyfile,target=/fixture.Caddyfile,readonly" \
  caddy:2-alpine caddy adapt --config /fixture.Caddyfile --adapter caddyfile
git --no-pager diff --check
```

Results: **87 Dashboard tests,40 real Gateway HTTP tests and one Caddy routing-contract regression passed**, Dashboard types/style and Gateway build passed; existing style budgets unchanged. The additional inline tests verify27 seconds of separate control/Executor ACKs, one schedule shared with the popover, route cleanup and cold-entry/hidden-tab behavior. Gateway HTTP tests verify canonical Compose-style status200, live failing readiness, unchanged native slots, authenticated-only access, no cookie forwarding and non-masking of controller failure/missing status; the existing query-bearing SILO-authorization405 test still passes unchanged.

Sandbox-enabled **Chrome/156.0.8078.4 passes27 browser checks**, retaining the previous25 and adding actual canonical Gateway status rendering plus the **normal cold-entry App** Personal connection route. Over27 real seconds it receives **five additional actual `/dashboard` control ACKs**, opens no popover, sends no Session message, fabricates no Executor ACK and retains the same connected control socket after navigation while application probes stop. Both390px/1440px screenshots have no horizontal overflow. The fixture uses actual HTTP/Socket.IO/SQLite/Gateway/PG and a clearly fictional Native health/unsupported-controller HTTP source; it is not a second production/native OS acceptance. Offline Caddy adaptation with an already present image passes; no image was downloaded.

Logs are `.settings-test-work/settings-followup-{dashboard,gateway,dashboard-types,dashboard-style,gateway-build,browser,caddy-test}.log`; Caddy adaptation is `settings-followup-caddy-adapt.{json,log}`. The nine-file SHA256 freeze manifest is `.settings-test-work/settings-followup-source-receipt.json`. Browser evidence is `.settings-test-work/browser/evidence.json`, including `personalConnection.samples:5`, `/dashboard`, `intervalWindowMs:27000`, no selected Session, zero Executor samples and `controlSocketSurvivesNavigation:true`; screenshots include `personal-connection-{390,1440}.png`. Pnpm11's installed-module metadata reports a `dedupeInjectedDeps` mismatch; the documented `verify-deps-before-run=warn` avoids its attempted reinstall and runs the existing tools, not a product test/build bypass. No dependency or manifest was changed.

Rebuild/freeze **Gateway and Dashboard** for these source fixes. Runtime/Executor/shared schemas and all36/17/SQLite5 checksums remain unchanged; the preserved Runtime image need not be rebuilt for this follow-up. The source Caddy cookie rule already matches the main agent's reported live scoped rule; any installation action remains main-only. A new clean normal Dashboard build/immutable-image and actual public browser reacceptance are main-agent work. The independently reported sub-millisecond warm LAN HTTPS health and29–38ms control ACKs are not added or labeled ICMP latency; missing VPN reachability remains unverified. These source results do not close physical OS or user-path acceptance, and no production/LXC/credentials/messages/commit/additional agent action was performed here.

### 25.15 Installed Dedicated rollout and main-agent acceptance

The main agent completed the preserved Compose installation's upgrade and the installed-path follow-up. This section records that installation's evidence, not universal closure of every C01–C12 environment. The Compose project, canonical Owner, PostgreSQL cluster, SILO storage identity, existing public ingress CA and all71 pre-existing Session scopes were preserved. Both originally reported Sessions remain `done` with their existing projection versions; acceptance sent neither Session a message.

**Build identity and supply chain.** The clean source snapshots retain actual source revision `7c3c09054517b5efede993151a62812296095168` with explicit dirty-source provenance; they are not represented as a clean official public release. The normal Dashboard build, including its Desktop publication guard, passed without bypass. Production dependencies were packaged with `pnpm deploy --legacy --prod --offline`, self-reference links were relocated into the closed package, and every remaining symlink was checked for package closure. Images were built from the already-present digest-pinned bases with pulling and build networking disabled. No new dependency, image base or third-party tool was downloaded for this packaging.

The first rollout used the complete Runtime/Gateway packages, not `dist` copied over stale dependencies. The retained Executor update key signed the local Dedicated assets, its public identity matched the existing deployment and repository key, and local Dedicated release verification passed. The managed local Executor received the verified same-version patch in a separate retained generation through its normal drain/lock/health controls. Its previous generation remains available. The final nine-file follow-up changed neither Runtime, Executor nor schema identities and rebuilt only Gateway and Dashboard.

The final installed immutable images are:

| Component | Installed image identity |
|---|---|
| Gateway | `sha256:1dd474ad67bf11a98822019c0ed890dfd587bf654206528c245f7067fda3143d` |
| Runtime | `sha256:e6cbc6e7a06355d7c971c25cf040fb941bc1b5e32f1a8fef8fd1ff99f6e19dfa` |
| Dashboard | `sha256:5c1f3c1a58c5e636f308fcb49b1e2d1b10d84f03a80b3a6ceb1089366f89bd0c` |

These are component-specific frozen source identities. This evidence-only document append occurred after image construction and does not imply a subsequent Runtime/Executor rebuild or a new clean commit.

**Expansion and rollback.** Backups and exact migration histories were retained before changes. The36/17-aware Gateway and Runtime bridges were first made healthy on control12/Runtime33; only then were the authorities expanded to control17/Runtime36, followed by deliberate `conditional-required` activation and the unified Settings layout. All45 baseline migration identities were preserved. Real packaged-image PostgreSQL rehearsals exercised every supported exact control head12–17 and Runtime head33–36, restricted-role conditional writes/conflicts, retained pre-expansion writers, reconstructed bridge writes, revision advancement and checksum-drift refusal. The final Gateway image repeated the control12–17 rehearsal. The final Dashboard image independently served health, HTML and its actual referenced module asset as the non-root runtime user before activation.

The follow-up retained the preceding36/17-aware image pair as its compatible rollback target and changed only Gateway/Dashboard; unrelated container identities were checked unchanged. Rollback must retain the expanded authorities, counters and metadata, not restore a schema12/33-only image or downgrade the database. Protected receipts and backups reside under `/var/lib/kala/dedicated/migrations/settings-rollout-20261112/`; the follow-up image context, rehearsal and installed browser proof are under `settings-followup-images-20261112/`. Runtime's existing version-table DELETE grant was not represented as revoked; the Gateway's restricted authority and schema-history protections were checked separately.

**Actual HTTPS acceptance.** A sandbox-enabled existing Chrome156 browser reached the real canonical HTTPS ingress with TLS verification enabled and isolated trust for the existing public CA. There was no HTTP relay, certificate bypass, synthetic Owner or Session ownership acquisition. The final full sequence verified:

1. Existing OIDC Owner login and the original organization binding, authenticated Runtime capabilities200 and final Kala logout204. Precise public identity protocol routes reach the existing identity proxy without diverting Kala authentication, `/v2/*` or administration routes.
2. The real Settings entry, Personal/Instance configuration/Deployment groups,24 applicable read/navigation routes,390px and1440px layouts without horizontal overflow, and zero backend500 responses. Installed `/runtime/deployment/status` returns200 with `kind: external` and `ok: true`; this Compose installation is not falsely displayed as a native slot-operator deployment.
3. Native SILO inside the Settings iframe, its separate administrator login, native static assets and authenticated object browser. A unique acceptance-only bucket completed create200, upload200, list200, exact-byte download200, object deletion200 and bucket deletion204; existing buckets were untouched and the fixture was removed.
4. Native cookies retain HttpOnly and SameSite=Lax and are Secure at the public TLS boundary. The scoped SILO proxy appends Secure without rewriting cookie paths or stripping native CSP/X-Frame-Options. The supported native browser CSP permits same-origin framing. The SILO authorization subrequest explicitly clears its query with `/auth/silo/authorize?`, while the original upstream object prefix/upload/download queries remain intact and Gateway's strict authorization-query rejection remains unchanged.
5. Native logout200 restores its own login form and leaves Kala's Owner authenticated. Leaving the completed native task explicitly confirms the actual Settings leave dialog; merely assigning a new hash while that guard blocks navigation is not accepted as a Connection-page test.
6. On the exact visible Personal connection route, five additional wire-observed `/dashboard` ACKs arrived in27 seconds: **2.046,2.714,2.171,3.868 and2.336ms** (median2.336ms). Independent control/Executor descriptions were checked outside sidebar text. After leaving, no additional application probes arrived over6.5 seconds and the same measured control WebSocket remained open. No selected Session or invented Executor-hop sample was needed.

The first authenticated application ACK in that final run was29.462ms, distinct from the subsequent2–4ms steady-state measurements. The original single/stale initial value and the missing routed diagnostics consumer must not be presented as continuing LAN latency. This observation does not attribute every millisecond of the initial ACK to TLS or prove every device's network path. The earlier independent LAN HTTPS-health measurement had0.603ms warm median; it is a different measurement and is not added to application RTT.

Final read-only checks found all expected long-running Compose services running, declared health checks healthy and restart counters zero; the existing `observability-readiness` one-shot remains exited as intended. Dedicated/mount-broker services and the managed local Executor service are active. Controlled ingress restarts during this maintenance are recorded separately and are not denied by those restart counters.

**Evidence boundaries.** The full installed browser report is `installed-browser-acceptance.json` in the protected follow-up directory; its matching session artifact is `settings-production-full-acceptance.json`. Source UT/integration/browser evidence remains in25.13–25.14. Reading24 production routes is not a claim that all51 mutations were exercised against live user configuration. Physical Windows/macOS integrations, every remote/legacy Executor, native Console WebSocket operations, Push/OS permission combinations and every multi-replica failure scenario were not independently reaccepted by this installation run. Source fixtures and contracts do not substitute for those environments.

The browser used the canonical hostname/TLS origin with its address mapped to the actual ingress's LAN address. The current test VM has no working Tailnet client/path to the canonical default-DNS address; end-to-end VPN/user-device latency remains unverified. No VPN software, ACL change or unrelated machine reconfiguration was introduced to fabricate that result. The preserved legacy Executor container was not claimed to have received the managed local Executor patch. No commit, push or public release publication was performed.

## 26. Settings presentation contract

The installed acceptance in25.15 did not establish satisfactory information hierarchy or cover an existing user's actual external-Console path. Passing API, route-presence or document-overflow checks is not sufficient UI acceptance. The following rules supersede any earlier examples that expose long diagnostic disclaimers, compound navigation labels or raw registry records as the default view.

1. Navigation uses short functional nouns: Appearance, Notifications, Connection, Account, Members, Models, Workspaces, Integrations, Policies, Access, Diagnostics, Services, Object storage, Consoles and Configuration. Group names are Personal, Organization/Instance and Deployment. Storage implementation names do not belong in Kala's storage navigation or page title; the separately opened vendor UI retains its own branding.
2. Desktop group headings are16px/semibold and navigation items14px, with distinct group spacing and item indentation. Task headings remain visible on mobile. A collapsed desktop sidebar and the mobile44px picker must not erase the task's own heading.
3. Explanations use the existing accessible `HelpHint`: hidden by default, available on hover or keyboard focus and pinnable by touch. Connection timing semantics, bounded sampling and last-sample timestamps belong in the existing Connection information popup, not above the graph. The compact connection path, measured values, chart and meaningful status remain visible. Required errors, destructive-action warnings, one-time secrets and unresolved save outcomes must not be hidden as optional help.
4. Workspaces are grouped by their exact workspace identity, combining matching registry and Runtime observations once. Names are navigable primary content; short observation badges are distinct from persisted registration state. Pool and device directories use separately titled structured lists, not paragraphs of IDs, modes and revisions. Directory rows do not repeat opaque IDs: full workspace identity is labeled and copyable in its overview; complete authorized registry metadata is available through a contextual diagnostic-copy action. No join by display name, false liveness inference or change to authority/query scope is permitted.
5. Apply the same hierarchy to integration observations, configuration sources, Hook inventories, configuration-application receipts, usage, login sessions and audit records. Small sets of meaningful fields use visible labeled rows, not a disclosure for one to three values. Configuration and health are separate fields; desired and actually observed effective revisions remain distinguishable. Use contextual diagnostic-copy actions for complete nonsecret receipts, preserving consumer generations and loaded-Session observations without default raw dumps. A maintenance task may open a purposeful dialog, retaining its mandatory stop-process warning and allowlisted command. Larger optional code examples may use disclosures; disclosures are not a blanket policy for technical data. Explanatory scope caveats remain in information help. Do not remove information, errors or controls merely to produce a cleaner screenshot.
6. Narrow layouts use single-column content, wrapping row names/status/actions, visible section headings,16px form inputs and44px primary action targets. Task tabs scroll horizontally inside the existing skinned `ScrollArea`; the document itself must not scroll horizontally. Settings task content must opt into the shared `ScrollArea` block-content layout through `contentClassName`; Radix's default internal table layout can widen a form while the outer viewport silently clips it. Flexible form inputs must not impose their intrinsic character width on the task. The native Console retains both its internal scrolling and a reachable Kala toolbar at320px/390px widths.
7. Separate-window Console navigation starts through the authenticated fixed `/auth/silo/open` entry. It reuses the active Dedicated Owner check and returns an uncached303 to `/silo/`; it accepts neither query-selected destinations nor cross-origin authorization. This entry alone cannot defeat a legacy worker that intercepts both authentication and Console navigation. Dashboard bootstrap must never mount App on a native Console path, and the static Dashboard server must refuse those paths rather than return its SPA shell. A detected cached-shell mismatch provides deliberate application-file refresh using the existing scoped PWA recovery, never an unsolicited reload or deletion of login/conversation data. Native proxy authorization, separate administrator login and final native-document checks remain required.
8. Acceptance must click the actual external link into a new tab, assert its final native title/path and absence of the Kala Dashboard, and include an actively controlling service worker. It must also exercise an actually controlling legacy navigation-fallback worker, not merely inspect the current worker's denylist. It must compare computed heading/item sizes, verify help is absent until hovered, exercise diagnostic-copy fidelity and purposeful maintenance dialogs, check exact navigation targets and exercise mobile controls/scrolling. Screenshots of representative mobile and desktop tasks require visual inspection; absence of root overflow alone is not a pass.
9. User-message metadata follows the bubble in wrapping normal flow at every viewport. Timestamp, actions, scheduled provenance and timing must not occupy the message body or widen a short bubble. Do not position the timestamp above another absolutely positioned footer and estimate padding for their combined height. Real-renderer acceptance compares bubble/footer/timestamp rectangles at320/390/768/1440px with localized historical dates, short/multiline/unbroken text, large font, optional scheduled/timing metadata and auto/always/hidden timestamps. Copy/edit behavior and cancelled-turn details remain functional. Class-name assertions alone are not geometric acceptance.

Source and installed evidence for this remediation must identify their actual build and path. In particular, a successful canonical-origin LAN-mapped click cannot prove the previously unreachable Tailnet path or retrospectively establish the cause of the user's browser-specific redirect. Such limitations must be recorded rather than hidden behind a global acceptance claim.

## 27. Installed presentation-remediation receipt

The presentation remediation was installed in the existing `kala-dedicated-latest` Compose project. Final immutable images are Gateway `sha256:69256a35929dec612fa01ce5e394a8d20e7b1323360589e437320bfdd5216936` and Dashboard `sha256:1ab7f3fa40731240b2b7e55fb289eb2e4ed79ae872527bc126100fe2f7c9d685`. Runtime remains `sha256:e6cbc6e7a06355d7c971c25cf040fb941bc1b5e32f1a8fef8fd1ff99f6e19dfa`; this remediation performed no schema migration, Runtime replacement or Executor replacement. Runtime/control heads remain36/17. Protected rollout receipts retain the preceding compatible image pairs and the intermediate responsive-fix activation rather than rewriting the earlier history.

Each image carries its frozen `source-provenance.json`. Protected image contexts and exact-image checks are retained under `settings-ui-remediation-images-20261112/`, with the final Dashboard context in `responsive-final/`. Builds used the normal Dashboard publication guards, the existing locked dependency cache, offline production packaging and Docker `--pull=false --network=none`. No new tooling or third-party download was introduced. The exact Gateway image passed the isolated control12–17 bridge/permission/checksum rehearsal; the exact Dashboard image served health, HTML and its actual JavaScript entry asset as UID65532.

The source regression run passed214 Settings/connection/service-worker tests,24 existing navigation tests and40 Gateway HTTP tests. Dashboard typechecking, the unchanged style budgets and the29-check real-browser source rehearsal passed. The browser fixture now models theme search with a valid JSON response; a successful HTML fallback is not accepted as a theme API response. The actual mobile App header resolves Settings rather than displaying `appShell.nav.settings`.

Installed acceptance used Chrome156 with TLS verification enabled at the canonical HTTPS origin, resolving that hostname to the actual ingress LAN address. It inspected the real installed UI rather than a source fixture. Computed sidebar group/item sizes were16px/14px. All24 Settings read/navigation routes passed control-boundary checks at both320px and390px, permitting intentional nested horizontal scrollers but not a widened/clipped task viewport. Workspace cards,44px name targets, exact workspace-detail navigation and the reachable directory end were checked at320px,390px,768px and1440px. Representative desktop/mobile screenshots were opened and visually inspected. That inspection caught the intrinsic-width defect; the final build opts into block scroll content and constrains the theme search flex row.

Connection explanations and sample freshness were absent by default and present on an actual information-button hover. An actively controlling `/sw.js` was installed before clicking the actual separate-Console link. The uncached authenticated entry reached `/silo/login`, displayed the native login form and contained no Kala Dashboard. The embedded mobile native login inputs and submit action fit their own viewport. A separate complete installed run authenticated the native administrator, created an isolated bucket, uploaded/listed/downloaded byte-matching content, deleted the object/bucket and logged out. Existing buckets were not modified; native logout left the Kala Owner authenticated.

The complete installed run also obtained five additional control ACKs over27seconds and verified that leaving Connection stopped sampling for6.5seconds without closing the same control socket. The final run's samples were8.958,2.601,2.644,2.241 and2.346ms; these are application round trips, not an ICMP guarantee. No Executor leg was fabricated for the cold entry with no selected Executor route.

Final identity checks preserved the canonical Owner, PostgreSQL cluster, SILO storage identity, ingress CA and all71 pre-existing Session scopes. The two retained diagnostic Sessions remained `done` at versions19479 and6449, with no new messages sent. Unrelated Compose container identities were unchanged, declared health checks passed, the expected observability one-shot remained exited0, and the actual user-managed `kala-executor.service` remained active.

The installed full acceptance, visual acceptance and screenshots are retained separately; a later visual inspection does not overwrite the earlier CRUD/probe evidence. Default-DNS access to the Tailnet address still timed out from this machine after installation. Therefore the original user's browser/Tailnet redirect was not reproduced and its unique cause is not established by this receipt. The fixed entry and its verified LAN-mapped path must not be presented as proof of that unavailable client path. No commit, push or public release publication was performed.

## 28. Mobile message and small-record follow-up receipt

The preceding acceptance missed overlapping user-message timestamps and did not justify the repeated small metadata disclosures. User metadata now follows the independently sized bubble in wrapping normal flow at every viewport. This removes the nested absolute-positioning/padding assumption and prevents a timestamp or action row from widening a short bubble. Workspace, pool and device directories no longer contain per-record technical disclosures. Workspace identity, Hook source/revision/time and configuration sources use labeled fields; configuration receipts and integration cards separate their meaningful states and preserve full nonsecret observations through diagnostic copying. Protected maintenance has a deliberate dialog with the existing mandatory warning and allowlisted command.

Dashboard bootstrap now refuses to mount App at `/silo`, `/silo/*` and `/auth/silo/open` when a Dashboard shell was incorrectly served there. The static Dashboard server returns an uncached503 for those native paths instead of its SPA fallback. An explicit recovery action uses the existing scoped PWA refresh; it does not automatically reload other work or delete login/conversation data. A failed or timed-out iframe releases its native-operation interruption hold when it is removed.

This hardening has a reproducible legacy-worker regression, **not an established diagnosis of the user's browser**. The browser test installs an actually controlling navigation-fallback worker that returns cached Dashboard HTML for both native entry paths. Separate isolated cases exercise embedded mismatch detection, removal of the wrong frame, explicit application refresh, standalone bootstrap recovery, arrival at the native-document fixture and preservation of unrelated caches/local preferences. The fixture is not SILO, real OIDC or a Tailnet transport.

The source run passed339 focused chat/Settings/PWA tests, four actual static-server/network-shell tests, Dashboard types/style budgets and the normal frozen Dashboard build. The31-check sandboxed Chrome156 rehearsal included real isolated PostgreSQL pagination/conditional-write cases and32 actual ChatPanel geometry combinations at320/390/768/1440px. Those combinations covered English/Chinese, historical dates, short/multiline/unbroken text, enlarged type, scheduled/failed/cancelled metadata and auto/always/hidden timestamps. Copy and edit exercised the actual fictional message. Representative screenshots were visually inspected. Product sources match the frozen image inputs; a subsequent test-driver-only change isolated the two legacy-worker cases in separate browser contexts.

Only Dashboard was replaced, with immutable image `sha256:19321ca4cca76c2dd3567e893109c6e7f9012aae2fff75f99d07a5c8ea8544d4`. The existing trusted base, locked dependencies and Docker `--pull=false --network=none` were retained. No package installation, schema migration, Gateway/Runtime/Executor replacement or storage conversion occurred. The exact candidate served health, HTML and its real entry asset as UID65532 and refused native SPA fallbacks. Protected rollout registration `uiMobileFollowup` preserves the previous compatible Dashboard image without overwriting earlier rollback records.

Installed acceptance again used the canonical TLS hostname **explicitly mapped to the production ingress over LAN, not default-DNS Tailnet transport**. All24 Settings read/navigation routes had no clipped controls at320/390px. The six actual workspace rows had44px name targets and fit320/390/768/1440px; diagnostic-copy identities matched actual overview navigation. Installed mobile/desktop screenshots were visually inspected. With an actively controlling current worker, both native Console entries reached `/silo/login`, not Dashboard. The native administrator login, isolated bucket upload/list/download with byte equality, object/bucket deletion and native logout passed; existing buckets were untouched and the Kala Owner remained authenticated. Connection obtained five further real ACKs and stopped after leaving without closing its control socket.

Post-upgrade checks preserved the canonical Owner, PostgreSQL cluster, SILO storage identity, ingress CA and all71 baseline Session scopes;73 scopes currently exist. The two retained diagnostic Sessions were `done` at versions19479/6500. Read-only event-name/timestamp inspection established that the latter's additional events predated this Dashboard replacement; this run sent neither Session a message and did not rewrite their histories. The managed user Executor service remained active; Dashboard was healthy with zero restarts and unrelated container identities were unchanged.

**Still unresolved:** direct default-DNS access to `agent.taile63bf3.ts.net` timed out again from this machine. Consequently this receipt cannot claim that the user's actual `/silo/` failure is fixed or uniquely caused by a legacy worker. Actual client-path evidence is required to distinguish stale application delivery from a different ingress route. The mobile/layout rollout is complete; that user-path investigation remains open. No commit, push or public release publication was performed.

## 29. Retained identity/browser entry routing correction

The user subsequently reported an actual `503` / `native_console_route_unavailable` response at `/silo/`. That is evidence of a native request reaching the Dashboard server, not proof of stale browser storage. Investigation identified a second browser entry that the preceding direct-ingress acceptance did not cover:

- The public443 ingress already authorized and proxied `/silo` to the native service.
- The retained compatibility forwarder sends browser requests to `identity-proxy:8080`. That proxy preserved login, identity protocols, Console metadata and the default Gateway route, but lacked the native storage route.

Authenticated browser navigation through the retained compatibility/identity chain reproduced the exact503 and JSON error before activation. A request using the generic `Accept: */*` instead returned a Runtime404; it was not an adequate reproduction of browser navigation. The corrected probe uses HTML Accept and independently opens an actual new browser tab. Both reproduced503. This establishes the omitted downstream route; it does not establish which external transport the user's browser used to reach it.

### 29.1 Required routing and generation contract

Every Dedicated browser entry that can serve the Settings application must implement the same native storage boundary, including the retained identity/browser proxy. A correct443 ingress does not compensate for an alternate entry's missing route.

The existing identity renderer now accepts the explicit CLI flag `--dedicated-silo-console`, equivalent to `{ dedicatedSiloConsole: true }` in its exported function. Generate a Dedicated identity/browser configuration using the existing authoritative Console environment and canonical HTTPS origin:

```sh
node scripts/deploy/render-identity-console-caddy.mjs \
  --public-origin https://identity.example \
  --environment existing-console-environment.json \
  --dedicated-silo-console
```

The renderer writes configuration to stdout; validate and install that output using the deployment's protected configuration procedure. Do not invent a Console client ID, change the existing issuer, overwrite existing identity routes or enable this opt-in for an unrelated Private Cloud profile. Without the flag, rendering is unchanged.

The additional route precedes the default Gateway fallback, redirects `/silo` to `/silo/`, performs Gateway authorization at `/auth/silo/authorize?`, strips only the native path prefix and proxies exclusively to `silo:9001`. The trailing question mark clears the authorization subrequest's query, not the original native API query. The Kala `ak_session` cookie is removed before proxying to storage; native cookies retain Secure, independent administrator login and logout semantics. Existing CSP/frame-ancestor restrictions remain authoritative. There is no new browser-selected upstream or authorization bypass.

### 29.2 Activation and evidence

An isolated candidate used the existing pinned Caddy image, production private network, real OIDC/Gateway and real SILO. Its adapted HTTP8080 routing was compared with the live identity proxy: removing only the new native route left the existing configuration equal after normalization of generated route-group names. The candidate passed the same browser acceptance before activation.

Production activation changed only `/var/lib/kala/dedicated/identity/Caddyfile`. It preserved the bind-mounted file's inode, owner and mode, fsynced the content and used Caddy's existing local administration API for a graceful same-container reload. Validation ran in the actual identity container before writing. A protected immutable backup and activation receipt are retained under `settings-silo-browser-routing-20261113`; activation failures restore the original bytes and reload. Session quiescence was required. Container IDs, images, start times and both retained Session versions/statuses remained unchanged.

| Entry and phase | Browser transport exercised | Result |
|---|---|---|
| Retained compatibility to original identity proxy | Canonical TLS hostname mapped to an isolated LAN TLS wrapper, forwarding to the actual existing compatibility container | Real Owner login succeeded; HTML request and new-tab navigation both returned native-route refusal503 |
| Candidate identity/browser proxy | Canonical TLS hostname mapped to an isolated LAN TLS wrapper and candidate proxy, using real existing identity/Gateway/storage | Anonymous native request401; Owner HTML request and new-tab navigation200 |
| Retained compatibility to installed identity proxy | The same baseline LAN TLS wrapper and actual compatibility container, now traversing the updated production identity proxy | Anonymous401; Owner native HTML and navigation200; embedded and separate native login; full native object acceptance passed |
| Existing public443 ingress after activation | Canonical TLS hostname explicitly mapped to the ingress LAN address, with its existing CA | Real Owner login and native HTML/new-tab navigation200 |
| Default-DNS Tailnet URL from this machine | No hostname mapping or TLS bypass | No HTTP response; final recheck failed TLS negotiation with an unexpected EOF |

Installed acceptance covered all24 Settings routes at320/390px and the actual separate-window control reached `/silo/login`, not Dashboard. It authenticated the independent native administrator, created an isolated bucket, uploaded/listed/downloaded byte-matching content, deleted the object and bucket, and logged out. Existing buckets were untouched and Kala Owner authentication survived native logout. The isolated candidate and installed runs used separate temporary buckets and both removed them.

The final renderer/identity-compose/bootstrap regression command passed19 tests. The protected post-install receipt confirms that the canonical Owner, PostgreSQL cluster, SILO storage identity, ingress CA and all71 baseline Session scopes were preserved;73 scopes currently exist. Dashboard, Gateway, Runtime and identity proxy were healthy with zero restarts. No software was installed, no image was pulled/rebuilt, and no schema or Executor change was required for this routing correction.

The baseline, candidate and installed browser reports are retained as `settings-silo-legacy-route-baseline-503.json`, `settings-silo-browser-route-candidate-acceptance.json` and `settings-silo-legacy-route-installed-acceptance.json`. The fixture driver's generic candidate-transport label is not an authoritative topology description for the baseline/installed runs; the explicit chain descriptions and results in this receipt define their scope. The direct ingress report is retained separately as `settings-silo-direct-ingress-final.json`.

The omitted production downstream route is fixed and its before/after behavior is reproduced. Default-DNS Tailnet transport remains unavailable to this machine; a successful LAN-mapped test must not be described as having exercised it. The user subsequently confirmed that the original URL now displays the native Console. That is user-reported actual-client confirmation, distinct from this machine's browser evidence. The user also rejected embedding the complete Console inside Settings and identified the missing administrator-login handoff; those are a new presentation/credential-access follow-up, not a recurrence of the routing failure. No commit, push or public release publication was performed.

## 30. Separate-window entry and explicit login handoff receipt

The user rejected embedding the complete native Console and explicitly approved allowing only the canonically bound Dedicated Owner to reveal and copy this installation's storage administrator username/password. The normative contract in §3 and §14 has been updated accordingly. Earlier embedded-console implementation and acceptance entries are historical receipts, not permission to reintroduce an iframe.

Settings now presents a short independent-login instruction, an Open console button and a structured Administrator login area. There is no native iframe or background native document fetch. Only Show login details initiates the protected credential POST. Username and password have separate labels and copy actions, Hide login details clears them, and tab hiding, navigation, identity/target changes or revoked capability remove them and abort pending work. Required instance-wide credential access warnings remain visible; additional scope explanation uses HelpHint.

Gateway uses the existing secret reader and authoritative installation secret files, not a second account or changed password. Both operator-configured file mounts are required and read-only. The protected host directory remains root-owned0700; only the two approved source files were granted root/65532 group read0640 for the existing non-root Gateway. The existing native username/password values were compared with the installed SILO environment without printing them. General profile/settings responses advertise only availability, not credentials.

The explicit endpoint checks Dedicated/native opt-in, POST/no query, exact Origin, a live authenticated Owner and active organization before reading, then the same current session/organization/Runtime unit/Owner after reading. It returns no-store/no-cache, sanitized failures and only the two approved fields. The captured Settings request authority separately allows this exact POST only for a same-Origin Dedicated Owner target. Initial installed acceptance caught the missing client allowlist entry before declaring completion; the correction has a component test using the real request-scope provider plus negative route/product/role/authority tests.

The final Gateway image is `sha256:3a86e9269134bdd2d0281d640682002bff8837e318c6afb55c0b17f8c36e4137`; Dashboard is `sha256:fe441bf29d86aa98e3184fa5051a35a896941f125467532da96a81aaede851fa`. Frozen sources, normal guarded production builds, the existing locked offline package store and trusted cached image bases were used. Docker builds disabled network and pulls. No package installation, schema migration, Runtime/Executor/SILO replacement, identity rewrite or password rotation occurred. The original compatible image pair and protected configuration/permission rollback records remain registered; the failed initial Dashboard candidate is recorded separately rather than overwriting rollback history.

Verification passed74 Dashboard/request-scope tests, three route-recovery tests and41 Gateway tests, plus type/style checks. The real sandboxed Chrome source run passed22 checks, including responsive storage entry and legacy-worker standalone recovery. Installed acceptance exercised both the actual retained compatibility/identity chain through a LAN TLS wrapper and the existing direct443 ingress with canonical-hostname TLS validation. Both covered24 Settings routes, actual username/password reveal, both copy actions, four viewport widths320/390/768/1440, native login using the credentials obtained from the UI, isolated bucket upload/list/download byte equality/deletion and native logout preserving Kala authentication. The direct run additionally verified no browser-storage persistence, no-store response headers, concealment on actual tab hiding and concealment after navigating away and back. The mobile launch/login-information screenshot was visually inspected; no real password was captured in that screenshot.

Post-install checks preserved the canonical Owner, PG/SILO/CA identities and all71 baseline Session scopes, with73 current scopes. Both retained diagnostic Sessions remained done at versions19479/6500. Gateway, Dashboard, Runtime, SILO and PostgreSQL were healthy with zero restarts; the actual managed user Executor service remained active.

Evidence is retained separately as `settings-storage-login-installed-retained-entry.json` and `settings-storage-login-installed-direct-ingress.json`. The fixture driver's generic candidate-transport label does not override the explicit retained-production-chain topology here. These HTTP/UI checks did not exercise the native object-manager WebSocket and therefore do not close the subsequently reported WebSocket failure.

## 31. Native WebSocket follow-up: reproduced layers and candidate evidence

The user's actual browser reported repeated failures at `/silo/ws/objectManager` after successful native login. A real authenticated browser through the retained compatibility chain reproduced that failure while native login returned204. Two independent omissions were established, not inferred from the console log alone:

1. The retained compatibility forwarder accepted only `/socket.io/` upgrades and destroyed native Console upgrade connections.
2. After adding a narrowly scoped native upgrade path in an isolated candidate, the handshake reached downstream but failed502. `forward_auth` inherited the native Upgrade headers, so its authorization subrequest was itself treated as a WebSocket instead of reaching the ordinary HTTP authorizer. Removing Connection/Upgrade only inside `forward_auth` corrected this second failure.

The candidate forwarder permits only GET WebSocket upgrades at `/silo/ws/<single endpoint>` for an explicitly registered browser Host, preserves the existing trusted upstream/route hint and forwards cookies/Origin/query unchanged to the guarded identity proxy. Other paths, unregistered authorities, traversal and inappropriate methods remain denied. Existing Socket.IO forwarding is unchanged. The actual native proxy still performs Dedicated Owner authorization; the compatibility hop does not authenticate storage users or grant access.

The isolated pinned-image candidate used the existing real OIDC, Gateway, native administrator credentials and SILO. Both the Console's natural object-manager connection and an independent browser probe completed101; the probe remained open for over2.2seconds. Real unauthenticated upgrade requests returned401 and foreign-Origin upgrade requests403. The candidate also passed native object CRUD, cookie/logout and control-connection regression. Additional actual read-only native navigation exercised Access Keys, Policies, Users, Groups, Metrics, Logs, Events, Tiering, Site Replication, Configuration, Trace and Watch; every triggered HTTP API returned200. No administrator configuration was changed by those page visits. This evidence does not assert that every optional streaming action was started or that an unexercised native feature is supported.

The final combined renderer/identity/bootstrap/forwarder run passed25 tests, including bidirectional upgraded bytes after the handshake, cookie/Origin/query preservation, restricted paths and propagation of downstream authorization failures. Before mutation, exact Caddy adaptation/validation, forwarder source-delta checks, immutable backups and rollback are required. Both actual ingress configurations and the mounted compatibility script must be updated in place without replacing their bind-mount inodes.

Production activation initially refused to proceed because one Session was executing tools. A bounded five-minute wait also refused to proceed; no protection was bypassed, no Session was canceled and no proxy file/process was changed by those refused attempts. The user then confirmed ending the task. The next quiescence check passed, and the main agent installed the tested changes.

The identity proxy was gracefully reloaded; the public443 ingress and retained compatibility forwarder were restarted in their existing containers. The three bind-mounted files retained their inodes and permissions, all container IDs/images were preserved, and other services were unchanged relative to the immediately preceding native-activation baseline. A reconciliation check additionally detected that several existing containers' start times had already changed between the older UI rollout receipt and this later activation baseline, with identical IDs/images/configuration/policy hashes. Those intervening observations were explicitly retained in deployment metadata rather than attributed to this proxy update or silently discarded.

Installed acceptance through the actual retained compatibility/production-identity chain obtained101 for both the native application's own object-manager socket and an independent authenticated browser probe; the latter remained open for over2.2seconds. Separate acceptance through the independently updated direct443 ingress produced the same natural/probe101 results. Both used the canonical hostname with verified TLS and explicit LAN mapping, not default-DNS Tailnet transport. Real missing-Owner and foreign-Origin upgrade requests remained401/403. The browser reported no native HTTP500s.

The retained-chain installed run repeated all24 Settings routes, actual username/password reveal/copy/conceal, mobile controls, independent native login, isolated object CRUD with exact-byte download, cleanup and native logout preserving Kala authentication. It also repeated the actual read-only native page visits listed above; every HTTP API triggered by those visits returned200. Merely expanding a navigation group was not counted as loading a child page, and Trace/Watch page entry was not claimed as having started every optional stream.

The final protected native activation receipt is `native-ws-activation.json`; separate browser evidence is `settings-native-ws-installed-full.json` and `settings-native-ws-installed-direct443.json`. Exact file hashes, unchanged images/IDs and the deliberately restarted proxy containers were verified. Canonical Owner, PG/SILO/CA identities and all71 baseline Session scopes remained intact, with73 current scopes. Declared service health checks passed, the actual managed user Executor remained active, all temporary candidate/TLS-wrapper containers were removed and the copied candidate route-hint configuration was deleted. Protected backups and only public fixture CAs were retained as evidence. No new software installation, image build/pull, schema migration, credential rotation, commit, push or public release publication was performed for this proxy-only follow-up.
