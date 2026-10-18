# Strong Isolation Roadmap

**Current:** one RuntimeHost process with logically isolated `TenantRuntimeUnit` instances.

## Trigger for stronger isolation

Move beyond in-process Units before serving mutually untrusted public users who can execute arbitrary tools, when regulatory boundaries require OS separation, or when one Unit's CPU/memory failure must not affect others.

## Stable migration boundary

RuntimeIngressGateway continues selecting an opaque Unit ID. RuntimeUnitIngress becomes a transport Port rather than an in-process call. Session/Event/Workspace protocols and the identity-to-Unit assignment remain unchanged.

## Stages

1. **Current logical isolation:** strict Unit roots, routing secret, ID collision tests, quotas and bounded concurrency.
2. **Worker-process Units:** one unprivileged child process per active Unit; IPC transport; cgroup/systemd limits; idle unload and supervised restart.
3. **Container Units:** rootless OCI container per active Unit or small trusted cohort; read-only image, private writable volume, no Docker socket, egress policy, seccomp/AppArmor, CPU/memory/PID limits.
4. **Remote Runtime pools:** Gateway/Host scheduler assigns Units to workers; signed short-lived internal credentials, durable catalog, drain/migrate protocol, replicated control store.

## Required migration semantics

- Unit enters `draining`, rejects new turns, finishes/cancels in-flight work, flushes event storage, records generation, and starts on the target with generation+1.
- Gateway routes only after target readiness and atomically changes assignment.
- Stale workers cannot accept traffic because internal credentials bind Unit ID and generation.
- Rollback retains the previous volume snapshot until target verification.

## Cost controls

Idle Units unload after policy-defined inactivity; warm pools absorb login latency. Resource Governor limits apply before scheduling and again at OS/container boundaries. Dedicated isolation can be reserved for higher-risk plans while trusted private deployments retain process Units.

## Acceptance gate

- hostile Unit cannot read another Unit's memory, filesystem, network credentials, process list, or telemetry;
- fork bomb, disk fill, infinite output, and OOM remain within Unit limits;
- migration preserves event count and Artifact hashes;
- stale generation traffic is rejected;
- worker crash only reconnects affected Units;
- hosted product URLs and Dashboard protocols do not change.
