/**
 * pi-trigger — 把 ~/.pi/trigger/<name>/ 下的事件监听服务交给 systemd user 托管，
 * 并把它们产生的事件转发给 pi-scheduler 的 job。
 *
 * 边界：
 *   - pi-scheduler 只认「时间/外部调用 → job」，不知道事件是什么；
 *   - pi-trigger 只知道「事件 → 调用 run-job」，不解释 job 的 prompt/model；
 *   - 唯一接触面是 bin/emit（trigger 侧）与 bin/run-job（scheduler 侧）这两条 CLI。
 *
 * 数据目录：~/.pi/trigger/<name>/trigger.yaml（声明文件，唯一真源），
 *          单元 ~/.config/systemd/user/pi-trigger-<name>.service（生成产物）。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { isError, listTriggerDirs, loadManifest, NAME_RE, type Manifest } from "./manifest.ts";
import { DATA_DIR, syncNow, unitName, systemctl, sh } from "./systemd.ts";
import { claimPanelShortcut, hideAllPanels, Panel, releasePanelShortcut, type PanelContext, type PanelOptions } from "./panel.ts";

const WIDGET = "pi-trigger";

type Ui = {
  notify(message: string, level: "info" | "warning" | "error"): void;
  confirm(title: string, body: string, opts?: unknown): Promise<boolean>;
  select(title: string, options: string[], opts?: unknown): Promise<string | undefined>;
  input(title: string, placeholder?: string, opts?: unknown): Promise<string | undefined>;
  setWidget(key: string, lines: string[] | undefined, opts?: unknown): void;
  setStatus(key: string, text: string | undefined): void;
  custom(factory: unknown, options?: unknown): Promise<unknown>;
};

/** 命令 handler 收到的 ctx（只用到这几个字段）。 */
type Ctx = { hasUI?: boolean; mode?: string; ui: Ui };

/**
 * 打开一个可关闭的浮层面板展示结果。
 *
 * 为什么不直接用 ui.notify：notify 是把 Text 追加进 transcript，pi 没有提供
 * 让用户清掉它的入口（只能 /reload 或换会话）。面板关掉即销毁，不留痕。
 */
function showPanel(ctx: Ctx, title: string, lines: string[], opts: Partial<PanelOptions> = {}): Panel {
  const panel = new Panel({ title, lines, widgetKey: WIDGET, ...opts });
  panel.show(ctx as unknown as PanelContext);
  return panel;
}

function readManifests(): Array<Manifest | { name: string; errors: string[] }> {
  return listTriggerDirs(DATA_DIR).map((n) => loadManifest(DATA_DIR, n));
}

function unitState(name: string): string {
  const r = sh("systemctl", ["--user", "is-active", unitName(name)]);
  const a = r.out.trim() || r.err.trim();
  const en = sh("systemctl", ["--user", "is-enabled", unitName(name)]);
  const e = en.out.trim() || en.err.trim();
  return `${a || "inactive"}${e ? ` / ${e}` : ""}`;
}

function statusLines(): string[] {
  const ms = readManifests();
  if (!ms.length) return ["(还没有任何 trigger — 在 ~/.pi/trigger/<name>/trigger.yaml 里声明)"];
  const out: string[] = [];
  for (const m of ms) {
    if (isError(m as never)) {
      const e = m as { name: string; errors: string[] };
      out.push(`• ${e.name}  ✗ 声明有误`);
      for (const err of e.errors) out.push(`    - ${err}`);
      continue;
    }
    const mm = m as Manifest;
    out.push(`• ${mm.name}  [${unitState(mm.name)}]`);
    if (mm.description) out.push(`    ${mm.description}`);
    out.push(`    exec: ${mm.service.exec}`);
    out.push(`    emit → job ${mm.emit.job}${mm.emit.context?.length ? `  context: ${mm.emit.context.join(", ")}` : ""}`);
  }
  return out;
}

function runSystemctlFor(name: string, verb: string[], ui: Ui): void {
  const r = systemctl(verb);
  if (r.code !== 0) ui.notify(`${verb.join(" ")} 失败: ${r.err}`, "error");
  else ui.notify(`${verb.join(" ")} ok`, "info");
}

async function pickTrigger(ui: Ui, what: string): Promise<string | undefined> {
  const names = listTriggerDirs(DATA_DIR);
  if (!names.length) {
    ui.notify("pi-trigger: 还没有 trigger — 在 ~/.pi/trigger/<name>/trigger.yaml 里声明", "info");
    return undefined;
  }
  if (names.length === 1) return names[0];
  return (await ui.select(`pi-trigger: ${what} which trigger?`, names)) ?? undefined;
}

// ---------------------------------------------------------------- commands

function registerCommands(pi: ExtensionAPI): void {
  pi.registerCommand("pi-trigger:sync", {
    description: "Regenerate systemd units from ~/.pi/trigger/*/trigger.yaml",
    handler: async (_args, ctx) => {
      const ui = ctx.ui;
      const s = syncNow();
      if (s.errors.length) ui.notify(s.errors.join("; "), "error");
      showPanel(ctx, "pi-trigger sync", [
        s.ok ? `sync ok — ${s.lines.filter((l) => l.startsWith("trigger ")).length} trigger(s)` : "sync had errors",
        "",
        ...s.lines,
      ]);
    },
  });

  pi.registerCommand("pi-trigger:list", {
    description: "List declared triggers and their systemd state",
    handler: async (_args, ctx) => {
      const lines = statusLines();
      showPanel(ctx, `pi-trigger (${listTriggerDirs(DATA_DIR).length})`, lines);
    },
  });

  pi.registerCommand("pi-trigger:status", {
    description: "Show journalctl status for a trigger service",
    getArgumentCompletions: (prefix) => {
      const f = listTriggerDirs(DATA_DIR).filter((n) => n.startsWith(prefix));
      return f.length ? f.map((n) => ({ value: n, label: n })) : null;
    },
    handler: async (args, ctx) => {
      const ui = ctx.ui;
      const name = args.trim() || (await pickTrigger(ui, "status"));
      if (!name) return;
      const r = sh("systemctl", ["--user", "status", "--no-pager", "-n", "30", unitName(name)]);
      const lines = (r.out + r.err).trimEnd().split("\n").filter((l) => l.trim());
      showPanel(ctx, `status: ${name}`, lines.length ? lines : ["(no output)"], {
        footer: `Esc 关闭 · ↑↓ 滚动 （${lines.length} 行）`,
      });
    },
  });

  pi.registerCommand("pi-trigger:logs", {
    description: "Show recent journal output for a trigger service",
    getArgumentCompletions: (prefix) => {
      const f = listTriggerDirs(DATA_DIR).filter((n) => n.startsWith(prefix));
      return f.length ? f.map((n) => ({ value: n, label: n })) : null;
    },
    handler: async (args, ctx) => {
      const ui = ctx.ui;
      const name = args.trim() || (await pickTrigger(ui, "logs"));
      if (!name) return;
      const r = sh("journalctl", ["--user", "-u", unitName(name), "-n", "80", "--no-pager"]);
      if (r.code !== 0) { ui.notify(r.err.trim() || "no journal output", "info"); return; }
      const lines = r.out.trimEnd().split("\n").filter((l) => l.trim());
      if (!lines.length) { ui.notify("no journal output for this trigger yet", "info"); return; }
      showPanel(ctx, `journal: ${name}`, lines, {
        startAtBottom: true,
        footer: `Esc 关闭 · ↑↓ 滚动 （${lines.length} 行）`,
      });
    },
  });

  pi.registerCommand("pi-trigger:start", {
    description: "Start (and enable) a trigger service",
    getArgumentCompletions: (prefix) => {
      const f = listTriggerDirs(DATA_DIR).filter((n) => n.startsWith(prefix));
      return f.length ? f.map((n) => ({ value: n, label: n })) : null;
    },
    handler: async (args, ctx) => {
      const ui = ctx.ui;
      const name = args.trim() || (await pickTrigger(ui, "start"));
      if (!name || !NAME_RE.test(name)) { ui.notify("trigger not found", "error"); return; }
      if (!fs.existsSync(path.join(DATA_DIR, name, "trigger.yaml"))) { ui.notify(`trigger "${name}" not found`, "error"); return; }
      syncNow();
      runSystemctlFor(name, ["enable", "--now", unitName(name)], ui);
    },
  });

  pi.registerCommand("pi-trigger:stop", {
    description: "Stop a trigger service (keeps it enabled)",
    getArgumentCompletions: (prefix) => {
      const f = listTriggerDirs(DATA_DIR).filter((n) => n.startsWith(prefix));
      return f.length ? f.map((n) => ({ value: n, label: n })) : null;
    },
    handler: async (args, ctx) => {
      const ui = ctx.ui;
      const name = args.trim() || (await pickTrigger(ui, "stop"));
      if (!name || !NAME_RE.test(name)) { ui.notify("trigger not found", "error"); return; }
      runSystemctlFor(name, ["stop", unitName(name)], ui);
    },
  });

  pi.registerCommand("pi-trigger:restart", {
    description: "Restart a trigger service (re-syncs units first)",
    getArgumentCompletions: (prefix) => {
      const f = listTriggerDirs(DATA_DIR).filter((n) => n.startsWith(prefix));
      return f.length ? f.map((n) => ({ value: n, label: n })) : null;
    },
    handler: async (args, ctx) => {
      const ui = ctx.ui;
      const name = args.trim() || (await pickTrigger(ui, "restart"));
      if (!name || !NAME_RE.test(name)) { ui.notify("trigger not found", "error"); return; }
      if (!fs.existsSync(path.join(DATA_DIR, name, "trigger.yaml"))) { ui.notify(`trigger "${name}" not found`, "error"); return; }
      syncNow();
      runSystemctlFor(name, ["restart", unitName(name)], ui);
    },
  });

  pi.registerCommand("pi-trigger:emit", {
    description: "Manually emit an event for a trigger (debug: fires its job)",
    getArgumentCompletions: (prefix) => {
      const f = listTriggerDirs(DATA_DIR).filter((n) => n.startsWith(prefix));
      return f.length ? f.map((n) => ({ value: n, label: n })) : null;
    },
    handler: async (args, ctx) => {
      const ui = ctx.ui;
      const name = args.trim().split(/\s+/)[0] || (await pickTrigger(ui, "emit"));
      if (!name) return;
      const m = loadManifest(DATA_DIR, name);
      if (isError(m)) { ui.notify(`${name}: ${m.errors.join("; ")}`, "error"); return; }
      const ok = await ui.confirm(
        "pi-trigger: 手动触发?",
        `对 "${name}" 伪造一次事件 → 运行 job "${m.emit.job}"（会真实执行一次 pi agent，消耗 token）。`,
      );
      if (!ok) { ui.notify("已取消", "info"); return; }
      const emit = path.join(path.dirname(fileURLToPath(import.meta.url)), "bin", "emit");

      // 正在运行的子进程句柄，让面板的 x 键能终止它。
      let child: ReturnType<typeof spawn> | undefined;
      const panel = new Panel({
        title: `pi-trigger: emit ${name}`,
        lines: [`$ emit → job ${m.emit.job}`],
        widgetKey: WIDGET,
        startAtBottom: true,
        footer: "运行中… · Esc 关闭面板 · x 终止",
        onKill: () => {
          try {
            child?.kill("SIGTERM");
          } catch {
            /* ignore */
          }
        },
      });
      panel.show(ctx as unknown as PanelContext);

      child = spawn("/bin/bash", [emit, "--context-json", JSON.stringify({ manual: true, trigger: name })], {
        env: { ...process.env, PI_TRIGGER_JOB: m.emit.job, PI_TRIGGER_NAME: name },
      });
      let buf = "";
      const sink = (d: Buffer) => {
        buf += d.toString();
        const parts = buf.split("\n");
        buf = parts.pop() ?? "";
        for (const p of parts) if (p.trim()) panel.appendLine(p);
      };
      child.stdout.on("data", sink);
      child.stderr.on("data", sink);
      const code: number = await new Promise((res) => {
        child!.on("close", (c) => res(c ?? 1));
        child!.on("error", () => res(1));
      });
      panel.setTitle(`pi-trigger: emit ${name} (exit ${code})`);
      panel.setFooter("Esc 关闭 · ↑↓/PgUp/PgDn 滚动");
      panel.appendLine("");
      panel.appendLine(
        code === 0
          ? "✓ emit ok"
          : code === 75
            ? "• job 正忙，已跳过（exit 75）"
            : `✗ emit 失败 exit=${code}`,
      );
    },
  });

  // 兜底：一键收掉所有面板（也会清掉旧版遗留的 widget）。
  pi.registerCommand("pi-trigger:panel-close", {
    description: "关闭所有 pi-trigger 输出面板",
    handler: async (_args, ctx) => {
      const n = hideAllPanels(ctx.ui);
      ctx.ui.notify(n ? `已关闭 ${n} 个面板` : "没有打开的面板", "info");
    },
  });
  // 两个扩展共享一个「一键全关」快捷键，只有先加载的那个真正注册。
  if (claimPanelShortcut()) {
    pi.registerShortcut("alt+w", {
      description: "关闭所有 pi 输出面板（pi-scheduler / pi-trigger）",
      handler: async (ctx) => {
        hideAllPanels(ctx.ui);
      },
    });
  }

  // /reload 会先发 session_shutdown 再加载新实例；
  // 在这里释放声明，新实例才能重新注册 alt+w。
  pi.on("session_shutdown", () => {
    releasePanelShortcut();
  });
}

// ---------------------------------------------------------------- tool

function registerTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "pi_trigger_list",
    label: "Pi Trigger: List",
    description: "列出 pi-trigger 的全部触发器：声明、systemd 状态、emit 目标 job。只读，无副作用。",
    promptSnippet: "List pi trigger daemons and their emit targets",
    promptGuidelines: [
      "Use pi_trigger_list when the user asks what event-driven trigger daemons exist, or which pi-scheduler job a trigger fires.",
    ],
    parameters: Type.Object({}),
    async execute() {
      const ms = readManifests();
      if (!ms.length) return { content: [{ type: "text" as const, text: "pi-trigger: 还没有任何 trigger（~/.pi/trigger/<name>/trigger.yaml）。" }] };
      const lines: string[] = [];
      for (const m of ms) {
        if (isError(m as never)) {
          const e = m as { name: string; errors: string[] };
          lines.push(`• ${e.name}  ✗ ${e.errors.join("; ")}`);
          continue;
        }
        const mm = m as Manifest;
        lines.push(`• ${mm.name}  [${unitState(mm.name)}]  → job ${mm.emit.job}`);
        lines.push(`  exec: ${mm.service.exec}`);
        if (mm.description) lines.push(`  ${mm.description}`);
      }
      return { content: [{ type: "text" as const, text: `pi-trigger (${ms.length}):\n${lines.join("\n")}` }] };
    },
  });
}

export default function (pi: ExtensionAPI): void {
  registerCommands(pi);
  registerTools(pi);
}
