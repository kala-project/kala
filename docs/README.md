# Kala documentation

Start with the [project overview](../README.md). This index is organized by what you need to do, rather than by source package. A link to a design, proposal, or historical record does not mean the feature is currently shipped; check its stated status and the [current deployment contract](architecture/deployment-mode-contract.md).

## Use Kala

- [Guides](guides/README.md) — choose a deployment, connect workspaces, and find the relevant user-facing workflow.
- [Product API](reference/api/v1.md) — API clients and durable Session/DAG operations.
- [Current roadmap](roadmap.md) — shipped, deferred, and out-of-scope work; confirm current behavior against the implementation.

## Operate a deployment

- [Operations index](operations/README.md) — install, upgrade, rollback, backup, and troubleshoot Portable, Dedicated, and Private Cloud.
- [Release support policy](operations/release-support-policy.md) — compatibility and rollback boundaries.
- [Revision-bound evidence policy](evidence/README.md) — distinguish current proof from historical records.

## Change Kala

- [Development workflow](development/build-test-deploy.md) and [contributing guide](../CONTRIBUTING.md).
- [Engineering principles](standards/engineering/principles.md), [UI principles](standards/product-and-ui/ui-principles.md), [supply-chain security](standards/security/supply-chain-security.md), and [testing standards](standards/release-quality/testing.md). These apply across components; a runbook is not a replacement for a standard.
- [Critical user-action test matrix](development/testing/critical-user-action-matrix.md) and [product E2E guidance](development/testing/product-e2e-harness.md).

## Look up a contract

- [Kernel specification](reference/kernel/spec.md), [Executor tool contract](reference/executor/tools.md), and [Product API](reference/api/v1.md).
- [Wire protocol](protocol/wire-protocol.md) and [event log](protocol/event-log.md). These retain their current paths because source and tests cite them directly.
- [Deployment modes](architecture/deployment-mode-contract.md) and [security control plane](architecture/host/security-control-plane.md).

## Understand the design

- [Architecture overview](architecture/overview.md), [core invariants](architecture/core-agent-invariants-and-fault-model.md), and [architecture decisions](architecture/adr/).
- [Dedicated Runtime](architecture/dedicated-platform-runtime-unit.md), [Private Cloud Runtime](architecture/private-cloud-runtime-units.md), [graceful restart and deployment](architecture/graceful-restart-and-deployment.md), and [browser sessions](architecture/browser-session-store.md).
- [Visual approval and preview](architecture/visual-approval-loop.md) describes a target design; its presence here does not claim it has shipped.
- [Dashboard designs](architecture/dashboard/) and [Host designs](architecture/host/) contain component-specific work. Use the document's status to distinguish current contracts from target designs.

## Research and historical records

- [Capability designs](capabilities/README.md) track implementation alignment; they are not a blanket claim that every proposal is shipped.
- [Standalone evaluation](evaluation/README.md) and [RL research](research/rl/) have separate lifecycles from the product Host and Dashboard.
- [Proposals](research/proposals/) are future or exploratory work, not operating procedures.
- [Historical reviews and programs](archive/README.md) provide context, not current instructions. [Evidence](evidence/README.md) remains at its revision-bound path; filename alone does not establish current acceptance.

Some documents retain their original component-oriented paths because source code, tests, or numbered capability indexes refer to them. Use this index and the document's status instead of assuming a folder name implies authority.
