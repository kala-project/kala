# Skills

**Status**: implemented baseline; this document is the source of truth for the
intended behavior. Where implementation and this document disagree, this
document wins and the implementation is a bug to fix unless the mismatch is
listed under explicit future work.

Agent-kernel implements skills as a host extension. A skill is a local
instruction package rooted at `SKILL.md`; the model uses a stable `skill` Tool
to list a compact index and then load the full Skill explicitly.
The pure kernel has no skill-specific state. It only sees ordinary tool calls,
tool results, and events.

## Problem Statement

Coding agents need reusable task knowledge without making every session prompt
large, opaque, or product-specific. A skill system must solve five problems:

1. **Reusable procedure**. Review checklists, release workflows, debugging
   playbooks, benchmark protocols, and domain conventions should live in files,
   not be copied into every prompt.
2. **Context pressure**. Loading every workflow body at startup wastes model
   context and increases the chance that unrelated instructions conflict.
3. **Selection observability**. If a model follows a skill, the transcript and
   JSONL log must show which skill was selected and when.
4. **Permission and audit surface**. A selected skill is privileged context. The
   system must be able to gate, deny, trace, and replay selection.
5. **Kernel neutrality**. Skills are host policy. The reducer should not learn
   skill discovery rules, path precedence, UI metadata, plugin distribution, or
   model-routing heuristics.

The dangerous design is hidden prompt mutation: the host silently injects large
skill bodies because natural language looked relevant. That is hard to debug,
hard to replay, and unsuitable for RL traces. Agent-kernel therefore treats
skill loading as an explicit model action.

## Design Principles

- **Progressive disclosure**. The stable Tool schema contains no workspace
  Skill metadata. `skill({ action: "list" })` returns only `name` and
  `description`; the full `SKILL.md` body is loaded only after selection.
- **Tool-call selection**. Loading a skill is a normal `skill` tool call, so it
  is visible in transcripts, debugger timelines, hook traces, JSONL replay, and
  training data.
- **Host-owned implementation**. Discovery, validation, loading, size limits,
  permissions, and future plugin integration belong in the host extension layer.
- **Directory-relative resources**. A skill may refer to sibling files such as
  `references/`, `scripts/`, templates, or assets. Those files are not loaded
  automatically; the tool result tells the model how to resolve relative paths.
- **Bounded privileged context**. A skill body has an explicit byte limit before
  it can enter model-visible context.
- **Strict first contract, extensible later**. The baseline requires only
  `name` and `description`. Unknown frontmatter fields are ignored so richer
  Agent Skills content can coexist without changing this host immediately.

## Reference Implementations: End-To-End Mechanics

This section is based on local reference source under `references/`, not on
marketing docs. The goal is to identify stable implementation patterns and the
tradeoffs that should shape agent-kernel.

### Shared Pattern

The serious references converge on the same architecture:

```text
1. Discover local or packaged skill sources.
2. Parse markdown frontmatter for routing metadata.
3. Validate at least name and description.
4. Put only compact metadata in startup/system context.
5. Select a skill explicitly or implicitly.
6. Load the full skill body on demand.
7. Resolve supporting files relative to the skill directory.
8. Record the load through ordinary runtime telemetry or tool history.
```

The important difference is the selection mechanism. Codex supports explicit
`$skill` mentions and implicit invocation. OpenCode exposes a real `skill` tool.
Pi tells the model to use `read` on a selected skill file. Claude Code can run a
skill inline or in a forked agent. Agent-kernel follows OpenCode's tool-call
shape because it is the most compatible with our kernel/event architecture.

### Codex Reference

Primary local files:

- `references/codex/codex-rs/core-skills/src/model.rs`
- `references/codex/codex-rs/core-skills/src/root_loader.rs`
- `references/codex/codex-rs/core-skills/src/injection.rs`
- `references/codex/codex-rs/config/src/skills_config.rs`

Codex models skills as host-owned metadata plus file-system mappings. The
`SkillMetadata` structure contains `name`, `description`, optional UI/interface
metadata, optional dependencies, optional policy, the path to the declaring
`SKILL.md`, scope, and plugin id. `SkillLoadOutcome` stores loaded skills,
errors, disabled paths, roots, and a map from skill path to the file system that
can read it. That last map matters for multi-environment hosts: the runtime
must not assume all skills are readable from the same local file system.

Codex root loading merges snapshots from repo, user, system, admin, and plugin
roots. It sorts by scope and path, deduplicates by `SKILL.md` path, and keeps
errors alongside successful metadata instead of failing all discovery. Plugin
skill roots can be cached as parsed snapshots during plugin load, so skill
discovery is integrated with distribution but still produces the same metadata
shape.

Codex selection has two paths. Explicit user selections and `$skill` mentions
are resolved by path/name in `injection.rs`; disabled paths and ambiguous names
are filtered. When selected, Codex reads the skill body through the stored file
system, emits injection telemetry, and returns a structured skill injection with
`name`, `path`, and `contents`. Codex also tracks policy such as
`allow_implicit_invocation` and product restrictions.

Lesson for agent-kernel: preserve the separation between skill metadata,
selection, and file-system authority. A skill snapshot can be host-owned and
still be replayable if the actual load is an explicit event.

### OpenCode Reference

Primary local files:

- `references/opencode/packages/core/src/skill.ts`
- `references/opencode/packages/core/src/skill/discovery.ts`
- `references/opencode/packages/core/src/tool/skill.ts`
- `references/opencode/packages/core/test/tool-skill.test.ts`

OpenCode is the closest reference to agent-kernel's baseline. Its skill service
maintains a list of sources, loads embedded/directory/URL sources, parses
frontmatter, caches loaded metadata, and exposes available skills after applying
permission filtering. The loader supports `SKILL.md` and flat markdown files,
keeps parsed content separate from frontmatter, and uses the description for
routing.

The OpenCode `skill` tool has a small input schema: `{ name: string }`. At
execution time it lists current skills, finds the selected name, asserts a
`skill` permission for the session and agent, samples sibling files, and returns
model-facing XML-like content:

```text
<skill_content name="...">
# Skill: ...
...
Base directory for this skill: ...
Relative paths in this skill ... are relative to this base directory.
<skill_files>...</skill_files>
</skill_content>
```

The test proves the end-to-end contract: the tool is registered as `skill`, a
selected skill produces model-facing content, permission assertions are made,
missing skills fail, denied permissions fail, and flat markdown skills can also
load.

Lesson for agent-kernel: a `skill` tool is a clean extension point. It gives us
normal tool authorization and output handling without teaching the kernel about
skills.

### Pi Reference

Primary local files:

- `references/pi/packages/coding-agent/src/core/skills.ts`
- `references/pi/packages/coding-agent/test/skills.test.ts`
- `references/pi/packages/coding-agent/test/suite/regressions/2781-skill-collision-precedence.test.ts`

Pi implements a broad Agent Skills loader. It scans directories recursively,
honors ignore files, follows valid symlinks, stops recursion when a directory
itself contains `SKILL.md`, and supports explicit skill paths. Frontmatter
supports `name`, `description`, and `disable-model-invocation`; unknown fields
are tolerated. Name and description validation produce diagnostics, but Pi
still loads many imperfect skills as long as description exists.

Pi formats available skills into system prompt XML with `name`, `description`,
and `location`. Skills marked `disable-model-invocation` are excluded from that
prompt and can only be invoked explicitly. The model is instructed to use the
ordinary `read` tool to load the selected skill file.

Pi also records collision diagnostics and keeps the first skill by configured
source order. This makes precedence visible rather than surprising.

Lesson for agent-kernel: diagnostics and collision reporting are product
quality features, but model-facing loading through a generic file read is less
auditable than a dedicated `skill` tool.

### Claude Code Reference

Primary local files:

- `references/claude-code-collection/claude-code-source-code/src/tools/SkillTool/SkillTool.ts`
- `references/claude-code-collection/claude-code-source-code/src/tools/SkillTool/prompt.ts`
- `references/claude-code-collection/claude-code-source-code/src/skills/loadSkillsDir.ts`
- `references/claude-code-collection/claude-code-source-code/src/components/permissions/SkillPermissionRequest/SkillPermissionRequest.tsx`

Claude Code's skill tool is more product-rich. It can combine local and MCP
skills, records detailed telemetry, distinguishes built-in/bundled/plugin
skills, and can execute a skill in a forked sub-agent context with its own
agent id and token budget. The runtime tags nested tool-use progress so the UI
can show work done inside the skill. It also has permission UI and skill usage
tracking.

This is more than a markdown loader: skills become a command surface, telemetry
surface, permission surface, plugin surface, and sub-agent execution surface.

Lesson for agent-kernel: forked execution and rich UI are valid later layers,
but the first host contract should remain a small loader. Forked skill execution
would overlap with our existing `agent` builtin and needs a separate design.

### OpenClaw Reference

Primary local areas:

- `references/openclaw/src/skills/loading/*`
- `references/openclaw/src/skills/runtime/*`
- `references/openclaw/src/skills/security/*`
- `references/openclaw/src/agents/embedded-agent-runner/sandbox-skills.ts`

OpenClaw is a production-heavy reference. It separates loading, runtime
refresh, session snapshots, embedded run entries, security scanning, workspace
auditing, plugin/bundled skill sources, and sandbox bridges. It treats skill
state as something that may change over time and that must be snapshotted per
session/run.

Lesson for agent-kernel: once multiple sessions and executors share a host,
skill visibility must be derived from the session/workspace boundary, not from a
single global mutable list. The current agent-kernel baseline uses a host-wide
startup registry, so this is an explicit future hardening area.

### Minimal Agent References

The clawspring-style references contain simple tool dispatch and sub-agent
patterns, but they are not skill systems. They lack frontmatter discovery,
progressive disclosure, skill-specific permission, supporting-file resolution,
and package distribution. They are useful as a lower bound: a tool table is not
enough to claim skill support.

## Agent-Kernel Design

### Skill Package Contract

The baseline package format is:

```text
.agent/skills/<name>/SKILL.md
~/.agent/skills/<name>/SKILL.md
```

`SKILL.md` must start with YAML-like frontmatter followed by markdown
instructions:

```markdown
---
name: code-review
description: Use when reviewing a diff or pull request for bugs, regressions, missing tests, and security risks.
---

## Instructions

Review the current diff. Findings first, ordered by severity.
```

The normative field set is intentionally small:

| Field | Required | Rule |
|---|---:|---|
| `name` | yes | Must match `^[a-z0-9]+(-[a-z0-9]+)*$` and match the containing directory name. |
| `description` | yes | After trimming, must be 1 to 1024 characters. Used as the model's routing signal. |

Unknown fields are ignored by the baseline host. Future fields must not change
the meaning of `name` or `description`.

### Discovery Contract

For each session, the host discovers skills from roots derived from the
session's current working directory:

1. Project-local: `<session cwd>/.agent/skills/*/SKILL.md`.
2. User-global: `~/.agent/skills/*/SKILL.md`.

Discovery scans only direct child directories of each root. For sessions bound
to a workspace Executor, the project root and selected `SKILL.md` bodies are
read through that Executor's sandboxed, workspace-ID-routed directory/file RPCs;
the Host must not assume it can access the Executor's cwd through its own mount
namespace. User-global skills remain Host-local. Project names override global
names. An unavailable Executor produces a visible diagnostic, not an assertion
that the workspace contains no skills. Discovery is bounded to 256 root entries
and skill content to 256 KiB. Invalid skills are skipped. The public registry is
sorted by skill name for stable tool-schema rendering. The existing untrusted
content security notice remains on every loaded Skill body.

The host maintains a refreshable session/workspace-scoped skill manager. It
refreshes the registry immediately before executing a `skill` Tool call but
never rewrites the model-facing Tool schema. This preserves provider prompt/KV
cache stability across Skill changes and workspaces. If the agent writes a new
`<session cwd>/.agent/skills/<name>/SKILL.md`, the same session can discover it
with `skill({ action: "list" })` and load it without restarting the host.

This is narrower than Codex, Pi, and OpenClaw. Parent-directory walking,
admin/system roots, plugin roots, recursive discovery, file watching, and
explicit skill paths are future work, not part of the implemented baseline.

### Runtime Exposure Contract

The host declares a builtin `skill` Tool before executor Tools. Its description
and input schema are stable and contain no discovered Skill metadata. The model
discovers the current Session registry with:

```json
{
  "name": "skill",
  "arguments": {
    "action": "list"
  }
}
```

The resulting Tool result contains a bounded compact XML index:

```xml
<available_skills>
  <skill>
    <name>code-review</name>
    <description>Use when reviewing a diff or pull request...</description>
  </skill>
</available_skills>
```

The model loads a selected Skill by emitting:

```json
{
  "name": "skill",
  "arguments": {
    "action": "load",
    "name": "code-review"
  }
}
```

The host handles that tool call without dispatching to the executor:

```text
1. Refresh the Session registry from its current cwd.
2. Validate `input.action` and `input.name`.
3. Look up the name in the Host registry.
4. Read the full SKILL.md from disk.
5. Reject the load if the UTF-8 body is larger than 256 KiB.
6. Return a Tool result containing a fixed trust-boundary warning before the
   Skill content, followed by the Skill name, absolute SKILL.md path,
   directory-relative path guidance, and full markdown body.
7. Continue the normal kernel loop so the next LLM request sees the Tool result.

For compatibility with persisted or in-flight callers created against the
previous schema, `{ "name": "code-review" }` is still interpreted as `load`.
New model-facing schemas require the explicit `action`.
```

The tool requires no approval in the baseline. That is acceptable only because
the current roots are local, explicit, and bounded. Per-skill `allow` / `ask` /
`deny` policy is required before accepting remote/plugin skill sources.

### Security And Isolation Contract

The baseline security contract is limited but explicit:

- Skills are instructions and references, not executable plugins.
- Loaded Skill text is explicitly marked as untrusted and subordinate to
  system, developer, and user instructions.
- The skill loader never executes scripts mentioned by a skill.
- Supporting files are not injected automatically.
- Tool-result size is capped at 256 KiB per loaded `SKILL.md`.
- Skill names cannot contain path separators, `.` segments, uppercase letters,
  or arbitrary punctuation.
- The kernel does not store skill registries or hidden skill state.

Session registries are scoped by session cwd, so two sessions in different
workspaces do not see each other's project-local skills. User-global skills are
intentionally shared through `~/.agent/skills`. This is still a local-host
trust model; remote/plugin skill sources require per-skill permission before
they can be enabled safely.

## Implementation Mapping

| Design requirement | Implementation | Tests | Status |
|---|---|---|---|
| Session-level discovery from cwd and user `.agent/skills` roots | `packages/host/src/extensions/skills.ts` `skillRootsForCwd()`, `discoverSkills()`, `createSkillManager()` | `packages/host/src/extensions/skills.test.ts` | Implemented baseline |
| Required `name` and `description` frontmatter | `parseSkillHeader()` / `extractFrontmatter()` | invalid/missing tests in `skills.test.ts` | Implemented baseline |
| Strict name pattern and directory/name match | `SKILL_NAME_PATTERN`, `basename(dirName)` check | invalid/name mismatch test | Implemented baseline |
| Description trim and 1024 character cap | `MAX_DESCRIPTION_LENGTH` | invalid/missing test covers missing; cap is code-covered but not directly asserted | Partial test gap |
| Duplicate names keep first root priority | `byName.has(info.name)` skip | duplicate root-priority test | Implemented baseline |
| Stable Skill Tool schema independent of registry | `skillToolSchema()` | schema stability tests in `skills.test.ts` and `builtin-tools.intent.test.ts` | Implemented |
| Compact available-skills index in list Tool result | `runSkillTool()` / `renderAvailableSkills()` | XML rendering and budget tests | Implemented |
| XML escaping for model-facing index | `escapeXml()` | XML escaping test | Implemented baseline |
| Explicit `skill({ action: "load", name })` load | `runSkillTool()` and Host Tool dispatch | Host loop and execution tests | Implemented |
| Skill load bypasses executor dispatch | `performCallTool()` handles `SKILL_TOOL_NAME` before `deps.tools.callTool()` | executor call-count test in `loop.test.ts` | Implemented baseline |
| Oversized skill refusal | `MAX_SKILL_BYTES = 256 * 1024` | oversized file test | Implemented baseline |
| Builtin tool list includes skill first | `createBuiltinTools()` prepends `skillToolSchema()` | indirectly covered by runtime tests | Implemented baseline |
| Same-session Skill authoring and loading | `createSkillManager()` refreshes before `skill` calls | session refresh test in `skills.test.ts` and stable-schema loop test | Implemented |
| Trust-boundary warning before Skill body | `runSkillTool()` | ordering assertion in `skills.test.ts` | Implemented |
| Workspace-scoped project skills | `createSkillManager()` derives roots from `record.state.cwd` | workspace isolation test in `skills.test.ts` | Implemented baseline |
| Diagnostics for skipped roots/skills/collisions | `SkillRegistry.diagnostics`; `/settings.skills` summary | diagnostics tests and schema typecheck | Implemented baseline |
| Host CLI delegates skill discovery to session manager | `kala-host.ts` uses `createBuiltinTools()` with empty initial index; `server.ts` installs manager | indirectly covered | Implemented with test gap |
| Per-skill approval/permission | none | none | Future work |
| Parent walking, admin/system/plugin roots, explicit paths | none | none | Future work |
| Supporting-file list/sampling | only path guidance is returned | none | Future work |

## Conformance Audit

### Satisfied

The implementation satisfies the core baseline design:

- `SKILL.md` directory packages are discovered from project and user roots.
- `name` and `description` are required and validated.
- The Skill Tool schema is stable across workspaces and registry mutations.
- A `list` Tool result exposes only compact routing metadata.
- The compact Skill index has an aggregate character budget and reports omitted
  entries when the budget is exceeded.
- Full skill bodies load only after an explicit model tool call.
- A fixed trust-boundary warning precedes every loaded Skill body.
- The host handles skill loading without executor dispatch.
- A session can author a new project-local skill and load it in the same
  session without host restart.
- Project-local skill visibility is scoped by session cwd; user-global skills
  remain shared by design.
- The kernel remains skill-neutral.
- Skill loads are represented as ordinary tool calls and tool results.
- Full bodies are bounded by a 256 KiB limit.
- XML escaping protects the available-skills index from malformed descriptions.
- Discovery diagnostics are available through the registry and `/settings`.

### Partial Or Risky

- The `/settings.skills` summary is host/default-root oriented. Session-specific
  diagnostics exist in the skill manager but are not yet exposed through a
  dedicated dashboard socket event.
- The parser is only YAML-like. It supports simple `key: value` fields and
  simple quotes, not full YAML. This is acceptable for the baseline but should
  be documented in user-facing skill authoring docs.
- The host CLI/server path is not directly covered by an integration test. The
  extension tests cover discovery/refresh and the loop tests cover runtime
  dispatch.

### Explicit Future Work

- Per-skill permission rules with `allow`, `ask`, and `deny`.
- Parent-directory walking to the repository root.
- Admin/system/plugin skill roots.
- Explicit skill paths and remote skill sources.
- File watching. Current refresh is on LLM/tool-call boundaries, not continuous.
- Session-specific diagnostics surfaced in the debugger UI.
- Optional metadata such as `disable-model-invocation`, `allowed-tools`,
  `license`, `compatibility`, `metadata`, UI fields, and dependency declarations.
- Sidecar file listing or sampled file manifests in the `skill` tool result.
- Forked skill execution. This should be designed with the existing `agent`
  builtin rather than added to the loader implicitly.

## Non-Goals For The Baseline

- Skills do not execute code by themselves.
- Skills do not register new tools.
- Skills do not mutate the kernel reducer.
- Skills do not automatically read `references/`, `scripts/`, templates, or
  assets.
- Skills do not provide a plugin marketplace or remote installer.
- Skills do not silently inject full bodies based on natural-language matching.
