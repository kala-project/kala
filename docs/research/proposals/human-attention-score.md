# Human Attention Score

## Motivation

Vibe coding can gradually move from assisted work to unattended delegation. The
operator may keep sending broad continuation prompts while the agent performs
more tool calls, edits more files, and approaches higher-risk actions such as
deploys or restarts. The product needs a session-level indicator that answers a
specific operational question:

> Is the human providing enough effective attention for this session's current
> autonomous activity and risk?

This is not a productivity score, politeness score, or global user-activity
metric. It is a risk indicator for one session.

## Design Principles

1. **Session scoped**

   Each score belongs to exactly one session. A user can be highly engaged in
   one session and absent in another. No global roll-up is part of this feature.

2. **Message-indexed timeline**

   The primary artifact is a curve where `x = message cursor` and `y = score`.
   The latest point is the compact indicator; the full timeline explains how
   attention changed as the conversation progressed.

3. **Quality of attention, not amount of activity**

   The score measures evidence of intent, constraints, review, correction, risk
   awareness, and continuity. Frequent approvals or clicks do not imply high
   attention unless they are paired with real review evidence.

4. **Risk-aware context**

   The same message can mean different things depending on session risk.
   `continue` after read-only exploration is low risk. `continue` after many
   edits, commits, and a pending deploy is high risk.

5. **Tone-insensitive**

   The evaluator must not penalize rudeness or emotional language. A blunt
   correction with specific technical constraints is high-quality attention.

6. **Explainable**

   Every low or high score must have compact reasons that point to evidence,
   such as "18 tool calls since last substantive review" or "Human corrected an
   incorrect deployment assumption".

7. **Non-blocking by default**

   The indicator warns and guides review. It should not interrupt normal work.
   High-risk actions may later use the score as a double-confirm signal.

8. **LLM-ready, deterministic first**

   The first implementation uses deterministic semantic heuristics so the UI is
   fast and always available. A later LLM evaluator can replace only the
   semantic judgement layer; final score composition remains deterministic.

## Data Model

The session exposes a timeline of points:

```typescript
type HumanAttentionTimeline = {
  sessionId: string
  points: readonly HumanAttentionPoint[]
  latest: HumanAttentionPoint | null
}

type HumanAttentionPoint = {
  sessionId: string
  messageCursor: number
  score: number // 0..100
  level: 'engaged' | 'watching' | 'drifting' | 'absent'
  confidence: number // 0..1
  dimensions: {
    inputQuality: number
    reviewDepth: number
    correctionQuality: number
    riskAwareness: number
    continuity: number
    riskExposure: number
  }
  reasons: readonly HumanAttentionReason[]
  evaluatedAt: string
  evaluator: 'heuristic' | 'llm'
}
```

`messageCursor` is the session event sequence. This makes chart points stable
across reconnects and replay.

## Scoring Rules

The score is easier to reason about as three forces:

```text
score = SemanticQuality + ReviewBonus - RiskPenalty - StalenessPenalty
```

The first implementation computes these from the session event timeline.

### Semantic Quality

Recent human messages and durable session anchors are scored for:

- **Intent quality**: explicit goal, scope, and acceptance criteria.
- **Constraint quality**: boundaries such as "do not deploy", "one commit per
  task", "do not write hostnames into repo".
- **Correction quality**: precise correction of agent assumptions or behavior.
- **Risk awareness**: references to tests, schema, deployment, data loss,
  running sessions, compatibility, or rollback.
- **Continuity**: reference to earlier requirements and enforcement of prior
  decisions.

Short messages are not automatically low quality. `不要部署` is short and high
signal. `继续` is short and usually low signal.

### Session Anchors

Some human instructions remain relevant beyond the recent window. Examples:

- no deployment without instruction
- one task per commit
- run tests before deploy
- do not write private hostnames into repo
- preserve current UI behavior

Anchors decay more slowly than ordinary messages, so an early high-quality
instruction does not disappear immediately. However, anchors cannot fully offset
large accumulated risk without fresh review.

### Risk Exposure

Risk exposure comes from agent activity since the last substantive human review.
Activity classes use different weights:

- read-only exploration: low
- tool calls that execute shell commands: medium
- file edits: medium-high
- commits/builds: high
- deploy/delete/schema/restart/force operations: very high

The score should drop slowly during read-only audit and faster during broad code
changes or deployment preparation.

### Review Evidence

Review evidence raises confidence and offsets risk:

- specific critique of output, screenshot, diff, or behavior
- correction of wrong environment/session assumptions
- approval paired with reason or constraint
- request for tests, risk summary, or exact change list

Plain repeated approvals are weak evidence and can still produce a low score.

### Levels

```typescript
if (score >= 75) level = 'engaged'
else if (score >= 50) level = 'watching'
else if (score >= 30) level = 'drifting'
else level = 'absent'
```

## Timeline Rules

The first implementation computes a point at each human message and at major
agent milestones. The chart uses all points, and the compact indicator displays
the latest point.

The evaluator uses a sliding recent window plus session anchors:

- recent window: roughly the last 24 session events
- anchors: durable high-signal constraints discovered earlier in the session
- risk since last substantive review: events after the last meaningful human
  review or correction

## UI Design

### Compact Indicator

The indicator appears in the current session header/control area near context
usage:

```text
Attention 68
```

Colors are restrained:

- `engaged`: green
- `watching`: sky/neutral
- `drifting`: amber
- `absent`: red

Empty state uses `Attention --` with a tooltip explaining that there is not
enough session activity yet.

### Popover

Clicking the indicator opens a session-scoped panel with:

- latest score and level
- line chart: x-axis message cursor, y-axis score 0..100
- compact dimension bars
- latest reasons
- suggested review actions

Point hover shows message cursor, score, level, and reasons for that point.

### Low Score Banner

When the latest level is `absent` and there is evidence of meaningful risk or
repeated low-signal delegation, a compact banner appears above the composer:

```text
Attention is low. Review recent changes before broad instructions.
```

It should be visible but not modal. A fresh low-risk exploration request should
not show this banner merely because it lacks review language; `absent` only
becomes user-facing when it is risk-adjusted.

### Suggested Actions

Initial actions:

- ask for risk summary: prefill or send a review prompt later
- review recent changes: later integration with changed-file/diff surfaces
- continue anyway: dismisses the banner for the current latest point

## LLM Evaluation Extension

The LLM evaluator should only replace semantic judgement. It should receive a
compact evidence packet, not the full transcript, and return structured scores
for the semantic dimensions. It must be explicitly instructed not to judge tone,
personality, or politeness. The deterministic scorer still combines semantic
quality with risk exposure and review staleness.

## Draft: Risk-Matched LLM Evaluation

The current regex-based evaluator is useful as a deterministic baseline, but it
should not remain the long-term source of truth for semantic judgement. Keyword
matches cannot reliably distinguish "do not deploy", "did you deploy?", and
"deploy now after tests pass". The next design should measure a simpler and more
operational idea:

> Attention score is the quality of current human supervision relative to the
> risk the agent has already taken or is about to take in this session.

### Formula

The final score remains deterministic:

```text
score = clamp(H - M - S - D, 0, 100)
```

- `H`: effective human supervision quality.
- `M`: risk mismatch penalty.
- `S`: stale supervision penalty.
- `D`: repeated delegation penalty.

The LLM only estimates semantic quality for a new human message. It does not
walk the full timeline, compute tool risk, apply decay, or produce the final
score.

### Effective Human Supervision Quality

For each new human message, the host evaluates a fixed-size evidence packet and
stores a quality result. The packet includes the new human message, a bounded
summary of recent agent activity, the latest risk summary, and a small number of
recent human messages. It must not include the full transcript.

The quality result is a `0..100` score using this rubric:

- `0..20`: low-information permission such as "continue", "ok", or "do it".
- `20..40`: broad instruction with little scope, context, or verification.
- `40..60`: clear target that is sufficient for low-risk exploration.
- `60..75`: concrete feedback based on visible output, logs, errors, UI state,
  or recent agent behavior.
- `75..90`: clear target plus constraints, ordering, or verification criteria.
- `90..100`: strong supervision that corrects an agent mistake and states risk
  boundaries or acceptance criteria.

The current effective value is:

```text
H = max(Q_latest, Q_carried)
Q_carried = Q_last_meaningful * 0.92 ^ work_since_then
```

`work_since_then` is deterministic progress after the last meaningful human
message:

- read-only tool call: `0.25`
- code edit: `1`
- build, test, or typecheck: `1`
- git operation: `1.5`
- deploy, restart, delete, migration, schema, credential, or permission change:
  `3`
- failed tool result followed by more work: additional `1`

This keeps a strong instruction alive while the agent is still operating inside
its scope, but it naturally decays as the agent continues to make consequential
progress.

### Risk Mismatch Penalty

Agent risk is deterministic and session-local. Recent risk events are accumulated
and capped to `0..100`:

- read-only file/search commands: `1`
- ordinary side-effect-free tooling: `2`
- code edit: `8`
- build, test, or typecheck: `6`
- git commit, merge, rebase, or branch mutation: `12`
- ssh, scp, or rsync: `14`
- restart or deploy: `18`
- delete, migration, schema, credential, or permission change: `22`
- failed tool call: additional `4`
- approval mode loosened: additional `20`

The mismatch penalty is:

```text
M = R * (1 - H / 100) * 0.45
```

Low-risk exploration therefore stays calm even with moderate supervision quality,
while high-risk work requires sharper human review, constraints, or correction.

### Stale Supervision Penalty

Supervision expires by meaningful work, not wall-clock time:

```text
S = min(25, max(0, work_since_then - allowance) * 3)
```

`allowance` is based on supervision quality:

- `H < 40`: `2`
- `40 <= H < 60`: `4`
- `60 <= H < 80`: `7`
- `H >= 80`: `10`

If the agent is in one uninterrupted run and the human has had no approval,
idle, or input opportunity, stale growth should pause. The indicator should not
punish the operator for a period where the product gave them no intervention
point.

### Repeated Delegation Penalty

The evaluator separately tracks consecutive low-information human messages such
as "continue", "ok", or "do it". A high-risk command with little detail, such as
"deploy", counts as low-information supervision and also raises deterministic
risk.

```text
D = min(25, streak ^ 2 * 4 * risk_factor)
```

`risk_factor` is:

- `0.4` when `R < 15`
- `0.8` when `15 <= R < 40`
- `1.2` when `R >= 40`

This avoids alarming on one low-risk "continue" during read-only exploration,
but quickly flags repeated broad delegation during edits, deploys, or restarts.

### Cost And Complexity

LLM evaluation must be incremental and persistent:

```text
cache key = sessionId + userMessageSeq + textHash + evaluatorVersion
```

Each human message is evaluated at most once per evaluator version. Tool events,
streaming updates, dashboard reconnects, and session view renders only recompute
the deterministic score from cached quality results and risk state.

For a session with `U` human messages and `N` total timeline events:

```text
LLM calls = O(U)
single LLM input size = O(1)
deterministic score update = O(delta events) or cached O(1) latest update
```

The design explicitly rejects rescoring the whole transcript on every render,
which would create unnecessary cost and could degrade toward `O(N^2)` behavior.

### Execution Model

The LLM evaluator runs in the host, not the dashboard. API keys stay server-side,
multiple dashboard tabs share one persisted result, and failures do not block the
agent loop.

```text
event appended: user_message
  -> enqueue semantic evaluation
  -> build fixed-size evidence packet
  -> store HumanAttentionQualityResult
  -> deterministic scorer updates latest points
  -> dashboard receives derived attention timeline
```

If the LLM call fails or is disabled, the existing deterministic heuristic is the
fallback semantic evaluator. The UI must show lower confidence for fallback
points but keep the indicator available.

### Acceptance Checks

- A fresh "inspect this project" request followed by read-only tools should not
  show a low-attention warning.
- Repeated "continue" during broad edits should degrade rapidly.
- "Deploy" without constraints should not be treated as ordinary continuation;
  it is low-detail supervision combined with high deterministic risk.
- A specific correction of the agent's environment, assumptions, or output should
  recover the score quickly.
- Opening another dashboard tab or reconnecting must not trigger new LLM calls
  for already evaluated user messages.
- Changing `evaluatorVersion` may schedule background reevaluation, but it must
  not block session interaction.

## Simulated Behavior Checks

- Strong constraints plus periodic correction should stay `engaged` even during
  heavy tool activity.
- Repeated `continue` messages during broad edits should drift toward `absent`.
- Read-only code audit with little user interaction should degrade slowly, not
  alarm immediately.
- A short but specific correction should recover the score quickly.
- Repeated approvals without review should not count as strong attention.
