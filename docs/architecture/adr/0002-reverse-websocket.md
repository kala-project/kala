# ADR 0002: Executor dials out to Host (reverse WebSocket)

**Status**: accepted
**Date**: 2026-07-04

## Context

The agent needs to run tools (`bash`, `read`, `write`, …) somewhere. In our design, "somewhere" is the Executor process — separated from Host, potentially on a different machine.

If Executor is on a laptop and Host is in the cloud:
- Laptop is behind NAT and/or a firewall
- Laptop has no public IP
- User doesn't want to open inbound ports, configure port forwarding, or tunnel via ngrok

Meanwhile, Host:
- Runs on a server with a public IP (Fly.io, Railway, self-hosted VM)
- Is trivially reachable inbound (it's a normal HTTPS/WSS endpoint)

The question: **which side initiates the connection?**

## Decision

**Executor dials out to Host.** Host exposes a Socket.IO server on `/executor` namespace. Executor is a Socket.IO client. Connections are held open (long-lived), and Host sends tool calls **over the reverse channel** — i.e. writes to a client that dialed in.

## Alternatives considered

**Host connects to Executor.** Requires Executor to have a public IP or reverse tunnel. Impractical for the common case (laptop behind NAT).

**Executor polls Host over HTTP.** Latency shoots up (poll interval floor). Requires larger request/response bookkeeping. Not a fit for interactive agent loops.

**gRPC bidirectional streams.** Would work, but gRPC in browsers requires gRPC-Web + proxy, and browser support for WebContainer executors is one of our goals. Socket.IO uniformly supports Node and browser as first-class clients.

**Custom WS + retry.** The right abstraction level, but Socket.IO already implements everything we'd re-invent (auto-reconnect, rooms, ACK correlation, event names). See [ADR 0003](0003-socket-io.md).

**Tunneling (ngrok, cloudflared).** Adds an external dependency and a third-party trust boundary. Doesn't help the "just install and run" experience.

## Consequences

**Good**:
- Laptop executor works with zero network config. Download `kala-executor.cjs`, then run `node kala-executor.cjs --host wss://host.example.com --sandbox-root /repo` and you're done.
- Same pattern works for browser executor: browser dials Host over WSS.
- Firewall-friendly (outbound HTTPS is universally allowed).
- Kill-safe: if the laptop closes, the WS drops, Host notices via disconnect, session pauses gracefully.

**Bad**:
- Host must scale for incoming long-lived connections. Not a problem at hobbyist scale; matters at 10K+ concurrent sessions (a v2 concern).
- If Host is behind a corporate proxy that terminates idle connections, we need keepalives. Socket.IO does this by default.
- Debugging is slightly weirder — you can't `curl` an Executor. But debugging happens from Host anyway, since Host owns the state.

## Verification

- Local dev: `pnpm dev` starts Host on `localhost:3000` and Executor connects with `--core ws://localhost:3000`
- Cloud dev: deploy Host to a public host, run Executor on any machine that can reach the host (no inbound rules needed)
- Browser dev: the dashboard's WebContainer plugin uses the same code path from the browser context
