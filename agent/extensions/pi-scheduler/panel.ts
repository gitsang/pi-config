/**
 * panel.ts — 可关闭的浮层面板（overlay）。
 *
 * 为什么需要它：setWidget / notify 都是「挂在界面上」的状态，pi 没有提供让用户
 * 亲手清掉它们的入口 —— 只能靠 /reload 或换会话，于是命令的大段输出会一直赖在
 * 界面上。overlay 不一样：它是临时挂载的组件，关掉即销毁，既不写 transcript、
 * 也不进 scrollback、更不落 session 文件。
 *
 * 同一份文件在 pi-scheduler/ 与 pi-trigger/ 各存一份拷贝：两个扩展保持互相独立、
 * 可各自分发，不引入跨扩展 import。两份拷贝之间只通过 globalThis 上一个
 * Symbol.for 注册表协作 —— 这样：
 *   1. 「一键全关」的快捷键由先加载的那个扩展注册一次，不会重复注册（重复注册
 *      会让 pi 在启动时打一条 [Extension issues] 警告，那本身又是一种残留噪声）；
 *   2. 但按下它会把两个扩展的面板一起关掉。
 *
 * 用法：
 *   const panel = new Panel({ title: "xxx", lines: [...] });
 *   panel.show(ctx);                       // TUI: overlay；RPC: 退回 setWidget
 *   panel.setLines([...]);                 // 随时更新（会重绘）
 *   panel.appendLine("...");               // 流式追加
 *   panel.close();                         // 或用户按 Esc
 *   await panel.closed;                    // 等用户关掉
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type OverlayOptions,
  type TUI,
} from "@earendil-works/pi-tui";

/**
 * 只描述用到的 UI 能力，故意用宽松签名：上游的 setWidget/custom 是重载方法，
 * 写死结构会随版本漂移。
 */
export type PanelContext = {
  hasUI?: boolean;
  mode?: string;
  ui: {
    custom: (factory: any, options?: any) => Promise<any>;
    setWidget: (key: string, content: string[] | undefined, options?: any) => void;
    notify: (message: string, level?: "info" | "warning" | "error") => void;
  };
};

export interface PanelOptions {
  title: string;
  lines: string[];
  /** 底部提示行；默认「Esc 关闭 · ↑↓ 滚动」 */
  footer?: string;
  /** 自动关闭毫秒数；0/不填 = 一直开着，等用户按键 */
  autoCloseMs?: number;
  /** 初始是否停在末尾（日志/流式输出用 true；列表用默认的顶部） */
  startAtBottom?: boolean;
  /** 按 x 时的动作（例如终止子进程），随后面板关闭 */
  onKill?: () => void;
  /** 非 TUI 模式（RPC）退回 setWidget 时用的 key */
  widgetKey?: string;
  /**
   * 覆盖 overlay 的位置/尺寸选项。
   *
   * 典型用法是填写向导：设成 `{ anchor: "top-center", nonCapturing: true }`，
   * 面板就贴在顶部且不抢焦点 —— 不会盖住底部的 input/editor 提示。
   */
  overlay?: Partial<OverlayOptions>;
}

// C0 控制符里只留 tab(\t) / LF(\n) / CR(\r) / ESC(\x1b，用于日志配色)。
const CTRL_CHARS = /[\u0000-\u0008\u000b-\u001a\u001c-\u001f\u007f]/g;

function cleanLines(lines: string[]): string[] {
  const out: string[] = [];
  for (const raw of lines) {
    for (const piece of String(raw ?? "").split("\n")) {
      out.push(piece.replace(/\t/g, "    ").replace(/\r/g, "").replace(CTRL_CHARS, ""));
    }
  }
  return out;
}

// ------------------------------------------------------- 跨扩展共享注册表
//
// Symbol.for 在同一个进程内是全局唯一的，两份 panel.ts 拷贝拿到的是同一个
// 符号，因此也共享同一个注册表 —— 不需要任何跨扩展 import。

interface PanelRegistry {
  panels: Set<Panel>;
  /** 已经用过的 setWidget key，兜底清除时要一并清掉 */
  widgetKeys: Set<string>;
  shortcutClaimed: boolean;
}

const REGISTRY = Symbol.for("pi.output-panels.registry");

function registry(): PanelRegistry {
  const g = globalThis as Record<symbol, PanelRegistry | undefined>;
  let r = g[REGISTRY];
  if (!r) {
    r = { panels: new Set(), widgetKeys: new Set(), shortcutClaimed: false };
    g[REGISTRY] = r;
  }
  return r;
}

/**
 * 声明「一键全关」快捷键。返回 true 表示本次调用应当真正去 registerShortcut。
 * 两个扩展都调用它，只有先加载的那个拿到 true，因此不会出现重复注册警告。
 */
export function claimPanelShortcut(): boolean {
  const r = registry();
  if (r.shortcutClaimed) return false;
  r.shortcutClaimed = true;
  return true;
}

/**
 * 释放快捷键声明。
 *
 * 必须这样做：pi 在 /reload 时会先给旧扩展发 session_shutdown，之后才加载新扩展。
 * 如果只是「一辈子只领一次」， reload 之后新实例就再也注册不上那个快捷键了。
 */
export function releasePanelShortcut(): void {
  registry().shortcutClaimed = false;
}

/** 兜底清除：关掉当前进程里所有扩展的输出面板，并抹掉可能残留的 widget。 */
export function hideAllPanels(ui: PanelContext["ui"]): number {
  const r = registry();
  const n = r.panels.size;
  for (const p of [...r.panels]) p.close();
  r.panels.clear();
  // 旧版本或异常路径可能把 widget 留下了，这里一并清掉。
  // 注意：setWidget(key, undefined) 才真正移除；传 [] 仍会留一个占位空行。
  for (const key of r.widgetKeys) {
    try {
      ui.setWidget(key, undefined);
    } catch {
      /* ignore */
    }
  }
  return n;
}

// ------------------------------------------------------------------ Panel

export class Panel {
  readonly lines: string[];
  title: string;
  footer: string;
  /** 用户关掉（或自动关闭）后 resolve */
  readonly closed: Promise<void>;

  isClosed = false;
  /** 是否有 onKill（决定 x 键是否显示/生效） */
  readonly hasKill: boolean;
  /** 初始是否停在末尾（日志/流式输出用） */
  readonly startAtBottom: boolean;

  private readonly opts: PanelOptions;
  private ctx?: PanelContext;
  private tui?: TUI;
  private done?: (result: void) => void;
  private timer?: ReturnType<typeof setTimeout>;
  private resolveClosed!: () => void;
  private usedWidgetFallback = false;

  constructor(opts: PanelOptions) {
    this.opts = opts;
    this.hasKill = Boolean(opts.onKill);
    this.startAtBottom = Boolean(opts.startAtBottom);
    this.title = opts.title;
    this.footer =
      opts.footer ?? `Esc 关闭${opts.onKill ? " · x 终止" : ""} · ↑↓/PgUp/PgDn 滚动`;
    this.lines = cleanLines(opts.lines);
    this.closed = new Promise<void>((resolve) => {
      this.resolveClosed = resolve;
    });
    registry().panels.add(this);
  }

  /** 显示面板。TUI → overlay；其它模式 → 退回 widget（旧行为）。 */
  show(ctx: PanelContext): this {
    this.ctx = ctx;
    if (!ctx.hasUI) {
      registry().panels.delete(this);
      return this;
    }

    const widgetKey = this.opts.widgetKey ?? "panel";
    if (ctx.mode !== "tui") {
      this.usedWidgetFallback = true;
      registry().widgetKeys.add(widgetKey);
      try {
        ctx.ui.setWidget(widgetKey, this.lines);
      } catch {
        /* ignore */
      }
      return this;
    }

    const overlayOptions: OverlayOptions = {
      anchor: "center",
      width: "86%",
      maxHeight: "95%",
      margin: 1,
      ...this.opts.overlay,
    };
    try {
      void ctx.ui
        .custom<void>(
          (tui: TUI, theme: Theme, _keybindings: unknown, done: (result: void) => void) => {
            this.done = done;
            this.tui = tui;
            return new PanelComponent(this, theme, tui) as Component;
          },
          { overlay: true, overlayOptions },
        )
        .then(() => this.markClosed())
        .catch(() => this.markClosed());
    } catch {
      // overlay 起不来时至少不要把内容静默丢掉
      this.markClosed();
    }

    if (this.opts.autoCloseMs && this.opts.autoCloseMs > 0) {
      this.timer = setTimeout(() => this.close(), this.opts.autoCloseMs);
    }
    return this;
  }

  /** 整体替换正文（保留滚动位置/跟随状态）。 */
  setLines(lines: string[]): void {
    this.lines.length = 0;
    this.lines.push(...cleanLines(lines));
    this.render();
  }

  /** 追加一行（流式输出用）。 */
  appendLine(line: string): void {
    const cleaned = cleanLines([line]);
    if (!cleaned.length) return;
    this.lines.push(...cleaned);
    // 面板本身是滚动视图，没必要无限堆积；留最近 400 行足够回看
    if (this.lines.length > 400) this.lines.splice(0, this.lines.length - 400);
    this.render();
  }

  setFooter(text: string): void {
    this.footer = text;
    this.render();
  }

  setTitle(text: string): void {
    this.title = text;
    this.render();
  }

  close(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const done = this.done;
    this.done = undefined;
    if (done) {
      try {
        done();
      } catch {
        /* ignore */
      }
    }
    this.markClosed();
  }

  /** 由 onKill（x 键）调用。 */
  kill(): void {
    try {
      this.opts.onKill?.();
    } finally {
      this.close();
    }
  }

  /** 面板是否仍然显示在屏幕上。 */
  get isOpen(): boolean {
    return !this.isClosed && (Boolean(this.done) || this.usedWidgetFallback);
  }

  private render(): void {
    try {
      this.tui?.requestRender();
    } catch {
      /* ignore */
    }
  }

  private markClosed(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    registry().panels.delete(this);
    if (this.usedWidgetFallback && this.ctx) {
      try {
        this.ctx.ui.setWidget(this.opts.widgetKey ?? "panel", undefined);
      } catch {
        /* ignore */
      }
    }
    this.resolveClosed();
  }
}

/** 单个面板的渲染组件：带边框、标题、滚动位置。 */
class PanelComponent implements Component {
  private offset = 0;
  private follow: boolean;

  constructor(
    private readonly panel: Panel,
    private readonly theme: Theme,
    private readonly tui: TUI,
  ) {
    this.follow = panel.startAtBottom;
  }

  render(width: number): string[] {
    const th = this.theme;
    const border = (s: string) => th.fg("border", s);
    const innerW = Math.max(1, width - 2);
    const lines = this.panel.lines;
    const maxBody = this.bodyHeight();

    const maxOffset = Math.max(0, lines.length - maxBody);
    this.offset = this.follow ? maxOffset : Math.min(Math.max(0, this.offset), maxOffset);

    const out: string[] = [];

    // 标题
    const title = truncateToWidth(` ${this.panel.title} `, Math.max(0, innerW - 2));
    const left = Math.max(0, Math.floor((innerW - visibleWidth(title)) / 2));
    const right = Math.max(0, innerW - visibleWidth(title) - left);
    out.push(border(`╭${"─".repeat(left)}`) + th.fg("accent", title) + border(`${"─".repeat(right)}╮`));

    // 正文
    const body = lines.slice(this.offset, this.offset + maxBody);
    if (body.length === 0) {
      out.push(border("│") + truncateToWidth(th.fg("dim", " (没有内容)"), innerW, "…", true) + border("│"));
    }
    for (const line of body) {
      out.push(border("│") + truncateToWidth(` ${line}`, innerW, "…", true) + border("│"));
    }
    for (let i = body.length; i < maxBody; i++) {
      out.push(border("│") + " ".repeat(innerW) + border("│"));
    }

    // 状态行：左提示、右滚动位置
    const total = lines.length;
    const range = total ? `${this.offset + 1}-${Math.min(this.offset + maxBody, total)}/${total}` : "0/0";
    const rightText = th.fg("dim", `${range} `);
    const room = Math.max(1, innerW - visibleWidth(rightText));
    const hint = truncateToWidth(th.fg("dim", ` ${this.panel.footer}`), room, "…", true);
    out.push(border("│") + hint + rightText + border("│"));
    out.push(border(`╰${"─".repeat(innerW)}╯`));

    return out;
  }

  handleInput(data: string): void {
    const lines = this.panel.lines;
    const maxBody = this.bodyHeight();
    const maxOffset = Math.max(0, lines.length - maxBody);

    if (matchesKey(data, "x") && this.panel.hasKill) {
      this.panel.kill();
      return;
    }

    if (
      matchesKey(data, "escape") ||
      matchesKey(data, "q") ||
      matchesKey(data, "enter") ||
      matchesKey(data, "ctrl+c")
    ) {
      this.panel.close();
      return;
    }

    if (matchesKey(data, "up") || matchesKey(data, "k")) {
      this.follow = false;
      this.offset = Math.max(0, this.offset - 1);
    } else if (matchesKey(data, "down") || matchesKey(data, "j")) {
      this.offset = Math.min(maxOffset, this.offset + 1);
      this.follow = this.offset >= maxOffset;
    } else if (matchesKey(data, "pageUp") || matchesKey(data, "ctrl+b")) {
      this.follow = false;
      this.offset = Math.max(0, this.offset - maxBody);
    } else if (matchesKey(data, "pageDown") || matchesKey(data, "ctrl+f")) {
      this.offset = Math.min(maxOffset, this.offset + maxBody);
      this.follow = this.offset >= maxOffset;
    } else if (matchesKey(data, "home")) {
      this.follow = false;
      this.offset = 0;
    } else if (matchesKey(data, "end")) {
      this.follow = true;
      this.offset = maxOffset;
    }

    try {
      this.tui.requestRender();
    } catch {
      /* ignore */
    }
  }

  invalidate(): void {
    /* 每帧重新计算，无需缓存 */
  }

  /** 正文可见行数：至少 3 行，最多 26 行，且不撑破终端。 */
  private bodyHeight(): number {
    const rows = this.tui?.terminal?.rows ?? 24;
    return Math.max(3, Math.min(rows - 6, 26));
  }
}
