import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installWatcher } from "./watcher.mjs";

/** pi-claude-handoff: run Claude Code's queued tasks visibly in this Pi session. */
export default function piClaudeHandoff(pi: ExtensionAPI): void {
  installWatcher(pi, Type);
}
