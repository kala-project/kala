# Desktop application debugging — source of truth

Status: implementation contract, 2026-10-30. This is the single normative contract for the manual multi-port application-debugging feature. Implementation/acceptance status is recorded at the end; a design requirement is not evidence that it already works.

## Authority and platform compatibility

This feature contract is subordinate to the [deployment-mode contract](../deployment-mode-contract.md), the [Private Cloud enterprise target](../private-cloud-enterprise-architecture-contract.md), and the [Dedicated implementation/migration contract](../dedicated-platform-runtime-unit.md). It defines a client capability, not a new Platform deployment mode. The [Private Cloud status ledger](../private-cloud-design-status.md) remains the evidence index; neither this document nor a local debug test changes its release/support claims.

- Portable may serve Dashboard assets from Host. Dedicated serves an independently versioned immutable Dashboard release through Stable Ingress; updating that release must not restart Runtime, Ingress, Supervisor or Executor. Private Cloud preserves its single product Origin and trusted Gateway-to-Unit route. The desktop reuses the selected authenticated Session transport; it does not choose a Runtime node, tenant header or alternate public proxy endpoint.
- Grants/streams are ephemeral, bounded state inside the routed Runtime/Executor connection, not authoritative Session work. They must not be stored in PostgreSQL/S3, checkpointed or replicated. Per-process admission limits are not cluster-global quotas. Adding replicas must not make another replica able to inject into a live grant.
- Engine.IO/Socket.IO connections stay pinned to their selected Unit generation/Session effect owner. Drain, owner loss, placement change, process replacement and Executor reconnection close the debug group. Reconnection does not resume a grant or replay bytes: the user reviews unknown application outcomes and explicitly restarts. Highly available control/Session services do not imply uninterrupted arbitrary TCP sessions.
- Client settings and isolated application cookies are local user data, not Gateway/Runtime authority. The enterprise prohibition on node-local authoritative application state remains unchanged. No new server-local durable store, shared filesystem, privileged daemon or inbound access to customer Executors is introduced.
- Every open/renew retains runtime-write, subscribed Session, Workspace and current effect-owner checks; Gateway session/membership revocation must close its existing upstream connection. A module test with injected identity is not proof of signed-ingress, revocation or multi-replica acceptance.

## 1. User outcome and scope

A user selects an online Workspace, opens **Application debugging** in the existing Linux desktop client, enters a small list of remote TCP ports and an entry port, and explicitly starts the group. The client binds the same ports on local loopback and opens an isolated interactive application window. For example local `localhost:5173` and `localhost:5000` lead to the selected Executor's loopback frontend/backend respectively. Client JavaScript containing `http://localhost:5000` therefore reaches the intended backend without rewriting JavaScript or application URLs.

V1 supports the existing Linux Tauri/WebKitGTK delivery only. It adds no automatic discovery/scanning, remote Chromium, screenshot streaming, public preview service, SSH dependency, VPN, HTTP response rewriting or application process management. It does not claim Windows/macOS/web support, Chromium-identical rendering, arbitrary OAuth-provider compatibility, debugger attachment or a complete DevTools product. HTTP, WebSocket/HMR, streaming and normal application login are TCP payloads, not special HTTP rewrites. TLS certificate validation and browser security remain enabled.

The desktop is still not an Executor or Host. Its new narrowly scoped responsibility is a **user-authorized loopback debug forwarder**. This explicitly extends the former no-local-listener desktop boundary only for this feature.

## 2. Reviewed architecture

```
local trusted settings window -> native bind/start/stop/config operations
                                  |
application WebView -> local TCP listeners (IPv4/IPv6 loopback)
                                  |
                    native per-stream bounded IPC channel
                                  |
selected authenticated Dashboard WebView (no copied cookies)
                                  |
                   existing authenticated Socket.IO connection
                                  |
Host: authorized workspace grant, pinned executor connection, bounded relay
                                  |
                   existing reverse Executor connection
                                  |
                 Executor -> 127.0.0.1:<approved remote port>
```

The Dashboard is an authenticated transport relay, not the authority to silently start arbitrary local listeners. Opening settings may be initiated from its desktop-only control; **Start must come from the packaged local settings window**, with the selected Host/principal/Workspace/Executor and ports visible. The remote Dashboard bridge may attach/detach the authenticated context, transport bounded frames for already-created streams and return acknowledgements. It must not expose generic native TCP connect/bind, filesystem, process, shell or cookie APIs.

No tokens/cookies/passwords travel through new native commands, URLs or saved settings. Application bytes must not enter agent tools, Session history, LLM context, SQL state, tracing bodies or per-frame audit logs. The data plane uses distinct debug events with bounded backpressure; it is not tool-call RPC. Control metadata may be audited without payloads or credentials.

## 3. Identity, authority and lifecycle

- Profiles are scoped to **selected Host origin + authenticated principal + Workspace identity + Executor identity**. Display names, filesystem paths and ports alone are not identities. The Host returns the principal/Executor binding from authenticated state, not from caller assertions.
- Host discovery of the selected binding uses the existing Workspace access, subscription, read-only/runtime-write and effect-owner checks. V1 requires a selected, subscribed Session bound to that Workspace as the effect-authority anchor, including on multiplexed Dashboard connections; do not bypass that requirement using a workspace-only RPC. Session identity is not part of the persisted profile, but changing the active Session stops its live grant. Viewers cannot establish debug grants. Target selection is explicit; there is no fallback to another Workspace/Executor.
- Existing HTTP-only network policies cannot safely authorize an opaque TCP protocol. If a restrictive/custom policy is configured, V1 fails closed with an explicit unsupported-policy explanation; only an absent policy or an unrestricted `defaultAction: allow` policy with no rules permits this feature. Never pretend that checking an HTTP URL authorizes arbitrary TCP, and never broaden a configured policy silently.
- Host grants are owned by one Dashboard socket, allow only the explicitly approved port set, and pin the current Executor connection generation. Every new stream is checked against that grant. A superseding connection, Executor disconnect, control disconnect, rejected renewal or expired grant closes the group and all its streams.
- Active grants have bounded leases, renewed only while the matching authenticated Dashboard context is active. Renewal rechecks authority; no per-byte database queries are allowed. There is no port-scanning/background SQL polling when inactive.
- Switching Host/account/Workspace/Executor context, logging out, leaving/destroying the Dashboard transport, closing the native group or exiting the desktop stops forwarding. Active tunnels and byte frames are not automatically replayed after reconnect. The user may explicitly restart from saved configuration after authorization succeeds.
- A lost acknowledgement/connection is an unknown application-request outcome, not proof that an HTTP POST or other effect did not happen. The product reports this and must not automatically retry/replay application bytes. Desktop cancellation/start timeout must also stop the socket-owned grant even if its grant ID was never received: control `stop` may omit that ID to cancel only the calling socket's group, including an authorization/start still pending. This prevents a late start acknowledgement from leaving an orphaned grant.

The Executor's localhost/network namespace is the target trust boundary. Filesystem sandbox roots do not prove that a port belongs to a repository. V1 deliberately connects only to numeric IPv4 loopback on the selected Executor; it accepts no remote hostname, IP, URL, DNS resolution or arbitrary network target. Services bound only to IPv6 or isolated inside another network namespace require an explicit reachable loopback endpoint there; do not silently broaden binding to a LAN address. Untrusted tenants must not share an unisolated Executor network namespace and assume this feature provides process-level isolation.

## 4. Local listeners and application window

- Accept 1–8 unique port numbers in 1024–65535; the entry port must be one of them. V1 uses **same-number** local/remote ports. No privilege elevation, automatic remapping or terminating another service to free a port.
- Reserve the complete listener group before enabling forwarding/opening the application. Bind only `127.0.0.1` and `::1`, not wildcard/LAN interfaces. IPv6-unavailable systems may operate IPv4-only with an explicit status; an occupied address/port is not treated as IPv6 unavailability.
- Any conflict/permission/grant failure unwinds every listener created for that attempt. Never silently attach to an existing local service or leave a partially active group. Errors name the affected port, explain the known state and how to retry safely.
- The user chooses HTTP or HTTPS for the entry port, default HTTP; no credentials/query tokens are accepted as configuration. The application opens at the chosen localhost entry origin. There is one active group per desktop instance in V1; switching profiles stops the old group first.
- The application uses a plain **GTK/WebKitGTK window created by the native shell**, not a Tauri-managed privileged WebView. This avoids injecting even Tauri's internal IPC/bootstrap into developer content. It has a separate WebsiteDataManager/WebContext and data/cache directory scoped to that profile, not the Dashboard or launcher profile. No Tauri command capabilities, native bridge injection, arbitrary file/application schemes, platform credentials or agent computer-control permissions are granted to application content. New-window requests, automatic downloads and native device permission requests are denied in V1. A persistent app profile may retain that application's login state; it must never share Kala login storage. The application storage fingerprint additionally includes the canonical approved port set, entry port and entry scheme, so changing to a different application configuration does not silently inherit another configuration's localhost cookies.
- Application navigation is limited to declared forwarded localhost origins and ordinary HTTPS navigation needed for explicit application login. New windows/native schemes are denied by default. No TLS/CORS/SameSite relaxation. External IdP compatibility is an acceptance concern, not a universal promise.
- Provide native window close/refresh and a basic interactive WebView; the config window provides open/stop/status. Closing the application window stops its group rather than retaining hidden listeners. WebKit inspector availability is optional and must not be marketed as full browser-debugger parity.

## 5. Bounded byte protocol

Control is versioned independently as app-debug v1. A request/reply carries a bounded opaque grant ID, stream ID and operation (`open`, `data`, `end`, `close`, and control `start`, `renew`, `stop`). The local IPC channel additionally correlates request acknowledgements to a native generation; stale responses cannot revive a stopped group.

- At most 32 concurrent streams per grant. Data chunks decode to at most 16 KiB. IDs, port lists and base64 are strictly validated; reject unknown operations/oversized/noncanonical payloads before allocating sockets.
- Each direction permits one unacknowledged chunk per stream. Pause reading until the downstream TCP write/IPC acknowledgement completes. A bounded deadline (15 seconds per hop) closes the affected stream on missing acknowledgement. No unbounded channel, browser write queue, Socket.IO reconnect buffer or retry queue.
- Maintain TCP byte order and half-close semantics. EOF in one direction does not discard a response still arriving in the other direction. Both EOFs/explicit close/error dispose stream state. On group close, shutdown sockets to unblock waiting readers/writers and fail outstanding acknowledgements.
- Up to eight groups per Host process initially, with per-Executor stream/socket bounds as a second enforcement boundary. Reject excess requests rather than silently dropping frames. Idle streams may be closed after a documented bounded idle period; reconnect is application-controlled, never byte replay.
- A relay must validate the sending Executor connection as well as grant/stream ownership. Another Dashboard socket, even for the same account, cannot inject into a grant. Duplicate stream IDs, data before open, stale-generation frames, repeated/unordered frame sequence and unapproved ports are rejected.
- Payload data is opaque TCP: login/API/WebSocket content is not inspected, rewritten, logged, cached or persisted. Existing global Socket.IO frame bounds still apply.

## 6. Persistence and UI contract

Only validated user configuration is persisted locally: scoped identity, port list, entry port and entry scheme. No live grant IDs, sockets, access tokens, cookies, URL credentials or forwarded content. Use bounded JSON, private local config permissions and atomic replace. A malformed file produces an actionable error, not silent data loss or automatic deletion. Application login storage is separate from this settings file. V1 permits at most 64 settings profiles and 64 isolated application storage profiles; each settings file is at most 16 KiB. Hitting a limit produces an explicit review/remove-unused-profiles instruction; it never deletes login data automatically. Closing settings also stops its group.

The packaged native GTK settings window states the selected server/workspace/executor, manual ports, entry selection and explicit Start/Stop/Open controls. Unsupported/old server or desktop versions report the missing capability, not a dead button. Web clients do not expose an apparently working local-forward action. A group is not "running" until local reservations and remote authorization both succeed. Disconnect/failure is visible and settings remain available for correction/restart.

## 7. Self review / challenge and revisions

The following challenges were applied before implementation; these choices are normative, while rejected approaches below are not alternative active designs.

| Challenge to the initial outline | Resolution in this contract |
| --- | --- |
| Native WSS would need platform authentication; copying Dashboard cookies breaks its isolation boundary. | Reuse the already-authenticated Dashboard connection, with a constrained native IPC data relay. No new credential export or standalone native login. |
| A remote page with a Start IPC could bind local ports without a local user decision. | Packaged local settings alone owns start/listener creation. Remote bridge is scoped to existing native streams and authenticated context. Application content receives no bridge. |
| Forwarding only the frontend leaves hardcoded backend localhost broken. | One explicit multi-port, same-number group. Port conflict fails the whole attempt; never silently renumber. |
| A standalone iframe/local WebView still has local networking. | Native loopback forwarders provide the missing actual network path for every declared port. No claim that embedding alone solves it. |
| A stream ending early could truncate POST responses or lose half-closes. | Ordered duplex streams, acknowledgements tied to downstream writes, explicit half-close, bounded cleanup. Real authenticated-wire testing reproduced an additional TCP-close-before-final-relay-ACK race: retain protocol state after normal TCP close until final data/EOF acknowledgements drain; do not treat transport close as proof the client received the response. |
| Socket reconnect replay could duplicate a login/API mutation. | Disconnect closes grants/listeners; no app-frame buffering/replay. Reconnect requires an explicitly restarted group. |
| Workspace identity alone does not survive replacement safely. | Pin authenticated principal and exact Executor connection generation, with renewable authority leases and fail-closed change handling. |
| Detection/authorization per packet could recreate excessive queries/traces. | No detection. Authorization on control/new-stream boundaries and bounded active renewal; no per-frame persistence, tracing payloads or SQL. |
| Browser cookies/native IPC could leak across app and platform windows. | Profile-specific WebKit context/data directory and no application capabilities/bridge. Test these boundaries, not only successful HTTP forwarding. |
| Socket.IO Admin development capture copies event arguments, including opaque debug bytes. | Redact all `app_debug:*` / `executor:app_debug_*` arguments at the Admin namespace event-output boundary before enabling instrumentation; preserve event names and ordinary diagnostics. Test the actual third-party development capture in both directions. Stopping grants when capture is enabled is insufficient because bytes may already be in flight. |
| Existing desktop docs said no listener/proxy. | Explicit narrow exception here; update the original decision text to reference this SoT, retaining all unrelated privilege constraints. |

## 8. Required verification / release gate

1. Real local TCP fixture: two backend ports through the authenticated relay path, ordered binary traffic, HTTP login cookie/API calls, WebSocket upgrade/duplex and streaming/half-close; no mock result may be described as real native UI acceptance.
2. Reject invalid ports, target addresses, over-budget data, unexpected sequence/IDs, unapproved ports, wrong owner/Executor, viewer access and offline/superseded bindings. Verify disconnect/revoke/lease expiry cleanup and no replay.
3. Native tests: all-or-nothing IPv4/IPv6 reservation, conflict cleanup without killing existing listeners, bounded request waits, half-close, persisted config separation and corrupt-file handling.
4. Desktop relay tests: explicit start, old-server/bridge absence, context change/transport disconnect stop and stale response rejection; inactive mode must not poll the database.
5. Actual Linux desktop build and isolated native smoke: enter frontend/backend ports, open the app, login/API/HMR where fixture supports it, stop/close, restart and restore configuration, and verify developer content has neither native bridge nor platform cookie storage. Use a self-owned test environment; never repurpose an in-use desktop/Executor or borrow its credentials.
6. Existing relevant Host/Executor/Dashboard/desktop tests, type/build checks, privacy and diff gates. Commit only local work; no push or in-use deployment without separate authorization.

### Build resource guard

Use the single [Dashboard resource-bounded build contract](../../development/dashboard-build.md). The final formal constrained production build has passed (59.718 s, rounded peak 2G, zero swap; an earlier checkpoint took 48.875 s); this removes the normal release-build blocker but does not pass every delivery gate. Full source-map profiling still exhausts the fixed Node heap during chunk rendering and remains an explicit open gate; release output has been restored map-free.

## 9. Implementation and acceptance status

- Design and self-challenge: completed before product code changes.
- Implementation: the end-to-end native framework is connected. Shared schemas, Host authorization/relay, Executor loopback endpoint and the selected-Session Dashboard adapter are wired to restricted native IPC. Only the packaged GTK settings controls can reserve/start; remote commands cannot. Settings are persisted privately/atomically by scoped identity. The application is a plain GTK/WebKit window with a separate WebsiteDataManager/WebContext/cookie database and no Tauri injection. Navigation/Session/context/transport changes cancel the group; stale generations cannot revive it. The desktop titlebar exposes settings only on native-integration-capable origins. This is implemented source, not a release-certification statement.
- Verified so far: **115 JS tests across 10 files** (Host 56, Executor 5, Dashboard 54), including 17 new boundary/module cases, 6 new Dashboard lifecycle cases and 1 real token-authenticated Host/Dashboard/Executor dual-port test. Existing 4 Dedicated-Dashboard cases verify release/asset delivery, not tenant authorization. The wire test verifies un-subscribed Session and other-socket rejection, a server-side read-only guard, post-stop rejection and unchanged conversation state; its read-only flag injection is not a signed ingress-role/tenant-isolation acceptance.
- Native `cargo test --locked`: **19 passed**: the prior 17 plus scoped configuration/private permissions/corrupt-file preservation and application navigation boundaries. The TCP foundation cases use a relay callback; separate real GTK acceptance below exercises native IPC.
- Real Linux GTK/IPC smoke: **passed** with the actual locked desktop binary, isolated Xvfb/D-Bus/profile, real token-authenticated Host/Dashboard/Executor, and two loopback services in a different network namespace. A native keyboard action starts/stops the group; a direct remote `start` request is rejected. It verifies cross-port login Cookie/API, streaming, WebSocket upgrade/duplex with an HMR-style update payload, explicit restart retaining a persistent application cookie, restored saved settings, and listener release after GTK handles Stop. The app sees neither `__KALA_DESKTOP_BRIDGE__`, `__TAURI__`, `__TAURI_INTERNALS__` nor the Dashboard's same-host platform cookie. It is not a full framework dev-server hot-reload or arbitrary external IdP certification.
- The same real WebKit smoke imports emitted production assets: Shiki TypeScript highlighting, Mermaid flowchart SVG/DOM layout and editor-Worker initialization RPC all pass. All five worker builds/VM boots and wider highlighter/parser coverage remain in the build tests; this smoke does not claim full editor interactions for every language.
- Actual Socket.IO Admin development capture regression verifies debug arguments are redacted in both namespaces/directions while transport bytes and ordinary diagnostics are unchanged.
- Acceptance: **partial; not release-certified / not ready to declare all gates passed**. The principal native framework and real local application path now pass. Full Dedicated signed-ingress/effect-owner integration, live membership revocation/placement changes, native Session/account switch and window-close races, external HTTPS IdP navigation and real framework dev-server HMR still need their own evidence. The smoke uses a minimal Dashboard fixture that imports the actual adapter, not the entire rendered production Dashboard shell. Private Cloud multi-tenant/HA acceptance and published Linux package delivery are not inferred from this local gate.
- Native verification fixture: self-owned Ubuntu 24.04 container `kala-app-debug-build-20261030`; Rust 1.93.1 and GTK/WebKit prerequisites installed. Host source is mounted read-only with UID mapping; Tauri generates schema files in a writable source copy **inside the fixture**, with Cargo outputs/cache also inside it. Each test run resynchronizes current desktop inputs; no in-use deployment, HOME or credentials are borrowed.

### Reproduce the opt-in native gate

Use only the self-owned fixture above. Resynchronize `packages/desktop` into its writable source copy, then build/test with `CARGO_BUILD_JOBS=1`, `CARGO_TARGET_DIR=/root/app-debug-target` and `cargo build --locked` / `cargo test --locked`. Build Dashboard release assets through its resource-bounded runner first. From `packages/executor`, run `KALA_NATIVE_DEBUG_SMOKE=1 node ../../node_modules/vitest/vitest.mjs run src/app-debug-desktop-smoke.test.ts`. The gate adds/removes only its own container-loopback proxy device and uses a unique D-Bus/Xvfb and XDG profile; it does not connect to a real account or in-use instance. SDKs and Cargo caches remain available for subsequent development.
