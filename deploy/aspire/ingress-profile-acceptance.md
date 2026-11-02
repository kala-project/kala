# Ingress boundary acceptance

The [deployment contract](../../docs/architecture/deployment-mode-contract.md) is authoritative. This record covers publication, not a running-installation or production certificate proof.

Official Aspire CLI 13.6.3 published all four profiles successfully from AppHost source SHA-256 `5882cb800c65d734d1b0def1f83b66940ad4263473e599cf1e7ee79e7cb203cc`:

| Ingress | Telemetry | Published resources | Topology gate |
| --- | --- | ---: | --- |
| bundled-caddy | disabled | 6 | passed |
| bundled-caddy | enabled | 9 | passed |
| external | disabled | 5 | passed |
| external | enabled | 8 | passed |

Every profile used an operator-supplied deployment descriptor. The external cases omitted the edge image, public hostname and Caddy listener inputs and deliberately supplied a nonexistent Caddy configuration path: publication succeeded without accessing it. They produced no ingress service or named volumes and exposed Gateway only on IPv4 loopback. Resolved publications passed the actual shared topology gate.

The publication-only fixture referenced the previously built Runtime `1e6fd5bd` image (`sha256:1b6d3fbc95468e9104e8d56d1eb6f29c54f7b0e21dc1a52d7b6426efe8a57828`) and Gateway image (`sha256:fa8b00139f0f8436ea32df2dfdb57a585a25e3fd0e0c37480cc8de9ef41b8e6e`); no containers were started for this check. It is not evidence that newer application source, including the later indeterminate-timing correction, ran in these images.

Unprivileged Python discovery ran 37 cases: 36 passed and the root-only UID/GID extraction case was skipped. A subsequent root run passed all 37 without skips. Shell syntax and the actual .NET AppHost restore/build passed; ASPIRE010 remains visible. Existing tests cover exact external shapes, mode-marker consistency, public HTTPS origin, forbidden wildcard handoff/named volumes, descriptor authority, v3 three/five-root inventories, cross-mode rejection and legacy bundled artifacts.

Subsequent [frozen external five-service acceptance](./external-ingress-acceptance.md) supplies new-image execution, independent TLS/WebSocket operation, fenced initialization and actual v3 three-root recovery. That record remains separate from this publication-only check. Real model/SDK/remote Executor work is still open. External certificates and keys are intentionally outside application backup custody. No public ACME issuance, renewal, sustained availability or production release qualification is implied.
