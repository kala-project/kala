# Authenticated Product Shell

## Problem

Authentication is not complete when OIDC returns successfully. A mature Private Cloud shell must make the active account visible and own the complete account-session lifecycle. Agent RunLab previously implemented identity provider integration and identity-to-`TenantRuntimeUnit` routing, but omitted this authenticated product layer.

## Boundaries

- ZITADEL authenticates users and owns passwords, passkeys, MFA, registration, and recovery.
- Private Cloud Gateway owns browser login sessions, safe profile projection, logout, expiry, and identity-to-Unit assignment.
- Dashboard owns account presentation, logout interaction, expiry UX, cache cleanup, and cross-tab synchronization.
- Host receives no user identity, email, profile, OIDC token, or Gateway cookie. It receives only trusted Unit routing headers.

## Gateway contract

### `GET /auth/me`

Authenticated response, always `Cache-Control: no-store`:

```json
{
  "authenticated": true,
  "profile": {
    "displayName": "RunLab Demo",
    "email": "runlab-demo@example.test",
    "initials": "RD"
  },
  "expiresAt": "2026-07-30T00:00:00.000Z"
}
```

Only presentation-safe fields are exposed. `issuer`, `subject`, Unit ID, tokens, roles, and routing keys are never returned.

Unauthenticated response is HTTP 200:

```json
{ "authenticated": false }
```

### `POST /auth/logout`

- Requires same-origin `Origin` when provided by a browser.
- Clears the local session and pending-login cookies.
- Returns HTTP 204 and does not automatically start a new login.
- Dashboard then renders a signed-out state with an explicit Sign in action.
- Provider-wide logout is a separate future action because it can sign the browser out of other ZITADEL applications.

## Dashboard product behavior

### Account trigger

The global shell always exposes an account trigger after identity bootstrap:

- avatar/initials;
- display name on wide layouts;
- accessible label containing the active account;
- loading skeleton while `/auth/me` resolves.

### Account menu

P0 entries:

1. identity summary (display name and email);
2. Account details;
3. Help & documentation;
4. Privacy & data on this device;
5. About/version;
6. Sign out.

### Logout transaction

1. POST `/auth/logout`.
2. Broadcast `logged-out` through `BroadcastChannel("agent-runlab-auth")` and a storage-event fallback.
3. Disconnect Dashboard sockets.
4. Clear identity-scoped IndexedDB session cache, React Query cache, sensitive in-memory state, notifications/badge, and selected-session state.
5. Navigate to `/signed-out`, preserving no tenant data in the rendered shell.

### Expiry and reauthentication

- Bootstrap and visibility changes revalidate `/auth/me`.
- A 401 or auth-specific Socket failure triggers revalidation.
- Expiry presents a blocking, accessible Session expired state with Sign in.
- Draft text remains in memory until the user chooses to leave; persisted tenant caches are not displayed while unauthenticated.

### Multi-tab behavior

Broadcast messages contain no profile or identifiers:

```ts
{ type: 'logged-out' | 'logged-in' | 'session-expired' }
```

Every receiving tab revalidates with `/auth/me`; broadcasts are hints, not authority.

## Acceptance matrix

- Desktop and mobile show who is signed in without opening Settings.
- Account menu is keyboard accessible and restores focus when closed.
- Account details show display name and email, never issuer/subject/Unit ID.
- Sign out clears the cookie, closes the authenticated shell, and does not immediately sign back in.
- A second tab signs out within one second and no longer renders cached conversations.
- A different user on the same browser Origin cannot see prior-user durable session cache.
- Expired sessions show `Session expired`, not a generic connection error.
- Host requests do not contain `ak_session`, profile claims, email, or OIDC tokens.
- Dedicated remains identity-free and does not show a fake account menu.
