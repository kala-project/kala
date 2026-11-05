# Release evidence and promotion contract

**Status:** normative

The release remains a draft until matching-runner clean-install evidence
for every supported Portable target is complete and both source-free asset and
GHCR image workflows succeed for the exact tag and revision. Builds alone do
not substitute for Portable runtime evidence. Dedicated and Private Cloud
lifecycles remain unverified preview capabilities.

## Evidence envelope

Each runner writes one `*.rc-evidence.json` object. The schema is versioned and
closed: unknown fields are rejected. It binds `tag`, SemVer `version`, exact
40-character source `revision`, distribution `category`, target, tested artifact
name and SHA-256, generation time, and a fixed set of boolean checks. `ok` and every
required check must equal `true`.

Before a runner starts the product, the workflow verifies GitHub provenance for
the downloaded artifact and checksum index, verifies the checksum entry, and binds
the release manifest to the candidate tag revision. A matching file name or
a checksum downloaded from the same unverified release is not sufficient.

Evidence deliberately excludes logs, receipts, domains, IP addresses, endpoints,
credentials, private paths, Session content, and screenshots. Those diagnostics may
remain in access-controlled workflow artifacts but cannot enter the public aggregate.

The required promotion matrix is:

| Category | Target | Required proof |
|---|---|---|
| Portable | Linux x64, macOS x64/arm64, and Windows x64 with ConPTY (exactly four records; Linux arm64 paused) | exact attested CJS asset, clean install, boot, capabilities, embedded Dashboard, persisted Session state, graceful stop, same-version reinstall; Windows also verifies the CJS Executor and ConPTY installer lifecycles |

Optional Dedicated and Private Cloud lifecycle evidence still has a strict schema
if independently produced, but is not claimed as proven for this release.
The old `v0.1.10` release lacks equivalent cross-platform predecessor assets;
no cross-version upgrade, systemd rollback, or Compose tenant isolation is
asserted by a same-version Portable reinstall.

## Promotion

`rc-acceptance.yml` runs against the draft tag on matching GitHub-hosted
Linux, macOS, and Windows runners, with no self-hosted or predecessor release dependency. The
Private Cloud tag workflow independently builds, signs, and scans versioned
multi-architecture images and bundles; those artifacts remain preview-only
until real clean Compose lifecycle evidence is available.

`promote-rc.yml` accepts an explicit acceptance run ID. Before changing release
state it verifies that the run used the release acceptance workflow, concluded successfully, and
has the same source revision as the tag, and confirms the GitHub Release and
GHCR tag workflows also succeeded for that revision. It downloads all evidence and executes
`verify-rc-evidence.mjs`, which rejects missing, duplicate, or extra targets, false or
missing checks, revision/tag drift, unknown schema fields, and private diagnostic
material. Only then is the public redacted aggregate attached and the draft bit
cleared. Promotion also fails if any required Windows asset is missing or
fails its exact-tag verification.

No npm packages are published by version tags. GHCR images are published by
the existing Private Cloud tag workflow, but image publication alone does not
certify a production Private Cloud deployment.
