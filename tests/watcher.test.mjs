import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  acquireOwnership,
  appendWorkLog,
  atomicPatchQueue,
  initProject,
  installWatcher,
  loadConfig,
  readQueue,
  releaseOwnership,
  TOOL_NAME,
} from "../src/watcher.mjs";

const Type = {
  Literal: (value) => ({ kind: "literal", value }),
  String: () => ({ kind: "string" }),
  Boolean: () => ({ kind: "boolean" }),
  Null: () => ({ kind: "null" }),
  Union: (items) => ({ kind: "union", items }),
  Array: (items, options) => ({ kind: "array", items, options }),
  Object: (properties, options) => ({ kind: "object", properties, options }),
};

function queue(overrides = {}) {
  return {
    schema_version: 3,
    status: "IDLE",
    task_id: "",
    task_type: "",
    preferred_agent: "",
    required_role: "any",
    gate: "none",
    gate_reason: "",
    parent_task_id: "",
    assigned_agent: "",
    assigned_model: "",
    thinking: "",
    instruction: "",
    working_dir: ".",
    scope: [],
    acceptance_criteria: [],
    plan_ref: "",
    created_at: "",
    created_by: "claude-code",
    started_at: "",
    completed_at: "",
    updated_by: "",
    result: "",
    files_changed: [],
    tests_run: [],
    error: "",
    ...overrides,
  };
}

function pending(overrides = {}) {
  return queue({
    status: "PENDING",
    task_id: "task-test-1",
    task_type: "IMPLEMENT",
    preferred_agent: "",
    required_role: "writer",
    gate: "none",
    gate_reason: "",
    instruction: "Implement the narrowly scoped synthetic test task.",
    working_dir: ".",
    scope: [".pi/extensions"],
    acceptance_criteria: ["Keep changes inside scope", "Run the focused test"],
    created_at: "2026-10-08T12:00:00.000Z",
    created_by: "claude-code",
    planner_extension: "preserve-me",
    ...overrides,
  });
}

function makeRoot(t, initialQueue = queue()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-claude-handoff-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, ".pi", "agents"), { recursive: true });
  fs.mkdirSync(path.join(root, ".pi", "extensions"), { recursive: true });
  fs.writeFileSync(path.join(root, "AGENTS.md"), "root policy snapshot\n");
  fs.writeFileSync(path.join(root, "CLAUDE.md"), "# shared\n\n## Work Log (Pi appends, newest last)\n_None yet._\n");
  fs.writeFileSync(path.join(root, "tasks.json"), `${JSON.stringify(initialQueue, null, 2)}\n`);
  fs.writeFileSync(path.join(root, ".pi", "agents", "example-writer.md"), `---\nname: example-writer\nmodel: provider/example-model\nthinking: high\nacceptanceRole: writer\n---\nwriter profile\n`);
  fs.writeFileSync(path.join(root, ".pi", "agents", "example-reviewer.md"), `---\nname: example-reviewer\nmodel: provider/example-model\nthinking: high\nacceptanceRole: read-only\n---\nread-only reviewer profile\n`);
  fs.writeFileSync(path.join(root, ".pi", "agents", "example-consultant.md"), `---\nname: example-consultant\nmodel: provider/example-model\nthinking: high\nacceptanceRole: read-only\n---\nread-only consultant profile\n`);
  fs.writeFileSync(path.join(root, ".pi", "agents", "example-writer-default-thinking.md"), `---\nname: example-writer-default-thinking\nmodel: provider/example-model\nthinking: default\nacceptanceRole: writer\n---\nwriter profile with platform default thinking\n`);
  return root;
}

function proxyFs(overrides = {}) {
  return new Proxy(fs, {
    get(target, property) {
      if (Object.hasOwn(overrides, property)) return overrides[property];
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function makeEnv(t, { initialQueue = queue(), cliFlags = {}, fsApi = fs, alive = () => true } = {}) {
  const root = makeRoot(t, initialQueue);
  const handlers = new Map();
  const commands = new Map();
  const tools = new Map();
  const flagValues = new Map();
  const initialFlags = new Map(Object.entries(cliFlags));
  const messages = [];
  const notifications = [];
  const statuses = new Map();
  const widgets = new Map();
  const timers = [];
  const cleared = new Set();
  let idle = true;
  const pi = {
    registerFlag(name, options) { flagValues.set(name, initialFlags.has(name) ? initialFlags.get(name) : options.default); },
    getFlag(name) { return flagValues.get(name); },
    registerCommand(name, definition) { commands.set(name, definition); },
    registerTool(definition) { tools.set(definition.name, definition); },
    setFlag(name, value) { flagValues.set(name, value); },
    on(name, handler) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); return () => {}; },
    sendUserMessage(message) { messages.push(message); },
  };
  const ctx = {
    cwd: root,
    mode: "tui",
    hasUI: true,
    isIdle: () => idle,
    isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "test-session-1" },
    ui: {
      notify: (message, type) => notifications.push({ message, type }),
      setStatus: (key, value) => statuses.set(key, value),
      setWidget: (key, value) => widgets.set(key, value),
    },
  };
  const runtime = installWatcher(pi, Type, {
    fs: fsApi,
    pollMs: 1000,
    isProcessAlive: alive,
    setInterval: (callback, ms) => { const timer = { callback, ms }; timers.push(timer); return timer; },
    clearInterval: (timer) => cleared.add(timer),
  });
  return {
    root, pi, runtime, ctx, messages, notifications, statuses, widgets, timers, cleared,
    handlers, commands, tools,
    setIdle(value) { idle = value; },
    writeQueue(value) { fs.writeFileSync(path.join(root, "tasks.json"), `${JSON.stringify(value, null, 2)}\n`); },
    readQueue() { return JSON.parse(fs.readFileSync(path.join(root, "tasks.json"), "utf8")); },
    rawQueue() { return fs.readFileSync(path.join(root, "tasks.json"), "utf8"); },
    async event(name, event = {}, eventCtx = ctx) {
      for (const handler of handlers.get(name) ?? []) await handler(event, eventCtx);
    },
  };
}

const sessionStart = async (env) => env.event("session_start", { type: "session_start", reason: "startup" });
const startWatch = async (env) => env.commands.get("handoff").handler("watch", env.ctx);
const completionReport = (overrides = {}) => ({
  status: "COMPLETE",
  worker: {
    agent: "example-writer", run_id: "writer-run-1", status: "COMPLETE", result: "Implemented the scoped change.",
    model: "provider/example-model", thinking: "high",
  },
  gate_evidence: [],
  async_status: { checked: true, pending_run_ids: [], failed_run_ids: [] },
  files_changed: [".pi/extensions/feature.ts"],
  tests_run: ["node --test .pi/tests/feature.test.mjs — passed"],
  result: "Scoped change and focused regression test passed.",
  error: "",
  ...overrides,
});

async function invokeReport(env, report) {
  return env.tools.get(TOOL_NAME).execute("call-1", report, undefined, undefined, env.ctx);
}


test("factory registers the flag, command, and report tool without starting session resources", (t) => {
  const env = makeEnv(t);
  assert.equal(env.timers.length, 0);
  assert.deepEqual([...env.commands.keys()], ["handoff"]);
  assert.deepEqual([...env.tools.keys()], [TOOL_NAME]);
  assert.equal(env.pi.getFlag("handoff"), false);
  assert.equal(env.rawQueue(), `${JSON.stringify(queue(), null, 2)}\n`);
});

test("PENDING at startup is handed to the visible main session with fresh shared context", async (t) => {
  const env = makeEnv(t, { initialQueue: pending(), cliFlags: { handoff: true } });
  await sessionStart(env);
  assert.equal(env.readQueue().status, "RUNNING");
  assert.equal(env.readQueue().updated_by, "pi");
  assert.equal(env.messages.length, 1);
  assert.match(env.messages[0], /CLAUDE CODE TASK HANDOFF/);
  assert.match(env.messages[0], /root policy snapshot/);
  assert.match(env.messages[0], /Fresh CLAUDE\.md/);
  assert.match(env.messages[0], /context: "fresh"/);
  assert.match(env.statuses.get("pi-claude-handoff"), /RUNNING/);
  await env.runtime.poll();
  assert.equal(env.messages.length, 1, "repeated poll does not dispatch the same task twice");
});

test("a busy main session leaves PENDING unchanged; an idle transition dispatches once", async (t) => {
  const env = makeEnv(t);
  await startWatch(env);
  env.writeQueue(pending());
  env.setIdle(false);
  await env.runtime.poll();
  assert.equal(env.readQueue().status, "PENDING");
  assert.equal(env.messages.length, 0);
  env.setIdle(true);
  await env.runtime.poll();
  await env.runtime.poll();
  assert.equal(env.readQueue().status, "RUNNING");
  assert.equal(env.messages.length, 1);
});

test("a replacement queue identity is preserved while an earlier task is active", async (t) => {
  const env = makeEnv(t, { initialQueue: pending() });
  await startWatch(env);
  const replacement = pending({ task_id: "replacement-task", instruction: "new planner task" });
  env.writeQueue(replacement);
  await env.runtime.poll();
  assert.equal(env.readQueue().task_id, "replacement-task");
  assert.equal(env.readQueue().status, "PENDING");
  assert.equal(env.messages.length, 1);
  assert.match(env.notifications.at(-1).message, /replacement/);
});

test("`--handoff` starts the watcher at session start, only in the visible TUI", async (t) => {
  const env = makeEnv(t, { cliFlags: { handoff: true } });
  await sessionStart(env);
  assert.equal(env.timers.length, 1);
  assert.equal(fs.existsSync(path.join(env.root, ".pi", "pi-claude-handoff.lock")), true);

  const off = makeEnv(t);
  await sessionStart(off);
  assert.equal(off.timers.length, 0);

  const rpc = makeEnv(t, { initialQueue: pending(), cliFlags: { handoff: true } });
  rpc.ctx.mode = "rpc";
  await sessionStart(rpc);
  assert.equal(rpc.timers.length, 0);
  assert.equal(rpc.messages.length, 0);
  assert.equal(rpc.readQueue().status, "PENDING");
  assert.equal(fs.existsSync(path.join(rpc.root, ".pi", "pi-claude-handoff.lock")), false);
});

test("/handoff init creates an IDLE tasks.json once and never overwrites", async (t) => {
  const env = makeEnv(t);
  fs.rmSync(path.join(env.root, "tasks.json"));
  await env.commands.get("handoff").handler("init", env.ctx);
  assert.equal(env.readQueue().status, "IDLE");
  assert.equal(env.readQueue().schema_version, 3);
  env.writeQueue(pending());
  assert.match(initProject(env.root), /already exists/);
  assert.equal(env.readQueue().status, "PENDING");
});

test("config: custom context files, agents directory and work log", async (t) => {
  const env = makeEnv(t, { initialQueue: pending() });
  fs.mkdirSync(path.join(env.root, "team"));
  fs.renameSync(path.join(env.root, ".pi", "agents", "example-writer.md"), path.join(env.root, "team", "example-writer.md"));
  fs.writeFileSync(path.join(env.root, "PLAN.md"), "plan context marker\n");
  fs.writeFileSync(path.join(env.root, "LOG.md"), "# Log\n\n## Done tasks\n");
  fs.writeFileSync(path.join(env.root, ".pi", "handoff.json"), JSON.stringify({
    contextFiles: ["PLAN.md", "MISSING.md"], agentsDir: "team", workLog: { file: "LOG.md", heading: "Done tasks" },
  }));
  await startWatch(env);
  assert.match(env.messages[0], /plan context marker/);
  assert.doesNotMatch(env.messages[0], /root policy snapshot/);
  await invokeReport(env, completionReport());
  assert.equal(env.readQueue().status, "COMPLETE");
  assert.match(fs.readFileSync(path.join(env.root, "LOG.md"), "utf8"), /task-test-1 \| COMPLETE/);
  assert.doesNotMatch(fs.readFileSync(path.join(env.root, "CLAUDE.md"), "utf8"), /task-test-1/);
});

test("config: workLog null disables logging; unsafe or unknown keys are rejected", (t) => {
  const root = makeRoot(t);
  const config = path.join(root, ".pi", "handoff.json");
  fs.writeFileSync(config, JSON.stringify({ workLog: null }));
  assert.equal(loadConfig(root).workLog, null);
  appendWorkLog(root, pending(), "COMPLETE", "ignored", fs, null);
  assert.doesNotMatch(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8"), /ignored/);
  for (const bad of [{ agentsDir: "../elsewhere" }, { contextFiles: ["/etc/passwd"] }, { workLog: { heading: "## x" } }, { surprise: true }]) {
    fs.writeFileSync(config, JSON.stringify(bad));
    assert.throws(() => loadConfig(root), undefined, JSON.stringify(bad));
  }
});

test("work-log heading may be numbered and must match whole words", (t) => {
  const root = makeRoot(t);
  const file = path.join(root, "CLAUDE.md");
  fs.writeFileSync(file, "# x\n\n## 8. Work Log (newest last)\n");
  appendWorkLog(root, pending(), "COMPLETE", "numbered ok", fs);
  assert.match(fs.readFileSync(file, "utf8"), /numbered ok/);
  fs.writeFileSync(file, "## Work Logs\n");
  assert.throws(() => appendWorkLog(root, pending(), "COMPLETE", "x", fs), /missing, duplicated/);
});

test("malformed JSON and unsupported queue schema/status fail closed, then a complete replacement is observed", async (t) => {
  const env = makeEnv(t);
  await startWatch(env);
  const file = path.join(env.root, "tasks.json");
  fs.writeFileSync(file, "{\"schema_version\":3");
  await env.runtime.poll();
  assert.equal(fs.readFileSync(file, "utf8"), "{\"schema_version\":3");
  assert.equal(env.messages.length, 0);

  const wrongSchema = pending({ schema_version: 99 });
  env.writeQueue(wrongSchema);
  const schemaBefore = env.rawQueue();
  await env.runtime.poll();
  assert.equal(env.rawQueue(), schemaBefore);
  assert.equal(env.messages.length, 0);

  const wrongStatus = pending({ status: "pending" });
  env.writeQueue(wrongStatus);
  const statusBefore = env.rawQueue();
  await env.runtime.poll();
  assert.equal(env.rawQueue(), statusBefore);
  assert.equal(env.messages.length, 0);

  env.writeQueue(pending());
  await env.runtime.poll();
  assert.equal(env.readQueue().status, "RUNNING");
  assert.equal(env.messages.length, 1);
});

test("invalid PENDING task types, roles, gates, missing scope/criteria, and path escapes become ERROR", async (t) => {
  const cases = [
    ["task type", { task_type: "CODE" }],
    ["role", { required_role: "executor" }],
    ["role mismatch", { task_type: "REVIEW", required_role: "writer" }],
    ["gate", { gate: "skip-review", gate_reason: "security" }],
    ["missing gate reason", { gate: "review-after", gate_reason: "" }],
    ["missing scope", { scope: [] }],
    ["missing criteria", { acceptance_criteria: [] }],
    ["working-dir escape", { working_dir: "../outside" }],
    ["scope escape", { scope: ["../outside"] }],
    ["missing creator", { created_by: "someone-else" }],
  ];
  for (const [label, override] of cases) {
    await t.test(label, async (subtest) => {
      const env = makeEnv(subtest, { initialQueue: pending(override) });
      await startWatch(env);
      assert.equal(env.readQueue().status, "ERROR");
      assert.match(env.readQueue().error, /Rejected PENDING task/);
      assert.equal(env.messages.length, 0);
    });
  }
});

test("stale RUNNING tasks are marked ERROR once and never automatically rerun", async (t) => {
  const env = makeEnv(t, { initialQueue: pending({ status: "RUNNING", updated_by: "pi", started_at: "2026-10-08T12:01:00.000Z" }) });
  await startWatch(env);
  assert.equal(env.readQueue().status, "ERROR");
  assert.match(env.readQueue().error, /unowned RUNNING/);
  assert.equal(env.messages.length, 0);
  assert.match(fs.readFileSync(path.join(env.root, "CLAUDE.md"), "utf8"), /task-test-1 \| ERROR/);
});

test("atomic queue replacement preserves replacements and handles partial writes and rename failures", (t) => {
  const root = makeRoot(t, pending());
  const snapshot = readQueue(root);
  const replacement = pending({ task_id: "planner-replacement", instruction: "replacement wins" });
  assert.throws(() => atomicPatchQueue(root, snapshot, { status: "RUNNING" }, fs, {
    beforeRename() { fs.writeFileSync(path.join(root, "tasks.json"), `${JSON.stringify(replacement, null, 2)}\n`); },
  }), /changed before atomic rename/);
  assert.equal(readQueue(root).queue.task_id, "planner-replacement");
  assert.equal(fs.readdirSync(root).filter((name) => name.endsWith(".tmp")).length, 0);

  const partialRoot = makeRoot(t, pending());
  const partialSnapshot = readQueue(partialRoot);
  const partialFs = proxyFs({ writeSync: (fd, buffer, offset, length) => fs.writeSync(fd, buffer, offset, Math.min(length, 3)) });
  const partial = atomicPatchQueue(partialRoot, partialSnapshot, { status: "RUNNING", updated_by: "pi" }, partialFs);
  assert.equal(readQueue(partialRoot).queue.status, "RUNNING");
  assert.equal(partial.queue.updated_by, "pi");

  const failRoot = makeRoot(t, pending());
  const failSnapshot = readQueue(failRoot);
  const before = fs.readFileSync(path.join(failRoot, "tasks.json"), "utf8");
  const failFs = proxyFs({ renameSync() { throw new Error("synthetic rename failure"); } });
  assert.throws(() => atomicPatchQueue(failRoot, failSnapshot, { status: "RUNNING" }, failFs), /synthetic rename failure/);
  assert.equal(fs.readFileSync(path.join(failRoot, "tasks.json"), "utf8"), before);
  assert.equal(fs.readdirSync(failRoot).filter((name) => name.endsWith(".tmp")).length, 0);
});

test("exclusive ownership blocks a second session and shutdown/reload cleanup is idempotent", async (t) => {
  const first = makeEnv(t);
  const second = makeEnv(t);
  // Use one shared project root for both independently registered runtimes.
  fs.rmSync(second.root, { recursive: true, force: true });
  second.ctx.cwd = first.root;
  await startWatch(first);
  await second.commands.get("handoff").handler("watch", second.ctx);
  assert.equal(first.timers.length, 1);
  assert.equal(second.timers.length, 0);
  assert.match(second.notifications.at(-1).message, /Another Pi session owns/);
  await first.event("session_shutdown", { type: "session_shutdown", reason: "reload" });
  await first.event("session_shutdown", { type: "session_shutdown", reason: "reload" });
  assert.equal(first.cleared.size, 1);
  assert.equal(fs.existsSync(path.join(first.root, ".pi", "pi-claude-handoff.lock")), false);
  await second.commands.get("handoff").handler("watch", second.ctx);
  assert.equal(second.timers.length, 1);
  await second.runtime.shutdown();
  assert.equal(fs.existsSync(path.join(first.root, ".pi", "pi-claude-handoff.lock")), false);
});

test("stale PID lock recovery is exclusive; malformed partial lock is left for manual inspection", (t) => {
  const staleRoot = makeRoot(t);
  const stale = acquireOwnership(staleRoot, "old-session", fs, { pid: 919191 });
  const current = acquireOwnership(staleRoot, "new-session", fs, { pid: 919192, isProcessAlive: () => false });
  assert.equal(current.owner.sessionId, "new-session");
  assert.throws(() => acquireOwnership(staleRoot, "third-session", fs, { pid: 919193, isProcessAlive: () => true }), /Another Pi session owns/);
  assert.equal(releaseOwnership(current), true);
  assert.equal(fs.existsSync(stale.path), false);

  const partialRoot = makeRoot(t);
  const lockPath = path.join(partialRoot, ".pi", "pi-claude-handoff.lock");
  fs.writeFileSync(lockPath, "{partial");
  assert.throws(() => acquireOwnership(partialRoot, "next-session", fs, { isProcessAlive: () => false }), /incomplete or malformed/);
  assert.equal(fs.readFileSync(lockPath, "utf8"), "{partial");
});

test("structured completion records agent evidence, preserves planner fields, and ignores duplicate reports", async (t) => {
  const env = makeEnv(t, { initialQueue: pending() });
  await startWatch(env);
  const report = completionReport();
  await assert.rejects(invokeReport(env, completionReport({ async_status: { checked: true, pending_run_ids: ["async-1"], failed_run_ids: [] } })), /pending or running/);
  assert.equal(env.readQueue().status, "RUNNING");
  const toolResult = await invokeReport(env, report);
  assert.match(toolResult.content[0].text, /recorded COMPLETE/);
  const saved = env.readQueue();
  assert.equal(saved.status, "COMPLETE");
  assert.equal(saved.assigned_agent, "example-writer");
  assert.equal(saved.planner_extension, "preserve-me");
  assert.equal(saved.instruction, pending().instruction);
  assert.deepEqual(saved.scope, [".pi/extensions"]);
  await assert.rejects(invokeReport(env, report), /No active watched task/);
  const log = fs.readFileSync(path.join(env.root, "CLAUDE.md"), "utf8");
  assert.equal((log.match(/task-test-1 \| COMPLETE/g) ?? []).length, 1);
});

test("review-after requires an independent, successful read-only agent and explicit model/thinking", async (t) => {
  const task = pending({ gate: "review-after", gate_reason: "security surface" });
  const env = makeEnv(t, { initialQueue: task });
  await startWatch(env);
  const reviewer = {
    gate: "review-after", agent: "example-reviewer", run_id: "review-run-1", status: "COMPLETE",
    result: "No blocking findings in the supplied diff.", independent: true, model: "provider/example-model", thinking: "high",
  };
  await assert.rejects(invokeReport(env, completionReport({ gate_evidence: [{ ...reviewer, status: "RUNNING" }] })), /pending or running/);
  await assert.rejects(invokeReport(env, completionReport({ worker: { ...completionReport().worker, model: "openai-codex/not-profile-model" } })), /does not match the selected agent profile/);
  await assert.rejects(invokeReport(env, completionReport({ gate_evidence: [{ ...reviewer, agent: "example-writer" }] })), /independent gate/);
  const result = await invokeReport(env, completionReport({ gate_evidence: [reviewer] }));
  assert.match(result.content[0].text, /recorded COMPLETE/);
  assert.equal(env.readQueue().status, "COMPLETE");
});

test("consult-before needs a distinct read-only agent and cannot be confused with review-after", async (t) => {
  const env = makeEnv(t, { initialQueue: pending({ gate: "consult-before", gate_reason: "architecture boundary" }) });
  await startWatch(env);
  const consultation = {
    gate: "consult-before", agent: "example-consultant", run_id: "consult-run-1", status: "COMPLETE",
    result: "Proceed inside the stated boundary.", independent: true, model: "provider/example-model", thinking: "high",
  };
  await assert.rejects(invokeReport(env, completionReport({ gate_evidence: [{ ...consultation, gate: "review-after" }] })), /COMPLETE requires explicit consult-before evidence/);
  await invokeReport(env, completionReport({ gate_evidence: [consultation] }));
  assert.equal(env.readQueue().status, "COMPLETE");
});

test("read-only reports cannot claim changed files", async (t) => {
  const task = pending({ task_type: "REVIEW", required_role: "read-only", scope: [".pi/extensions"] });
  const env = makeEnv(t, { initialQueue: task });
  await startWatch(env);
  const worker = {
    agent: "example-reviewer", run_id: "reviewer-run", status: "COMPLETE", result: "Review complete.",
    model: "provider/example-model", thinking: "high",
  };
  await assert.rejects(invokeReport(env, completionReport({ worker, files_changed: [".pi/extensions/change.ts"] })), /Read-only tasks cannot report files_changed/);
  assert.equal(env.readQueue().status, "RUNNING");
  await invokeReport(env, completionReport({ worker, files_changed: [] }));
  assert.deepEqual(env.readQueue().files_changed, []);
});

test("reported changed paths use project-root-relative scope when working_dir is a child repo", async (t) => {
  const task = pending({ working_dir: "child-repo", scope: ["child-repo/src/"] });
  const env = makeEnv(t, { initialQueue: task });
  fs.mkdirSync(path.join(env.root, "child-repo", "src"), { recursive: true });
  await startWatch(env);
  const result = await invokeReport(env, completionReport({ files_changed: ["child-repo/src/change.ts"] }));
  assert.match(result.content[0].text, /recorded COMPLETE/);
  assert.deepEqual(env.readQueue().files_changed, ["child-repo/src/change.ts"]);
});

test("work-log append rejects a level-two heading after the work log", (t) => {
  const root = makeRoot(t);
  const file = path.join(root, "CLAUDE.md");
  fs.appendFileSync(file, "\n## Notes\nDo not append the work log here.\n");
  const before = fs.readFileSync(file, "utf8");
  assert.throws(() => appendWorkLog(root, pending(), "ERROR", "must not append", fs), /no longer the final level-two section/);
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("work-log append refuses a replaced file and never truncates a concurrent append", (t) => {
  const root = makeRoot(t);
  const claude = path.join(root, "CLAUDE.md");
  let replaceBeforeOpen = true;
  const replacedFs = proxyFs({
    openSync(file, flags, mode) {
      if (replaceBeforeOpen && path.basename(String(file)) === "CLAUDE.md") {
        replaceBeforeOpen = false;
        fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("_None yet._", "Other note..."));
      }
      return fs.openSync(file, flags, mode);
    },
  });
  assert.throws(() => appendWorkLog(root, pending(), "ERROR", "replacement check", replacedFs), /changed while its work-log section was being checked/);
  assert.match(fs.readFileSync(claude, "utf8"), /Other note/);
  assert.doesNotMatch(fs.readFileSync(claude, "utf8"), /replacement check/);

  let wrotePartial = false;
  const concurrentFs = proxyFs({
    writeSync(fd, buffer, offset, length) {
      if (!wrotePartial) {
        wrotePartial = true;
        const count = fs.writeSync(fd, buffer, offset, Math.min(length, 5));
        fs.writeSync(fd, Buffer.from("CONCURRENT_APPEND\n"));
        return count;
      }
      throw new Error("synthetic append failure");
    },
  });
  assert.throws(() => appendWorkLog(root, pending(), "ERROR", "partial append", concurrentFs), /synthetic append failure/);
  assert.match(fs.readFileSync(claude, "utf8"), /CONCURRENT_APPEND/);
});

test("work-log failure is surfaced and prevents a successful COMPLETE", async (t) => {
  const fsApi = proxyFs({
    openSync(file, flags, mode) {
      if (path.basename(String(file)) === "CLAUDE.md" && (flags & fs.constants.O_APPEND)) throw new Error("synthetic work-log failure");
      return fs.openSync(file, flags, mode);
    },
  });
  const env = makeEnv(t, { initialQueue: pending(), fsApi });
  await startWatch(env);
  await assert.rejects(invokeReport(env, completionReport()), /Work-log append failed/);
  assert.equal(env.readQueue().status, "ERROR");
  assert.match(env.readQueue().error, /Work-log append failed/);
  assert.ok(env.notifications.some((item) => item.type === "error" && /work.log/i.test(item.message)));
});

test("native async subagent launches keep an unreported task RUNNING until explicit terminal status", async (t) => {
  const env = makeEnv(t, { initialQueue: pending() });
  await startWatch(env);
  await env.event("tool_execution_start", { type: "tool_execution_start", toolCallId: "tool-call-async", toolName: "subagent", args: { agent: "example-writer", task: "implement task" } });
  await env.event("tool_execution_end", { type: "tool_execution_end", toolCallId: "tool-call-async", toolName: "subagent", result: { content: [{ type: "text", text: "Async run accepted" }] }, isError: false });
  await env.event("agent_settled", { type: "agent_settled", aborted: false });
  assert.equal(env.readQueue().status, "RUNNING");
  assert.ok(env.notifications.some((item) => /remains RUNNING/.test(item.message)));
  await assert.rejects(invokeReport(env, completionReport({ async_status: { checked: true, pending_run_ids: ["writer-run-1"], failed_run_ids: [] } })), /pending or running/);
  assert.equal(env.readQueue().status, "RUNNING");
  await invokeReport(env, completionReport());
  assert.equal(env.readQueue().status, "COMPLETE");

  const sync = makeEnv(t, { initialQueue: pending() });
  await startWatch(sync);
  await sync.event("tool_execution_start", { type: "tool_execution_start", toolCallId: "tool-call-sync", toolName: "subagent", args: { agent: "example-writer", task: "implement task", async: false } });
  await sync.event("tool_execution_end", { type: "tool_execution_end", toolCallId: "tool-call-sync", toolName: "subagent", result: { content: [{ type: "text", text: "Foreground run complete" }] }, isError: false });
  await sync.event("agent_settled", { type: "agent_settled", aborted: false });
  assert.equal(sync.readQueue().status, "ERROR", "an unreported foreground child remains an abandoned task");
});

test("profile thinking default is unspecified but the resolved report thinking must be valid", async (t) => {
  const env = makeEnv(t, { initialQueue: pending() });
  await startWatch(env);
  const worker = {
    agent: "example-writer-default-thinking", run_id: "platform-run", status: "COMPLETE", result: "Platform work completed.",
    model: "provider/example-model", thinking: "high",
  };
  await invokeReport(env, completionReport({ worker }));
  assert.equal(env.readQueue().status, "COMPLETE");

  const invalid = makeEnv(t, { initialQueue: pending() });
  await startWatch(invalid);
  await assert.rejects(invokeReport(invalid, completionReport({ worker: { ...worker, thinking: "default" } })), /resolved child model and thinking level/);
  assert.equal(invalid.readQueue().status, "RUNNING");
});

test("session abort/shutdown never infers COMPLETE and stale unreported work is not rerun", async (t) => {
  const env = makeEnv(t, { initialQueue: pending() });
  await startWatch(env);
  await env.event("agent_settled", { type: "agent_settled", aborted: true });
  assert.equal(env.readQueue().status, "ERROR");
  assert.match(env.readQueue().error, /aborted/);
  assert.equal(env.messages.length, 1);
  await env.runtime.poll();
  assert.equal(env.messages.length, 1);
  assert.ok(env.notifications.some((item) => /inspect FleetView/i.test(item.message)));
});

test("stop is not cancellation and holds ownership until active work is accounted for", async (t) => {
  const env = makeEnv(t, { initialQueue: pending() });
  await startWatch(env);
  await env.commands.get("handoff").handler("stop", env.ctx);
  assert.equal(env.messages.length, 1);
  assert.equal(fs.existsSync(path.join(env.root, ".pi", "pi-claude-handoff.lock")), true);
  assert.ok(env.notifications.at(-1).message.includes("not cancelled"));
  await env.runtime.shutdown();
  assert.equal(env.readQueue().status, "ERROR");
  assert.equal(fs.existsSync(path.join(env.root, ".pi", "pi-claude-handoff.lock")), false);
});

test("failed visible handoff records ERROR instead of leaving an unowned RUNNING task", async (t) => {
  const env = makeEnv(t, { initialQueue: pending() });
  env.pi.sendUserMessage = () => { throw new Error("busy race"); };
  await startWatch(env);
  assert.equal(env.readQueue().status, "ERROR");
  assert.match(env.readQueue().error, /Visible task handoff failed/);
  assert.equal(env.messages.length, 0);
});
