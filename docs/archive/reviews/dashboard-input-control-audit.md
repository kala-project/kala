# Dashboard Input Control Audit

Date: 2026-07-26

## Decision rule

- Use `select` for finite enums and safe operational presets.
- Use editable combobox (`input + datalist`) when the Host has known values but custom values remain valid.
- Use resource selector when the server already exposes a list of runs, models, workspaces, providers, or backends.
- Keep text input for identifiers created by the user, searches, labels, URLs, credentials, commands, paths without a browse API, and pasted structured content.

## Converted

| Area | Field | Previous | New |
|---|---|---|---|
| SWE-bench Wizard | Model | raw text | Host model combobox; custom model remains valid |
| SWE-bench Wizard | Dataset | duplicate raw text plus preset | one visible dataset preset selector; hidden compatibility field only for old tests |
| SWE-bench Wizard | Split | raw text | `test/dev/train` select |
| SWE-bench Wizard | Max workers | raw number | `1/2/4/8` select |
| SWE-bench Wizard | Max turns | raw number | `10/20/40/80` select |
| SWE-bench Wizard | Instance limit | raw number | editable preset combobox `1/5/10/30/100/300` |
| SWE-bench Grade | Max workers | raw number | `1/2/4/8` select |
| Bad Cases | Run ID | raw text | run registry select loaded on demand |
| Rollout export | Status filter | comma-separated text | common single/multi-status presets |
| Executor access | Workspace ID | raw text | attached workspace select; blank means unbound invite |
| Interface | Live tool tail | raw number | finite preset select |
| Interface | Session cache MB | raw number | editable numeric combobox with safe presets |
| Terminal/ProgramBench | Agent command | always raw text | recipe select; custom command appears only for Custom |

## Correctly retained as text/file inputs

| Area | Field | Reason |
|---|---|---|
| All Wizards | Run ID | user-created identity; generator already provided |
| Dataset | Custom HuggingFace repo | open namespace |
| Dataset | HuggingFace token | secret |
| Dataset/patch/results | upload and paste | arbitrary structured content |
| Custom backend | shell command | deliberately free-form escape hatch |
| Terminal-Bench/SWE-Marathon | server task directory | no safe server directory catalog API exists yet |
| Search surfaces | docs/explorer/trace/theme | free-form query |
| Settings | provider ID/label/base URL/API key | user-defined provider creation |
| Settings | model ID/label/context window | manual model registration supports unknown models |
| Settings | Host endpoint | arbitrary deployment URL |
| Settings | invite label | user-facing label |
| Workspace rename | display name | user-facing label |
| Confirmation fields | delete phrase | intentional safety confirmation |
| Bad Case annotation | note | free-form analysis |

## Follow-up requiring new backend APIs

- Server-side directory picker for benchmark task directories.
- Dataset catalog endpoint beyond the built-in SWE-bench presets.
- Backend-specific dynamic configuration schema rendered directly from `agent-backend-list` rather than the current fixed fields.
- Multi-select component for arbitrary rollout statuses if new status values are added.
