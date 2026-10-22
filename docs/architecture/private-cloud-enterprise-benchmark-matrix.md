# Private Cloud Enterprise Benchmark Matrix

Status: normative planning input — decisions and Pilot exit criteria, not proof of implementation or release acceptance. Compare the [enterprise architecture contract](./private-cloud-enterprise-architecture-contract.md) with the [design/status ledger](./private-cloud-design-status.md) and the [release evidence](../operations/private-cloud-release.md) before claiming a capability is shipped.
Scope: trusted enterprise customers, manually provisioned contracts, customer-managed outbound Executor
Non-goals: public self-service billing, public untrusted code execution, an in-product ticketing system

## Reference products

This matrix uses official product documentation rather than treating one product as a complete template:

- **GitLab** — primary reference for customer-managed runners, group/project resource scope, enterprise identity, and audit.
- **Grafana Cloud** — primary reference for organization/stack control planes, scoped machine credentials, private-network agents, and fleet operations.
- **GitHub Actions** — secondary reference for self-hosted runner hierarchy, runner groups, labels, and customer responsibility boundaries.
- **Sentry** — secondary reference for organization/team/project membership and granular administration.

Agent RunLab's closest combined analogy is: **GitLab Runner execution model + Grafana Cloud enterprise control plane + an Agent-native interactive Session runtime**.

## Decision vocabulary

| Decision | Meaning |
|---|---|
| Core | Agent RunLab must implement this because it defines Agent semantics or its security boundary. |
| Integrate | Use a mature OSS/service through a narrow Port/Adapter. |
| Pilot+ | Preserve the design boundary now; implement only after validated enterprise demand. |
| Exclude | Explicitly outside the product. |

## Capability matrix

| Domain | Reference evidence | Agent RunLab decision | Planned implementation / owning graph node |
|---|---|---|---|
| Tenant hierarchy | Grafana separates organization and stack realms; GitLab scopes runners to instance/group/project; Sentry uses organization/team/project | Core | Organization → Workspace → Session, with Executor pools scoped to Organization or Workspace; `controlPlaneSchema`, `workspaceAuthorization` |
| Human membership | Sentry provides organization and team roles; GitLab top-level groups govern enterprise membership | Core + Integrate identity | Fixed Owner/Admin/Member/Viewer roles in RunLab; authentication, SAML/OIDC/MFA delegated to ZITADEL; `enterpriseSso`, `enterpriseRbac` |
| Owner safety | Mature products reserve destructive organization operations for owners | Core | Last-owner protection, owner transfer, suspension and deletion confirmation; `enterpriseRbac`, `retentionExportDeletion` |
| Enterprise provisioning | Enterprise cloud products support centrally managed organizations rather than requiring public checkout | Core | Contract-backed manual create/suspend/close, entitlements and support tier; `manualProvisioning` |
| Service identities | Grafana distinguishes Access Policies from Grafana service accounts and supports scoped tokens with expiration | Core | Service accounts and tokens with explicit scopes, expiry, rotation and revocation; `serviceAccountsApi` |
| Machine-token realm | Grafana policies apply to organization or stack realms and never span organizations | Core | Token realm is Organization/Workspace/Executor; deny cross-realm use; `workspaceAuthorization`, `executorEnrollmentContract` |
| Customer-managed execution | GitLab and GitHub define self-managed runners installed and maintained by customers | Core | Customer Executor remains first-class; platform owns protocol/control plane, customer owns host/OS; `executorEnrollmentImplementation` |
| Runner/Executor hierarchy | GitLab runners can be instance/group/project; GitHub runners can be enterprise/org/repository | Core | Organization pool and Workspace-dedicated Executor; no public shared untrusted pool; `executorFleetManagement` |
| Scheduling | GitLab matches runner tags, type, status, capacity and capabilities | Core | Labels, platform capabilities, health, capacity, affinity, maintenance and drain; `executorFleetManagement` |
| Enrollment | Runner products register a client and establish persistent identity | Core | One-time expiring invite, approval, device identity, credential rotation/revocation; `executorEnrollmentContract`, `executorEnrollmentImplementation` |
| Outbound private connectivity | Grafana PDC uses a customer-deployed agent initiating an encrypted outbound connection; multiple agents provide horizontal resilience and destinations can be restricted | Core | Outbound-only TLS/WSS Executor channel, proxy/customer CA, reconnect, destination documentation; `outboundChannelReliability`, `executorProxyAndCa` |
| Customer control boundary | Grafana PDC can be stopped by the customer; GitHub states customers maintain runner machines | Core + docs | Explicit shared-responsibility model, revoke/drain controls and no platform inbound access; `hybridArchitectureContract`, `executorFleetManagement` |
| Execution idempotency | Runner systems must tolerate retries and reconnects | Core | Operation IDs, call receipts, ACK sequencing, duplicate suppression and late-result rejection; `executorProtocolReliabilityAudit`, `outboundChannelReliability` |
| Workspace tool governance | Runner products scope execution to repositories/projects and protected resources | Core | Workspace roots, File/Git/Shell permissions, approval modes, timeout/output/network/sensitive-path policy; `workspaceToolPolicy` |
| Agent lifecycle | No reference product owns RunLab's interactive autonomous semantics | Core | Session, Queue, Steer, Approval, Compact, Sub-agent and Task Graph remain in-house; highest-strength core hardening graph |
| Secrets | Mature platforms separate credential storage from resource metadata | Integrate | Store only `credentialRef`; resolve through OpenBao Port; `secretManagement` |
| Customer LLM | Comparable enterprise tools support customer endpoints/integrations | Core + Integrate secret/network | OpenAI/Anthropic-compatible endpoints, private CA/proxy, policy and health tests; `customerLlmProviders` |
| Artifacts | Runner products persist job artifacts separately from execution state | Integrate | MinIO/S3 adapter with tenant prefixes, signed URLs, quota and retention; `artifactObjectStorage` |
| Usage and quota | Grafana exposes billing/usage scopes; Sentry documents quota management | Core | Internal immutable usage ledger and contract entitlements, without payment processing; `usageAndEntitlements` |
| Audit | GitLab records actor/action/time across group/project/instance and supports APIs/exports/streaming patterns; Grafana exposes audit-log scopes | Core | Append-only audit events, filtered query/export and SIEM webhook boundary; `enterpriseAudit`, `auditQueryExport` |
| Audit content minimization | Enterprise audit should prove control actions without copying sensitive payloads | Core | Never store prompt, secret or file body in control-plane audit records; `enterpriseAudit` |
| Retention and deletion | Sentry exposes storage location and organization deletion; enterprise platforms expose retention controls | Core + Integrate object store | Organization retention, export, grace period, retryable deletion and deletion evidence; `retentionExportDeletion` |
| Admin portal | Grafana Cloud Portal centralizes stacks, access policies and tokens | Core | RunLab Admin Center for contract, users, SSO, Executor, policies, usage, audit and retention; `adminCenterEnterprise` |
| API and automation | Grafana and GitLab expose scoped APIs | Core | Versioned OpenAPI, idempotency keys, service-account scopes and rate limits; `serviceAccountsApi` |
| Event delivery | Enterprise products support audit/event forwarding | Core using PostgreSQL | Transactional Outbox, HMAC, retries, dead-letter history and secret rotation; no Kafka initially; `webhookOutbox` |
| Observability | Grafana's domain demonstrates metrics/logs/traces/alerting separation | Integrate | OpenTelemetry Collector + Prometheus/Grafana/Loki/Tempo/Alertmanager; `telemetryStack` |
| Customer status and errors | Mature cloud products expose operational status and traceable failures | Integrate | Gatus status page, GlitchTip error aggregation, visible trace IDs and recovery actions; `errorAndStatusStack` |
| Support | Mature products link diagnostics to an external support workflow | Integrate | Redacted Support Bundle, Zammad Ticket ID/link only; `supportIntegration` |
| Supply chain | Enterprise runner software requires signed, inspectable releases | Integrate | Trivy/Syft/Grype, SBOM, secret scan and signed Executor artifacts; `securitySupplyChain` |
| Upgrade compatibility | Customer-managed agents can lag the control plane | Core | Protocol/version range, release channels, drain, maintenance windows, rollback; `releaseUpgradeSystem` |
| SCIM | GitLab documents SCIM provisioning coupled to enterprise SSO | Pilot+ via ZITADEL | Keep identity provisioning adapter boundary; enable only for contracted demand after SSO/RBAC stability |
| Complex relationship authorization | Mature products may need inherited group/project relations | Pilot+ | Start with fixed roles and Workspace grants; evaluate OpenFGA only when inheritance exceeds fixed policy; `workspaceAuthorization` |
| Policy-as-code | Some enterprises require centrally authored policy | Pilot+ | Evaluate OPA only after fixed Tool Policy proves insufficient; `opaDecisionGate` |
| Elastic managed runners | GitLab/GitHub offer provider-operated runners and autoscaling | Exclude for current positioning | No public untrusted execution pool; operators bring trusted Executors |
| Public checkout and payment | Public-service concern | Exclude | Manual contracts and internal entitlements only |
| Ticket lifecycle | Support-system concern | Exclude | Zammad remains system of record |

## Product boundaries derived from the matrix

1. **Organization is the commercial and security tenant.** Workspace is an authorization and execution scope, not a second commercial tenant.
2. **Executor identity is a machine principal, not a browser token.** Enrollment credentials, runtime access credentials and human sessions must be separate.
3. **Organization-wide and Workspace-dedicated Executor pools are both required.** Public shared execution is explicitly prohibited.
4. **Core Agent semantics remain deployment-configuration neutral.** Private Cloud identity/routing must wrap, not fork, Session/Queue/Compact/Tool behavior.
5. **Machine credentials require realm, scope, expiry, rotation and revocation.** A single permanent all-powerful API key is not acceptable.
6. **Outbound-only does not remove policy requirements.** Destination allowlists, proxy/CA support, diagnostics, drain and customer revocation remain necessary.
7. **Control-plane audit contains control facts, not customer content.** Sensitive content stays in tenant-scoped Session/Artifact systems under retention policy.
8. **OSS integrations remain replaceable adapters.** ZITADEL, OpenBao, MinIO, OTel stack, Gatus, GlitchTip and Zammad must not leak vendor-specific concepts into Agent core.

## Pilot release minimum

A Hybrid Pilot is not acceptable until all of the following work end-to-end:

- Manual Organization provisioning with contract entitlements.
- Enterprise SSO, fixed RBAC, last-owner protection and immediate revocation.
- Workspace authorization and organization/workspace Executor pools.
- One-time enrollment, outbound reconnect, rotation, revocation, drain and proxy/customer CA diagnostics.
- Workspace Tool Policy and customer LLM credential references.
- Usage ledger, immutable audit, retention/export/deletion.
- Admin Center, scoped service API and reliable webhook delivery.
- OTel-based telemetry, status/error surfaces, redacted support bundle and signed release evidence.
- Two-organization isolation plus real customer-network simulation.

## Official source set

- Grafana Cloud Access Policies: <https://grafana.com/docs/grafana-cloud/security-and-account-management/authentication-and-permissions/access-policies/>
- Grafana Private Data Source Connect: <https://grafana.com/docs/grafana-cloud/connect-externally-hosted/private-data-source-connect/>
- GitLab Runners: <https://docs.gitlab.com/ci/runners/>
- GitLab Audit Events: <https://docs.gitlab.com/user/compliance/audit_events/>
- GitLab Group SAML SSO: <https://docs.gitlab.com/user/group/saml_sso/>
- GitLab SCIM: <https://docs.gitlab.com/user/group/saml_sso/scim_setup/>
- GitHub Self-hosted Runners: <https://docs.github.com/en/actions/concepts/runners/self-hosted-runners>
- GitHub Runner Groups: <https://docs.github.com/en/actions/concepts/runners/runner-groups>
- Sentry Organization and User Management: <https://docs.sentry.io/organization/membership/>
