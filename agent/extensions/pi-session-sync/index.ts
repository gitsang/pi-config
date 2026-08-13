/**
 * pi-session-sync — 外部进程（如 paseo 拉起的另一个 pi）向当前会话文件追加写入时，
 * 自动把本 TUI 的会话从磁盘重载，实现"跟随刷新"。
 *
 * 设计要点：
 *   - 会话重载原语 `switchSession` 只存在于"命令上下文"（ExtensionCommandContext），
 *     事件回调里拿不到。所以本扩展在启动时用一次性命令 `/sync-arm` 捕获一个命令
 *     上下文存起来（模块级，跨会话切换存活），之后由文件 watcher 复用它直接调
 *     `switchSession`，无需你再敲任何命令。
 *   - 每次 `switchSession` 成功后扩展实例会被重建，旧命令上下文失效；这里用
 *     `switchSession({ withSession })` 回调里拿到的新上下文重新武装（re-arm），
 *     因此可以持续自动刷新。
 *
 * 启用方式（二选一，之后全程自动）：
 *   1) 启动时带上初始命令：  pi -c "/sync-arm"
 *   2) 或首次在会话里输入一次： /sync-arm
 *   （可写进 shell alias，例如： alias pi='pi -c "/sync-arm"'）
 *
 * 可选配置（本目录下 config.json，与 index.ts 同级）：
 *   {
 *     "lockInputDuringExternalWrite": false,  // 外部写入期间禁用输入框
 *     "debounceMs": 600                       // 文件事件防抖，单位 ms
 *   }
 *
 * 约束：本扩展只负责"跟随刷新"，无法把两个进程的并发写合并成一条分支。
 * 请保持"外部写完 → 这边刷新 → 你再输入"的交替节奏；不要在外部进程还
 * 在跑的时候同时输入。
 */

import { existsSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

const EXT_DIR = dirname(fileURLToPath(import.meta.url));
const STATUS_KEY = "session-sync";

interface Config {
  lockInputDuringExternalWrite: boolean;
  debounceMs: number;
}

function loadConfig(): Config {
  const defaults: Config = { lockInputDuringExternalWrite: false, debounceMs: 600 };
  try {
    const p = join(EXT_DIR, "config.json");
    if (existsSync(p)) {
      const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<Config>;
      return {
        lockInputDuringExternalWrite:
          raw.lockInputDuringExternalWrite ?? defaults.lockInputDuringExternalWrite,
        debounceMs: typeof raw.debounceMs === "number" ? raw.debounceMs : defaults.debounceMs,
      };
    }
  } catch {
    // ignore malformed config, fall back to defaults
  }
  return defaults;
}

const config = loadConfig();

// ---- 模块级状态：跨扩展实例（会话切换）存活 -------------------------------
let reloadCtx: ExtensionCommandContext | null = null; // 用于触发 switchSession 的命令上下文
let activeUi: {
  setStatus(key: string, text: string | undefined): void;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  getEditorText?(): string;
} | null = null;
let externalActive = false; // 检测到外部写入，尚未完成刷新
let syncing = false; // 正在执行 switchSession
let inputUnsub: (() => void) | null = null; // onTerminalInput 的退订函数

function updateStatus() {
  if (!activeUi) return;
  if (syncing) {
    activeUi.setStatus(STATUS_KEY, "🔄 正在同步会话…");
  } else if (externalActive) {
    activeUi.setStatus(STATUS_KEY, "⏳ 外部正在写入会话…");
  } else if (reloadCtx) {
    activeUi.setStatus(STATUS_KEY, "🔁 会话自动同步已就绪");
  } else {
    activeUi.setStatus(STATUS_KEY, undefined);
  }
}

/** 读取会话文件里最后一条非 header 条目的 id（读取失败/读到半行返回 null）。 */
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
      return null; // 半行，等下一个事件重试
    }
  }
  return null;
}

export default function (pi: ExtensionAPI) {
  let watcher: FSWatcher | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let lastNotifiedLeaf: string | null = null;

  function clearTimers() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  function teardownWatcher() {
    clearTimers();
    if (watcher) {
      watcher.close();
      watcher = null;
    }
  }

  function doReload() {
    if (syncing || !reloadCtx) return;
    const file = reloadCtx.sessionManager.getSessionFile();
    if (!file) return;

    syncing = true;
    updateStatus();
    void (async () => {
      try {
        await reloadCtx!.waitForIdle();
        const result = await reloadCtx!.switchSession(file, {
          withSession: (newCtx) => {
            // 用新会话的命令上下文重新武装，供下一次自动刷新使用
            reloadCtx = newCtx;
            activeUi = newCtx.ui;
          },
        });
        if (result.cancelled) {
          activeUi?.notify("自动同步被其它扩展拦截（session_before_switch）", "warning");
        }
      } catch (err) {
        // 常见于命令上下文已失效（极少数竞态），标记为未武装，下次外部写入时提醒重新 /sync-arm
        reloadCtx = null;
        activeUi?.notify(
          "自动同步上下文失效，请再执行一次 /sync-arm 重新启用",
          "warning",
        );
      } finally {
        syncing = false;
        externalActive = false;
        updateStatus();
      }
    })();
  }

  function checkExternal(ctx: {
    mode: string;
    isIdle(): boolean;
    sessionManager: { getSessionFile(): string | undefined; getLeafId(): string | null };
    ui: {
      setStatus(key: string, text: string | undefined): void;
      notify(message: string, type?: "info" | "warning" | "error"): void;
      getEditorText?(): string;
    };
  }) {
    if (disposed || syncing) return;
    if (ctx.mode !== "tui") return;
    if (!ctx.isIdle()) return; // pi 自己在写（或正在跑回合），跳过

    const file = ctx.sessionManager.getSessionFile();
    if (!file) return;

    let diskLeaf: string | null;
    try {
      diskLeaf = readDiskLeafId(file);
    } catch {
      return; // 文件暂时不可读，等下一个事件
    }
    if (!diskLeaf) {
      // 可能读到了对端正在追加的半行（解析失败）。稍后重试一次，避免漏掉最后一次刷新。
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(() => checkExternal(ctx), 400);
      return;
    }

    const memoryLeaf = ctx.sessionManager.getLeafId();
    if (diskLeaf === memoryLeaf) return; // 已同步（或 pi 自己的写入）

    // 外部写入检测到
    externalActive = true;
    updateStatus();

    if (!reloadCtx) {
      if (diskLeaf !== lastNotifiedLeaf) {
        lastNotifiedLeaf = diskLeaf;
        activeUi?.notify(
          "检测到外部写入，但自动同步未启用 — 执行一次 /sync-arm 后即可自动刷新",
          "warning",
        );
      }
      return;
    }

    // 保护：用户正在输入时先不刷新，等编辑框清空后再试
    const editor = ctx.ui.getEditorText?.() ?? "";
    if (editor.trim()) {
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(() => checkExternal(ctx), 1000);
      return;
    }

    doReload();
  }

  function startWatcher(ctx: {
    mode: string;
    sessionManager: { getSessionFile(): string | undefined; getLeafId(): string | null };
    ui: {
      setStatus(key: string, text: string | undefined): void;
      notify(message: string, type?: "info" | "warning" | "error"): void;
      getEditorText?(): string;
    };
  }) {
    teardownWatcher();
    activeUi = ctx.ui;
    if (ctx.mode !== "tui") return;

    const file = ctx.sessionManager.getSessionFile();
    if (!file) return; // 临时会话

    lastNotifiedLeaf = null;
    const dir = dirname(file);
    const name = basename(file);

    watcher = watch(dir, (_eventType, filename) => {
      if (filename !== null && filename !== name) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => checkExternal(ctx), config.debounceMs);
    });
  }

  // ---- 一次性武装命令（同时兼作手动刷新） -----------------------------------
  pi.registerCommand("sync-arm", {
    description: "启用会话自动同步（检测到外部写入时自动刷新）",
    handler: async (_args, ctx) => {
      reloadCtx = ctx;
      activeUi = ctx.ui;
      ctx.ui.notify("会话自动同步已启用", "info");
      updateStatus();
      // 若武装前已经有待处理的外部改动，立即刷新一次
      checkExternal(ctx);
    },
  });

  pi.on("session_start", (_event, ctx) => {
    disposed = false;
    startWatcher(ctx);

    // 输入锁：外部写入期间可配置为禁用输入框
    if (ctx.mode === "tui" && inputUnsub === null) {
      inputUnsub = ctx.ui.onTerminalInput(() => {
        if (externalActive && config.lockInputDuringExternalWrite) {
          return { consume: true };
        }
        return undefined;
      });
    }
  });

  pi.on("session_shutdown", () => {
    disposed = true;
    teardownWatcher();
    // 旧命令上下文即将失效，等待 withSession 重新武装
    reloadCtx = null;
    externalActive = false;
    syncing = false;
    if (inputUnsub) {
      inputUnsub();
      inputUnsub = null;
    }
  });
}
