# Host Security Control Plane

Last updated: 2026-07-11

This document is normative for public or shared deployments. The host is a
control plane: it can read session history, drive LLM calls, route tool calls to
executors, mutate session metadata, and expose artifacts. It must not be
treated as a static dashboard server.

## 1. Boundary Model

The system has three security principals:

| Principal | Connects to | Authority |
|---|---|---|
| Dashboard operator | `/dashboard` and HTTP routes | Observes sessions, sends user messages, approves/rejects tools, changes runtime knobs. |
| Executor daemon | `/executor` | Executes tools for one workspace identity under a configured workspace root. |
| Host process | local filesystem and provider APIs | Owns sessions, settings, LLM adapters, audit log, and routing decisions. |

The executor remains an environment adapter. It does not know whether a tool
result enters the agent transcript. Kernel-facing tool calls and host-internal
RPCs are separated inside the host only.

## 2. Workspace Root And cwd

An executor can be started with one or more workspace roots:

```bash
node kala-executor.cjs --host https://host.example.com --sandbox-root /repo
```

`--sandbox-root` is repeatable. `SANDBOX_ROOTS` provides the same values as a
colon-separated environment variable.

Runtime rules:

1. The first root is the default workspace root.
2. A session `cwd` may be the root itself or any real path below one configured
   root.
3. Relative tool paths resolve against the session `cwd` when present, otherwise
   the first root.
4. Symlinks are resolved before the root check.
5. If no root is configured, the executor trusts the whole machine. This is
   acceptable only for local development; public deployments should always set a
   root.

The host should reject invalid cwd changes before recording `cwd_changed`. The
executor remains the final enforcement layer because it has local filesystem
truth.

## 3. Executor Identity And Onboarding

`workspaceId` is a routing key, not proof of identity. A public host must not
trust a workspace id solely because an executor announced it.

The product path is invite based:

1. Dashboard calls `POST /auth/executor-invites`.
2. Host returns a permanent invite token and stores only its hash.
3. The Connect Workspace modal renders one copyable command containing that
   invite.
4. The executor starts with `--invite <token>` and announces its `workspaceId`.
5. Host validates the invite, binds it to the announced `workspaceId` on first
   use, mints a long-term executor token, and persists only its hash.
6. Host returns the long-term token in `executor:welcome`.
7. Executor writes it to `~/.kala/executor-token` and uses it on later
   reconnects. If the operator starts the executor with `--profile <name>`, the
   token is stored under `~/.kala/profiles/<name>/executor-token`
   instead.

The operator never has to type a `workspaceId` or JSON token mapping.

The Dashboard has two invite creation paths:

- **Connect Workspace** creates a new permanent invite labeled
  `Connect Workspace` and renders a one-time copyable command. The invite does
  not expire; operators should revoke it from Settings when it should stop
  working.
- **Settings → Executor access** is the durable management surface. It lists
  invite summaries, creates labeled invites, edits labels and optional
  workspace pre-bindings, revokes invites, and regenerates token material.

The Dashboard can list, create, edit, revoke, and regenerate executor invites
through `GET/POST/PATCH/DELETE /auth/executor-invites` and
`POST /auth/executor-invites/:id/regenerate`. Invite list responses return only
summaries: id, optional label, optional bound workspace id, creation time, last
used time, and revocation status. They never return token hashes or plaintext
tokens; plaintext is returned only once from create/regenerate responses.
Revoking or regenerating a bound invite also removes the saved reconnect
identity for that workspace, so future reconnects must use a valid invite again.

The Dashboard can also list and revoke saved executor identities through
`GET /auth/executor-identities` and
`DELETE /auth/executor-identities?workspaceId=<id>`. These endpoints return
only identity summaries: `workspaceId`, optional label, creation time, and last
seen time. They never return token hashes or plaintext tokens. Revoking an
identity removes the host-side token hash; an already running executor may stay
connected until the socket drops, but its next reconnect must use a fresh invite.

The host also supports static token-scoped executor identities as an advanced
deployment escape hatch:

```json
{
  "tokens": [
    {
      "token": "ak-exec-secret",
      "workspaceId": "ws-prod-1",
      "label": "production repo executor"
    }
  ]
}
```

Rules:

1. Executor handshake token or invite is authenticated before `executor:announce` is
   accepted.
2. If a long-term token is scoped to a workspace id, the announced `workspaceId` must
   equal that scope.
3. If a valid unbound invite is used, the first announced `workspaceId` becomes
   the invite binding and the scope for the new long-term identity.
4. If the token is unscoped, the announced `workspaceId` is allowed but still
   audited.
5. A second live executor claiming the same workspace remains rejected.
6. Reconnect with the same executor id is allowed only after token validation.
7. When the host has an executor identity store configured, anonymous executor
   handshakes are rejected. A daemon must use an invite, a saved
   long-term token, or an explicitly configured static token.

This prevents an attacker from connecting a daemon and self-assigning someone
else's workspace id.

## 4. Dashboard Authentication

For local development, `KALA_AUTH_TOKEN` can protect dashboard and executor
Socket.IO handshakes. For public deployments, GitHub OAuth can be required.

Configuration is environment driven and surfaced read-only in `/settings`:

| Env | Meaning |
|---|---|
| `KALA_AUTH_TOKEN` | Shared bearer token fallback for local/private deployments. |
| `KALA_GITHUB_OAUTH_REQUIRED=1` | Require GitHub OAuth for dashboard and protected HTTP routes. |
| `GITHUB_CLIENT_ID` | GitHub OAuth app client id. |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth app client secret. Never returned in settings. |
| `GITHUB_OAUTH_CALLBACK_URL` | Public callback URL, e.g. `https://host.example.com/auth/github/callback`. |
| `GITHUB_USERNAME_WHITELIST` | Optional comma-separated login allowlist. |
| `KALA_AUTH_SESSION_SECRET` | HMAC secret for dashboard login cookies. |
| `KALA_EXECUTOR_TOKENS` | Optional JSON array of executor token scopes, for example `[{"token":"ak-exec-secret","workspaceId":"ws-prod-1","label":"prod"}]`. |
| `KALA_EXECUTOR_IDENTITIES` | Persistent executor identity file. Defaults to `~/.kala/executor-identities.json` when the host CLI is used. |
| `KALA_AUDIT_DIR` | Audit JSONL directory. Defaults to `~/.kala/audit` when the host CLI is used. |

When GitHub OAuth is required:

1. `GET /auth/github/start` redirects to GitHub.
2. `GET /auth/github/callback` exchanges the code, fetches the GitHub user, and
   creates an HttpOnly SameSite cookie.
3. HTTP JSON routes require a valid cookie.
4. Dashboard Socket.IO handshakes require the same valid cookie.
5. If a whitelist is configured, the GitHub `login` must match exactly.

Executor authentication is still token-based; GitHub users do not authenticate
executors.

## 5. Audit Log

The audit log is separate from session JSONL.

Session JSONL is the agent execution trace: reducer events, LLM responses, tool
calls, and replay/debug state.

Audit log is the control-plane accountability record: actor, action, target,
outcome, and security-relevant metadata. It should reference session JSONL by
`sessionId`, `sessionSeq`, `callId`, or artifact URI instead of copying payloads.

Audit entries are JSONL under `~/.kala/audit/audit-YYYY-MM-DD.jsonl` by
default. Each entry has this shape:

```json
{
  "ts": "2026-07-11T09:00:00.000Z",
  "action": "dashboard.user_message",
  "actor": { "kind": "github_user", "login": "alice" },
  "target": { "sessionId": "s1" },
  "outcome": "ok",
  "refs": { "sessionSeq": 42 },
  "metadata": { "messageBytes": 183, "mode": "steer" }
}
```

Do not copy LLM request/response bodies, complete user messages, or complete
tool output into audit entries. Store compact metadata and stable references.

Required audit actions include:

- dashboard login success/failure and socket accept/reject,
- executor socket accept/reject and announce accept/reject,
- session create/delete/fork/clear,
- cwd/model/approval changes,
- user approve/reject and user message metadata,
- internal tool RPCs such as file read/list and background task control,
- settings mutations,
- benchmark/enhancement HTTP actions.

## 6. Public Deployment Baseline

Public hosts should enable all of the following:

1. HTTPS/WSS behind a reverse proxy.
2. GitHub OAuth or equivalent external access control.
3. Token-scoped executor identities.
4. Workspace roots on every executor.
5. Audit logging.
6. Non-`allow_all` approval default unless the network boundary is private.
7. Origin restrictions and rate limits at the reverse proxy.

## References

[1] https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps
[2] https://docs.github.com/en/rest/users/users?apiVersion=2022-11-28#get-the-authenticated-user
