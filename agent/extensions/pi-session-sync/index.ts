/**
 * pi-session-sync — pick up external changes to the current session file.
 *
 * Background: pi sessions are append-only JSONL files. If another process
 * (e.g. a second `pi` spawned by paseo) opens the SAME session file and keeps
 * appending, this pi instance's in-memory view becomes stale and the TUI will
 * not show the new entries on its own.
 *
 * What this extension does:
 *   - Watches the current session file for external changes.
 *   - When it detects entries on disk that this instance does not know about,
 *     it notifies you to run `/sync`.
 *   - `/sync` re-opens the session file from disk via `ctx.switchSession()`,
 *     which reloads the transcript (and the active leaf) into the TUI.
 *
 * Usage:
 *   /sync                 reload the current session from disk
 *
 * Install: place this folder under ~/.pi/agent/extensions/ (already there) and
 * run `/reload` in pi (or restart pi).
 *
 * IMPORTANT LIMITATION (by design, not a bug):
 *   - pi's extension API only exposes the reload-from-disk primitive
 *     (`switchSession`) inside *command* handlers. Extensions cannot
 *     programmatically invoke a command from a background file-watcher
 *     callback, so this extension detects + notifies automatically, but the
 *     actual reload is a one-key `/sync` (or you can bind a key).
 *   - Do NOT type into pi while the external writer (paseo) is mid-turn.
 *     Concurrent writers create two divergent branches in the tree, not a
 *     merge. Sync only makes sense when this instance is idle.
 */

import { watch, type FSWatcher } from "node:fs";
import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEBOUNCE_MS = 400;

export default function (pi: ExtensionAPI) {
  let watcher: FSWatcher | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  // Last disk leaf id we already alerted about, to avoid re-notifying.
  let lastNotifiedLeaf: string | null = null;

  function teardownWatcher() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (watcher) {
      watcher.close();
      watcher = null;
    }
  }

  /** Return the last non-header entry id in the session file, or null. */
  function readDiskLeafId(file: string): string | null {
    const text = readFileSync(file, "utf8");
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type !== "session" && entry.id) return entry.id;
      } catch {
        // Partial line from a concurrent append; caller retries on next event.
        return null;
      }
    }
    return null;
  }

  function checkExternalChange(ctx: {
    isIdle(): boolean;
    sessionManager: { getSessionFile(): string | undefined; getLeafId(): string | null };
    ui: { notify(message: string, level: "info" | "warning" | "error"): void };
  }) {
    if (disposed) return;
    // Skip while pi itself is writing (avoids false positives mid-append).
    if (!ctx.isIdle()) return;

    const file = ctx.sessionManager.getSessionFile();
    if (!file) return;

    let diskLeaf: string | null;
    try {
      diskLeaf = readDiskLeafId(file);
    } catch {
      return; // file vanished or is being rewritten; try again on next event
    }
    if (!diskLeaf) return;

    const memoryLeaf = ctx.sessionManager.getLeafId();
    if (diskLeaf === memoryLeaf) return; // in sync (or pi's own write)
    if (diskLeaf === lastNotifiedLeaf) return; // already alerted for this change

    lastNotifiedLeaf = diskLeaf;
    ctx.ui.notify(
      "会话文件已被外部修改（例如 paseo 继续了本会话）— 输入 /sync 刷新",
      "warning",
    );
  }

  function startWatcher(ctx: {
    mode: string;
    sessionManager: { getSessionFile(): string | undefined; getLeafId(): string | null };
  }) {
    teardownWatcher();
    if (ctx.mode !== "tui") return; // only meaningful in interactive mode

    const file = ctx.sessionManager.getSessionFile();
    if (!file) return; // ephemeral / in-memory session

    lastNotifiedLeaf = null;
    const dir = dirname(file);
    const name = basename(file);

    // Watch the directory rather than the file: some writers replace the file
    // via atomic rename, which breaks a plain file watcher.
    watcher = watch(dir, (_eventType, filename) => {
      if (filename !== null && filename !== name) return; // unrelated file
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => checkExternalChange(ctx), DEBOUNCE_MS);
    });
  }

  pi.on("session_start", (_event, ctx) => {
    disposed = false;
    startWatcher(ctx);
  });

  pi.on("session_shutdown", () => {
    disposed = true;
    teardownWatcher();
  });

  pi.registerCommand("sync", {
    description: "从磁盘重新加载当前会话（合并 paseo 等外部写入）",
    handler: async (_args, ctx) => {
      const file = ctx.sessionManager.getSessionFile();
      if (!file) {
        ctx.ui.notify("当前是无持久化的临时会话，无法同步", "error");
        return;
      }
      await ctx.waitForIdle();
      ctx.ui.notify("正在重新加载会话…", "info");
      const result = await ctx.switchSession(file);
      // NOTE: on success the runtime is replaced, so the old `ctx` is stale
      // from here on. We only touch it in the cancelled branch (no replacement
      // happened then, so it is still valid).
      if (result.cancelled) {
        ctx.ui.notify("同步被取消（session_before_switch 拦截）", "warning");
      }
    },
  });
}
