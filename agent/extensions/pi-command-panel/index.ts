/**
 * Command Panel Extension
 *
 * Opens a fuzzy-searchable command panel overlay anywhere in the editor via
 * Ctrl+P — no need to type `/<cmd>` at the start of the input.
 *
 * - Ctrl+P (main editor) ........... open panel
 * - type ........................... fuzzy-filter across name + description
 * - ↑↓ ............................. navigate (also Ctrl+P / Ctrl+N)
 * - Enter .......................... run the selected command immediately
 * - Esc / Ctrl+C ................... cancel
 *
 * How commands run (Enter executes directly, never just fills the editor):
 *   Every selection is dispatched through the editor's `onSubmit` handler, which
 *   is pi's unified command dispatcher — it runs built-in commands (/model,
 *   /tree, /compact…), extension commands, skills, and prompt templates exactly
 *   as if you had typed and submitted `/<name>`. Your in-progress editor text
 *   (draft) is saved first and restored afterward for commands that return to
 *   the same session, so you can invoke commands mid-typing without losing your
 *   draft. Session-changing commands (/new, /fork, /tree, /resume, /clone,
 *   /quit, /reload) intentionally skip draft restoration.
 *
 * Requires the companion keybindings.json change that moves model cycling off
 * Ctrl+P. Note: Ctrl+M is NOT used for model cycling because Ctrl+M and Enter
 * send the same byte (0x0D) in terminals — binding model cycling to Ctrl+M
 * would make every Enter cycle the model. Model cycling uses Alt+M instead.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { keyText, type Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  fuzzyFilter,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

type CmdSource = "builtin" | "extension" | "prompt" | "skill";

interface PanelItem {
  /** Invocable name without leading slash, e.g. "model" or "skill:foo". */
  name: string;
  /** Short display label (without the skill: prefix for skills). */
  label: string;
  description: string;
  source: CmdSource;
}

/** Built-in interactive commands (not returned by pi.getCommands()). */
const BUILTIN_COMMANDS: PanelItem[] = [
  { name: "model", label: "model", description: "Switch models", source: "builtin" },
  { name: "scoped-models", label: "scoped-models", description: "Enable/disable models for Alt+M cycling", source: "builtin" },
  { name: "settings", label: "settings", description: "Thinking level, theme, message delivery, transport", source: "builtin" },
  { name: "resume", label: "resume", description: "Pick from previous sessions", source: "builtin" },
  { name: "new", label: "new", description: "Start a new session", source: "builtin" },
  { name: "name", label: "name", description: "Set session display name  ·  /name <name>", source: "builtin" },
  { name: "session", label: "session", description: "Show session file, ID, messages, tokens, cost", source: "builtin" },
  { name: "tree", label: "tree", description: "Jump to any point in the session and continue from there", source: "builtin" },
  { name: "trust", label: "trust", description: "Save project trust decision for future sessions", source: "builtin" },
  { name: "fork", label: "fork", description: "Create a new session from a previous user message", source: "builtin" },
  { name: "clone", label: "clone", description: "Duplicate the current active branch into a new session", source: "builtin" },
  { name: "compact", label: "compact", description: "Manually compact context  ·  /compact [prompt]", source: "builtin" },
  { name: "copy", label: "copy", description: "Copy last assistant message to clipboard", source: "builtin" },
  { name: "export", label: "export", description: "Export session to HTML or JSONL", source: "builtin" },
  { name: "import", label: "import", description: "Import and resume a session  ·  /import <file>", source: "builtin" },
  { name: "share", label: "share", description: "Upload as private GitHub gist with shareable link", source: "builtin" },
  { name: "reload", label: "reload", description: "Reload keybindings, extensions, skills, prompts, themes", source: "builtin" },
  { name: "hotkeys", label: "hotkeys", description: "Show all keyboard shortcuts", source: "builtin" },
  { name: "changelog", label: "changelog", description: "Display version history", source: "builtin" },
  { name: "login", label: "login", description: "Manage OAuth or API-key credentials", source: "builtin" },
  { name: "logout", label: "logout", description: "Log out credentials", source: "builtin" },
  { name: "quit", label: "quit", description: "Quit pi", source: "builtin" },
];

/** Commands that change/destroy the session context — skip draft restoration. */
const NAVIGATING = new Set([
  "new", "fork", "tree", "resume", "clone", "quit", "reload",
]);

/** Build the full command list: built-ins first, then extension/prompt/skill. */
function buildItems(pi: ExtensionAPI): PanelItem[] {
  const items: PanelItem[] = BUILTIN_COMMANDS.map((c) => ({ ...c }));
  const seen = new Set(items.map((i) => i.name));

  let dynamic: { name: string; description?: string; source: string }[] = [];
  try {
    dynamic = pi.getCommands() as unknown as typeof dynamic;
  } catch {
    dynamic = [];
  }

  for (const cmd of dynamic) {
    if (!cmd?.name) continue;
    if (cmd.name === "panel") continue; // don't list ourselves
    if (seen.has(cmd.name)) continue;
    const source = (cmd.source as CmdSource) ?? "extension";
    const label = source === "skill" && cmd.name.startsWith("skill:")
      ? cmd.name.slice(6)
      : cmd.name;
    items.push({
      name: cmd.name,
      label,
      description: cmd.description ?? "",
      source,
    });
    seen.add(cmd.name);
  }
  return items;
}

function sourceColor(theme: Theme, source: CmdSource, text: string): string {
  switch (source) {
    case "builtin":
      return theme.fg("accent", text);
    case "extension":
      return theme.fg("text", text);
    case "prompt":
      return theme.fg("success", text);
    case "skill":
      return theme.fg("warning", text);
    default:
      return text;
  }
}

function sourceTag(source: CmdSource): string {
  switch (source) {
    case "builtin": return "bi";
    case "extension": return "ext";
    case "prompt": return "tpl";
    case "skill": return "sk";
    default: return "  ";
  }
}

/** Pad/truncate a (possibly styled) string to exactly `width` visible cells. */
function padToWidth(str: string, width: number): string {
  const w = visibleWidth(str);
  if (w > width) return truncateToWidth(str, width, "");
  if (w < width) return str + " ".repeat(width - w);
  return str;
}

interface TuiLike {
  requestRender: () => void;
}

interface PanelCtx {
  ui: {
    setEditorText: (s: string) => void;
    getEditorText: () => string;
    notify: (m: string, t?: "info" | "warning" | "error") => void;
    custom: <T>(
      factory: (
        tui: TuiLike,
        theme: Theme,
        keybindings: unknown,
        done: (value: T) => void,
      ) => Component | { render: (w: number) => string[]; invalidate: () => void; handleInput: (d: string) => void },
      options?: { overlay?: boolean; overlayOptions?: Record<string, unknown> },
    ) => Promise<T>;
  };
}

/**
 * The panel overlay component. Implements the pi-tui Component interface.
 * Render is computed fresh every frame (no caching) so selection changes
 * always reflect immediately.
 */
class CommandPanel implements Component {
  private items: PanelItem[];
  private theme: Theme;
  private tui: TuiLike;
  private done: (value: string | null) => void;

  private query = "";
  private filtered: PanelItem[];
  private selected = 0;
  private readonly maxVisible = 10;
  private readonly nameCol: number;

  constructor(
    items: PanelItem[],
    theme: Theme,
    tui: TuiLike,
    done: (value: string | null) => void,
  ) {
    this.items = items;
    this.theme = theme;
    this.tui = tui;
    this.done = done;
    this.filtered = items;

    let maxName = 8;
    for (const it of items) {
      const w = visibleWidth("/" + it.label);
      if (w > maxName) maxName = w;
    }
    this.nameCol = Math.min(maxName, 26);
  }

  private refilter(): void {
    const q = this.query;
    this.filtered = q.trim()
      ? fuzzyFilter(this.items, q, (it) => `${it.label} ${it.name} ${it.description}`)
      : this.items;
    this.selected = 0;
  }

  handleInput(data: string): void {
    // Navigation — arrows AND Ctrl+P/Ctrl+N (handy inside the panel)
    if (matchesKey(data, "up") || matchesKey(data, "ctrl+p")) {
      if (this.filtered.length > 0) {
        this.selected = (this.selected - 1 + this.filtered.length) % this.filtered.length;
      }
    } else if (matchesKey(data, "down") || matchesKey(data, "ctrl+n")) {
      if (this.filtered.length > 0) {
        this.selected = (this.selected + 1) % this.filtered.length;
      }
    } else if (matchesKey(data, "pageUp")) {
      this.selected = Math.max(0, this.selected - this.maxVisible);
    } else if (matchesKey(data, "pageDown")) {
      this.selected = Math.min(
        Math.max(0, this.filtered.length - 1),
        this.selected + this.maxVisible,
      );
    } else if (matchesKey(data, "home")) {
      this.selected = 0;
    } else if (matchesKey(data, "end")) {
      this.selected = Math.max(0, this.filtered.length - 1);
    } else if (matchesKey(data, "enter") || matchesKey(data, "return")) {
      const item = this.filtered[this.selected];
      if (item) {
        this.done(item.name);
        return; // closing overlay
      }
    } else if (matchesKey(data, "escape") || matchesKey(data, "esc") || matchesKey(data, "ctrl+c")) {
      this.done(null);
      return;
    } else if (matchesKey(data, "backspace")) {
      if (this.query.length > 0) {
        this.query = this.query.slice(0, -1);
        this.refilter();
      }
    } else if (matchesKey(data, "ctrl+u")) {
      this.query = "";
      this.refilter();
    } else {
      // Printable character → append to query
      const code = data.charCodeAt(0);
      if (data.length >= 1 && code >= 32 && code !== 127) {
        this.query += data;
        this.refilter();
      }
    }
    this.tui.requestRender();
  }

  private renderRow(item: PanelItem, isSelected: boolean, width: number): string {
    const t = this.theme;
    const prefix = isSelected ? t.fg("accent", "▸ ") : "  ";
    const nameRaw = "/" + item.label;
    const nameField = padToWidth(
      isSelected ? t.bold(nameRaw) : sourceColor(t, item.source, nameRaw),
      this.nameCol,
    );

    const tagCol = 4;
    const tag = padToWidth(t.fg("dim", sourceTag(item.source)), tagCol);
    const descWidth = width - 2 - this.nameCol - tagCol - 2; // prefix + name + tag + 2 gaps
    let descField = "";
    if (descWidth >= 6 && item.description) {
      descField = "  " + padToWidth(t.fg("muted", item.description), descWidth);
    }

    let line = prefix + nameField + " " + tag + descField;
    line = padToWidth(line, width);
    if (isSelected) line = t.bg("selectedBg", line);
    return line;
  }

  render(width: number): string[] {
    const t = this.theme;
    // Reserve 2 columns for the left/right border so content fits inside the box.
    const innerWidth = Math.max(0, width - 2);
    const lines: string[] = [];

    // Title
    const title = t.fg("accent", t.bold(" Command Panel"));
    const hint = t.fg("dim", "  type to filter · ↑↓ select · ⏎ run · esc cancel");
    lines.push(padToWidth(title + hint, innerWidth));

    // Separator
    lines.push(padToWidth(t.fg("border", "─".repeat(innerWidth)), innerWidth));

    // Search line with cursor
    const prompt = t.fg("accent", "> ");
    const q = this.query.length > 0 ? t.fg("text", this.query) : "";
    const cursor = t.bg("selectedBg", " ");
    lines.push(padToWidth(prompt + q + cursor, innerWidth));

    // List
    if (this.filtered.length === 0) {
      lines.push(padToWidth(t.fg("warning", "  No matching commands"), innerWidth));
    } else {
      const max = this.maxVisible;
      let start = this.selected - Math.floor(max / 2);
      start = Math.max(0, Math.min(start, Math.max(0, this.filtered.length - max)));
      const end = Math.min(start + max, this.filtered.length);
      for (let i = start; i < end; i++) {
        lines.push(this.renderRow(this.filtered[i]!, i === this.selected, innerWidth));
      }
    }

    // Separator
    lines.push(padToWidth(t.fg("border", "─".repeat(innerWidth)), innerWidth));

    // Footer
    const count = `${this.filtered.length}/${this.items.length}`;
    const footer = t.fg("dim", ` ${count}   ⏎ run · esc cancel · ⌫ delete char · ctrl+u clear`);
    lines.push(padToWidth(footer, innerWidth));

    // Wrap the content in a box border (top/bottom rails + side walls).
    const side = t.fg("border", "│");
    const out: string[] = [t.fg("border", "┌" + "─".repeat(innerWidth) + "┐")];
    for (const line of lines) out.push(side + line + side);
    out.push(t.fg("border", "└" + "─".repeat(innerWidth) + "┘"));
    return out;
  }

  invalidate(): void {
    // No caching — render is always fresh.
  }
}

function submitHint(): string {
  try {
    const k = keyText("tui.input.submit").split("/")[0];
    return k ? `press ${k}` : "press submit";
  } catch {
    return "press submit";
  }
}

/**
 * Run the chosen command by dispatching it through the editor's onSubmit
 * handler (pi's unified command dispatcher). Runs immediately on Enter —
 * the command is never just filled into the editor.
 */
async function runCommand(ctx: PanelCtx, tui: TuiLike | null, item: PanelItem): Promise<void> {
  // After the overlay closes, the TUI restores focus to the editor, so the
  // focused component is the editor instance. `focusedComponent` is private at
  // the type level but present at runtime.
  const editor = (tui as { focusedComponent?: { onSubmit?: (text: string) => void } } | null)
    ?.focusedComponent;
  const onSubmit = editor?.onSubmit;

  if (typeof onSubmit !== "function") {
    // Fallback (should not happen): prefill and let the user submit.
    ctx.ui.setEditorText("/" + item.name + " ");
    ctx.ui.notify(`/${item.label} — ${submitHint()} to run`, "info");
    return;
  }

  const navigating = NAVIGATING.has(item.name);
  const draft = ctx.ui.getEditorText();

  try {
    if (navigating) {
      // These change/destroy the session context; awaiting may invalidate ctx,
      // so fire-and-forget and do not touch the editor afterward.
      void Promise.resolve(onSubmit("/" + item.name));
    } else {
      await onSubmit("/" + item.name);
      // onSubmit clears the editor for built-in commands; restore the draft so
      // commands invoked mid-typing don't lose in-progress text.
      ctx.ui.setEditorText(draft);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!navigating) {
      ctx.ui.notify(`/${item.label} failed: ${msg}`, "error");
    }
  }
}

export default function commandPanelExtension(pi: ExtensionAPI): void {
  // Also expose as /panel for discoverability (filtered out of the list).
  pi.registerCommand("panel", {
    description: "Open the command panel",
    handler: async (_args, ctx) => {
      await openPanel(pi, ctx);
    },
  });

  pi.registerShortcut("ctrl+p", {
    description: "Open command panel",
    handler: async (ctx) => {
      await openPanel(pi, ctx);
    },
  });
}

async function openPanel(pi: ExtensionAPI, ctx: PanelCtx): Promise<void> {
  const items = buildItems(pi);
  let capturedTui: TuiLike | null = null;

  const chosen = await ctx.ui.custom<string | null>(
    (tui, theme, _keybindings, done) => {
      capturedTui = tui;
      const panel = new CommandPanel(items, theme, tui, done);
      return {
        render: (w: number) => panel.render(w),
        invalidate: () => panel.invalidate(),
        handleInput: (d: string) => {
          panel.handleInput(d);
        },
      };
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: "72%",
        minWidth: 52,
        margin: 1,
      },
    },
  );

  if (!chosen) return;
  const item = items.find((i) => i.name === chosen);
  if (!item) return;
  await runCommand(ctx, capturedTui, item);
}
