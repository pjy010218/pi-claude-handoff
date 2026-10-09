# Resolution of the 2026-10-09 security review

Review: [REVIEW.md](REVIEW.md), at commit `81ea282`. Each finding was reproduced on Linux before fixing.

| Finding | Status | Fix | Regression test (`tests/watcher.test.mjs`) |
|---|---|---|---|
| R1 (withdrawn) | Agreed: not a finding | `COMPLETE` means the work and review finished, not approval. Docs, skill and template now say so, and R5 makes the reviewer's verdict visible | n/a |
| R2 (medium) | Fixed | `atomicPatchQueue` serializes once and refuses any write over the 256 KiB read limit; the task stays `RUNNING` and readable | "R2: a report that would make tasks.json exceed its read limit…" |
| R3 (low) | Fixed | All reads go through a bounded reader that checks size on the open descriptor and reads at most limit + 1 bytes. Added limits for the lock (4 KiB), work log (4 MiB) and profile count (256) | "R3: oversized files are rejected without reading them whole" |
| R4 (low) | Fixed | The work log is checked and appended through one descriptor, refused when `nlink !== 1`, and compared by device and inode | "R4: the work log refuses a hard-linked file…" |
| R5 (medium) | Fixed | The validated worker, gate and async evidence is saved as `report` in `tasks.json` and returned in the tool result; the work-log line names each gate's reviewer and the start of its verdict | "R5: worker, gate and async evidence is persisted…", "R5: a new task clears the previous task's report…" |

Also from the review's package notes: the Pi peer dependency ranges are capped below 2.0, and `docs/protocol.md` now says that `acceptanceRole: read-only` is a routing label, not a tool restriction.

[repro.test.mjs](repro.test.mjs) asserts the behavior *before* these fixes, so R2–R5 in it now fail by design (R1 still passes because it describes intended behavior). The fixed behavior is covered by the tests listed above, which run in CI.

Not addressed here, as the review itself rates them architectural rather than findings: binding reports to pi-subagents' native run status, real-Pi integration tests in CI, and Windows coverage.
