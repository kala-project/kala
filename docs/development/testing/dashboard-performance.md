# Dashboard production performance profiling

For the reusable commands, evidence layout, A/B workflow, source-map attribution, scenario authoring rules, and troubleshooting, see [Dashboard production profiling runbook](dashboard-performance-runbook.md).

## Standard

Performance conclusions must come from the embedded production Dashboard bundle running in real Chromium against the real Host. Unit timing and component fixtures may guard algorithms, but they do not establish user-visible performance.

Each profile keeps:

- production artifact identity;
- Chrome trace and CPU profile;
- Long Task entries and frame intervals;
- DOM, mounted Transcript rows, Inspector Trace rows, and minimap nodes;
- JS heap and layout/style counters;
- an exact reproducible interaction scenario.

Commands:

```bash
pnpm run perf:profile-production
pnpm run perf:profile-streaming
```

`perf:profile-production` creates a 5,001-event Session by default. `PERF_TURNS` controls its size. `PERF_ASSERT_BUDGET=1` enables structural CI budgets.

## Confirmed baseline

The initial 5,001-event production profile showed:

| Scenario | Baseline |
|---|---:|
| Cold load | about 4.45 s |
| Short Session → long Session | about 2.68 s |
| Long Session → short Session | about 805 ms |
| DOM nodes on long Session | 105,876 |
| Longest cold-load Long Task | 1,254 ms |
| Longest short → long frame | about 1,317 ms |
| Transcript rows mounted | 10 |

DOM attribution proved the Transcript virtualizer was working: its visible rows had only 15–37 descendants each. The unbounded DOM came from the default Inspector Trace:

- `reducer-trace-list`: about 100,001 descendants;
- `timeline-minimap`: 5,000 descendants.

The Trace rendered every event and repeatedly called `timeline.indexOf`, `findPriorCallLlm`, `flow.find`, and `messageIndexFor` per row. This combined an unbounded DOM with repeated full-history scans.

## Optimization 1: Inspector Trace windowing

The Reducer Trace now uses `react-virtuoso`. Trace metadata is prepared in one linear pass, and the minimap samples at most 120 real events while always preserving the selected event.

Production A/B with the same 5,001-event fixture:

| Metric | Before | After | Change |
|---|---:|---:|---:|
| DOM nodes | 105,876 | 1,276 | -98.8% |
| Cold load | 4.45 s | 1.81 s | -59.3% |
| Short → long | 2.68 s | 443 ms | -83.4% |
| Long → short | 805 ms | 261 ms | -67.5% |
| Longest switch Long Task | 1,095 ms | 90 ms | -91.8% |
| Scroll maximum frame | 300 ms | 50 ms | -83.3% |

The optimized page still mounted the same 10 Transcript rows. Inspector Trace retained visible rows and 120 minimap samples; the feature was not disabled or truncated.

## Optimization 2: current-turn orphan repair

Source-mapped production CPU profiles showed `appendCancelledResultsForOrphanedToolCalls` consuming about 65 ms while replaying the long Session. It scanned the complete accumulated message history for every new user turn, causing cumulative quadratic work.

The state-machine boundary only needs to inspect the immediately preceding turn: earlier turns have already crossed the same repair boundary. Restricting the scan to the suffix after the latest user message produced:

| Metric | Before | After |
|---|---:|---:|
| Short → long | 475.5 ms | 409.7 ms |
| Longest Long Task | 90 ms | 53 ms |
| p95 frame | about 100 ms | 50 ms |

The prior 65 ms hotspot disappeared. Kernel state-machine tests include a 2,000-turn history and verify that only the current orphan is repaired.

## Real streaming result

A separate production profile used:

- production Host and Executor artifacts;
- a same-protocol Anthropic SSE provider;
- 240 Markdown token chunks over about three seconds;
- eight real `read_file` Tool calls;
- the final persisted response.

Observed result:

| Metric | Result |
|---|---:|
| Total sampled interaction | 3.66 s |
| Average frame | 16.83 ms |
| p99 frame | 16.8 ms |
| Maximum frame | 50 ms |
| Frames over 33 ms | 2 |
| Frames over 50 ms | 0 |
| Long Tasks | one, 61 ms |
| DOM nodes | 1,615 |

This disproved the hypothesis that token batching or Tool streaming was the primary source of the general multi-second jank. The largest application-related sampled cost was Motion scroll measurement, but it did not create sustained dropped frames in this scenario.

## Current budgets

For the production history profile:

- long-Session DOM: at most 5,000 nodes;
- Reducer Trace subtree: at most 1,000 descendants;
- minimap: at most 150 descendants;
- Session-switch Long Task: at most 200 ms;
- cold-load Long Task: at most 250 ms.

Absolute wall-clock timings remain recorded but are not CI gates because shared runner speed varies. Structural bounds and Long Task ceilings are stable regression signals.

## Remaining measured costs

After the two confirmed fixes, source-mapped switching profiles still show smaller costs in:

- Inspector state-diff `messagesEqual` serialization;
- human-attention timeline derivation;
- normal Kernel history replay;
- initial code-highlighter/WASM loading;
- Motion scroll measurement.

These are not yet large enough to justify speculative rewrites. Any further optimization must first reproduce one of them as a user-visible Long Task in the same production profiler.
