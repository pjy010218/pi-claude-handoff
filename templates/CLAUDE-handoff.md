<!--
pi-claude-handoff protocol. Paste this into your project's CLAUDE.md (and keep "## Work Log" as the LAST
level-two section; the Pi watcher appends one line there per finished task). Both Claude Code and Pi read it.
Edit the routing table to match your agents; keep the rest unless you know what you are changing.
-->

## Claude Code ⇄ Pi handoff protocol

Claude Code plans. Pi's agents (profiles in `.pi/agents/`) implement and test, visibly, in the Pi TUI. `tasks.json` in the project root is the only channel between them.

### Rules
1. **Roles.** Claude Code is the planner. Implementation and testing are done by the relevant Pi agent; Pi's main session picks the agent and only coordinates. Each agent keeps the model, thinking level and tools in its profile.
2. **Claude Code does not implement.** It does not edit source, config or tests, and does not run implementation or test commands. It writes tasks into `tasks.json`, plans, and reviews results.
3. **One task at a time.** Claude Code writes a new task only when `status` is `IDLE`, or `COMPLETE`/`ERROR` and the result has been reviewed.
4. **Field ownership.** Claude Code writes `status: "PENDING"` and the planner fields (`task_id`, `task_type`, `required_role`, `preferred_agent` (hint only), `gate`, `gate_reason`, `parent_task_id`, `instruction`, `working_dir`, `scope`, `acceptance_criteria`, `plan_ref`, `created_at`, `created_by: "claude-code"`). Pi writes `RUNNING`/`COMPLETE`/`ERROR` and the report fields (`assigned_agent`, `assigned_model`, `thinking`, `started_at`, `completed_at`, `result`, `files_changed`, `tests_run`, `error`, `updated_by`). Neither overwrites the other's fields. Claude Code resets the queue to `IDLE` after review.
5. **Roles must fit.** `IMPLEMENT`, `TEST`, `DOCUMENT` go to `writer` agents; `CONSULT`, `REVIEW` go to `read-only` agents and change no files. If no agent fits, Pi reports `ERROR` instead of improvising.
6. **Gates are not optional.** When a task matches a trigger below, Claude Code sets `gate`. `consult-before`: a distinct read-only agent advises before the writer starts. `review-after`: a distinct read-only agent reviews the writer's output. A reviewer is never the agent that did the work.
7. **Scope.** Pi stays inside `scope` and `instruction`. If blocked or unclear, it reports `ERROR` with a clear reason. Nobody commits, pushes, merges or deploys unless the task explicitly says so.

### Routing and gates
| Trigger | Gate |
|---|---|
| Architecture or module boundaries | `consult-before` |
| Security-sensitive code (auth, crypto, input handling, permissions) | `review-after` (mandatory) |
| Personal or customer data | `review-after` (mandatory) |
| Release-adjacent changes | `review-after` |
| Everything else | `none` |

If a task matches several triggers, use the strictest gate. The queue holds one gate per task; if a task needs both, split it into a consult task and a writer task linked by `parent_task_id`.

### Workflow
1. The user asks Claude Code for something.
2. Claude Code plans and, for non-trivial work, writes the plan down (for example under `docs/plans/`).
3. Claude Code writes a self-contained `PENDING` task to `tasks.json` and tells the user "Task queued in Pi."
4. The Pi watcher marks it `RUNNING` and hands it to Pi's main session, which delegates to the right agent (and gate agent) in view of the user.
5. Pi records `COMPLETE` or `ERROR` with the validated report and appends a line to the Work Log.
6. The user asks Claude Code to review. Claude Code reads `tasks.json`, checks the diff and test results, notes its verdict, and resets the queue to `IDLE` or queues a follow-up.

## Work Log
_Pi appends one line per finished task: `YYYY-MM-DD HH:MM | task_id | COMPLETE/ERROR | summary`. Keep this the last level-two section._
