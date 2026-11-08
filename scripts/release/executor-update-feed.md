# Executor signed update feed release gate

The final public release publishes `executor-update-manifest.json` and
`executor-update-public-key.pem` alongside `kala-executor.cjs`. The feed signs the
exact CJS bytes with Ed25519; `artifact.file` is `kala-executor`, the executable
name used by the managed updater after download. The numeric protocol range is
the major version of the shared wire protocol. The Portable Host must also
embed both feed files because `/install/assets` can be served without an
adjacent release directory.

Provision one **persistent**, operator-controlled Ed25519 PKCS#8 private PEM
as the encrypted Actions secret `EXECUTOR_UPDATE_PRIVATE_KEY_PEM` before
running `release.yml`. Keep the private key off Git, release artifacts and logs.
Do not regenerate it for each release: installed Executors retain the
verification key they received at install time. Key rotation needs an explicit
installed-client migration plan. Example local commands (use an existing
operator-managed key file, never a key in the repository):

```sh
node scripts/release/sign-executor-update-feed.mjs --directory release --private-key-file /secure/operator/executor-update-private.pem
node scripts/release/embed-windows-assets-in-portable-host.mjs --directory release --repo OWNER/REPO --tag v0.3.1 --expected-revision "$(git rev-parse HEAD)" --canonical-dashboard
pnpm run build:release-assets -- --component all --tag v0.3.1 --repo OWNER/REPO --finalize-only
cosign sign-blob --yes --bundle release/SHA256SUMS.sigstore.json release/SHA256SUMS
pnpm run verify:release-assets -- --require-signed
cosign verify-blob --bundle release/SHA256SUMS.sigstore.json \
  --certificate-identity "https://github.com/OWNER/REPO/.github/workflows/release.yml@refs/tags/v0.3.1" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com release/SHA256SUMS
```

Sign only **after** the canonical CJS and Windows assets are staged, **before**
embedding the final Host and finalizing checksums. The CI final job does this
automatically, then signs `SHA256SUMS` with Sigstore and runs the required
signed gate before uploading. The promotion workflow independently verifies
the signed feed and exact candidate inventory. Unsigned local partial builds
remain supported; `--private-cloud-runtime` deliberately rejects a signed
feed and cannot satisfy `--require-signed`.

For a **local Dedicated** deployment using the Linux x64 all-component CJS
stage, verify the unsigned stage first and sign its existing `/app/release`
directory with the same persistent operator key. This mode requires a closed,
checksummed Linux-only stage, updates its `SHA256SUMS`, and does not rebuild or
embed the Host. Use the resulting files from `/install/assets` directly:

```sh
pnpm run verify:release-assets -- --private-cloud-runtime
node scripts/release/sign-executor-update-feed.mjs --directory release \
  --private-key-file /secure/operator/executor-update-private.pem --local-dedicated
pnpm run verify:release-assets -- --local-dedicated
```

`--local-dedicated` does **not** make a public release: the default signer and
the public `--require-signed` gate still require the complete Windows final
inventory and the Sigstore checksum signature. Local verification requires both
feed files, validates the Ed25519 signature and the closed Linux-stage inventory
and checksums, and skips only the embedded Host feed comparison; it rejects
`--private-cloud-runtime` and `--require-signed` combinations.
