# Protocol and guarantees

## Queue: `tasks.json` (schema version 3)

One JSON object in the project root. Claude Code owns the planner fields and sets `PENDING`; Pi owns the report fields and sets `RUNNING`, `COMPLETE` or `ERROR`. The watcher preserves fields it does not recognize and never overwrites planner fields.

| Field | Owner | Notes |
|---|---|---|
| `schema_version` | both | Always `3` |
| `status` | both | `IDLE`, `PENDING` (Claude Code), `RUNNING`, `COMPLETE`, `ERROR` (Pi) |
| `task_id` | Claude Code | Single line, at most 200 characters |
| `task_type` | Claude Code | `IMPLEMENT`, `TEST`, `DOCUMENT` (writer) or `CONSULT`, `REVIEW` (read-only) |
| `required_role` | Claude Code | `writer`, `read-only` or `any`; must fit the task type |
| `preferred_agent` | Claude Code | Hint only |
| `gate`, `gate_reason` | Claude Code | `none`, `consult-before`, `review-after`; gates only on writer tasks; reason required when set |
| `parent_task_id` | Claude Code | Links follow-ups |
| `instruction` | Claude Code | Required, at most 32 KiB |
| `working_dir` | Claude Code | Existing directory inside the project |
| `scope` | Claude Code | 1–32 project-relative paths; changed files must fall inside |
| `acceptance_criteria` | Claude Code | 1–32 items |
| `plan_ref` | Claude Code | Optional pointer to a plan |
| `created_at`, `created_by` | Claude Code | Parseable timestamp; `created_by` must be `claude-code` |
| `assigned_agent`, `assigned_model`, `thinking` | Pi | From the worker evidence |
| `started_at`, `completed_at`, `updated_by` | Pi | |
| `result`, `files_changed`, `tests_run`, `error` | Pi | From the validated report |

Paths must stay inside the project root, both as written and after resolving symlinks.

## Lifecycle

1. The watcher polls `tasks.json` once a second while enabled.
2. An invalid `PENDING` task is rewritten to `ERROR` with the reason ("Rejected PENDING task: …").
3. While the main Pi session is busy, a valid `PENDING` task waits. Once idle, the watcher atomically writes `RUNNING` and sends a visible handoff message containing the planner fields and the fresh context files.
4. Pi's main session delegates to agents with `pi-subagents` (async by default, visible in FleetView) and finishes by calling `handoff_task_report`.
5. The tool validates the report and writes `COMPLETE` or `ERROR`, then appends one line to the work log.

## Report: `handoff_task_report`

| Field | Meaning |
|---|---|
| `status` | `COMPLETE` or `ERROR` |
| `worker` | `{ agent, run_id, status, result, model, thinking }` for the agent that did the task, or `null` for an error without a worker |
| `gate_evidence` | Zero or one `{ gate, agent, run_id, status, result, independent: true, model, thinking }` matching the queue gate |
| `async_status` | `{ checked: true, pending_run_ids, failed_run_ids }` from the latest `subagent({ action: "status" })` |
| `files_changed`, `tests_run`, `result`, `error` | Report fields |

`COMPLETE` is refused unless:
- the worker names an existing agent profile with the right `acceptanceRole`, finished `COMPLETE`, and reports a valid thinking level and model (matching the profile when the profile pins them);
- the queue's gate, if any, has evidence from a different read-only agent that finished `COMPLETE`, with its own run ID;
- no run of this task is pending or failed;
- read-only tasks report no changed files, and changed files lie inside `scope`;
- the queue still holds this same task (same planner fields, still `RUNNING`).

## Writes, locking and recovery

- Queue writes go to a private temporary file in the same directory (full write and fsync), re-check the queue's raw hash, planner fingerprint and status, then rename atomically.
- `.pi/pi-claude-handoff.lock` gives one Pi session ownership of a project's queue. A live owner blocks others. A lock left by a dead process is recovered under a second exclusive guard; malformed locks are left for manual inspection.
- An unowned `RUNNING` task (from a session that ended mid-task) is marked `ERROR` and **never rerun automatically**, since its effects are unknown.
- If `tasks.json` changes during a task, the watcher keeps the replacement, stops dispatching and tells you.
- After an observed async subagent launch, the task stays `RUNNING` when the main turn settles, so you can reopen the session and report once the children finish. Without one, a turn that settles without a valid report marks the task `ERROR`.
- Work-log appends refuse to write if the heading is missing, duplicated or no longer last, or if the file changes underneath them. A log failure turns a just-written `COMPLETE` into `ERROR`.
- Atomic rename and the lock protect cooperating writers. They are not a cross-process compare-and-swap: an unrelated writer racing in the brief window after the final check can still win or lose a write.

## Limits

- **Reports are attestations, not proof.** Pi's extension API does not give this package a task-scoped callback that binds each child run's ID, status, model and result to the current task. Run IDs, results and `async_status` are reported by the main model, and the tool checks them for consistency. Review the diff and FleetView before accepting work.
- **Not a sandbox.** The watcher is ordinary trusted extension code. It does not stop the model or child tools from going outside `scope`, and it does not cancel orphaned child runs.
- A child that finishes after the Pi session closes leaves the task `RUNNING` until the next watcher marks it `ERROR`.
