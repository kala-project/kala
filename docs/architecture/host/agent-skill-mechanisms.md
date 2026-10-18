# Agent Skill Mechanisms: Reference Comparison

Status: reference note comparing how other coding-agent products implement
skills. This is background material for `docs/architecture/host/skills.md`, which is the
source of truth for agent-kernel's own skill design.

The content below was originally part of an early RL integration research
note. It is not related to Agentic RL; it lives here because it belongs to
the host/skill layer of agent-kernel.

## Why this comparison matters

`agent-kernel` does not currently have a first-class skill system in the
sense of discoverable instruction packages such as `SKILL.md` bundles with
trigger rules, bundled references, scripts, and optional assets. What exists
today is lower-level infrastructure that could host such a system:

- A fixed executor tool registry: `read`, `ls`, `glob`, `grep`, `write`,
  `edit`, `bash`, background shell controls, `websearch`, and
  memory tools.
- Host-declared tool schemas in `builtinTools`, including the host-side
  `agent` builtin for child sessions and `todo_graph` as the sole default
  planning tool.
- Session, workspace, and global memory tools. Session memory is lifted
  into kernel state; workspace/global memory lives on executor-owned disk.
- Git-hook-like host hooks for `pre_tool_use`, `post_tool_use`,
  `session_start`, and `session_end`.
- A `/compact` slash command in the dashboard composer.

The kernel deliberately keeps planning, durable memory policy, and
sub-agent strategy outside the pure reducer. A skill system therefore lives
above the kernel, probably as a host/extension layer that can discover
skill packages, inject instructions or references into context, register
optional tools, and use hooks for lifecycle/tool mediation.

`docs/architecture/host/skills.md` describes agent-kernel's chosen approach. This
document describes what other agents do, so the design decisions in
`skills.md` can be judged against a real reference set.

## Shared pattern across mature agents

Claude Code, Codex, OpenCode, and Pi have converged on a similar mechanism:

1. A skill is a directory containing `SKILL.md`.
2. `SKILL.md` has YAML frontmatter with at least a name and description,
   plus markdown instructions.
3. The agent does not put every full skill body into the prompt up front.
4. Startup/discovery injects only a compact available-skills list into
   context.
5. The model or user selects a skill.
6. The runtime loads the full `SKILL.md` on demand.
7. Supporting files such as `references/`, `scripts/`, templates, or
   assets live beside `SKILL.md` and are read or executed only when the
   skill instructions ask for them.

This is progressive disclosure: descriptions are always cheap; full skill
instructions and references are paid only when relevant.

## Claude Code

Claude Code skills follow the Agent Skills convention but add
product-specific controls.

- Locations: enterprise-managed skills, personal
  `~/.claude/skills/<name>/SKILL.md`, project
  `.claude/skills/<name>/SKILL.md`, plugin
  `<plugin>/skills/<name>/SKILL.md`, and nested `.claude/skills/`
  directories in monorepos.
- Invocation: explicit slash command such as `/deploy`, or automatic model
  invocation based on `description` / `when_to_use`.
- Naming: the command name normally comes from the directory path, not the
  frontmatter `name`; plugin skills are namespaced as
  `plugin-name:skill-name`.
- Loading: skill directories are watched; changes to `SKILL.md` can take
  effect in-session.
- Frontmatter controls include `disable-model-invocation`, `user-invocable`,
  `allowed-tools`, `disallowed-tools`, `model`, `effort`, `context: fork`,
  `agent`, `hooks`, `paths`, and `shell`.
- Extra mechanism: dynamic context injection with lines like `` !`git diff` ``;
  Claude runs the command and substitutes output before the model sees the
  skill body.
- Execution model: skills can run inline or in a forked subagent context.
- Compatibility: older `.claude/commands/*.md` command files still work,
  but skills supersede commands because they support directories and
  supporting files.

## Codex

Codex uses skills as the reusable workflow authoring format and plugins as
the installable distribution unit.

- Locations: repo `.agent/skills` from CWD up to repo root, user
  `$HOME/.agent/skills`, admin `/etc/codex/skills`, and system bundled
  skills.
- Invocation: explicit `$skill-name` mention / skill selector, or implicit
  model selection from the skill description.
- Loading: startup context includes only name, description, and path. The
  initial skills list is budgeted to a small part of the model context; full
  `SKILL.md` is read only after selection.
- Required frontmatter: `name` and `description`.
- Optional sidecar: `agents/openai.yaml` for Codex app UI metadata, implicit
  invocation policy, and declared tool dependencies such as MCP servers.
- Enable/disable: `[[skills.config]]` entries in `~/.codex/config.toml` can
  disable a skill by path.
- Creation/distribution: `$skill-creator` scaffolds skills;
  `$skill-installer` installs curated skills; plugins package one or more
  skills plus optional app mappings, MCP config, hooks, and assets through
  `.codex-plugin/plugin.json` and marketplace metadata.

Codex's important design detail is the split between local skill authoring
and plugin distribution. A raw skill is enough for one repo or user. A
plugin is for sharing, bundling, marketplace install, and app/MCP
integration.

## OpenCode

OpenCode exposes skills through an actual `skill` tool rather than relying
only on slash commands or implicit file reads.

- Locations: `.opencode/skills/<name>/SKILL.md`,
  `~/.config/opencode/skills/<name>/SKILL.md`, Claude-compatible
  `.claude/skills` / `~/.claude/skills`, and agent-compatible
  `.agent/skills` / `~/.agent/skills`.
- Discovery: for project paths, OpenCode walks upward from CWD to the git
  worktree root and collects matching skill directories along the way.
- Required frontmatter: `name` and `description`; optional `license`,
  `compatibility`, and string-to-string `metadata`. Unknown fields are
  ignored.
- Validation: `name` must match the containing directory and follow
  `^[a-z0-9]+(-[a-z0-9]+)*$`; descriptions are capped.
- Runtime exposure: the `skill` tool description contains an XML
  `<available_skills>` list with skill names and descriptions.
- Invocation: the model calls `skill({ name: "git-release" })` to load the
  full skill.
- Permissions: `opencode.json` has pattern-based `permission.skill` rules
  with `allow`, `deny`, and `ask`; permissions can be overridden per agent.
  The `skill` tool itself can also be disabled for an agent.

OpenCode is the cleanest example of skills as a first-class tool: listing
is in the tool description, and loading is a tool call subject to the
normal permission system.

## Pi

Pi has both a broad TypeScript extension API and a separate Agent Skills
implementation.

- Locations: global `~/.pi/agent/skills/` and `~/.agent/skills/`; project
  `.pi/skills/` and `.agent/skills/` from CWD up to git root; package
  `skills/` directories or `pi.skills` entries in `package.json`; explicit
  settings `skills` arrays; repeatable CLI `--skill <path>`.
- Discovery: scans at startup, extracts names and descriptions, and
  injects available skills into the system prompt in XML form.
- Loading: the model is expected to use `read` to load the full `SKILL.md`;
  users can force this through `/skill:name` commands.
- Frontmatter: `name` and `description` are required; `license`,
  `compatibility`, `metadata`, `allowed-tools`, and
  `disable-model-invocation` are supported.
- Validation: Pi warns on most Agent Skills spec violations but still
  loads the skill; missing description is a hard failure. Name collisions
  warn and keep the first skill found.
- Compatibility: Pi can consume skills from Claude Code or Codex
  directories by adding those paths in settings.
- Extensions: TypeScript extensions are more powerful than skills. They
  can register tools, commands, event hooks, custom UI, renderers, and
  persistent state. Skills are prompt/workflow packages; extensions are
  executable runtime plugins.

Pi's design separates lightweight skill instructions from full trusted
code extensions. That split is useful: most workflows should be skills;
only runtime behavior needs extensions.

## clawspring-style minimal agents

The clawspring reference is not a skill system. It has a Python tool
dispatch table and an `Agent` tool for sub-agent spawning. Useful for
minimal agent loops, but it lacks skill discovery, frontmatter,
progressive disclosure, permissions, supporting files, and package
distribution.

## Implication for `agent-kernel`

`agent-kernel` should implement skills above the pure reducer as a
host-level capability. The reducer should only see ordinary messages,
tools, events, and state transitions.

A credible skill implementation for this project should include:

- Skill discovery from project and user directories, probably compatible
  with `.agent/skills/<name>/SKILL.md` first.
- Frontmatter validation for `name` and `description`.
- Progressive disclosure: inject only an available-skills summary into
  the LLM context.
- A `skill` tool, or equivalent explicit host mechanism, that loads a
  selected skill body on demand.
- Permission controls for skill visibility and loading.
- Support for references/scripts/assets relative to the skill directory.
- Optional plugin packaging later, for bundling skills with MCP servers,
  hooks, custom tools, or UI assets.

The first implementation should copy OpenCode/Codex's simple data model
rather than inventing a new format: use `SKILL.md`, `name`, `description`,
optional metadata, compact available-skill listing, and on-demand full
load. See `docs/architecture/host/skills.md` for the actual chosen design.
