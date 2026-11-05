# Smart Output Truncation & Preemptive Tool Result Pruning (SoT)

**Status**: implemented.
**Related Documents**: `docs/host/tool-output-overflow.md`, `docs/host/context-compaction.md`

---

## 1. Problem Statement & Motivation

In autonomous coding and system-troubleshooting sessions, tool outputs (`bash`, `multi_grep`, `read_file`, test runners, build logs) are the single largest driver of context window exhaustion and prompt-cache invalidation.

Prior to this design, `kala` had two gaps in its tool-output lifecycle:

1. **Executor-Side Single-Line / Long-Line Tail Loss & Non-Actionable Overflow Hints (`packages/executor/src/tools/overflow.ts`)**:
   - When an output had fewer than `previewLines` (400) lines—or when `previewLines` still exceeded `inlineBytes` (e.g., minified bundles, long JSON lines, dense compiler output)—`preview()` fell back to `Buffer.from(full, 'utf8').subarray(0, inlineBytes).toString('utf8')`.
   - That fallback **dropped the tail completely** (hiding the decisive exit error or summary at the end of the output) and could slice multi-byte UTF-8 codepoints mid-character.
   - Furthermore, `overflowMarker` referenced `read { path: '...' }` without telling the model which **exact line numbers** were omitted or how to paginate the middle region via `read_file { path, offset, limit }` or search it with `multi_grep`.

2. **Host-Side Gap Between Normal Operation and Full LLM Compaction (`packages/host/src/extensions/compaction.ts`)**:
   - Full context compaction (`runCompact`) invokes an LLM summarizer at `hardThreshold` (92% of context window) and replaces the conversation prefix with a summary.
   - Often, 70–85% of the accumulated transcript tokens consist merely of stale historical `tool_result` payloads from 10+ turns ago that the agent has already inspected and acted upon.
   - Paying for a full LLM summarization call (and rewriting the entire message prefix) when deterministic pruning of stale oversized `tool_result` payloads would immediately reclaim 30–60% of the context window wastes latency, tokens, and conversational fidelity.

---

## 2. Design Overview

We introduce a two-stage defense across the Executor and Host boundaries while keeping `@agent-kernel/kernel` 100% pure:

```
┌────────────────────────────────────────────────────────────────────────────┐
│ Stage 1: Executor Smart Head+Tail Truncation & Actionable Spill Navigation │
│ (packages/executor/src/tools/overflow.ts)                                  │
│                                                                            │
│ - Triggers when UTF-8 byte length > inlineBytes (default 32 KB)            │
│ - Spills full output to <workspaceRoot>/.kala/overflow/<sessionId>/<callId>│
│ - Computes Head + Tail preview bounded by BOTH previewLines AND inlineBytes│
│ - UTF-8 codepoint-safe byte slicing (never produces U+FFFD replacement)    │
│ - Emits exact omitted line range when whole lines survive, or restarts pagination at line zero when the byte budget cuts through lines; supplies actionable `read_file` & `multi_grep`   │
│   instructions within the 512-char dashboard sentinel window               │
└────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ Stage 2: Host Preemptive Tool Result Pruning (Micro-Compaction)            │
│ (packages/host/src/context/preemptive-pruning.ts + compaction.ts)          │
│                                                                            │
│ - Zero-LLM, deterministic pruning pass before full LLM compaction          │
│ - Triggers in `beforeModelCall` when context usage >= softThreshold (0.70) │
│   or before `runCompact` when historical tool results dominate context     │
│ - Protects the most recent `preserveRecentGroups` (default 6 assistant     │
│   turn groups) so active reasoning never loses recent tool outputs         │
│ - Replaces older oversized `tool_result` blocks (>= 2,000 chars) with a    │
│   compact stub preserving head/tail snippet, original byte/line counts,    │
│   spill path (if present), and 100% valid `tool_call`/`tool_result` pairs  │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Stage 1 Specification: Executor Smart Head+Tail Truncation

### 3.1 Dual-Constraint Head+Tail Preview (`previewSmart`)

Given `full: string`, `previewLines: number`, and `inlineBytes: number`:

1. **Line-based Head+Tail split**:
   - Split `full` on `\n` into `parts` (`totalLines = parts.length`).
   - If `totalLines > previewLines` and `previewLines > 0`:
     - `headLines = Math.max(1, Math.ceil(previewLines / 2))`
     - `tailLines = Math.max(1, previewLines - headLines)`
     - `omittedStartLine = headLines + 1` (1-indexed display; `read_file.offset` is zero-based)
     - `omittedEndLine = totalLines - tailLines` (1-indexed)
     - `omittedLines = totalLines - headLines - tailLines`
     - Construct candidate preview with marker:
       `[... ${omittedLines} lines omitted (lines ${omittedStartLine}-${omittedEndLine}) ...]`

2. **Byte-budget Head+Tail enforcement (`sliceHeadTailUtf8`)**:
   - If the candidate preview (or `full` when `totalLines <= previewLines`) still exceeds `inlineBytes`:
   - Reserve budget for the inline omission marker (~96 bytes), then split the remaining byte budget **50% Head / 50% Tail** (clamped so total preview bytes <= `inlineBytes`).
   - Slice the UTF-8 buffer on valid codepoint boundaries at both the end of Head and the start of Tail so multi-byte UTF-8 characters (CJK, emoji, box-drawing characters) are never corrupted into `U+FFFD`.
   - Insert `[... ${omittedBytes} bytes omitted (${omittedLines} lines) ...]` between the UTF-8-safe head and tail slices.
   - When this byte-budget fallback applies, slice the original full output rather than the line-shortened candidate; previously computed whole-line omission offsets are no longer valid. Label the preview as zero complete lines and start `read_file` at offset zero.

### 3.2 Actionable Overflow Marker (`overflowMarker`)

The marker appended at the end of the truncated tool output must:
1. Put `--- output truncated:` last so it remains within the Dashboard's final 512 characters even for long spill paths.
2. Provide exact `read_file` pagination parameters (`path`, `offset`, `limit`) and `multi_grep` guidance so the LLM can inspect the omitted middle section directly:

```text
--- use `read_file { path: '<filePath>', offset: 200, limit: 200 }` or `multi_grep { searches: [{ pattern: '<pattern>', path: '<filePath>' }] }` to inspect omitted lines
--- output truncated: 400 / 2400 lines, 14210 / 98304 bytes stored at overflow://call_01J...
```

---

## 4. Stage 2 Specification: Host Preemptive Tool Result Pruning

### 4.1 Invariants

1. **Tool Call / Tool Result Pairing**:
   - Every `tool_call` in an `assistant` message must still have its matching `tool_result` with the exact same `callId` in the subsequent `tool` message. Preemptive pruning **never deletes** a `tool` message or `tool_result` item; it only shrinks `item.content` in place.
2. **Recent Turn Protection**:
   - The most recent `preserveRecentGroups` assistant turn groups (default `6`) are never modified by preemptive pruning. Active multi-step debugging always sees its recent tool outputs verbatim.
3. **Idempotency**:
   - Already-pruned `tool_result` blocks are marked with a sentinel prefix (`[pruned tool_result:`) and are skipped on subsequent passes.
4. **Spill Pointer Preservation**:
   - If an older `tool_result` contained an `overflow://<callId>` spill marker and `read_file` path, the pruned stub preserves the spill path so the model can still re-read the file on demand.

### 4.2 Pruning Thresholds & Policy

```typescript
export type PreemptivePruningOptions = {
  /** Soft context ratio at which preemptive pruning activates (default: 0.70). */
  softRatio?: number
  /** Target context ratio after pruning (default: 0.55). */
  targetRatio?: number
  /** Number of most-recent assistant turn groups to keep untouched (default: 6). */
  preserveRecentGroups?: number
  /** Minimum character length of a historical tool_result to be eligible (default: 2000). */
  minPruneChars?: number
  /** Number of head characters preserved in the pruned stub (default: 280). */
  stubHeadChars?: number
  /** Number of tail characters preserved in the pruned stub (default: 280). */
  stubTailChars?: number
}
```

### 4.3 Pruned Stub Format

When an eligible historical `tool_result` (associated with tool name `<toolName>` and `callId`) is pruned, its content is replaced with:

```text
[pruned tool_result: tool=<toolName> callId=<callId> original=<lines> lines / <bytes> bytes]
<head snippet (up to 280 chars)>
... [historical tool output pruned to save context budget] ...
<tail snippet (up to 280 chars)>
<preserved overflow marker if any>
```

### 4.4 Integration with `kala.compaction` Extension & Loop

1. **In `kala.compaction` (`beforeModelCall`)**:
   - At the soft threshold, prune only the current model request. The stored transcript remains authoritative until a durable compaction occurs.
   - When preflight compaction is required, invoke the normal Host compaction path first; do not treat a request-only pruning result as persisted progress.
2. **In `runCompact` (`packages/host/src/extensions/compaction.ts`)**:
   - Before the LLM summarizer for non-manual triggers, persist deterministic pruning with `messages_replaced` if it brings usage under the existing policy threshold: the actual preflight input limit for `preflight`, or `hardThreshold * 0.80` for `auto` and `tool_result`. Do not replace an active pending tool-call group. Manual `/compact` retains its explicit summarization behavior.

---

## 5. Verification & Acceptance Criteria

1. **Unit Tests (`packages/executor/src/tools/overflow.test.ts`)**:
   - Multi-line output exceeding `inlineBytes` preserves both head and tail and includes `offset`/`limit` in `read_file` hint.
   - Single-line or long-line output exceeding `inlineBytes` preserves **both head and tail bytes** (no tail loss).
   - Multi-byte UTF-8 characters (CJK, emoji) sliced at byte boundaries never produce `U+FFFD` (`\uFFFD`).
   - `OVERFLOW_MARKER_PREFIX` (`--- output truncated:`) stays within the final 512 chars of `content`.
2. **Unit & Integration Tests (`packages/host/src/context/preemptive-pruning.test.ts`)**:
   - Protects the most recent `preserveRecentGroups` assistant turns.
   - Prunes older oversized `tool_result` items while preserving `tool_call`/`tool_result` pairing and `overflow://` paths.
   - Idempotent across repeated calls.
   - Integrates cleanly with `kala.compaction` `beforeModelCall` so high tool-output pressure is relieved deterministically.
