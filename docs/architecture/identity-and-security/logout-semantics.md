# Logout Semantics

**Status:** accepted product contract
**Scope:** Private Cloud deployment; Dedicated has no end-user login

## Product actions

### Sign out this device

- Revoke the current server-side browser Session durably.
- Best-effort revoke its Provider refresh token.
- Clear product cookies, product caches, active notifications, and background connections.
- Broadcast logout to other tabs using the same browser profile.
- Navigate to `/auth/login?prompt=login` and show a real login form; do not stop at an informational signed-out page.

### Sign out all devices

- Revoke every server-side browser Session for the same `(issuer, subject)`.
- Best-effort revoke each Provider refresh token.
- Clear current browser state and navigate to a forced login form.
- Other devices fail their next HTTP/WebSocket authentication immediately and transition to signed-out UI.

### Sign out identity provider

Provider-wide logout is an explicit separate action where the Provider supports an end-session endpoint. It first completes local `logout-all`, then redirects through the Provider end-session flow, and finally returns to forced product login. Product logout never claims that all unrelated Provider applications were signed out unless this flow completed.

## Required behavior

- Logout routes accept POST only and enforce same-origin requests.
- Revocation occurs before cookie clearing or Provider network calls.
- Missing/already-revoked cookies make logout idempotently successful.
- Background API requests return 401 and cannot silently recreate a product Session.
- Existing WebSockets cannot authorize new operations after server revocation.
- Login uses `prompt=login` after logout to prevent Provider SSO from silently returning to the application.
- Browser/PWA acceptance checks final login input, network request method/status, cookie deletion, API 401, cross-tab state, and cache cleanup.
