# Security review: pi-claude-handoff 0.1.0

Reviewed 2026-10-09, commit `81ea28271e59accf29f76d132e41d6225314d40c`.

Recommendation: address R2 and R5 before publishing. R1 has been withdrawn after
clarifying that task completion is separate from approval. R3 and R4 are additional
local robustness and file-confinement hardening. No remotely exploitable code
execution, direct credential exfiltration, or embedded credential was identified
in the reviewed first-party source. This is a scoped code review, not a security
certification or an audit of every Pi/subagent dependency.

## Scope and threat model

Reviewed all tracked files: the Pi entry point, the complete 1,030-line watcher,
tests, protocol documentation, templates, npm manifest, and GitHub Actions workflow.
Checked the proposed npm payload with `npm pack --dry-run --ignore-scripts --json`.
Reproductions use mocked Pi APIs and disposable filesystem fixtures; no model,
Claude process, real subagent, or publication is involved.

The extension intentionally consumes a queue written by another agent and injects
its contents as a user message. Project trust is required to start watching.
The intended security boundary is the local operator account and its trusted
project, with report validation providing additional workflow safety. Anyone
who can alter trusted project instructions or installed extensions can already
influence Pi. The literal `created_by: "claude-code"` is metadata, not source
authentication. Automatic dispatch, prompt injection by trusted repository text,
model-supplied attestations, and the absence of a tool sandbox are documented
architectural risks, rather than newly discovered privilege-escalation bugs.

This distinction matches [Pi's security policy](https://github.com/earendil-works/pi/security):
local files writable by the operator share its trust boundary. The priorities
below concern this package's release guarantees. They are not CVSS scores or
claims that each issue qualifies for a Pi advisory.

## Findings

### R1 — Withdrawn: review completion is separate from approval

Locations: `src/watcher.mjs:326-348`, `templates/agents/example-reviewer.md:13-14`.

The original review incorrectly treated `COMPLETE` as an approval signal.
The documented protocol requires completed worker/gate runs and leaves acceptance
to Claude Code and the human reviewing the result. It does not define `COMPLETE`
as "security approved" or "safe to publish".

A standalone review can correctly finish `COMPLETE` while returning
`Verdict: BLOCK`: the review job succeeded and its subject failed the review.
Likewise, recording that implementation and its required review have finished
does not itself authorize release. The reproduction confirms that completed
negative gate evidence is accepted, but does not establish a violated approval
requirement. No release action or approval-boundary bypass was demonstrated.

R1 is therefore withdrawn as a security finding and release blocker. Its test is
retained as an informational lifecycle example. An explicit decision field could
make the distinction clearer, but rejecting task completion on `BLOCK` would be
a product-policy change, not a required security fix. Preserving the actual
review verdict for the planner remains a separate concern covered by R5.

### R2 — Medium / P2: valid reports can make tasks.json unreadable

Locations: `src/watcher.mjs:286-297`, `src/watcher.mjs:442-462`,
`src/watcher.mjs:771-787`; read cap at `src/watcher.mjs:6,119`.

Reports allow 100 test entries, each 2,048 JavaScript string units, and a separate
100-entry changed-file list. The queue is capped at 262,144 UTF-8 bytes on reads.
The writer never applies that cap to the final serialized object. Existing
planner and unknown fields are retained, JSON serialization can expand strings,
and UTF-8 can use several bytes per string unit.

Reproduction R2 supplies 100 distinct allowed-length CJK test descriptions. The
report succeeds and writes a 615,555-byte `COMPLETE` queue. `readQueue` immediately
rejects that file, and polling reports a queue error. Normal watcher processing
and stale-task recovery cannot read it. With a configured work log, failure
recovery also cannot read such an oversized terminal queue.

Prerequisite: only a schema-valid model report. This can occur accidentally;
the individual field validators and tool schema permit the input.

Fix: serialize once, enforce the total UTF-8 queue cap before creating/replacing
the temp file, and use those same bytes for the hash. Reject the report while
preserving the valid `RUNNING` queue. Include preserved fields in the budget.
Consider a bounded external report artifact for larger evidence. Test Unicode,
JSON escaping, and an already-near-limit queue.

### R3 — Low / P3: read limits apply after unbounded synchronous reads

Locations: `src/watcher.mjs:81-85,233-241,372-377,525-539,562-574`.

Queue, configuration, context, and profile readers call `readFileSync` before
checking byte limits. Work-log and lock reads have no size bound. Thus a limit
does not bound the memory allocation or time spent reading. The queue path is
polled every second and performs synchronous work on the Pi process's event loop.
Large files can freeze the TUI or exhaust memory before validation rejects them.

Reproduction R3 instruments the filesystem and confirms that a one-MiB queue is
fully read before the 256-KiB rejection. A process crash was not induced.

Prerequisite: a large local input file, including an accidentally generated queue
or growing log. This is local robustness hardening, not a demonstrated network
DoS or cross-account attack.

Fix: open a validated regular file, `fstat` the descriptor, enforce a size bound
before allocation, and read at most limit + 1 bytes from that same descriptor so
concurrent growth cannot bypass the limit. Bound profile count and total context
as well as individual files. Give the append-only log a rotation or bounded
scanning policy and impose a small fixed bound on lock records.

### R4 — Low / P3: work-log hard links bypass project confinement

Locations: `src/watcher.mjs:69-78,372-403`.

The file check rejects symlinks and paths whose realpath escapes the project,
but an NTFS/POSIX hard link is a regular file whose realpath remains inside the
project. `appendWorkLog` writes to its shared inode. A project-local `CLAUDE.md`
hard-linked to an outside Markdown file with a Work Log heading therefore changes
that outside file. `O_NOFOLLOW` does not reject hard links, and the inode equality
check accepts them.

Reproduction R4 creates two disposable projects, links one's `CLAUDE.md` into the
other, and confirms that appending in the first modifies the second. Verified on
Windows/NTFS; the sandbox itself disallowed creating hard links, so this one
fixture-only test ran outside the sandbox.

Prerequisite: a pre-existing hard link or permission to create one on the same
filesystem. This does not demonstrate acquiring new OS permissions. It violates
the package's stated project-path confinement and can also happen accidentally.

Fix: conservatively reject `nlink !== 1` for mutable log files, checking the opened
descriptor before writing. Compare both device and inode when checking file
identity. Document the remaining local race/alias limitations; path validation
is not an OS sandbox. Add a real-filesystem hard-link regression on supported
platforms, rather than testing only symlink flags in a mock.

### R5 — Medium / P2: validated run and gate evidence is not persisted

Locations: `src/watcher.mjs:771-787,990-993`.

The tool accepts and validates worker run ID/result, reviewer identity/run ID,
gate result/model/thinking, and async status. The saved patch retains only the
worker agent/model/thinking and coordinator summary, changed files and tests.
It drops the run IDs, independent review identity/result, and async snapshot.
The work log receives a generic completion line and tool result `details` is
undefined. A gate's caveats are therefore absent from the protocol's queue/log
channel that Claude Code is instructed to use for review.

Reproduction R5 reports an approving review with a token-rotation caveat and a
distinct reviewer run ID. Neither that caveat, the reviewer run ID, nor the worker
run ID appears in the persisted queue or work log. Pi's own transcript may retain
the tool arguments, but this package provides no durable evidence reference to
the planner through its declared handoff channel.

Fix: persist bounded worker/gate/async evidence in a versioned report object,
including run IDs, explicit decisions, resolved profile metadata and capture time.
Alternatively persist a digest and a stable path to a bounded report artifact.
Teach the planner to inspect that evidence. Apply R2's total output bound so this
addition cannot poison the queue. Preserve limitations: stored model claims
remain claims unless verified against native execution data.

## Package and dependency assessment

- The dry-run npm payload contains 13 intended files, 80,556 unpacked bytes. No
  tests, `.git`, workflows, runtime queue, local configuration, or review artifacts
  are included by the current `files` allowlist. Review artifacts are deliberately
  outside `docs/` and `src/` to keep them out of the published package.
- No direct `dependencies`, bundled dependencies, install/postinstall hook,
  executable shell invocation, HTTP request, dynamic code evaluation, or
  environment-secret read exists in the first-party source. Peer dependencies
  still introduce a substantial external execution/supply-chain trust surface.
- The package has no lockfile or installed dependency graph to audit. The
  `@earendil-works/pi-ai` and optional `pi-subagents` peers accept `*`; the coding
  agent peer accepts `>=1.1.0` without a major-version upper bound. Select tested
  compatible peer ranges and pin a representative development/integration graph
  for reproducible CI. A peer range is not a transitive vulnerability scan.
- Four published Pi advisories were checked: [temporary extension installs](https://github.com/earendil-works/pi/security/advisories/GHSA-jfgx-wxx8-mp94),
  [project trust](https://github.com/earendil-works/pi/security/advisories/GHSA-mqxh-6gq7-558m),
  [credential file writes](https://github.com/earendil-works/pi/security/advisories/GHSA-r95r-rj6r-c39x),
  and [HTML export URLs](https://github.com/earendil-works/pi/security/advisories/GHSA-7v5m-pr3q-6453).
  Their affected coding-agent ranges are below this package's declared `>=1.1.0`
  minimum. They are not findings against this package. No full transitive audit
  or clean dependency bill of health is claimed.
- CI uses SHA-pinned actions, read-only repository permissions, and checkout
  without persisted Git credentials. It tests the mock watcher on Ubuntu with
  Node 22.19.0 and 24.x, but has no real Pi/subagents integration test. Add real
  host smoke tests and Windows coverage for filesystem behavior. Protect the npm
  maintainer account and use trusted publishing/provenance for the eventual release.
- A targeted scan of tracked source/templates found no common private-key,
  npm-token, GitHub-token, AWS-access-key, or OpenAI-key pattern. This is not an
  exhaustive credential or repository-history audit. The repository has one commit.

## Architectural improvements

The current safety documentation correctly says reports are attestations and the
extension is not a sandbox. Keep that explicit. A fabricated completion with
invented run IDs is accepted by design, so the gate/report mechanisms cannot be
advertised as independent execution proof.

Current [pi-subagents extension APIs](https://github.com/nicobailon/pi-subagents/blob/main/docs/extension-api.md)
provide native status snapshots, launch correlation and optional completion
events. Evaluate those capabilities against a tested minimum version for stronger
binding between a handoff and its actual child runs. Version/capability checks
should fail closed when stronger verification is promised.

Also, `acceptanceRole: read-only` is a label rather than a capability restriction.
[pi-subagents documents](https://github.com/nicobailon/pi-subagents/blob/main/docs/agents.md)
that it does not grant or revoke tools. The shipped reviewer template has a read
allowlist, but the watcher parses only name/role/model/thinking and accepts a
`read-only`-labeled profile regardless of its actual tools. Stronger guarantees
would require checking the resolved launch contract and effective tool ceiling.
This is covered by the documented non-sandbox limitation, not counted as a new
privilege-escalation finding here.

## Validation and reproduction

Environment: Windows, Node 22.23.0, npm 10.9.8. The existing suite passed all 38
tests with temporary files under the writable workspace. Initial failures in the
default sandbox temp directory were filesystem permission artifacts, not product
failures. Syntax checking of `src/watcher.mjs` passed.

All five independent checks demonstrated the audited behavior. Four ran
in the sandbox; the NTFS hard-link reproduction ran with a fixture-only sandbox
exception. R1 is an informational lifecycle check after withdrawal of that
finding. R2-R5 assert the presence of the remaining gaps, so their passing is
evidence of those issues, not evidence of a secure implementation.

Run from the repository root:

```powershell
New-Item -ItemType Directory -Path .security-review-tmp -Force | Out-Null
$env:TEMP = Join-Path (Get-Location) '.security-review-tmp'
$env:TMP = $env:TEMP
node --test --test-reporter=spec tests/watcher.test.mjs
node --test --test-reporter=spec security-review/repro.test.mjs
```

On ordinary hosts the hard-link test requires filesystem hard-link support and
permission to link its two disposable fixtures. It does not access real files
outside the temporary test trees. No production code or existing tests were
modified during this review.
