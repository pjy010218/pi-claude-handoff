# Changelog

## 0.1.1 (2026-10-09)

Security review fixes (security-review/REVIEW.md, 2026-10-09). Upgrade from 0.1.0.
- A report can no longer make `tasks.json` larger than the watcher's own read limit; it is refused and the task stays `RUNNING` (R2)
- Size limits are enforced before reading, and only limit + 1 bytes are read; lock, work log and profile count are bounded too (R3)
- The work log refuses hard-linked files and checks and writes through one descriptor (R4)
- Validated worker, gate and async evidence is persisted in `tasks.json` as `report` and summarized in the work log; peer ranges capped below Pi 2 (R5)

## 0.1.0 (2026-10-09)

- Pi extension that watches `tasks.json` and hands Claude Code's tasks to the visible Pi session
- `/handoff init | watch | status | stop`, `pi --handoff`
- `handoff_task_report` tool with fail-closed validation of worker and gate evidence
- Configurable context files, agents directory and work log (`.pi/handoff.json`)
- Templates: CLAUDE.md protocol section, Claude Code skill, example agent profiles, empty queue
