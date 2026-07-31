/**
 * Command Panel Extension
 *
 * Opens a fuzzy-searchable command panel via Ctrl+P or when `/` is the first
 * editor input.
 *
 * - Ctrl+P (main editor) ........... open panel
 * - / (start of main editor) ....... open panel
 * - type in the editor ............. fuzzy-filter across name + description
 * - ↑↓ ............................. navigate (also Ctrl+P / Ctrl+N)
 * - Tab ............................ complete `/<cmd> ` and close panel
 * - Enter .......................... run the selected command immediately
 * - Esc / Ctrl+C ................... cancel and keep the editor text
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
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CustomEditor, keyText, type Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  fuzzyFilter,
  getKeybindings,
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

type PanelAction = { name: string; commandText: string } | null;

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
  setFocus: (component: Component | null) => void;
  addInputListener: (
    listener: (data: string) => { consume?: boolean; data?: string } | undefined,
  ) => () => void;
}

interface EditorLike extends Component {
  getText: () => string;
  setText: (text: string) => void;
  isShowingAutocomplete: () => boolean;
  onSubmit?: (text: string) => void | Promise<void>;
}

class CommandPanelEditor extends CustomEditor {
  onPanelTrigger?: () => void;

  override handleInput(data: string): void {
    const cursor = this.getCursor();
    if (
      this.onPanelTrigger &&
      matchesKey(data, "/") &&
      this.getText().length === 0 &&
      cursor.line === 0 &&
      cursor.col === 0
    ) {
      this.onPanelTrigger();
      return;
    }
    super.handleInput(data);
  }
}

interface PanelCtx {
  ui: {
    setEditorText: (s: string) => void;
    getEditorText: () => string;
    notify: (m: string, t?: "info" | "warning" | "error") => void;
    setWidget: (
      key: string,
      content: ((tui: TuiLike, theme: Theme) => Component) | undefined,
      options?: { placement?: "aboveEditor" | "belowEditor" },
    ) => void;
  };
}

/**
 * The panel component. Implements the pi-tui Component interface.
 * Render is computed fresh every frame (no caching) so selection changes
 * always reflect immediately.
 */
class CommandPanel implements Component {
  private items: PanelItem[];
  private theme: Theme;
  private tui: TuiLike;
  private done: (item: PanelItem | null) => void;
  private complete: (item: PanelItem) => void;

  private filtered: PanelItem[];
  private filterQuery = "";
  private selected = 0;
  private readonly maxVisible = 10;
  private readonly nameCol: number;

  constructor(
    items: PanelItem[],
    theme: Theme,
    tui: TuiLike,
    done: (item: PanelItem | null) => void,
    complete: (item: PanelItem) => void,
  ) {
    this.items = items;
    this.theme = theme;
    this.tui = tui;
    this.done = done;
    this.complete = complete;
    this.filtered = [...items].reverse();
    this.selected = Math.max(0, this.filtered.length - 1);

    let maxName = 8;
    for (const it of items) {
      const w = visibleWidth("/" + it.label);
      if (w > maxName) maxName = w;
    }
    this.nameCol = Math.min(maxName, 26);
  }

  setQuery(query: string): void {
    const trimmed = query.trimStart();
    const commandMatch = trimmed.match(/^\/([^\s]*)/);
    const filterQuery = (commandMatch ? commandMatch[1]! : trimmed).trim();
    if (filterQuery === this.filterQuery) return;

    this.filterQuery = filterQuery;
    const ranked = filterQuery
      ? fuzzyFilter(this.items, filterQuery, (it) => `${it.label} ${it.name} ${it.description}`)
      : [...this.items];
    this.filtered = ranked.reverse();
    this.selected = Math.max(0, this.filtered.length - 1);
  }

  handlePanelInput(data: string): boolean {
    const kb = getKeybindings();

    // Follow pi's selection bindings, with Ctrl+P/Ctrl+N as panel extras.
    if (kb.matches(data, "tui.select.up") || matchesKey(data, "ctrl+p")) {
      if (this.filtered.length > 0) {
        this.selected = (this.selected - 1 + this.filtered.length) % this.filtered.length;
      }
    } else if (kb.matches(data, "tui.select.down") || matchesKey(data, "ctrl+n")) {
      if (this.filtered.length > 0) {
        this.selected = (this.selected + 1) % this.filtered.length;
      }
    } else if (kb.matches(data, "tui.select.pageUp")) {
      this.selected = Math.max(0, this.selected - this.maxVisible);
    } else if (kb.matches(data, "tui.select.pageDown")) {
      this.selected = Math.min(
        Math.max(0, this.filtered.length - 1),
        this.selected + this.maxVisible,
      );
    } else if (kb.matches(data, "tui.select.confirm")) {
      const item = this.filtered[this.selected];
      if (item) {
        this.done(item);
        return true;
      }
    } else if (kb.matches(data, "tui.input.tab")) {
      const item = this.filtered[this.selected];
      if (item) {
        this.complete(item);
        return true;
      }
    } else if (kb.matches(data, "tui.select.cancel")) {
      this.done(null);
      return true;
    } else {
      return false;
    }

    this.tui.requestRender();
    return true;
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
    const lines: string[] = [];
    const count = `${this.filtered.length}/${this.items.length}`;
    const completeKey = keyText("tui.input.tab") || "tab";

    // Keep all panel metadata in the header; the list has no side or bottom frame.
    const title = t.fg("accent", t.bold(" Command Panel"));
    const hint = t.fg("dim", `  ${count}   ${completeKey} complete · ⏎ run · esc cancel`);
    lines.push(t.fg("border", "─".repeat(width)));
    lines.push(padToWidth(title + hint, width));
    lines.push(t.fg("border", "─".repeat(width)));

    if (this.filtered.length === 0) {
      lines.push(padToWidth(t.fg("warning", "  No matching commands"), width));
    } else {
      const max = this.maxVisible;
      let start = this.selected - Math.floor(max / 2);
      start = Math.max(0, Math.min(start, Math.max(0, this.filtered.length - max)));
      const end = Math.min(start + max, this.filtered.length);
      for (let i = start; i < end; i++) {
        lines.push(this.renderRow(this.filtered[i]!, i === this.selected, width));
      }
    }

    return lines;
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
async function runCommand(
  ctx: PanelCtx,
  tui: TuiLike | null,
  item: PanelItem,
  commandText: string,
): Promise<void> {
  // The widget closes with focus on the editor. `focusedComponent` is private
  // at the type level but present at runtime.
  const editor = (tui as { focusedComponent?: { onSubmit?: (text: string) => void } } | null)
    ?.focusedComponent;
  const onSubmit = editor?.onSubmit;

  if (typeof onSubmit !== "function") {
    // Fallback (should not happen): prefill and let the user submit.
    ctx.ui.setEditorText(commandText + (commandText.endsWith(" ") ? "" : " "));
    ctx.ui.notify(`/${item.label} — ${submitHint()} to run`, "info");
    return;
  }

  const navigating = NAVIGATING.has(item.name);
  const draft = ctx.ui.getEditorText();

  try {
    if (navigating) {
      // These change/destroy the session context; awaiting may invalidate ctx,
      // so fire-and-forget and do not touch the editor afterward.
      void Promise.resolve(onSubmit(commandText));
    } else {
      await onSubmit(commandText);
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
  let isOpen = false;
  const showPanel = async (ctx: PanelCtx, initialText = ""): Promise<void> => {
    if (isOpen) return;
    isOpen = true;
    try {
      await openPanel(pi, ctx, initialText);
    } finally {
      isOpen = false;
    }
  };

  // Also expose as /panel for RPC/programmatic invocation (filtered from the list).
  pi.registerCommand("panel", {
    description: "Open the command panel",
    handler: async (_args, ctx) => {
      await showPanel(ctx);
    },
  });

  pi.registerShortcut("ctrl+p", {
    description: "Open command panel",
    handler: async (ctx) => {
      await showPanel(ctx);
    },
  });

  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      const editor = new CommandPanelEditor(tui, theme, keybindings);
      editor.onPanelTrigger = () => {
        void showPanel(ctx, "/");
      };
      return editor;
    });
  });
}

async function openPanel(
  pi: ExtensionAPI,
  ctx: PanelCtx,
  initialText = "",
): Promise<void> {
  const items = buildItems(pi);
  const draft = ctx.ui.getEditorText();
  let capturedTui: TuiLike | null = null;

  const action = await new Promise<PanelAction>((resolve) => {
    ctx.ui.setWidget(
      "command-panel",
      (tui, theme) => {
        capturedTui = tui;
        const editor = (tui as TuiLike & { focusedComponent?: EditorLike }).focusedComponent;
        if (!editor) {
          resolve(null);
          return { render: () => [], invalidate: () => {} };
        }

        let closed = false;
        let removeInputListener = (): void => {};
        let panel: CommandPanel;

        const close = (item: PanelItem | null): void => {
          if (closed) return;
          closed = true;

          const panelText = editor.getText();
          const editorText = panelText.trim();
          const completedCommand = editorText.match(/^\/(\S+)([\s\S]*)$/);
          const commandText = item && completedCommand?.[1] === item.name
            ? `/${item.name}${completedCommand[2] ?? ""}`.trimEnd()
            : item ? `/${item.name}` : "";

          removeInputListener();
          ctx.ui.setWidget("command-panel", undefined);
          ctx.ui.setEditorText(item ? draft : panelText);
          tui.setFocus(editor);
          tui.requestRender();
          resolve(item ? { name: item.name, commandText } : null);
        };

        const syncFromEditor = (): void => {
          const query = editor.getText();
          // Suppress pi's slash-command popup while the panel owns command-name
          // selection. Argument completion remains native after `/<cmd> `.
          if (/^\/[^\s]*$/.test(query) && editor.isShowingAutocomplete()) {
            editor.setText(query);
          }
          panel.setQuery(query);
          tui.requestRender();
        };

        panel = new CommandPanel(
          items,
          theme,
          tui,
          close,
          (item) => {
            ctx.ui.setEditorText(`/${item.name} `);
            close(null);
          },
        );

        removeInputListener = tui.addInputListener((data) => {
          // Previous keystrokes may have been delivered in the same event-loop
          // batch, before their queued post-editor sync had a chance to run.
          panel.setQuery(editor.getText());

          const kb = getKeybindings();
          const argumentAutocompleteOwnsKey =
            editor.isShowingAutocomplete() &&
            /^\/\S+\s/.test(editor.getText()) &&
            (
              kb.matches(data, "tui.select.up") ||
              kb.matches(data, "tui.select.down") ||
              kb.matches(data, "tui.input.tab") ||
              kb.matches(data, "tui.select.confirm") ||
              kb.matches(data, "tui.select.cancel")
            );

          if (!argumentAutocompleteOwnsKey && panel.handlePanelInput(data)) {
            return { consume: true };
          }

          queueMicrotask(syncFromEditor);
          return undefined;
        });

        ctx.ui.setEditorText(initialText);
        panel.setQuery(initialText);
        tui.setFocus(editor);
        return panel;
      },
      { placement: "aboveEditor" },
    );
  });

  if (!action) return;
  const item = items.find((i) => i.name === action.name);
  if (!item) return;
  await runCommand(ctx, capturedTui, item, action.commandText);
}
