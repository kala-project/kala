# Executor signed update feed release gate

The final public release publishes `executor-update-manifest.json` and
`executor-update-public-key.pem` alongside `kala-executor.cjs`. The feed signs the
exact CJS bytes with Ed25519; `artifact.file` is `kala-executor`, the executable
name used by the managed updater after download. The numeric protocol range is
the major version of the shared wire protocol. The Portable Host must also
embed both feed files because `/install/assets` can be served without an
adjacent release directory.

Keep the **persistent**, operator-controlled Ed25519 PKCS#8 private PEM local.
The tracked `executor-update-public-key.pem` matches the verification key of
the current local Dedicated Executor. Check that other existing installations
trust this key before advertising this update to them. Do not regenerate the
private key for each release: key rotation needs an explicit installed-client
migration plan.
Build the complete Linux x64 CJS stage from the final clean revision, verify it,
then sign its `kala-executor.cjs` with the existing key. Put the base64 encoding
of the resulting public `executor-update-manifest.json` into the annotated
release tag message, in this exact form:

```text
Kala release candidate
Executor-Update-Manifest-Base64: <base64 of signed manifest JSON>
```

The tag must point to the exact commit used for the CJS build. CI stages the
envelope only after checking the tag object and revision, then verifies its
Ed25519 signature with the tracked public key and checks the canonical CJS
artifact size, hash, release version and protocol. The private key never goes
to GitHub or the published tag. Example local signing command for the verified Linux-only stage (use an
existing operator-managed key file, never a key in the repository):

```sh
pnpm run verify:release-assets -- --private-cloud-runtime
node scripts/release/sign-executor-update-feed.mjs --directory release \
  --private-key-file /secure/operator/executor-update-private.pem --local-dedicated
pnpm run verify:release-assets -- --local-dedicated
```

Base64-encode the resulting `release/executor-update-manifest.json` into the
annotated tag message shown above, with no other message lines. CI fetches the
complete tag object and fails if its commit, format, key, signature or Executor
CJS hash differs. CI alone embeds Windows assets and creates/verifies the
Sigstore checksum signature; a local Dedicated signature is not a public release.

CI verifies the offline signature only **after** the canonical CJS and Windows
assets are staged, **before** embedding the final Host and finalizing checksums.
It then signs `SHA256SUMS` with Sigstore and runs the required signed gate before
uploading. The promotion workflow independently verifies the signed feed and
exact candidate inventory. Unsigned local partial builds remain supported;
`--private-cloud-runtime` deliberately rejects a signed feed and cannot
satisfy `--require-signed`.

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
