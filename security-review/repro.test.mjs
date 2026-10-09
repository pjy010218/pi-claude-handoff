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

// These assertions demonstrate the audited behavior. R1 is an informational
// lifecycle example, not a security finding. Passing R2-R5 means the corresponding
// gap still exists, not that the implementation is secure. No real agents launch.

test("R1 withdrawn: completed work and a completed negative review do not imply approval", async (t) => {
  const env = makeEnv(t, { initialQueue: pending({ gate: "review-after", gate_reason: "security review" }) });
  await startWatch(env);
  const gate = {
    gate: "review-after", agent: "example-reviewer", run_id: "blocked-review", status: "COMPLETE",
    result: "Critical credential disclosure remains. Verdict: BLOCK", independent: true,
    model: "provider/example-model", thinking: "high",
  };
  await invokeReport(env, completionReport({ gate_evidence: [gate] }));
  assert.equal(env.readQueue().status, "COMPLETE");
});

test("R2: a valid report poisons the queue by exceeding its read limit", async (t) => {
  const env = makeEnv(t, { initialQueue: pending() });
  await startWatch(env);
  // 100 unique entries of 2048 UTF-16 units, within all report/schema limits.
  // CJK text expands to three UTF-8 bytes per unit.
  const tests = Array.from({ length: 100 }, (_, i) => `${String(i).padStart(3, "0")}${"測".repeat(2045)}`);
  await invokeReport(env, completionReport({ tests_run: tests }));
  assert.equal(env.readQueue().status, "COMPLETE");
  const bytes = fs.statSync(path.join(env.root, "tasks.json")).size;
  assert.ok(bytes > 256 * 1024);
  t.diagnostic(`Serialized terminal queue: ${bytes} bytes; allowed read: 262144 bytes`);
  assert.throws(() => readQueue(env.root), /exceeds the 262144-byte limit/);
  await env.runtime.poll();
  assert.match(env.notifications.at(-1).message, /exceeds the 262144-byte limit/);
});

test("R3: oversized JSON is fully read before being rejected", (t) => {
  const root = makeRoot(t);
  const file = path.join(root, "tasks.json");
  fs.writeFileSync(file, " ".repeat(1024 * 1024));
  let bytesRead = 0;
  const observedFs = proxyFs({
    readFileSync(target, ...args) {
      const result = fs.readFileSync(target, ...args);
      if (target === file) bytesRead += Buffer.byteLength(result, "utf8");
      return result;
    },
  });
  assert.throws(() => readQueue(root, observedFs), /exceeds/);
  assert.equal(bytesRead, 1024 * 1024);
});

test("R4: work-log hard link appends to a file outside the project", (t) => {
  const root = makeRoot(t);
  // The outside file is a disposable fixture, never a user's document.
  const outside = makeRoot(t);
  const externalFile = path.join(outside, "CLAUDE.md");
  const projectFile = path.join(root, "CLAUDE.md");
  fs.unlinkSync(projectFile);
  fs.linkSync(externalFile, projectFile);
  assert.equal(fs.lstatSync(projectFile).isSymbolicLink(), false);
  assert.ok(fs.statSync(projectFile).nlink > 1);
  appendWorkLog(root, pending(), "ERROR", "hard-link boundary escaped");
  assert.match(fs.readFileSync(externalFile, "utf8"), /hard-link boundary escaped/);
});

test("R5: worker and gate run evidence is discarded from the persisted result", async (t) => {
  const env = makeEnv(t, { initialQueue: pending({ gate: "review-after", gate_reason: "security review" }) });
  await startWatch(env);
  const gate = {
    gate: "review-after", agent: "example-reviewer", run_id: "unique-review-evidence", status: "COMPLETE",
    result: "Verdict: OK with notes. Rotate the test-only token before shipping.", independent: true,
    model: "provider/example-model", thinking: "high",
  };
  const response = await invokeReport(env, completionReport({ gate_evidence: [gate] }));
  const queueAndLog = env.rawQueue() + fs.readFileSync(path.join(env.root, "CLAUDE.md"), "utf8");
  assert.equal(env.readQueue().status, "COMPLETE");
  assert.doesNotMatch(queueAndLog, /unique-review-evidence|Rotate the test-only token|writer-run-1/);
  assert.equal(Object.hasOwn(env.readQueue(), "gate_evidence"), false);
  assert.equal(response.details, undefined);
});
