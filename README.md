# pi-claude-handoff

**Claude Code plans. Pi's agents do the work, in front of you.**

When one agent harness delegates to another, you usually see only the final answer. pi-claude-handoff keeps the work visible: Claude Code writes a task into `tasks.json`, and a Pi session you have open in the same directory picks it up and runs it with its subagents in the Pi TUI (FleetView), exactly as if you had typed it there. When the work is done, Pi writes a validated report back to the same file, and Claude Code reviews it.

It suits a "smart planner, fast workers" setup: an expensive model plans and reviews in Claude Code, while Pi routes the implementation to whichever models your agent profiles use.

```
 Claude Code (planner)                 tasks.json                   Pi TUI (visible workers)
 ─────────────────────                 ──────────                   ────────────────────────
 plans, writes PENDING task  ───────▶  PENDING  ───────▶  watcher marks RUNNING, hands task
                                                           to Pi's main session
                                                           main session delegates to agents
                                                           (writer, then reviewer if gated)
 reviews result, resets IDLE ◀───────  COMPLETE ◀───────  handoff_task_report validates evidence
                                       + Work Log line     and records the result
```

## What you get

- A **Pi extension** that watches `tasks.json`: `/handoff watch | status | stop | init`, a status line, and the `handoff_task_report` tool.
- **Gates**: `consult-before` and `review-after`, run by a different read-only agent, required before a task can be `COMPLETE`.
- **Fail-closed reports**: `COMPLETE` needs a finished worker from a real agent profile with the right role, the gate evidence, no pending child runs, and changed files inside the task's scope.
- **Careful file handling**: atomic queue writes, a single-owner lock, no automatic reruns after a crash, and an append-only work log.
- **The Claude Code half**: a `CLAUDE.md` protocol section, a Claude Code skill that teaches Claude how to queue and review tasks, and example agent profiles.

## Requirements

- [Pi](https://github.com/earendil-works/pi) 1.1.0 or newer, Node.js 22.19 or newer
- [`pi-subagents`](https://www.npmjs.com/package/pi-subagents) installed in Pi (used for delegation and FleetView)
- Claude Code

## Setup

1. **Install the Pi package**

   ```bash
   pi install npm:pi-claude-handoff
   ```

2. **Create the queue.** In your project, start Pi and run `/handoff init`, which creates an IDLE `tasks.json` (it never overwrites one). Or copy `templates/tasks.json`.

3. **Add agent profiles** to `.pi/agents/`. Each needs `name` and `acceptanceRole: writer` or `acceptanceRole: read-only` in its frontmatter. Start from `templates/agents/example-writer.md` and `templates/agents/example-reviewer.md`. You need at least one writer, plus a read-only agent for reviews and gates.

4. **Teach Claude Code the protocol**
   - Paste `templates/CLAUDE-handoff.md` into your `CLAUDE.md`. Keep `## Work Log` as the last level-two section; Pi appends one line per finished task there.
   - Copy `templates/claude-skill/pi-handoff/` to `.claude/skills/pi-handoff/`.

5. **Run it.** Open Pi in the project and start the watcher:

   ```bash
   pi --handoff          # starts watching at startup
   # or, inside Pi:  /handoff watch
   ```

   Pi asks you to trust the project the first time. Then ask Claude Code for something, for example "add input validation to the signup form and have it reviewed", and watch Pi pick it up.

## Configuration

Optional `.pi/handoff.json` (see `templates/handoff.json`):

```json
{
  "contextFiles": ["AGENTS.md", "CLAUDE.md"],
  "agentsDir": ".pi/agents",
  "workLog": { "file": "CLAUDE.md", "heading": "Work Log" }
}
```

| Key | Default | Meaning |
|---|---|---|
| `contextFiles` | `["AGENTS.md", "CLAUDE.md"]` | Re-read and included in every handoff. Missing files are skipped |
| `agentsDir` | `.pi/agents` | Where agent profiles live |
| `workLog` | `CLAUDE.md`, `Work Log` | File and `##` heading for the log (`## 8. Work Log` also matches). `null` turns logging off |

All paths are project-relative and must stay inside the project.

## Commands

| Command | Does |
|---|---|
| `/handoff init` | Creates an IDLE `tasks.json` if there isn't one |
| `/handoff watch` | Starts watching (TUI only; needs project trust) |
| `/handoff status` | Shows the queue and watcher state |
| `/handoff stop` | Stops polling. Does not cancel an active task; the lock is held until it is reported or the session ends |
| `pi --handoff` | Starts watching as the session starts |

## Safety and limits

- **Reports are checked claims, not proof.** Pi's API does not let the watcher bind each child run to the task directly, so run IDs, results and the async status come from the main model. The report tool checks them for consistency and fails closed, but review the diff yourself.
- **Not a sandbox.** It does not stop an agent from editing outside the task's scope or cancel orphaned runs. Use your normal permissions and review.
- **No automatic reruns.** A task left `RUNNING` by a session that died is marked `ERROR`, never retried, because its effects are unknown.
- Only one Pi session can own a project's queue at a time.

Details: [docs/protocol.md](docs/protocol.md).

## Development

```bash
npm test     # node --test, with a mocked Pi API and temporary project trees
```

## License

MIT © Junyeong Park
