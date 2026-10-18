# ADR 0006: No separate relay process in v1

**Status**: accepted
**Date**: 2026-07-04

## Context

An earlier design draft included a **relay** — a lightweight process whose only job was to sit between Executor and Host, forwarding messages between them. Rationale (at the time):

- Executor cannot know Host's address if Host is behind an LB
- Multiple Host instances need a session-affinity router
- The relay could be public and shared, while Cores could be private

On review with the project owner, this was pushed back: **"Host has a public IP. Why do we need a relay?"**

## Decision

**No independent relay process in v1.** Host exposes the Socket.IO server directly. Executor dials Host. Dashboard dials Host. Same host, three roles.

The functionality the relay would have provided (session routing, room management) collapses into a **connection layer module inside Host**. It's not a separate process; it's a directory (`packages/host/src/connection/`).

## Alternatives considered

**Ship the relay as designed** (independent process).

*Rejected*. Adds:
- A second binary to deploy
- A second point of failure
- A second network hop of latency
- Documentation, config, monitoring overhead

None of these are justified at v1's target scale (a single Host, one to a few concurrent sessions per instance).

**Have Executor talk to Host directly, but leave "relay" as a hypothetical future.**

This is the accepted decision. The v1 shape does not include a relay. If v2 needs one — because Host needs to scale horizontally, or because we want to offer a hosted relay while users self-host Cores — we can extract the connection layer into a standalone process at that time. The interface is already clean.

**Use Socket.IO Redis Adapter for horizontal Host scaling instead of a bespoke relay.**

*Deferred*. If a v2 scenario demands multiple Cores sharing session state, Socket.IO's redis-adapter is the natural first step. Only if that doesn't fit do we build a proprietary relay.

## Consequences

**Good**:
- v1 deploys as *one* headless service. `fly deploy` and you're done.
- No inter-process contract between Host and Relay to specify.
- Fewer moving parts to explain in the README and to new contributors.

**Bad**:
- Host has more responsibility. If Host process dies, both the executor connection and the LLM adapter go down. Mitigation: Host is stateless-in-memory except for the event log, which is on disk. Restart replays the log.
- No natural place to shed load. If sessions grow beyond one Host's capacity, we'll need horizontal scaling. This is a v2 problem to solve when it becomes a real one, not now.
- Some cloud deployment patterns (edge functions, serverless) become awkward. Socket.IO wants a long-lived server process. This is a natural constraint of the architecture, not a shortcoming of the no-relay decision.

## Verification

The connection layer lives in `packages/host/src/connection/` and exposes an interface (`ConnectionServer`) that could, in principle, be extracted to a separate process later. If v2 needs the split:

1. Move `packages/host/src/connection/` to `packages/relay/src/`.
2. Add HTTP/WS between Host and Relay for state-change broadcasts.
3. Router logic (`sessionId → coreInstance`) sits in Relay.

But not now. **v1 = single process, single reason to exist.**
