# Memory consolidation

**Status**: design accepted, implementation in progress.
**Depends on**: three-tier memory ([`../executor/tools.md`](../reference/executor/tools.md) §2.10, [`../planning/feature-gaps.md`](../research/proposals/feature-gaps.md) §1.22).
**Pattern reference**: `references/claude-code-collection/memory/consolidator.py`.

## 1. Why

The current memory system exposes three scopes (`session` / `workspace` / `global`) that the agent writes to *on impulse*: whatever the LLM decides is worth remembering in this turn gets a `memory { operation: "write" }` call. That is fine as a working notepad but has one clear gap:

**Impulse writes miss the durable-signal pass.** The agent writes a memory when *the current turn* looks noteworthy, without seeing the whole session. By the time a session ends, the model has learned things — user preferences, corrections, project decisions — that were never distilled into `MEMORY.md` because no single turn was the right moment to write them.

Claude Code's fix: expose a **single slash command** (`/consolidate-memory`) that reads the current session's messages, asks a lightweight LLM call to pull out durable signal, and writes results directly to the workspace memory root. No auto-trigger, no `.staging/` intermediate, no two-phase pipeline. One command, one call, done.

## 2. What we build

### 2.1 Trigger

Only one path: user types `/consolidate-memory` in the dashboard composer. Nothing runs automatically — not on session-done, not on turn count, not on threshold.

Skips (silent no-op returning a short toast):

- Sessions shorter than **8 messages** (the shipped minimum and Claude Code's `MIN_MESSAGES_TO_CONSOLIDATE`). Short Q&A rarely has durable signal.
- Sub-agent sessions — the parent is where signal accumulates; running consolidation on a helper turn double-counts.

### 2.2 What it does

1. Read the session's `state.messages`, filter to the last 40 (≈20 turns) — same window Claude Code uses.
2. Build a condensed transcript: `Role: {first 600 chars of content}` per message.
3. Fire a single host-internal LLM call — same pathway as `compaction.ts`, not a sub-agent — with:
   - system prompt: [`ConsolidatorSystemPrompt`](#61-consolidator-system-prompt)
   - user message: the condensed transcript
   - tools: none (this call doesn't take actions; it emits JSON)
   - expected output: a JSON object matching [`ConsolidatorOutput`](#62-consolidator-output-schema)
4. Parse the JSON. Drop the whole result on parse failure. Drop individual entries missing required fields.
5. Hard-cap at **3 memories per invocation** — matches Claude Code. Quality over quantity.
6. For each candidate entry:
   - Compute the target key: sanitize the `name` field against `/^[a-zA-Z0-9_-]{1,64}$/`.
   - If a workspace memory with that key already exists and its `confidence` >= candidate's `confidence` (default 0.8 for consolidator-sourced), skip. Never downgrade a higher-trust memory with an LLM-inferred one.
   - Otherwise write the memory file atomically (temp + rename) and update `MEMORY.md`.
7. Emit `memory:consolidated` back to the dashboard with counts.

### 2.3 Storage layout

No new directories. Consolidator writes into the existing workspace memory root exactly like `memory { operation: "write" }` does today:

```
<workspace>/.kala/memory/
  MEMORY.md
  <key>.md            ← agent-authored, and now also consolidator-authored
```

Files written by the consolidator carry an extra frontmatter field so we can tell them apart from user/agent-authored entries:

```markdown
---
name: user-prefers-terse-updates
description: The user reinforced that end-of-turn recaps should be one sentence
type: feedback
source: consolidator
confidence: 0.8
generatedAt: 2026-07-06T14:22:00.000Z
sessionId: 01J...
---

{body}
```

The `source: consolidator` field is what enables the "don't downgrade" check on subsequent runs. If the user later explicitly runs `memory { operation: "write" }` on the same key (implicit `source: user`, `confidence: 1.0`), the consolidator will leave it alone on the next pass.

### 2.4 `MEMORY.md` maintenance

`MEMORY.md` stays agent-authored between runs. When consolidator writes a new file, it appends a one-line entry to `MEMORY.md` in the format the existing memory tool already uses: `- Name (key.md) — description`. If the key already existed, replace the line in place. No index-wide rewrite.

### 2.5 What the consolidator does not do

- **No `.staging/` directory.** Direct write.
- **No auto-fire on session-done.** Slash command only.
- **No cross-session consolidation.** Runs against the *current* session's messages, not accumulated staged extracts.
- **No global-scope consolidation.** Workspace only (`<workspace>/.kala/memory/`). Global memory lives at `~/.kala/memory/` and grows via explicit `memory { operation: "write" }` — cross-workspace signal is harder to reason about and out of scope.
- **No merging into existing files.** If the LLM emits a name that collides with an existing memory, we either skip (higher confidence exists) or overwrite (equal or lower). We do not read the existing content and hand it back to the LLM for a merge pass. Simpler; matches Claude Code.

## 3. Wire protocol changes

One new client message, one new host event. All additive.

```typescript
// Dashboard → Host
export type ClientConsolidateMemory = {
  requestId: string
  sessionId: string
}

// Host → Dashboard (ack pattern like fs:read_file)
export type ConsolidateMemoryResult = {
  requestId: string
  sessionId: string
  saved: string[]       // memory names that were written
  skipped: number       // candidates rejected (too-short session, conflict, invalid)
  reason?: string       // populated when saved.length === 0 (e.g. "session too short")
  error?: string
}
```

Kernel: no changes. The consolidator is host-side and writes to disk directly through the executor's memory tool path (or the equivalent host-side write helper).

## 4. Configuration

Current implementation uses the host-side `DEFAULT_CONSOLIDATION_CONFIG` in `packages/host/src/memory-consolidation.ts`:

```json
{
  "memoryConsolidation": {
    "enabled": true,
    "minMessages": 8,
    "maxPerRun": 3,
    "defaultConfidence": 0.8,
    "windowSize": 40,
    "perMessageCharCap": 600,
    "timeoutMs": 60000
  }
}
```

There is no user-facing config file yet. The code path accepts an injected `ConsolidationConfig` for tests and future wiring; if `enabled` is false, the slash command reports "consolidation disabled in config" and does nothing.

## 5. Slash command wiring

Follows the existing `/compact` pattern. Concrete surface:

**Composer** (`packages/dashboard/src/features/chat/Composer.tsx`) — add to `slashCommands` array:

```typescript
{
  command: '/consolidate-memory',
  label: 'Consolidate memory',
  run: onConsolidateMemory,
}
```

**App** (`packages/dashboard/src/app.tsx`) — new `onConsolidateMemory` handler that emits the wire event with a fresh `requestId` and hooks the ack:

```typescript
const onConsolidateMemory = () => {
  if (!session.socket || !session.currentSession) return
  const requestId = crypto.randomUUID()
  session.socket.emit(
    'client:consolidate_memory',
    { requestId, sessionId: session.currentSession.id },
    (result: ConsolidateMemoryResult) => {
      // toast: "Saved N memories" | "Nothing worth saving" | error
    },
  )
}
```

**Host** (`packages/host/src/connection/dashboard-ns.ts`) — new handler alongside `client:compact` that resolves the session, verifies it's at rest (idle/done/error), and dispatches to `consolidateMemory(session, config)` in a new module `packages/host/src/memory-consolidation.ts`.

## 6. Prompts

### 6.1 Consolidator system prompt

Adapted verbatim from Claude Code's `_SYSTEM`:

```
You are a memory consolidation assistant. Analyze the conversation below and
extract insights that are worth storing as persistent memories for future
sessions.

Focus ONLY on:
1. New user preferences or working-style corrections revealed in this session
2. Project decisions or facts made explicit (NOT derivable from code/git)
3. Behavioral feedback given to the AI (what to do or avoid, and why)

Return a JSON object with key "memories" containing a list of objects, each with:
  "name":        short kebab-case slug, matches /^[a-z0-9-]{1,64}$/,
                 e.g. "user-prefers-concise-responses"
  "type":        "user" | "feedback" | "project" | "reference"
  "description": one-line description (used for search relevance)
  "content":     memory body; for feedback/project lead with the rule/fact then
                 **Why:** and **How to apply:** lines
  "confidence":  float 0.0–1.0 (use ~0.8 for inferred, ~0.9 for clearly stated)

Return {"memories": []} if nothing new or worth saving.

Do NOT extract:
- Code patterns, architecture, file paths — derivable from the codebase
- Git history or debugging fixes — already in commits
- Anything already obvious from CLAUDE.md
- Ephemeral task state or tool results

Keep to AT MOST 3 memories. Quality over quantity.
Reply with ONLY the JSON object. No prose, no markdown fences.
```

### 6.2 Consolidator output schema

```typescript
type ConsolidatorEntry = {
  name: string          // /^[a-z0-9-]{1,64}$/ after sanitization
  type: 'user' | 'feedback' | 'project' | 'reference'
  description: string
  content: string
  confidence?: number   // default 0.8
}

type ConsolidatorOutput = {
  memories: ConsolidatorEntry[]
}
```

Validation drops any entry missing `name` / `type` / `description` / `content`. Truncates `memories` to `maxPerRun`.

## 7. Failure modes and recovery

| Failure | Behaviour |
|---|---|
| LLM call errors or times out | `error` field populated on the ack. Session state unchanged. |
| LLM returns malformed JSON | `error: "consolidator returned invalid JSON"`. Nothing written. |
| Entry missing required fields | That entry dropped, `skipped` incremented. Other entries still apply. |
| Entry conflicts with higher-confidence existing memory | That entry dropped, `skipped` incremented. Kept memory unchanged. |
| Session too short | `saved: []`, `reason: "session too short (N < 8 messages)"`. |
| Session not at rest | Ack with `error: "session is running; wait for it to finish"`. |
| Two `/consolidate-memory` invocations concurrently on the same session | Second one waits behind a per-session mutex; both run to completion in order. |

## 8. Testing plan

- **Kernel:** no changes, no tests.
- **Host:** new module `host/src/memory-consolidation.ts`:
  - Skips sessions shorter than `minMessages`.
  - Skips sub-agent sessions.
  - Respects `enabled: false`.
  - Drops entries missing required fields.
  - Skips entries that would overwrite higher-confidence memories.
  - Applies at most `maxPerRun` entries.
  - Writes atomically (temp + rename).
- **Executor:** no changes.
- **Dashboard:** new slash command shows up in the `/` autocomplete, dispatches the wire event, renders the ack as a toast.

## 9. Non-goals

- Two-phase pipeline (per-session staging + workspace consolidate). We looked at codex's design and chose Claude Code's single-step model instead. Reason: agent-kernel is single-user, file-only, and doesn't need the staging plane. If cross-session accumulation becomes valuable later, a staging directory can be layered on top of this without breaking the current surface.
- Structured usage/recency scoring. Confidence is the only rank signal; deletion happens when the user or the LLM says so, not on a decay schedule.
- Global-scope consolidation. Deferred until we see cross-workspace signal that clearly belongs there.
- Streaming progress. The call is short (single non-tool LLM call, no loop). The ack lands in one shot.
