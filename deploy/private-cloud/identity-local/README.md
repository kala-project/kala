# Bundled localhost identity secrets

This overlay is only for a first install reached through HTTP loopback. It is source material for the private-cloud bundle, whose builder flattens this directory's `Caddyfile` to `identity-local.Caddyfile` beside the Compose files. Do not invoke the source overlay directly: its relative Caddyfile mount is intentionally resolved only in the generated bundle.

Set `KALA_IDENTITY_SECRETS_DIR` to an absolute operator-managed directory. The directory must be mode `0700`; every file must be a regular, non-symlink file with mode `0600` or `0400` and no trailing newline:

- `postgres_password`: at least 16 random bytes.
- `zitadel_masterkey`: exactly 32 random bytes, as required by ZITADEL.
- `initial_human_password`: at least 16 random bytes. ZITADEL creates `zitadel-admin` with this password and requires it to be changed on first login.

Use single-line, high-entropy printable values. The initial human password is read by the one-shot init container into a protected file-backed ZITADEL configuration; it is never placed in a Compose environment variable or container command. Keep the directory after installation for recovery, and protect it independently of Kala tenant storage.

The only published identity socket is the literal `127.0.0.1:13002`. Kala ingress reaches discovery internally at `http://identity-proxy:8080` while the public issuer remains `http://localhost:13002`.

## HTTPS Console over private h2c

The optional `single-origin.Caddyfile` also supports an operator-managed public
HTTPS origin with `KALA_IDENTITY_SCHEME=https`. In ZITADEL v4.16, with
`--tlsMode disabled`, the Console environment can still contain an HTTP `api`
URL even when its `issuer` is HTTPS. Forwarding `X-Forwarded-Proto` makes the
issuer correct but does not correct this API field. The HTTPS Console then
blocks its HTTP gRPC calls under its content-security policy (and browser
mixed-content rules); static HTTP 200 responses alone do not prove it works.

Inspect `/ui/console/assets/environment.json` through the identity proxy using
the public Host, and retain its existing metadata. If only `api` has the wrong
scheme, render a corrected single-origin Caddyfile offline:

```sh
node scripts/deploy/render-identity-console-caddy.mjs \
  --public-origin https://identity.example \
  --environment /operator/console-environment.json \
  > /operator/single-origin.Caddyfile
```

The input is the existing Console environment JSON, **not** enrollment secrets
or credentials (`--environment -` reads it from standard input). The renderer requires the issuer and API authority to match the
explicit public origin, preserves the existing Console client ID and every other
metadata field, and overrides only the exact environment endpoint with
`Content-Type: application/json` and `Cache-Control: no-store`. It does not change
the provider, app registration, issuer, human identities, or privileges.

Back up the active identity Caddyfile, validate the generated file with the
existing Caddy image, install it at the existing bind-mounted Caddyfile path,
then use `caddy reload` inside the identity proxy. No application or identity
service restart is necessary. Validate the served JSON and an actual authorized
Console session, including successful administrative gRPC status, before
considering the change complete. Do not disable CSP, mixed-content protection,
or TLS certificate verification.

**Persistence:** restarting or recreating Compose services preserves this fix
only while they retain that generated bind-mounted file. Copying the unrendered
source Caddyfile over it, regenerating the identity deployment, or changing the
Console client metadata does **not** automatically preserve/refresh the override.
Retain the protected environment snapshot and generated Caddyfile with operator
recovery artifacts; re-fetch authoritative metadata and re-render when replacing
identity configuration. The default HTTP-loopback template remains unchanged
unless this renderer is explicitly used.
