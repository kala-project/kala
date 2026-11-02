# Dedicated local candidate acceptance — 2026-10-29

> Historical bundled candidate. For the newer `069e6172` images and external five-service/v3 recovery proof, see [external-ingress acceptance](./external-ingress-acceptance.md). The newer proof does not retroactively change this record's nine-resource/v2 scope.

**Passed: frozen Runtime/Gateway source `1e6fd5bd`, actual Aspire nine-resource deployment, packaged Owner lifecycle, and trust-preserving artifact-v2 cold recovery.**

This is bounded local integration evidence, **not** a supported/signed production release. The exact nine image references, source revision, operator and generated-Compose hashes are in [current-image-acceptance.json](./current-image-acceptance.json).

## Frozen nine-resource candidate: what actually ran

Runtime and Gateway were built from a frozen `git archive` of `1e6fd5bdf8acea6cba180621998c23ae5fece7f0`, not a workspace/Session copy:

- Runtime: `kala-dedicated-agent-runtime@sha256:1b6d3fbc95468e9104e8d56d1eb6f29c54f7b0e21dc1a52d7b6426efe8a57828`
- Gateway: `kala-dedicated-agent-gateway@sha256:fa8b00139f0f8436ea32df2dfdb57a585a25e3fd0e0c37480cc8de9ef41b8e6e`

Product Dashboard source is unchanged since `c948fe30`; its previously pinned image was reused. The Linux Runtime is an unsigned local test build with explicit local-test release metadata, not registry or cross-platform release provenance.

Official .NET SDK 10.0.403 and Aspire CLI 13.6.3 published the real model. The isolated fixture then:

1. Started **eight long-running services plus one readiness job exiting zero**. Runtime/Gateway waited for the finite job; the two observability daemons retained restart and bounded Docker-log settings. Service versions were bound to image digests by the published model.
2. Logged in over CA-verified HTTPS and sent a real request through Caddy and Gateway to Runtime over the private HTTP network. The authenticated Aspire telemetry API showed both packaged services and correlated HTTP spans.
3. Ran the actual packaged normal Owner password-change and acknowledged local-root recovery CLIs. Each revoked the live browser session; new-password login preserved the same Organization.
4. Invoked production `backup.sh`, stopping all nine resources and creating **artifact v2 with PostgreSQL, SILO, recovery material, Caddy data and Caddy config**.
5. Invoked production `recovery.sh` with source fencing and fresh-volume creation explicitly acknowledged. It restored three fresh disjoint bind roots and two new local Caddy volumes; no source root/volume was overwritten.
6. Started the restored nine-resource profile successfully, without fixture ownership workarounds.
7. Reused the **original SSL context and original opaque Owner cookie** held in memory. No new CA was loaded, trust redistributed or TLS verification disabled. The original and restored CA SHA-256 were both `dca108d4f0821ed292aabc63b9e202b02f63136e15c45578961733be13f535d5`.
8. Confirmed SQL and S3 sentinels byte-for-byte, then removed source/restored test containers and their own profile volumes.

The fixture used synthetic credentials and SQL/S3 sentinels, not a real business Session. Application binaries and deployment/backup/restore commands were real; no real model request was made.

## Business telemetry: separate component proof

[prove-standalone.sh](./telemetry/prove-standalone.sh) passed using the actual new `AgentTelemetryBridge`, pinned Collector and protected standalone Aspire Dashboard. Its inputs are explicitly **synthetic persisted timing metadata**, not mocked claims of a real model or Executor run.

The protected API returned an anonymous `agent.turn` root and LLM/concurrent-tool children with the same trace and correct parent IDs. An interrupted tool retained unset OTLP status and `execution.state=unknown`. Authentication, safe logs, metric presence, bounded/disconnected export and sensitive-field exclusion passed. Focused tests also prove different Units can reuse identical Session/turn IDs without merging traces.

Histogram encoding is checked at client output and accepted by the real Collector. Dashboard resource-summary presence does not prove individual histogram buckets or arbitrary resource attributes; those are not claimed here. HTTP and Socket.IO Agent trees remain separate. Tool timing is server-observed, not a fabricated native remote Executor span. Metrics remain best-effort observations, not an exactly-once billing authority.

## Historical distinct-image upgrade and failure recovery

The earlier image pair is separately bound to `9c04a7ea`; it must not be relabeled as the latest source:

- Production `upgrade.sh` upgraded genuinely different `c948fe30` → `9c04a7ea` Runtime/Gateway images under an exact PostgreSQL-16/no-migration policy, with a completed cold backup before startup, healthy services, CA-verified login and byte-exact SQL/S3 data.
- A Gateway `process.exit(17)` failure injection returned nonzero after its backup. It emitted no `upgrade_completed`, retained the failed command and performed no automatic rollback.
- Separately authorized production cold recovery into fresh roots preserved its original opaque Owner cookie and SQL/S3 data.

These runs used a pre-v2 operator working copy. They are historical application-image evidence, not proof that the final operator bytes were exercised in those upgrades. The latest candidate proof above exercises final operator v2 backup/recovery. It does **not** establish a controlled distinct-image upgrade to `1e6fd5bd` or a supported predecessor-release compatibility contract.

The successful-upgrade driver initially misparsed Compose JSON-lines after product upgrade success; a bounded continuation completed its checks. Its original pre-upgrade cookie was lost with that process and is not claimed to have survived the upgrade. The separate failure-recovery and latest v2 recovery proofs each preserved their own original cookie.

## Subsequent source correction — not in the accepted images

Final review found the older timing projection converted every `ok: false` tool result to `failed`, even when the authoritative structured failure outcome was `indeterminate`. Source `b2a8ee03` now projects that receipt as interrupted/unknown without mutating the receipt or replaying anything. Tool-count metrics no longer interpret timing completeness as external-effect settlement.

Host build and the actual `TurnTimingTracker` → bridge → OTLP structured-receipt regression passed; the real Collector/Dashboard component proof was rerun on this source. **The accepted nine-resource image pair above does not contain this subsequent correction.** Rebuilding that next candidate and exercising real model/SDK/Executor business remains required; the older integration result is not relabeled.

## Remaining gates — not completed

- Latest-image real model/native SDK/remote Executor and implementation-child business acceptance.
- Logical WebSocket-command correlation through Gateway, native SDK and remote Executor.
- Continuous PG/SILO/Caddy/host metrics, durable history and actionable alerts.
- Provider-specific startup-credential rotation and state-master-key decrypt/re-encrypt migration. Owner change/recovery is supported; generic file replacement is not rotation.
- Arbitrary schema/PG-major migration and supported predecessor-release compatibility.
- Public ACME/DNS issuance/renewal, long soak and complete workload/container hardening.
- Supported signed/cross-platform release and registry provenance; **no push or existing-deployment replacement was performed**.

Small local result logs, source/image manifests and the final parameterized Compose are retained at the JSON record's local paths. The owned synthetic fixture, secret-bearing backups/keys and recovery copies were deleted (1,486,316 KiB allocated), along with six unused owned Caddy volumes, three publish capsules and four frozen-source contexts. No global prune was used; toolchains, images, existing development containers and the unrelated main-worktree 14 UI/mock changes remain untouched.
