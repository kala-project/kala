# Compact Auto-resume Incident — 2026-07-31

**Status:** historical incident report; not current release evidence or implementation status.

Session: `123e4567-e89b-42d3-a456-42661417000d`

## Evidence

The Session log shows two distinct behaviors:

1. Successful compactions at cursors 871, 1742, 3095, 4929, 6631, 7764, 8533, 9360 and 10276. Compaction itself usually continued because it occurred inside an already-running Host dispatch chain.
2. At cursor 10399 the durable Task Graph still had pending work, but the next LLM response at cursor 10400 used `finishReason=stop` with plain text. Kernel correctly treated a plain assistant answer as terminal `done`; no durable mechanism translated unfinished Task Graph state into a continuation obligation. Work stopped until the user sent another message at cursor 10401.

Several historical compaction events had `resume=true`, but others had no resume flag. Automatic compaction on a resting Session explicitly called `compact(..., 'auto')` without resume, so a Session with durable active graph work could remain done after compaction. This was not a summarizer failure; it was a missing contract between Task Graph durability and Host liveness.

The dense cancel sequence around cursor 9350 is historical duplicate input already covered by cancel coalescing/event-log hardening. No new cancel occurred at cursor 10400; the latest reported interruption was the premature terminal LLM response.

## Fix

- Added `todoGraphContinuationState`, reconstructed from durable successful `todo_graph` results after process restart.
- Host now regards active or ready Task Graph nodes as an explicit autonomous-work obligation.
- If the LLM returns a terminal plain response while that obligation remains, Host emits a durable recovery `messages_replaced(resume=true)` and continues once.
- Automatic compaction of a resting Session resumes immediately when durable graph work remains.
- Continuation is bounded to once per Task Graph revision. The graph must advance before another automatic recovery, preventing a malfunctioning model from hot-looping.
- Cancel and clear always suppress this recovery; Sessions without Task Graph work retain normal one-answer terminal behavior.
- Missing logs during teardown fail the optional continuation check closed without an unhandled rejection.

## Verification

- Focused Host tests: 157 passed.
- Full Host suite: 113 files, 853 passed, 2 skipped, no unhandled errors.
- Kernel suite: 58 passed.
- Regression tests cover premature terminal response, one-per-revision bound, no-graph behavior, fresh-Host durable graph reconstruction, and auto-compact continuation.
