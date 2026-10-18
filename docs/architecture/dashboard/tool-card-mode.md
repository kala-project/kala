# Tool Card Mode

**Status:** Normative source of truth for Tool activity presentation, Intention projection, interaction, and responsive behavior.

`Tool Card Mode` is a per-session dashboard preference controlling only the
collapsed presentation of tool calls. It does not change transcript grouping,
tool execution, approvals, or expanded request/result content.

## Modes

- `dots` (default): one status dot per tool call, with a tooltip containing the
  tool name, primary target, status, and structured change summary when present.
- `standard`: the existing textual card header with tool name, target, lifecycle
  badges, and structured summary.

Clicking either collapsed presentation opens the same detailed activity view. In
Dots mode, clicking an individual Dot pins its bounded preview; the direction
affordance opens the group. Pending approvals remain expanded regardless of mode
so a display preference cannot hide required user action.

## Intention presentation contract

An Intention belongs to one persisted `tool_call`. It is not an LLM-generated
session summary and the Dashboard must not invoke an LLM to shorten, rewrite, or
invent one. Tool input, commands, paths, and parameters are not substitutes for
an Intention and remain hidden in the default presentation.

Every modern Tool schema requires a model-authored Intention of 12–240 characters.
It must state the concrete user- or product-facing objective advanced by the call
and why that operation is needed, with enough domain context to distinguish it
from adjacent calls. Generic action labels (`read file`, `search code`, `run
tests`), argument paraphrases, commands, and paths are invalid product copy. The
system prompt and schema description both carry this rule so it survives provider
differences. Because some OpenAI-compatible providers do not reliably honor
JSON-Schema `required`, the Host also injects the current Intention instruction
at request assembly time, including for Sessions created under older prompts.
Legacy providers that still omit Intention remain executable, but the value stays
absent and the UI uses its generic lifecycle state; the Kernel must never
synthesize product copy from a path, command, query, URL, pattern, or generic
operation sentence.

The three presentation surfaces have different responsibilities:

1. **Agent activity Badge** is the only persistent surface for the current or
   immediately preceding live action.
2. **Collapsed Dot Line text** explains historical activity or the Dot the user
   is actively inspecting; it must not duplicate the Badge.
3. **Expanded rows and pinned previews** explain a selected call. Commands,
   paths, and parameters remain inside closed `Technical details`.

### Agent activity Badge

The Badge projects lifecycle state from authoritative kernel state and persisted
Tool events. It must match a live `pendingCalls.callId` to the corresponding
`tool_call`; it must never treat the last Intention in the lifetime Timeline as
current merely because it is the newest one.

| Runtime state | Badge behavior |
|---|---|
| Tool running | The current full Intention as primary copy; animated activity icon and live elapsed time express execution |
| Tool succeeded and the Agent is thinking before its next action | The previous full Intention as primary copy; success icon and fixed Tool duration express the completed step |
| Tool failed and the Agent is thinking before its next action | The previous full Intention as primary copy; failure icon and fixed Tool duration express the failed step |
| Waiting for Tool approval | The pending full Intention as primary copy; amber approval icon expresses the gate |
| Thinking or working before any Tool Intention exists | The short fallback `Thinking` or `Working` |
| Assistant text streaming, idle, done, or error | No stale Tool Intention; the existing streaming, completion, or error surface owns feedback |

The completion wording refers only to the preceding Tool step, not to completion
of the user's whole task. When a new Tool starts, its current Intention replaces
the previous-step projection immediately. Missing legacy Intention data uses only the short lifecycle state; it must not
fabricate an Intention or expose Tool arguments. The Badge
must not render prose prefixes such as `In progress`, `Previous step completed`,
`Previous step did not complete`, or `Awaiting approval`; lifecycle is visual
state, not a second sentence competing with the Intention.

### Collapsed Dot Line text

The Dot Line always preserves the compact Tool history. Its text follows this
priority and suppression policy:

1. A pinned Dot's full Intention.
2. A hovered or keyboard-focused Dot's full Intention.
3. For a settled historical group, the group's latest full Intention as its
   persistent summary.
4. Otherwise no text.

While the group contains a running Tool, its default text is hidden because the
Badge already shows the current Intention. While the Agent is in the post-Tool
thinking bridge and the Badge shows the just-finished Intention, that
just-finished
group's default text is also hidden. Inspecting another historical Dot may show
that Dot's Intention; inspecting the current/previous Dot must not render the
same sentence twice.

When the group is expanded, the collapsed group summary is removed. Each row
with a recorded Intention shows that Tool's own full Intention. Hover and pinned
previews may repeat the selected row's Intention because they replace, rather
than accompany, the collapsed summary. Legacy calls without a recorded Intention remain individually visible using the
existing non-sensitive Tool summary (for example, `Read completed` or
`Search completed`), rather than a fabricated Intention or a generic placeholder.
Failed, running, and approval calls likewise remain individually inspectable.
Commands, paths, and parameters remain hidden behind the per-call closed
`Technical details` disclosure.


### Dot grouping and expansion

Dots are grouped only when adjacent calls use the same Tool name. A group renders
`×N`; it never merges across a different Tool. `×N` is semantic call aggregation,
while `+N` remains the width-budget omission count. Aggregated status preserves
failure, approval, running, orphaned, and success precedence, and expansion still
shows every original call and result.

Expanded Tool activity ends with a visible Collapse action. Collapsing from the
bottom returns the summary near the viewport instead of forcing the user to scroll
back through a long detail block.

### Responsive expanded layout

The expanded group header is metadata only: Tool/`Tool activity`, operation
count, and lifecycle badges. It must not place a command, path, parameter, or
long Intention into a shrinking header column. On narrow phones and portrait
tablets, lifecycle badges may wrap onto a second line but the content column
must never collapse into character-by-character wrapping. Per-call Intention is
shown in the rows; technical values stay in closed `Technical details`.

## Required state-transition behavior

The following sequence is normative:

```text
thinking without Tool -> Thinking Badge
Tool dispatched        -> current Intention + animated activity state
Tool result persisted  -> same Intention + success/failure state and fixed duration
next Tool dispatched   -> next Intention + animated activity state
assistant text streams -> Badge hidden
turn settles           -> Badge hidden; Dot Line becomes a historical summary
```

At no point may the same Intention be simultaneously rendered as both the Agent
activity Badge and the default Dot Line text.

## Verification gates

Changes to this contract require:

- reducer/unit coverage for running, approval, successful previous step, failed
  previous step, new-Tool replacement, streaming suppression, and settled turn;
- component coverage proving Badge/Dot Line de-duplication plus Hover and Pin
  behavior;
- responsive component coverage for expanded mixed groups;
- a production build and real Chromium inspection at phone, portrait tablet,
  and desktop sizes, with no viewport overflow, character-by-character header
  wrapping, console errors, or broken Dot interactions;
- transactional deployment through the external checkpoint finalizer, followed
  by read-only verification of the completed transaction, active generation
  hash, Host health, Executor reconnection, and production UI.

## Ownership and persistence

The value lives in `SessionPreferences`, alongside the selected model. The host
persists explicit values as append-only session metadata and includes preferences
in session summaries so Session Info can inspect and update any listed session.
Missing values resolve to `dots`; old sessions therefore receive the new default
without rewriting their logs. Existing control-plane metadata updates synchronize
changes across connected dashboards.

Session Info is the only configuration surface. It displays the effective mode
and saves changes together with the other editable session metadata.
