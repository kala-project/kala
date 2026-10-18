# RL Experiments (local-only)

This directory holds evidence and narrative for RL training experiments --
run logs, evidence reports, follow-up addenda, and any artifact bundles
produced on rented GPU hosts. Its contents are intentionally not committed
to version control.

## Why not committed

Experiment records unavoidably contain host-specific details that we do
not want in the public repository:

- absolute filesystem paths on the operator's workstation
- rented-instance identifiers (rented GPU host instance IDs, offers, ssh hosts,
  ports)
- guest VM private IP addresses
- personal accounts or clone URLs used only during that run

Scrubbing these while keeping the reports useful causes information loss
(specific machines can no longer be cross-referenced with logs, artifact
paths become ambiguous). Rather than lose that traceability, the reports
are kept whole and this directory is `.gitignore`d.

## Ignore rules

Everything under this directory is ignored by `.gitignore` except:

- `README.md` (this file)
- `.gitignore` itself

## Layout

Each experiment lives in its own date-indexed folder named
`YYYY-MM-DD-run-N`, where `N` starts at `1` and increments if there is
more than one run on the same day. The suffix is required even for the
first run of the day, so folder names sort predictably.

Typical contents inside a run folder:

- `raw-log.md` — chronological operator log: setup, retries, blocker
  investigation, and recovery decisions across paid attempts.
- `final-report.md` — full E2E evidence report for the run:
  environment, commands, versions, artifacts, cleanup.
- `addendum.md` — post-run addendum written after a successful (or
  near-successful) run: verdict, root causes, honest evidence
  assessment.
- `evidence-notes.md` (optional) — private narrative notes based on the
  run. Personal, not shared.
- `artifacts/` — tarballs of the on-host artifact tree (event logs,
  token captures, reward records, training trajectory), scp'd back from
  the rented host. Each run keeps its own `artifacts/` next to its
  reports so tarballs from different runs cannot collide.

## How this connects to the RL documentation

- `../../docs/research/rl/system-design.md` — the design source of truth. Explains what a
  training-ready rollout must contain and why product session logs are
  not RL samples.
- `../../docs/research/rl/implementation.md` — the local implementation gate and acceptance
  criteria that must be green before any paid experiment starts.
- `../../docs/research/rl/training-design.md` — training methodology, execution decisions
  (GPU/model/budget), stop conditions, and risks. Experiments in this
  directory are attempts to execute that plan.

If you are picking this project up on a new machine and want to
reproduce results, follow `../../docs/research/rl/training-design.md`; the files in this
directory are evidence from past runs, not a runbook.
