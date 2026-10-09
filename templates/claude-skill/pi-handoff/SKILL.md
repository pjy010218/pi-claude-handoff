---
name: pi-handoff
description: Hand implementation, testing and review work to Pi's agents through tasks.json, then review their results. Use whenever a task needs code, test or doc changes, or an independent review, in a project that has tasks.json and the "Claude Code ⇄ Pi handoff protocol" in CLAUDE.md.
---

# Handing work to Pi

In this project you plan and review; Pi's agents implement and test while the user watches in the Pi TUI. Follow the "Claude Code ⇄ Pi handoff protocol" section of CLAUDE.md. This skill is the how-to.

## Queue a task

1. Read `tasks.json`. Continue only if `status` is `IDLE`, or `COMPLETE`/`ERROR` and you have already reviewed that result. Otherwise tell the user what is in progress and stop.
2. Pick `task_type`: `IMPLEMENT`, `TEST` or `DOCUMENT` (writer work), or `CONSULT` or `REVIEW` (read-only work).
3. Check the routing table in CLAUDE.md and set `gate` (`none`, `consult-before` or `review-after`) and `gate_reason`. Gates attach only to writer tasks. For a standalone review, use `task_type: "REVIEW"` with `gate: "none"`.
4. Write the instruction so a fresh agent can do the work without this conversation: goal, constraints, files involved, how to verify, and what not to touch.
5. Update `tasks.json`, keeping every existing field and changing only the planner fields:

```json
{
  "status": "PENDING",
  "task_id": "short-kebab-id-001",
  "task_type": "IMPLEMENT",
  "required_role": "writer",
  "preferred_agent": "",
  "gate": "none",
  "gate_reason": "",
  "parent_task_id": "",
  "instruction": "Self-contained instruction…",
  "working_dir": ".",
  "scope": ["src/feature/", "tests/feature.test.ts"],
  "acceptance_criteria": ["Criterion one", "Criterion two"],
  "plan_ref": "docs/plans/feature.md",
  "created_at": "2026-10-09T12:00:00Z",
  "created_by": "claude-code"
}
```

Rules the watcher enforces (otherwise it marks the task `ERROR`):
- `schema_version` stays `3`; `created_by` is exactly `"claude-code"`; `created_at` is a parseable timestamp.
- `scope` lists 1–32 project-relative paths (a trailing `/` marks a directory); `acceptance_criteria` lists 1–32 items.
- `working_dir` is an existing directory inside the project (`.` for the root).
- `required_role` matches the task type, or is `"any"`.
- `preferred_agent` is only a hint; Pi chooses the agent.

6. Tell the user: "Task queued in Pi." Do not do the work yourself.

## Review a result

1. When the user asks, read `tasks.json`: `status`, `assigned_agent`, `assigned_model`, `result`, `files_changed`, `tests_run`, `error`, the `report` object (worker and gate run IDs, and each gate reviewer's `result`), and the last line of the Work Log.
   `COMPLETE` means the work and any required review finished. It does not mean the reviewer approved: read `report.gate_evidence[].result` for the verdict, and treat a BLOCK as changes required.
2. Check the actual changes (for example `git diff` on `files_changed`) and whether the tests and acceptance criteria are really satisfied. The report is the agents' claim, not proof.
3. Give the user your verdict. If changes are needed, queue a follow-up with `parent_task_id` set to the reviewed task.
4. Reset the queue: `status: "IDLE"`, empty the task and report fields, and set `report` to `null` (keep `schema_version: 3`, `required_role: "any"`, `gate: "none"`, `working_dir: "."`, `created_by: "claude-code"`).

## When something is off

- `RUNNING` for a long time: the user can check Pi's FleetView. Do not edit `tasks.json` while a task is `RUNNING`.
- `ERROR` with "unowned RUNNING": a Pi session ended mid-task. Inspect the working tree before re-queuing; the watcher never reruns tasks automatically.
- `ERROR` with "Rejected PENDING task": fix the field it names and queue the task again.
