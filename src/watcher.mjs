import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

const QUEUE_SCHEMA = 3;
const QUEUE_MAX_BYTES = 256 * 1024;
const CONTEXT_MAX_BYTES = 128 * 1024;
const STATUSES = new Set(["IDLE", "PENDING", "RUNNING", "COMPLETE", "ERROR"]);
const TASK_TYPES = new Set(["IMPLEMENT", "TEST", "DOCUMENT", "CONSULT", "REVIEW"]);
const ROLES = new Set(["any", "writer", "read-only"]);
const GATES = new Set(["none", "consult-before", "review-after"]);
const WRITER_TYPES = new Set(["IMPLEMENT", "TEST", "DOCUMENT"]);
const READER_TYPES = new Set(["CONSULT", "REVIEW"]);
const THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const PLANNER_FIELDS = [
  "schema_version", "status", "task_id", "task_type", "preferred_agent", "required_role", "gate",
  "gate_reason", "parent_task_id", "instruction", "working_dir", "scope", "acceptance_criteria",
  "plan_ref", "created_at", "created_by",
];
const STRING_FIELDS = [
  "task_id", "task_type", "preferred_agent", "required_role", "gate", "gate_reason", "parent_task_id",
  "assigned_agent", "assigned_model", "thinking", "instruction", "working_dir", "plan_ref", "created_at",
  "created_by", "started_at", "completed_at", "updated_by", "result", "error",
];
const ARRAY_FIELDS = ["scope", "acceptance_criteria", "files_changed", "tests_run"];

export const TOOL_NAME = "handoff_task_report";
export const CONFIG_FILE = ".pi/handoff.json";
export const DEFAULT_CONFIG = Object.freeze({
  /** Files injected (fresh) into every handoff, in order. Missing files are skipped. */
  contextFiles: ["AGENTS.md", "CLAUDE.md"],
  /** Pi agent profiles the coordinator may delegate to (pi-subagents format plus `acceptanceRole`). */
  agentsDir: ".pi/agents",
  /** Markdown file and level-two heading that receive one line per finished task; null disables. */
  workLog: { file: "CLAUDE.md", heading: "Work Log" },
});

const oneLine = (value, limit = 240) => String(value ?? "").replace(/[\r\n\t\0-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, limit);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

function within(base, target) {
  const relative = path.relative(base, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function canonicalWithMissing(target, io) {
  let cursor = path.resolve(target);
  const suffix = [];
  while (true) {
    try {
      return path.resolve(io.realpathSync(cursor), ...suffix);
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      suffix.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

function safeRoot(root, io) {
  const actual = io.realpathSync(root);
  if (!io.statSync(actual).isDirectory()) throw new Error("Watcher root is not a directory.");
  return actual;
}

function safeProjectFile(root, relative, io, kind = "file") {
  const target = path.resolve(root, relative);
  if (!within(root, target)) throw new Error(`${relative} escapes the project root.`);
  const stat = io.lstatSync(target);
  if (stat.isSymbolicLink()) throw new Error(`${relative} must not be a symlink.`);
  if (kind === "file" && !stat.isFile()) throw new Error(`${relative} is not a regular file.`);
  if (kind === "directory" && !stat.isDirectory()) throw new Error(`${relative} is not a directory.`);
  const actual = io.realpathSync(target);
  if (!within(root, actual)) throw new Error(`${relative} resolves outside the project root.`);
  return { path: actual, stat };
}

function readStrictJson(file, io, maxBytes, label) {
  const stat = io.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular, non-symlink file.`);
  const raw = io.readFileSync(file, "utf8");
  if (Buffer.byteLength(raw, "utf8") > maxBytes) throw new Error(`${label} exceeds the ${maxBytes}-byte limit.`);
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`${label} is not complete valid JSON.`);
  }
  if (!isPlainObject(value)) throw new Error(`${label} must contain a JSON object.`);
  return { raw, value };
}

function validateQueueShape(queue) {
  if (queue.schema_version !== QUEUE_SCHEMA) throw new Error(`Unsupported tasks.json schema_version (expected ${QUEUE_SCHEMA}).`);
  if (!STATUSES.has(queue.status)) throw new Error("tasks.json has an invalid status.");
  for (const key of STRING_FIELDS) {
    if (!Object.hasOwn(queue, key) || typeof queue[key] !== "string") throw new Error(`tasks.json field ${key} must be a string.`);
  }
  for (const key of ARRAY_FIELDS) {
    if (!Object.hasOwn(queue, key) || !Array.isArray(queue[key]) || queue[key].some((item) => typeof item !== "string")) {
      throw new Error(`tasks.json field ${key} must be an array of strings.`);
    }
  }
  if (queue.status === "IDLE" && queue.task_type !== "" && !TASK_TYPES.has(queue.task_type)) {
    throw new Error("IDLE tasks.json has an invalid task_type.");
  }
}

export function queueFingerprint(queue) {
  return sha(JSON.stringify(PLANNER_FIELDS.filter((key) => key !== "status").map((key) => [key, queue[key]])));
}

export function readQueue(root, io = fs) {
  const project = safeRoot(root, io);
  const { path: file } = safeProjectFile(project, "tasks.json", io);
  const { raw, value } = readStrictJson(file, io, QUEUE_MAX_BYTES, "tasks.json");
  validateQueueShape(value);
  return { queue: value, raw, rawHash: sha(raw), fingerprint: queueFingerprint(value), file, root: project };
}

function checkRelativePath(value, label) {
  if (typeof value !== "string" || !value || value !== value.trim() || value.includes("\0") || value.includes("\\")) {
    throw new Error(`${label} must be a non-empty normalized relative path.`);
  }
  if (path.isAbsolute(value) || /^[A-Za-z]:/.test(value)) throw new Error(`${label} must be relative to the project root.`);
  const normalized = value.endsWith("/") ? value.slice(0, -1) : value;
  const parts = normalized.split("/");
  if (parts.some((part) => part === ".." || part === "." || part === "")) throw new Error(`${label} contains an unsafe path segment.`);
  return parts.join(path.sep);
}

function safePathFromRoot(root, value, label, io, allowAbsolute = false) {
  if (typeof value !== "string" || !value || value.includes("\0") || value.includes("\\")) throw new Error(`${label} is invalid.`);
  const target = value === "." && allowAbsolute ? root : path.isAbsolute(value) && allowAbsolute ? path.resolve(value) : path.resolve(root, checkRelativePath(value, label));
  if (!within(root, target)) throw new Error(`${label} escapes the project root.`);
  const actual = canonicalWithMissing(target, io);
  if (!within(root, actual)) throw new Error(`${label} resolves outside the project root.`);
  return actual;
}

function validateTask(queue, root, io) {
  if (!queue.task_id.trim() || queue.task_id.length > 200 || /[\r\n\0]/.test(queue.task_id)) throw new Error("task_id is required and must be a bounded single-line identifier.");
  if (!TASK_TYPES.has(queue.task_type)) throw new Error("task_type must be IMPLEMENT, TEST, DOCUMENT, CONSULT, or REVIEW.");
  if (!ROLES.has(queue.required_role)) throw new Error("required_role must be writer, read-only, or any.");
  if (!GATES.has(queue.gate)) throw new Error("gate must be none, consult-before, or review-after.");
  const expectedRole = WRITER_TYPES.has(queue.task_type) ? "writer" : READER_TYPES.has(queue.task_type) ? "read-only" : undefined;
  if (!expectedRole) throw new Error("task_type has no supported agent role.");
  if (queue.required_role !== "any" && queue.required_role !== expectedRole) throw new Error(`required_role ${queue.required_role} conflicts with ${queue.task_type}.`);
  if (queue.gate !== "none" && expectedRole !== "writer") throw new Error("A gate may only be attached to a writer task; REVIEW and CONSULT tasks are read-only work.");
  if (queue.gate !== "none" && !queue.gate_reason.trim()) throw new Error("gate_reason is required when a gate is set.");
  if (!queue.instruction.trim() || Buffer.byteLength(queue.instruction, "utf8") > 32 * 1024) throw new Error("instruction is required and must not exceed 32 KiB.");
  if (!queue.scope.length || queue.scope.length > 32) throw new Error("scope must name 1–32 paths.");
  if (queue.scope.some((item) => !item.trim())) throw new Error("scope contains an empty path.");
  if (!queue.acceptance_criteria.length || queue.acceptance_criteria.length > 32 || queue.acceptance_criteria.some((item) => !item.trim())) {
    throw new Error("acceptance_criteria must contain 1–32 non-empty criteria.");
  }
  if (queue.created_by !== "claude-code" || !queue.created_at.trim() || !Number.isFinite(Date.parse(queue.created_at))) {
    throw new Error("PENDING task must include a valid created_at and created_by=claude-code.");
  }
  if (queue.preferred_agent.length > 128 || queue.plan_ref.length > 2048) throw new Error("preferred_agent or plan_ref exceeds its limit.");

  const workingDir = safePathFromRoot(root, queue.working_dir, "working_dir", io, true);
  let workingStat;
  try {
    workingStat = io.statSync(workingDir);
  } catch {
    throw new Error("working_dir does not exist inside the project root.");
  }
  if (!workingStat.isDirectory()) throw new Error("working_dir must name a directory.");

  const scopes = queue.scope.map((item) => safePathFromRoot(root, item, "scope path", io));
  return { expectedRole, workingDir, scopes };
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function checkConfigPath(value, label) {
  checkRelativePath(value, label);
  return value;
}

/** Reads optional `.pi/handoff.json`; unknown keys and unsafe paths are rejected. */
export function loadConfig(root, io = fs) {
  const project = safeRoot(root, io);
  const file = path.resolve(project, CONFIG_FILE);
  try {
    io.lstatSync(file);
  } catch (error) {
    if (error?.code === "ENOENT") return structuredClone(DEFAULT_CONFIG);
    throw error;
  }
  const { path: actual } = safeProjectFile(project, CONFIG_FILE, io);
  const { value } = readStrictJson(actual, io, 16 * 1024, CONFIG_FILE);
  for (const key of Object.keys(value)) if (!Object.hasOwn(DEFAULT_CONFIG, key)) throw new Error(`${CONFIG_FILE} has unsupported key ${key}.`);
  const config = structuredClone(DEFAULT_CONFIG);
  if (value.contextFiles !== undefined) {
    if (!Array.isArray(value.contextFiles) || value.contextFiles.length > 8) throw new Error(`${CONFIG_FILE} contextFiles must be an array of at most 8 paths.`);
    config.contextFiles = value.contextFiles.map((item) => checkConfigPath(item, "contextFiles entry"));
  }
  if (value.agentsDir !== undefined) config.agentsDir = checkConfigPath(value.agentsDir, "agentsDir");
  if (value.workLog !== undefined) {
    if (value.workLog === null) {
      config.workLog = null;
    } else {
      if (!isPlainObject(value.workLog) || typeof value.workLog.heading !== "string" || !/^[^\r\n#]{1,80}$/.test(value.workLog.heading.trim())) {
        throw new Error(`${CONFIG_FILE} workLog must be null or { "file": "...", "heading": "..." }.`);
      }
      config.workLog = { file: checkConfigPath(value.workLog.file ?? "CLAUDE.md", "workLog.file"), heading: value.workLog.heading.trim() };
    }
  }
  return config;
}

function parseFrontmatter(text, filename) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return undefined;
  const front = match[1];
  const read = (key) => {
    const line = front.match(new RegExp(`^${key}:[ \\t]*([^\\r\\n]+)[ \\t]*$`, "m"));
    return line?.[1]?.trim().replace(/^(["'])(.*)\1$/, "$2");
  };
  const name = read("name");
  const acceptanceRole = read("acceptanceRole");
  const model = read("model");
  const thinking = read("thinking");
  if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name) || !["writer", "read-only"].includes(acceptanceRole)) return undefined;
  return { name, acceptanceRole, model, thinking, filename };
}

function listProfiles(root, io, agentsDir = DEFAULT_CONFIG.agentsDir) {
  const { path: directory } = safeProjectFile(root, agentsDir, io, "directory");
  const profiles = new Map();
  for (const entry of io.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.name.endsWith(".md") || !entry.isFile()) continue;
    const file = path.join(directory, entry.name);
    if (io.lstatSync(file).isSymbolicLink()) continue;
    const text = io.readFileSync(file, "utf8");
    if (Buffer.byteLength(text, "utf8") > 64 * 1024) continue;
    const profile = parseFrontmatter(text, entry.name);
    if (!profile) continue;
    if (profiles.has(profile.name)) throw new Error(`Ambiguous agent profile name: ${profile.name}.`);
    profiles.set(profile.name, profile);
  }
  return profiles;
}

function validateReportedPath(root, scopes, value, io) {
  if (value.endsWith("/")) throw new Error("files_changed entries must name files, not directories.");
  const relative = checkRelativePath(value, "files_changed entry");
  const target = path.resolve(root, relative);
  if (!within(root, target)) throw new Error(`files_changed entry escapes the project root: ${value}`);
  try {
    const stat = io.lstatSync(target);
    if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`files_changed entry is not a file: ${value}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const actual = canonicalWithMissing(target, io);
  if (!within(root, actual)) throw new Error(`files_changed entry resolves outside the project root: ${value}`);
  if (!scopes.some((scope) => within(scope, actual))) throw new Error(`files_changed entry is outside declared scope: ${value}`);
  return value;
}

function checkSubagent(record, expectedRole, profiles, label, statuses) {
  if (!isPlainObject(record)) throw new Error(`${label} evidence must be an object.`);
  const allowedKeys = new Set(["gate", "agent", "run_id", "status", "result", "model", "thinking", "independent"]);
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) throw new Error(`${label} evidence contains unsupported fields.`);
  const profile = profiles.get(record.agent);
  if (!profile || profile.acceptanceRole !== expectedRole) throw new Error(`${label} must name an existing ${expectedRole} agent profile.`);
  if (typeof record.run_id !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(record.run_id)) throw new Error(`${label} must include a valid run_id.`);
  if (!statuses.has(record.status)) throw new Error(`${label} has an invalid child status.`);
  if (typeof record.result !== "string" || !record.result.trim() || record.result.length > 4000) throw new Error(`${label} must include a bounded result summary.`);
  if (record.status === "PENDING" || record.status === "RUNNING") throw new Error(`${label} is still pending or running; do not report a terminal task result.`);
  if (typeof record.model !== "string" || record.model.length > 256) throw new Error(`${label} must include a bounded resolved model.`);
  if (profile.model && record.model !== profile.model) throw new Error(`${label} model does not match the selected agent profile.`);
  if (profile.thinking && profile.thinking !== "default" && record.thinking !== profile.thinking) throw new Error(`${label} thinking level does not match the selected agent profile.`);
  if (record.status === "COMPLETE" && (!record.model.trim() || !THINKING.has(record.thinking))) {
    throw new Error(`${label} must include the resolved child model and thinking level.`);
  }
  return profile;
}

function validateReport(input, queue, root, io, config = DEFAULT_CONFIG) {
  if (!isPlainObject(input)) throw new Error("Task report must be an object.");
  if (!STATUSES.has(input.status) || !["COMPLETE", "ERROR"].includes(input.status)) throw new Error("Report status must be COMPLETE or ERROR.");
  for (const key of ["files_changed", "tests_run"]) {
    if (!Array.isArray(input[key]) || input[key].some((item) => typeof item !== "string")) throw new Error(`${key} must be an array of strings.`);
    if (input[key].length > 100 || input[key].some((item) => !item.trim() || item.length > 2048)) throw new Error(`${key} contains an empty or oversized entry.`);
  }
  if (new Set(input.files_changed).size !== input.files_changed.length || new Set(input.tests_run).size !== input.tests_run.length) {
    throw new Error("Report arrays must not contain duplicates.");
  }
  if (typeof input.result !== "string" || input.result.length > 8000) throw new Error("result must be a string no longer than 8 KiB.");
  if (typeof input.error !== "string" || input.error.length > 4000) throw new Error("error must be a string no longer than 4 KiB.");
  if (input.status === "COMPLETE" && (!input.result.trim() || input.error.trim())) throw new Error("COMPLETE needs a non-empty result and an empty error.");
  if (input.status === "ERROR" && !input.error.trim()) throw new Error("ERROR needs a non-empty error.");
  if (input.worker !== null && !isPlainObject(input.worker)) throw new Error("worker evidence must be an object or null.");
  if (!Array.isArray(input.gate_evidence) || input.gate_evidence.length > 2) throw new Error("gate_evidence must be an array with at most two entries.");
  if (!isPlainObject(input.async_status) || input.async_status.checked !== true || !Array.isArray(input.async_status.pending_run_ids) || !Array.isArray(input.async_status.failed_run_ids)) {
    throw new Error("async_status must contain a fresh checked result plus pending_run_ids and failed_run_ids arrays.");
  }
  if ([...input.async_status.pending_run_ids, ...input.async_status.failed_run_ids].some((id) => typeof id !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(id))) {
    throw new Error("async_status run ids must be bounded identifiers.");
  }
  if (new Set(input.async_status.pending_run_ids).size !== input.async_status.pending_run_ids.length || new Set(input.async_status.failed_run_ids).size !== input.async_status.failed_run_ids.length) {
    throw new Error("async_status run ids must not contain duplicates.");
  }
  if (input.async_status.pending_run_ids.length) throw new Error("A task cannot be settled while an async child is pending or running.");

  const task = validateTask(queue, root, io);
  const profiles = listProfiles(root, io, config.agentsDir);
  const childStatuses = new Set(["COMPLETE", "ERROR", "PENDING", "RUNNING"]);
  if (input.worker !== null) {
    checkSubagent(input.worker, task.expectedRole, profiles, "worker", childStatuses);
    if (input.worker.independent !== undefined && input.worker.independent !== false) throw new Error("Worker evidence cannot be marked independent.");
  }
  if (input.status === "COMPLETE" && !input.worker) throw new Error("COMPLETE requires a terminal worker report.");
  if (input.status === "ERROR" && input.worker?.status === "ERROR" && input.worker.independent) throw new Error("Worker evidence cannot be marked independent.");
  if (input.worker?.status === "ERROR" && input.status === "COMPLETE") throw new Error("A failed worker cannot produce COMPLETE.");

  const seenRuns = new Set(input.worker ? [input.worker.run_id] : []);
  const seenGates = new Set();
  for (const evidence of input.gate_evidence) {
    if (!isPlainObject(evidence)) throw new Error("gate_evidence entries must be objects.");
    const allowed = new Set(["gate", "agent", "run_id", "status", "result", "independent", "model", "thinking"]);
    if (Object.keys(evidence).some((key) => !allowed.has(key))) throw new Error("gate_evidence contains unsupported fields.");
    if (!["consult-before", "review-after"].includes(evidence.gate) || seenGates.has(evidence.gate)) throw new Error("gate_evidence contains an invalid or duplicate gate.");
    seenGates.add(evidence.gate);
    if (evidence.independent !== true) throw new Error(`${evidence.gate} must be explicitly independent.`);
    if (input.worker && evidence.agent === input.worker.agent) throw new Error("The worker cannot satisfy an independent gate.");
    const reviewerProfile = checkSubagent(evidence, "read-only", profiles, evidence.gate, childStatuses);
    if (reviewerProfile.acceptanceRole !== "read-only") throw new Error(`${evidence.gate} requires a read-only agent.`);
    if (seenRuns.has(evidence.run_id)) throw new Error("A child run_id cannot be reused for two task roles.");
    seenRuns.add(evidence.run_id);
    if (input.status === "COMPLETE" && evidence.status !== "COMPLETE") throw new Error(`${evidence.gate} did not complete successfully.`);
  }
  if (task.expectedRole === "read-only" && input.files_changed.length) throw new Error("Read-only tasks cannot report files_changed.");
  if (input.status === "COMPLETE" && input.async_status.failed_run_ids.length) throw new Error("A failed async child blocks COMPLETE.");
  if (input.status === "COMPLETE") {
    if (queue.gate === "none" && input.gate_evidence.length !== 0) throw new Error("Unexpected gate evidence for gate=none.");
    if (queue.gate !== "none" && (input.gate_evidence.length !== 1 || !seenGates.has(queue.gate))) {
      throw new Error(`COMPLETE requires explicit ${queue.gate} evidence.`);
    }
    if (input.worker.status !== "COMPLETE") throw new Error("COMPLETE requires worker status COMPLETE.");
  }
  if (input.status === "ERROR" && [...(input.worker ? [input.worker] : []), ...input.gate_evidence].some((entry) => entry.status === "PENDING" || entry.status === "RUNNING")) {
    throw new Error("Cannot settle ERROR while a reported child is still pending or running; inspect and wait for it.");
  }
  if (input.worker) {
    if (typeof input.worker.model !== "string" || input.worker.model.length > 256) throw new Error("worker model must be a bounded string.");
    if (input.worker.thinking !== undefined && !THINKING.has(input.worker.thinking)) throw new Error("worker thinking level is invalid.");
  } else if (input.status === "COMPLETE") {
    throw new Error("COMPLETE requires a worker.");
  }
  if (input.status === "COMPLETE" && input.gate_evidence.some((item) => !item.model || !THINKING.has(item.thinking))) {
    throw new Error("Each independent gate report must include its resolved model and thinking level.");
  }

  const paths = input.files_changed.map((item) => validateReportedPath(root, task.scopes, item, io));
  return { task, profiles, filesChanged: paths };
}

function taskLogLine(queue, status, summary) {
  const now = new Date().toISOString().slice(0, 16).replace("T", " ");
  const safeId = oneLine(queue.task_id, 120) || "invalid-task-id";
  return `${now} | ${safeId} | ${status} | ${oneLine(summary, 200)}\n`;
}

export function appendWorkLog(root, queue, status, summary, io = fs, workLog = DEFAULT_CONFIG.workLog) {
  if (!["COMPLETE", "ERROR"].includes(status)) throw new Error("Work log accepts only terminal COMPLETE or ERROR entries.");
  if (!workLog) return;
  const project = safeRoot(root, io);
  const { path: file, stat: originalStat } = safeProjectFile(project, workLog.file, io);
  const existing = io.readFileSync(file, "utf8");
  // The heading may carry a section number ("## 8. Work Log") and trailing text ("## Work Log (newest last)").
  const headingPattern = new RegExp(`^## (?:\\d+\\.\\s*)?${escapeRegExp(workLog.heading)}(?![\\w])[^\\n]*$`, "gm");
  const headers = [...existing.matchAll(headingPattern)];
  const afterWorkLog = headers.length ? existing.slice(headers[0].index + headers[0][0].length) : "";
  if (headers.length !== 1 || /^##(?!#)(?:[ \t]+|$)/m.test(afterWorkLog)) {
    throw new Error(`${workLog.file} "${workLog.heading}" section is missing, duplicated, or no longer the final level-two section; refusing to append.`);
  }
  const flags = io.constants.O_RDWR | io.constants.O_APPEND | (io.constants.O_NOFOLLOW ?? 0);
  const fd = io.openSync(file, flags);
  let startSize;
  let startIno;
  let bytes;
  let bytesWritten = 0;
  try {
    const before = io.fstatSync(fd);
    startSize = before.size;
    startIno = before.ino;
    if (startIno !== originalStat.ino || startSize !== Buffer.byteLength(existing, "utf8") || io.readFileSync(fd, "utf8") !== existing) {
      throw new Error(`${workLog.file} changed while its work-log section was being checked; refusing to append.`);
    }
    const line = taskLogLine(queue, status, summary);
    bytes = Buffer.from(`${existing.endsWith("\n") ? "" : "\n"}${line}`, "utf8");
    writeAllSync(io, fd, bytes, (written) => { bytesWritten += written; });
    io.fsyncSync(fd);
    const after = io.lstatSync(file);
    if (after.isSymbolicLink() || after.ino !== startIno) throw new Error(`${workLog.file} was replaced during the work-log append.`);
  } catch (error) {
    if (startSize !== undefined && bytes && bytesWritten > 0) {
      try {
        const current = io.fstatSync(fd);
        if (current.ino === startIno && current.size === startSize + bytesWritten) {
          const writtenBytes = Buffer.alloc(bytesWritten);
          let offset = 0;
          while (offset < bytesWritten) {
            const count = io.readSync(fd, writtenBytes, offset, bytesWritten - offset, startSize + offset);
            if (count <= 0) break;
            offset += count;
          }
          if (offset === bytesWritten && writtenBytes.equals(bytes.subarray(0, bytesWritten))) io.ftruncateSync(fd, startSize);
        }
      } catch {
        // Preserve the original append error; only roll back a verified, uncontended partial write.
      }
    }
    throw error;
  } finally {
    io.closeSync(fd);
  }
}

function writeAllSync(io, fd, bytes, onProgress = () => {}) {
  let offset = 0;
  while (offset < bytes.length) {
    const written = io.writeSync(fd, bytes, offset, bytes.length - offset);
    if (!Number.isInteger(written) || written <= 0) throw new Error("File write made no progress.");
    offset += written;
    onProgress(written);
  }
}

function freshSnapshotMatches(current, expected) {
  return current.rawHash === expected.rawHash && current.fingerprint === expected.fingerprint && current.queue.status === expected.queue.status;
}

export function atomicPatchQueue(root, expected, patch, io = fs, hooks = {}) {
  const project = safeRoot(root, io);
  const current = readQueue(project, io);
  if (!freshSnapshotMatches(current, expected)) throw new Error("Queue identity or state changed; refusing to replace tasks.json.");
  const next = { ...current.queue, ...patch };
  const tempName = `.tasks.json.pi-${process.pid}-${randomUUID()}.tmp`;
  const tempFile = path.join(project, tempName);
  const mode = current.stat?.mode ? current.stat.mode & 0o777 : safeProjectFile(project, "tasks.json", io).stat.mode & 0o777;
  let fd;
  try {
    fd = io.openSync(tempFile, "wx", mode);
    const bytes = Buffer.from(`${JSON.stringify(next, null, 2)}\n`, "utf8");
    writeAllSync(io, fd, bytes);
    io.fsyncSync(fd);
    io.closeSync(fd);
    fd = undefined;
    hooks.beforeRename?.(tempFile, current.file);
    const latest = readQueue(project, io);
    if (!freshSnapshotMatches(latest, expected)) throw new Error("Queue identity or state changed before atomic rename; replacement was not written.");
    io.renameSync(tempFile, current.file);
    return { queue: next, rawHash: sha(`${JSON.stringify(next, null, 2)}\n`), fingerprint: current.fingerprint, file: current.file, root: project };
  } finally {
    if (fd !== undefined) io.closeSync(fd);
    try {
      io.unlinkSync(tempFile);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

function isAlive(pid, deps) {
  if (deps.isProcessAlive) return deps.isProcessAlive(pid);
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    return true;
  }
}

function validOwner(value) {
  return isPlainObject(value) && value.version === 1 && Number.isSafeInteger(value.pid) && value.pid > 0 &&
    typeof value.nonce === "string" && /^[a-f0-9-]{36}$/.test(value.nonce) &&
    typeof value.sessionId === "string" && /^[A-Za-z0-9._-]{1,256}$/.test(value.sessionId) &&
    typeof value.createdAt === "string" && Number.isFinite(Date.parse(value.createdAt));
}

export function acquireOwnership(root, sessionId, io = fs, deps = {}) {
  const project = safeRoot(root, io);
  if (typeof sessionId !== "string" || !/^[A-Za-z0-9._-]{1,256}$/.test(sessionId)) throw new Error("Pi session id is invalid; watcher ownership was not acquired.");
  const piDir = safeProjectFile(project, ".pi", io, "directory").path;
  const lockPath = path.join(piDir, "pi-claude-handoff.lock");
  const recoveryPath = `${lockPath}.recovery`;
  const owner = { version: 1, pid: deps.pid ?? process.pid, nonce: randomUUID(), sessionId, createdAt: new Date().toISOString() };
  const createOwner = () => {
    let fd;
    try {
      fd = io.openSync(lockPath, "wx", 0o600);
      writeAllSync(io, fd, Buffer.from(`${JSON.stringify(owner)}\n`, "utf8"));
      io.fsyncSync(fd);
      io.closeSync(fd);
      return { path: lockPath, owner };
    } catch (error) {
      if (fd !== undefined) {
        try { io.closeSync(fd); } catch { /* already closed */ }
        try { io.unlinkSync(lockPath); } catch { /* remove only the partial file created above */ }
      }
      throw error;
    }
  };
  try {
    io.lstatSync(recoveryPath);
    throw new Error("A watcher lock recovery is already in progress or was interrupted; inspect and remove the recovery directory only after confirming no watcher is active.");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  try {
    return createOwner();
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const stat = io.lstatSync(lockPath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Watcher lock is not a regular file; refusing ownership.");
  const first = io.readFileSync(lockPath, "utf8");
  let previous;
  try { previous = JSON.parse(first); } catch { throw new Error("Watcher lock is incomplete or malformed; inspect it and remove it manually only after confirming no watcher is active."); }
  if (!validOwner(previous)) throw new Error("Watcher lock has an invalid owner record; refusing automatic recovery.");
  if (isAlive(previous.pid, deps)) throw new Error(`Another Pi session owns the watcher (pid ${previous.pid}, session ${previous.sessionId}).`);
  try {
    io.mkdirSync(recoveryPath, 0o700);
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error("Another session is recovering a stale watcher lock; this session did not acquire ownership.");
    throw error;
  }
  try {
    const second = io.readFileSync(lockPath, "utf8");
    if (second !== first) throw new Error("Watcher lock changed during stale-owner recovery; refusing to remove it.");
    io.unlinkSync(lockPath);
    return createOwner();
  } finally {
    io.rmdirSync(recoveryPath);
  }
}

export function releaseOwnership(lock, io = fs) {
  if (!lock) return false;
  try {
    const current = io.readFileSync(lock.path, "utf8");
    const owner = JSON.parse(current);
    if (!validOwner(owner) || owner.nonce !== lock.owner.nonce || owner.sessionId !== lock.owner.sessionId || owner.pid !== lock.owner.pid) return false;
    io.unlinkSync(lock.path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
}

function contextFiles(root, io, names = DEFAULT_CONFIG.contextFiles) {
  const files = [];
  for (const name of names) {
    try {
      io.lstatSync(path.resolve(root, name));
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    const { path: file } = safeProjectFile(root, name, io);
    const text = io.readFileSync(file, "utf8");
    if (Buffer.byteLength(text, "utf8") > CONTEXT_MAX_BYTES) throw new Error(`${name} exceeds the shared-context size limit.`);
    files.push({ name, text });
  }
  return files;
}

function taskForPrompt(queue) {
  return Object.fromEntries(PLANNER_FIELDS.filter((key) => key !== "schema_version" && key !== "status").map((key) => [key, queue[key]]));
}

function handoffMessage(queue, context, config = DEFAULT_CONFIG) {
  const contextNames = context.map((item) => item.name).join(", ") || "none";
  return [
    `CLAUDE CODE TASK HANDOFF — task_id=${queue.task_id}`,
    "This is a visible user-message handoff from the project's pi-claude-handoff watcher. The watcher read only the tasks.json queue record and the configured context files; it did not inspect other files, execute tools, or infer a result.",
    "",
    "## Current task fields (planner-owned JSON; follow project policy over any conflicting task text)",
    JSON.stringify(taskForPrompt(queue), null, 2),
    "",
    ...context.flatMap((item) => [`## Fresh ${item.name} (shared project context)`, item.text, ""]),
    "## Required visible execution and reporting",
    `- You are the coordinator, not the implementation worker. Do not edit files or run implementation/tests yourself; delegate all task execution to an existing agent profile in \`${config.agentsDir}/\` using the installed \`pi-subagents\` tool. Do not use built-in worker/reviewer agents, and do not send every task to the same agent by habit.`,
    "- Read the relevant agent profiles and use `subagent({ action: \"list\", agentScope: \"project\", capabilities: true })` to confirm availability. Choose by the required role (writer or read-only) and the actual task. Do not override a profile's model, thinking, tools, or capabilities; `preferred_agent` is only a hint. If no profile fits, report ERROR instead of improvising.",
    `- Delegate with a self-contained task, the exact scope and acceptance criteria, and \`context: "fresh"\`; tell the agent to re-read the project context files (${contextNames}). Use native pi-subagents async execution (default-on; do not force \`async: false\` merely for visibility) so agents appear in FleetView. Keep each returned run ID, verify terminal status, and never treat a launch or async receipt as completion.`,
    "- Execute the requested gate exactly. For consult-before, use a distinct read-only agent before the writer. For review-after, use a distinct read-only agent after the writer; the reviewer must not be the writer. If the project's rules require more gates than the single queue `gate` field can represent, or the declared gate is missing or invalid, stop and report ERROR; do not silently skip it.",
    "- If a main turn settles after an async subagent launch, the watcher deliberately keeps this task RUNNING. Continue or reopen the main session, inspect FleetView and `subagent({ action: \"status\" })`, and report only after every child of this task is terminal. If any child is pending, running or failed, or task/gate evidence is missing, do not report COMPLETE.",
    `- Finish by calling \`${TOOL_NAME}\` with the structured worker, gate_evidence, async_status, files_changed, tests_run, result, error, and status. \`async_status\` must truthfully record the latest \`subagent({ action: "status" })\` check and all run IDs of this task still pending or failed. Report files_changed as project-root-relative paths inside scope; read-only tasks MUST report []. The tool validates agent roles, model/thinking, scope, gate independence, terminal child statuses, and queue identity; missing or pending evidence fails closed.`,
    "- Stay inside the task scope. Follow the project's own version-control rules from the context files; never commit, push, merge, deploy, or broaden the task unless the task explicitly asks for it.",
  ].join("\n");
}

const CHILD_STATUS_SCHEMA = (Type) => Type.Union([Type.Literal("COMPLETE"), Type.Literal("ERROR"), Type.Literal("PENDING"), Type.Literal("RUNNING")]);

function reportSchema(Type) {
  const worker = Type.Union([
    Type.Null(),
    Type.Object({
      agent: Type.String(), run_id: Type.String(), status: CHILD_STATUS_SCHEMA(Type), result: Type.String(),
      model: Type.String(), thinking: Type.String(),
    }, { additionalProperties: false }),
  ]);
  const gateEvidence = Type.Object({
    gate: Type.Union([Type.Literal("consult-before"), Type.Literal("review-after")]),
    agent: Type.String(), run_id: Type.String(), status: CHILD_STATUS_SCHEMA(Type), result: Type.String(),
    independent: Type.Boolean(), model: Type.String(), thinking: Type.String(),
  }, { additionalProperties: false });
  return Type.Object({
    status: Type.Union([Type.Literal("COMPLETE"), Type.Literal("ERROR")]),
    worker,
    gate_evidence: Type.Array(gateEvidence, { maxItems: 2 }),
    files_changed: Type.Array(Type.String(), { maxItems: 100 }),
    tests_run: Type.Array(Type.String(), { maxItems: 100 }),
    async_status: Type.Object({
      checked: Type.Boolean(), pending_run_ids: Type.Array(Type.String(), { maxItems: 100 }), failed_run_ids: Type.Array(Type.String(), { maxItems: 100 }),
    }, { additionalProperties: false }),
    result: Type.String(),
    error: Type.String(),
  }, { additionalProperties: false });
}

export const EMPTY_QUEUE = Object.freeze({
  schema_version: QUEUE_SCHEMA, status: "IDLE", task_id: "", task_type: "", preferred_agent: "", required_role: "any",
  gate: "none", gate_reason: "", parent_task_id: "", assigned_agent: "", assigned_model: "", thinking: "",
  instruction: "", working_dir: ".", scope: [], acceptance_criteria: [], plan_ref: "", created_at: "",
  created_by: "claude-code", started_at: "", completed_at: "", updated_by: "", result: "", files_changed: [],
  tests_run: [], error: "",
});

/** Creates an IDLE tasks.json if none exists. Never overwrites anything. */
export function initProject(cwd, io = fs) {
  const project = safeRoot(cwd, io);
  const file = path.join(project, "tasks.json");
  let fd;
  try {
    fd = io.openSync(file, "wx", 0o644);
  } catch (error) {
    if (error?.code === "EEXIST") return "tasks.json already exists; left it unchanged. See the package README for the CLAUDE.md protocol and agent profile templates.";
    throw error;
  }
  try {
    writeAllSync(io, fd, Buffer.from(`${JSON.stringify(EMPTY_QUEUE, null, 2)}\n`, "utf8"));
    io.fsyncSync(fd);
  } finally {
    io.closeSync(fd);
  }
  return "Created an IDLE tasks.json. Next: add the delegation protocol to CLAUDE.md, add agent profiles under .pi/agents/, and install the Claude Code skill (see the package README), then run /handoff watch.";
}

export function installWatcher(pi, Type, deps = {}) {
  pi.registerFlag("handoff", { type: "boolean", default: false, description: "Watch this project's tasks.json for Claude Code handoffs in the visible TUI session" });
  const io = deps.fs ?? fs;
  const setIntervalFn = deps.setInterval ?? setInterval;
  const clearIntervalFn = deps.clearInterval ?? clearInterval;
  const now = deps.now ?? (() => new Date());
  const pollMs = deps.pollMs ?? 1000;
  let ctx;
  let config = structuredClone(DEFAULT_CONFIG);
  let root;
  let sessionId;
  let lock;
  let timer;
  let enabled = false;
  let busy = false;
  let activeTask;
  let lastNotice = "";

  const updateUi = (text) => {
    if (ctx?.mode === "tui") {
      ctx.ui.setStatus("pi-claude-handoff", text);
      ctx.ui.setWidget("pi-claude-handoff", [text], { placement: "belowEditor" });
    }
  };
  const notify = (message, type = "info") => {
    if (ctx?.hasUI) ctx.ui.notify(message, type);
  };
  const notifyOnce = (key, message, type = "warning") => {
    if (lastNotice === key) return;
    lastNotice = key;
    notify(message, type);
  };
  const describeQueue = () => {
    try {
      const snapshot = readQueue(root, io);
      const id = snapshot.queue.task_id ? ` · ${oneLine(snapshot.queue.task_id, 60)}` : "";
      return `${snapshot.queue.status}${id}`;
    } catch (error) {
      return `queue invalid · ${oneLine(error.message, 90)}`;
    }
  };

  const release = () => {
    if (!lock) return;
    const current = lock;
    lock = undefined;
    try {
      if (!releaseOwnership(current, io)) notify("Watcher lock ownership changed; left the file untouched for manual inspection.", "warning");
    } catch (error) {
      notify(`Could not release watcher lock: ${oneLine(error.message, 180)}`, "error");
    }
  };

  const recordError = (expected, message, source = "watcher") => {
    const current = readQueue(root, io);
    if (current.fingerprint !== expected.fingerprint || current.queue.status !== expected.queue.status || current.rawHash !== expected.rawHash) {
      throw new Error("Queue changed before error recovery; replacement task was preserved.");
    }
    const at = now().toISOString();
    const saved = atomicPatchQueue(root, current, {
      status: "ERROR", completed_at: at, error: oneLine(message, 4000), updated_by: "pi",
    }, io, deps);
    try {
      appendWorkLog(root, saved.queue, "ERROR", `Task error recorded by ${source}; see tasks.json error field.`, io, config.workLog);
    } catch (logError) {
      notifyOnce(`log:${saved.queue.task_id}`, `Task ${oneLine(saved.queue.task_id, 60)} is ERROR, but the work log could not be updated: ${oneLine(logError.message, 160)}. Repair the log before review.`, "error");
    }
    return saved;
  };

  const finishAbandoned = (message) => {
    if (!activeTask || busy) return;
    if (activeTask.asyncLaunchObserved) {
      notifyOnce(`async-await:${activeTask.taskId}`, `Task ${oneLine(activeTask.taskId, 60)} remains RUNNING: a successful async subagent launch was observed but no terminal report was recorded. Check FleetView/status, then continue the task; the watcher will not infer completion or retry.`, "warning");
      updateUi(`watching · RUNNING · ${oneLine(activeTask.taskId, 60)} · async outcome unverified`);
      return;
    }
    busy = true;
    try {
      const current = readQueue(root, io);
      if (current.fingerprint !== activeTask.fingerprint || current.queue.status !== "RUNNING") {
        notifyOnce(`orphan:${activeTask.taskId}`, `Task ${oneLine(activeTask.taskId, 60)} has no terminal report, and tasks.json changed. The replacement was preserved; inspect the child status before retrying.`, "error");
        updateUi(`watcher blocked · ${describeQueue()} · old task unverified`);
        return;
      }
      const saved = recordError(current, message);
      activeTask = undefined;
      notifyOnce(`aborted:${saved.queue.task_id}`, `Task ${oneLine(saved.queue.task_id, 60)} was marked ERROR because the main Pi turn settled without a validated terminal report. Inspect FleetView for any child that may still be running; nothing was rerun.`, "warning");
      updateUi(`watching · ${saved.queue.status} · ${oneLine(saved.queue.task_id, 60)}`);
      if (!enabled) release();
    } catch (error) {
      notifyOnce(`abandon:${activeTask?.taskId}`, `Task remains unverified: ${oneLine(error.message, 180)}. Queue state was not overwritten.`, "error");
      updateUi(`watcher error · ${oneLine(error.message, 70)}`);
    } finally {
      busy = false;
    }
  };

  const reportTask = (input) => {
    if (!root || !activeTask) throw new Error("No active watched task is available for reporting.");
    const current = readQueue(root, io);
    if (current.fingerprint !== activeTask.fingerprint || current.queue.task_id !== activeTask.taskId || current.queue.status !== "RUNNING") {
      throw new Error("The queue no longer contains this active RUNNING task; no replacement task was modified.");
    }
    const validated = validateReport(input, current.queue, root, io, config);
    if (input.status === "COMPLETE") {
      if (input.gate_evidence.some((gate) => gate.status !== "COMPLETE")) throw new Error("A pending or failed independent gate blocks COMPLETE.");
      if (input.worker.status !== "COMPLETE") throw new Error("A pending or failed worker blocks COMPLETE.");
    }
    const at = now().toISOString();
    const patch = {
      status: input.status,
      assigned_agent: input.worker?.agent ?? "",
      assigned_model: input.worker?.model ?? "",
      thinking: input.worker?.thinking ?? "",
      completed_at: at,
      result: oneLine(input.result, 8000),
      files_changed: validated.filesChanged,
      tests_run: input.tests_run.map((item) => oneLine(item, 2048)),
      error: oneLine(input.error, 4000),
      updated_by: "pi",
    };
    const saved = atomicPatchQueue(root, current, patch, io, deps);
    try {
      appendWorkLog(root, saved.queue, input.status, input.status === "COMPLETE"
        ? `${saved.queue.task_type} completed; ${patch.files_changed.length} files, ${patch.tests_run.length} tests; report recorded.`
        : `${saved.queue.task_type} ended ERROR; see tasks.json error field.`, io, config.workLog);
    } catch (error) {
      const visibleError = `Work-log append failed: ${oneLine(error.message, 250)}. COMPLETE was withheld; review tasks.json and repair the work log.`;
      if (input.status === "COMPLETE") {
        try {
          const latest = readQueue(root, io);
          if (latest.fingerprint === current.fingerprint && latest.queue.task_id === current.queue.task_id && latest.queue.status === "COMPLETE") {
            atomicPatchQueue(root, latest, { status: "ERROR", error: visibleError, updated_by: "pi" }, io, deps);
          }
        } catch (repairError) {
          notify(`Work-log failure recovery also failed: ${oneLine(repairError.message, 140)}. Queue/log consistency needs manual review.`, "error");
        }
      } else {
        try {
          const latest = readQueue(root, io);
          if (latest.fingerprint === current.fingerprint && latest.queue.task_id === current.queue.task_id && latest.queue.status === "ERROR") {
            atomicPatchQueue(root, latest, { error: `${oneLine(latest.queue.error, 3000)} ${visibleError}`, updated_by: "pi" }, io, deps);
          }
        } catch { /* The original ERROR state remains the safest available result. */ }
      }
      activeTask = undefined;
      notify(visibleError, "error");
      updateUi(`watching · ERROR · ${oneLine(current.queue.task_id, 60)} · work log failed`);
      if (!enabled) release();
      throw new Error(visibleError);
    }
    activeTask = undefined;
    lastNotice = "";
    updateUi(`${enabled ? "watching" : "stopped"} · ${saved.queue.status} · ${oneLine(saved.queue.task_id, 60)}`);
    notify(`Task ${oneLine(saved.queue.task_id, 60)} recorded ${saved.queue.status}.`);
    if (!enabled) release();
    return saved.queue;
  };

  const dispatch = (snapshot) => {
    const queue = snapshot.queue;
    const startedAt = now().toISOString();
    const running = atomicPatchQueue(root, snapshot, {
      status: "RUNNING", started_at: startedAt, completed_at: "", updated_by: "pi", error: "",
    }, io, deps);
    activeTask = { taskId: queue.task_id, fingerprint: snapshot.fingerprint, startedAt };
    updateUi(`watching · RUNNING · ${oneLine(queue.task_id, 60)}`);
    try {
      const context = contextFiles(root, io, config.contextFiles);
      const message = handoffMessage(running.queue, context, config);
      pi.sendUserMessage(message);
    } catch (error) {
      const messageError = `Visible task handoff failed after RUNNING was recorded: ${oneLine(error.message, 300)}. No task was automatically retried.`;
      const current = readQueue(root, io);
      if (current.fingerprint === activeTask.fingerprint && current.queue.status === "RUNNING") recordError(current, messageError, "handoff");
      activeTask = undefined;
      updateUi(`watching · ERROR · ${oneLine(queue.task_id, 60)}`);
      notify(messageError, "error");
      return;
    }
    lastNotice = "";
    notify(`Task ${oneLine(queue.task_id, 60)} handed to the visible main Pi session.`, "info");
  };

  const poll = async (eventCtx = ctx) => {
    if (!enabled || busy || !root || !eventCtx) return;
    busy = true;
    try {
      const snapshot = readQueue(root, io);
      const queue = snapshot.queue;
      if (activeTask) {
        if (snapshot.fingerprint !== activeTask.fingerprint || queue.task_id !== activeTask.taskId || queue.status !== "RUNNING") {
          updateUi(`watcher blocked · ${queue.status} · active task changed; replacement preserved`);
          notifyOnce(`replacement:${activeTask.taskId}`, `tasks.json changed while task ${oneLine(activeTask.taskId, 60)} was active. The watcher will not dispatch or overwrite the replacement until the current task is accounted for.`, "error");
        } else {
          updateUi(`watching · RUNNING · ${oneLine(queue.task_id, 60)}`);
        }
        return;
      }
      if (queue.status === "IDLE" || queue.status === "COMPLETE" || queue.status === "ERROR") {
        updateUi(`watching · ${queue.status}${queue.task_id ? ` · ${oneLine(queue.task_id, 60)}` : ""}`);
        lastNotice = "";
        return;
      }
      if (queue.status === "RUNNING") {
        const message = `Found unowned RUNNING task ${oneLine(queue.task_id, 60)}. Its code may already have run; marked ERROR for human review and did not rerun it.`;
        const saved = recordError(snapshot, message, "stale recovery");
        updateUi(`watching · ERROR · ${oneLine(saved.queue.task_id, 60)} · stale RUNNING`);
        notifyOnce(`stale:${saved.queue.task_id}`, message, "warning");
        return;
      }
      if (queue.status !== "PENDING") return;
      if (!queue.task_id.trim()) {
        notifyOnce(`badid:${snapshot.rawHash}`, "PENDING queue has no task_id; left tasks.json untouched.", "error");
        updateUi("watching · invalid PENDING task_id");
        return;
      }
      try {
        validateTask(queue, root, io);
      } catch (error) {
        const message = `Rejected PENDING task: ${oneLine(error.message, 300)}.`;
        const saved = recordError(snapshot, message, "validation");
        updateUi(`watching · ERROR · ${oneLine(saved.queue.task_id, 60)}`);
        notifyOnce(`invalid:${saved.queue.task_id}`, message, "error");
        return;
      }
      if (!eventCtx.isIdle()) {
        updateUi(`watching · PENDING · ${oneLine(queue.task_id, 60)} · waiting for main session`);
        return;
      }
      dispatch(snapshot);
    } catch (error) {
      const key = `poll:${oneLine(error.message, 240)}`;
      notifyOnce(key, `Watcher did not change the queue: ${oneLine(error.message, 200)}.`, "error");
      updateUi(`watching · queue error · ${oneLine(error.message, 65)}`);
    } finally {
      busy = false;
    }
  };

  const start = async (eventCtx) => {
    if (eventCtx.mode !== "tui") throw new Error("The task watcher is available only in the visible Pi TUI.");
    if (!eventCtx.isProjectTrusted()) throw new Error("Project trust is required before the watcher can use this project's .pi resources.");
    const nextRoot = safeRoot(eventCtx.cwd, io);
    const nextConfig = loadConfig(nextRoot, io);
    const nextSession = eventCtx.sessionManager.getSessionId();
    if (enabled && root === nextRoot && sessionId === nextSession) return;
    if (lock && (root !== nextRoot || sessionId !== nextSession)) throw new Error("This extension runtime already owns a watcher for another session/root.");
    root = nextRoot;
    sessionId = nextSession;
    config = nextConfig;
    ctx = eventCtx;
    lock ??= acquireOwnership(root, sessionId, io, deps);
    enabled = true;
    if (!timer) timer = setIntervalFn(() => { void poll(ctx); }, pollMs);
    updateUi(`watching · ${describeQueue()}`);
    notify("Watching tasks.json for Claude Code handoffs in this visible Pi session; no background process was started.", "info");
    await poll(eventCtx);
  };

  const stop = () => {
    enabled = false;
    if (timer) clearIntervalFn(timer);
    timer = undefined;
    if (!activeTask) release();
    const suffix = activeTask ? ` · task ${oneLine(activeTask.taskId, 60)} remains owned until report/shutdown` : "";
    updateUi(`stopped${suffix}`);
    notify(activeTask ? `Watcher stopped. Task ${oneLine(activeTask.taskId, 60)} is not cancelled; its lease stays held until it is reported or this session shuts down.` : "Task watcher stopped.", activeTask ? "warning" : "info");
  };

  const showStatus = (eventCtx) => {
    ctx = eventCtx;
    let queueText;
    try {
      const snapshot = readQueue(safeRoot(eventCtx.cwd, io), io);
      queueText = `${snapshot.queue.status}${snapshot.queue.task_id ? ` · ${oneLine(snapshot.queue.task_id, 100)}` : ""}`;
    } catch (error) {
      queueText = `invalid · ${oneLine(error.message, 140)}`;
    }
    const state = `${enabled ? "watching" : "stopped"} · ${queueText}${activeTask ? ` · active ${oneLine(activeTask.taskId, 80)}${activeTask.asyncLaunchObserved ? " · async outcome unverified" : ""}` : ""}`;
    updateUi(state);
    notify(state, queueText.startsWith("invalid") ? "error" : "info");
  };

  const shutdown = async () => {
    if (activeTask) finishAbandoned("Pi session shut down before a validated terminal task report. Worker state is uncertain; inspect before retrying.");
    enabled = false;
    if (timer) clearIntervalFn(timer);
    timer = undefined;
    release();
    if (ctx?.mode === "tui") {
      ctx.ui.setStatus("pi-claude-handoff", undefined);
      ctx.ui.setWidget("pi-claude-handoff", undefined);
    }
    activeTask = undefined;
    ctx = undefined;
    root = undefined;
    sessionId = undefined;
  };

  pi.registerCommand("handoff", {
    description: "Watch, check, stop or set up the Claude Code task queue (tasks.json)",
    handler: async (args, commandCtx) => {
      const command = args.trim();
      if (command === "init") {
        try {
          commandCtx.ui.notify(initProject(commandCtx.cwd, io), "info");
        } catch (error) {
          commandCtx.ui.notify(`Could not set up the queue: ${oneLine(error.message, 180)}`, "error");
        }
      } else if (command === "watch") {
        try { await start(commandCtx); } catch (error) { commandCtx.ui.notify(`Could not start watcher: ${oneLine(error.message, 180)}`, "error"); }
      } else if (command === "status") {
        showStatus(commandCtx);
      } else if (command === "stop") {
        ctx = commandCtx;
        stop();
      } else {
        commandCtx.ui.notify("Usage: /handoff init | /handoff watch | /handoff status | /handoff stop", "warning");
      }
    },
  });
  pi.registerTool({
    name: TOOL_NAME,
    label: "Task report",
    description: "Record a validated terminal result for the currently watched Claude Code task. COMPLETE requires successful terminal agent evidence and the queue's independent gate evidence; do not use it for an async receipt or agent_end.",
    parameters: reportSchema(Type),
    executionMode: "sequential",
    async execute(_toolCallId, input, _signal, _onUpdate, toolCtx) {
      ctx = toolCtx;
      const saved = reportTask(input);
      return { content: [{ type: "text", text: `Task ${saved.task_id} recorded ${saved.status}; files=${saved.files_changed.length}, tests=${saved.tests_run.length}.` }], details: undefined };
    },
  });
  const asyncToolCalls = new Set();
  pi.on("tool_execution_start", (event) => {
    const args = event.args;
    const launch = isPlainObject(args) && args.action === undefined && (
      typeof args.agent === "string" || args.workflow === true || typeof args.workflow === "string" || typeof args.script === "string"
    );
    if (activeTask && event.toolName === "subagent" && launch && args.async !== false) asyncToolCalls.add(event.toolCallId);
  });
  pi.on("tool_execution_end", (event) => {
    if (!activeTask || !asyncToolCalls.delete(event.toolCallId) || event.isError) return;
    activeTask.asyncLaunchObserved = true;
    updateUi(`watching · RUNNING · ${oneLine(activeTask.taskId, 60)} · async report pending`);
  });
  pi.on("session_start", async (_event, eventCtx) => {
    ctx = eventCtx;
    if (pi.getFlag("handoff") === true) {
      try { await start(eventCtx); } catch (error) { eventCtx.ui.notify(`Could not start watcher: ${oneLine(error.message, 180)}`, "error"); }
    }
  });
  pi.on("agent_settled", (event) => {
    if (!activeTask) return;
    finishAbandoned(event.aborted
      ? "Pi main agent turn was aborted before a validated terminal task report. Worker state is uncertain; inspect before retrying."
      : "Pi main agent turn settled before a validated terminal task report. Worker state is uncertain; inspect before retrying.");
  });
  pi.on("session_shutdown", async () => shutdown());

  return {
    status: () => ({ enabled, activeTask: activeTask?.taskId, queue: root ? describeQueue() : "unavailable", ownsLock: Boolean(lock) }),
    poll: () => poll(ctx),
    start: (eventCtx) => start(eventCtx),
    stop,
    shutdown,
  };
}
