# Dashboard Frontend Improvements

> Scope: `packages/dashboard`
>
> Status: implemented and reviewed
>
> Focus: resilient browser capabilities and narrow-screen operational layouts.

This document records the implemented frontend architecture and its acceptance
criteria. Browser features are progressive enhancements: the host remains the
source of truth, unsupported APIs fall back quietly, and no dashboard feature
adds presentation state to the kernel or wire protocol.

## Design Rules

1. Browser-local state may cache or present runtime data, but never owns agent
   execution, approvals, routing, queued messages, or session history.
2. Socket.IO, host RPC, and session event streams are never Service Worker
   runtime-cache targets.
3. Session transcripts and tool output are sensitive browser-profile data. A
   user can disable and clear the durable cache from Settings.
4. Browser APIs are feature-detected. Core workflows remain usable without
   IndexedDB persistence, App Badging, File System Access, or Wake Lock.
5. Mobile layouts preserve operational density and actions. They do not turn
   data-heavy work surfaces into horizontally scrolling desktop tables.

## Delivered Architecture

### Durable Session Cache

The dashboard uses a two-level read-through cache:

- L1 is the existing synchronous memory LRU. It makes same-tab session changes
  immediate and remains available when durable storage is disabled.
- L2 stores normalized session views in IndexedDB through `idb`. It restores a
  previously viewed session before opening its Socket.IO connection.
- Keys are partitioned by normalized host endpoint, protocol version, and local
  cache schema version. Data from another host or incompatible schema cannot be
  hydrated accidentally.
- The host cursor reconciles every cached view. A cache behind the host requests
  only the missing history; a cache ahead of the host is discarded and reloaded
  in full.

Durable writes are scheduled outside socket handlers. They are cursor-monotonic
across tabs, use a single IndexedDB read/write transaction for compare-and-put,
and enforce the configured byte budget by least-recently-used timestamp.

Deletion is generation-safe. Session deletion invalidates all older writes for
that session. Clear, disable, and close invalidate the whole cache generation. A
mutation barrier orders deletes and namespace clears against writes that already
started, and `flush()` waits for both scheduled and in-flight operations. This
prevents a delayed write from resurrecting cleared data.

Settings exposes:

- durable cache enable/disable;
- cache size budget;
- cached session count and estimated bytes;
- browser persistent-storage status and request action where supported;
- explicit cache clearing.

Disabling L2 clears durable records but intentionally preserves L1 memory for
the current page. Corrupt or structurally invalid records are ignored and
removed. IndexedDB failure never prevents the dashboard from connecting.

### Background Scheduling

`lib/scheduler.ts` provides a cancellable background task abstraction. It uses
`scheduler.postTask` when available and a zero-delay task fallback otherwise.
Cancellation has two distinct guarantees:

- work that has not started is rejected with `AbortError` and never runs;
- work that already started receives an aborted signal, but its task promise
  settles only after the callback settles.

The second guarantee is required by IndexedDB cleanup and `flush()`. Synchronous
callback exceptions are converted into task rejections.

Workers were not added. Current measurements and test fixtures do not justify
structured-clone cost, worker protocols, and duplicated lifecycle handling. A
worker should be introduced only after a named pure computation exceeds the
main-thread budget on representative sessions.

### App Badging

Installed applications can show a conservative actionable count. The count is
derived from loaded control/session state and includes pending approvals, visible
session failures, and connection failure. Merely running a session does not set a
badge.

Badging is configurable under Notifications. Unsupported browsers render a
disabled control and continue normally. Badge updates ignore browser API errors,
clear when the count reaches zero, and clear on `pagehide` or dashboard unmount.
The badge is a local approximation, not a server-global counter.

### Explicit File Saves

`lib/save-file.ts` is the shared explicit-save path for workspace file downloads
and artifact exports. On supported browsers it opens `showSaveFilePicker`, writes
the Blob, and closes the writable stream. Cancellation is quiet. Unsupported
browsers and non-cancellation picker failures use the existing Blob URL download
fallback.

MIME parameters are removed before constructing picker accept rules. File
handles are never persisted, and remote paths are reduced to user-facing
filenames. Saves remain direct user actions; an agent cannot write to the
operator's local filesystem through this API.

### Wake Lock and Page Lifecycle

Wake Lock is opt-in under Interface settings. A visible page requests a screen
lock only while the selected session is actively running. It releases when the
session rests, the page becomes hidden, the setting is disabled, or the component
unmounts. It reacquires after visibility returns if the run is still active.

`pagehide` starts a best-effort cache flush without blocking navigation. Socket
state reconciliation remains active and independent of Wake Lock support.

## Responsive Work Surfaces

### Composer and Shell

The existing visual-viewport shell remains the single height authority for
desktop, mobile browser, and standalone PWA modes. Composer controls stay within
the visible viewport, retain a minimum 16px mobile input size to avoid iOS zoom,
and do not create document-level horizontal overflow.

### Inspector

The trace panel keeps its minimap, filter controls, replay scrubber, and semantic
state summaries width-bounded. State diff content is collapsed by default; the
selected sequence and change count remain visible in the status row. Expanding
the panel shows semantic groups first and raw field-level changes only behind a
second explicit toggle.

### Settings

The dialog is bounded by the visual viewport. Its section selector is a compact
responsive strip, while section content owns vertical scrolling and rejects
horizontal overflow. Wide path/config tables use stacked key/value rows where a
table would be unreadable. Controls wrap at narrow widths without moving primary
actions outside the viewport.

### Artifacts and Session Profiles

Artifact inventory, Session profiles, and memory use two renderers
from the same data model:

- desktop keeps dense comparison tables;
- widths below the medium breakpoint use compact, scan-friendly rows.

CSS selects the active renderer. Tests scope queries to the intended desktop or
mobile tree because DOM test environments do not apply responsive CSS. Operations
rows collapse to stacked fields on narrow screens instead of preserving fixed
desktop columns.

### Explorer, File Viewer, and Metadata

The existing session/file/git drawer behavior remains intact. File-view controls
wrap without horizontal page scrolling, and large images use a contained scroll
area. Workspace metadata switches from a desktop table to mobile definition rows
with breakable values. File save actions use the shared native-picker/fallback
path.

## Verification

Automated component coverage includes:

- L1/L2 hydration and host namespace partitioning;
- stale-tab cursor protection;
- delete, clear, and disable during an in-flight IndexedDB write;
- scheduler cancellation before and during execution;
- native save, cancellation, permission failure, and Blob fallback;
- App Badge count derivation and unsupported browsers;
- Wake Lock acquire, hide/release, restore/reacquire, and disable;
- responsive artifact, settings, metadata, inspector, file, and source-control
  surfaces.

The real-browser regression script builds the production PWA once, starts the
real host, and reuses one Chromium process for:

| Surface | Viewport | Checks |
| --- | ---: | --- |
| Desktop browser | 1440 x 820 | shell, composer, settings, tool cards, inspector |
| Mobile browser | 320 x 700 | minimum-width containment |
| Mobile browser | 375 x 812 | common compact phone |
| Mobile browser | 390 x 844 | full settings and capability controls |
| Mobile browser | 430 x 932 | large phone |
| Standalone PWA | 390 x 844 | service worker, viewport, full settings |

Every scenario checks shell height, document horizontal overflow, composer focus
and visibility, touch input font size, dots-mode tool expansion, and dialog
containment. The full settings scenarios also verify durable cache, Wake Lock,
and App Badge controls.

## Deferred Work

- OPFS is deferred. The cache currently stores JSON session views, not large
  binary blobs, so a second storage engine would add complexity without benefit.
- Web Workers are deferred until profiling identifies a specific pure operation
  whose compute cost exceeds serialization and messaging overhead.
- Streamed downloads require a host streaming endpoint and are outside this
  frontend-only change. Current explicit saves still materialize a Blob.
- Cross-tab App Badge leadership is deferred. Badge state remains a conservative
  local approximation and clears on page exit.
- Browser cache encryption is not claimed. Users requiring no transcript data on
  disk should disable the durable cache and clear existing records.

## Non-Goals

- changing kernel state, event schemas, or Socket.IO protocol messages;
- storing authoritative queued messages or runtime decisions in the browser;
- Service Worker caching of host APIs or session streams;
- persistent local file handles or automatic background exports;
- replacing desktop operational tables when enough width is available.
