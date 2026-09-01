/**
 * pi-prompt — user-defined prompt snippets invoked via slash commands.
 *
 * Every file in ./prompts/ (*.md, *.txt, *.prompt) becomes a command:
 *
 *     /prompt:<filename>        insert the prompt text into the input box
 *     /prompt                   list available prompts and pick one
 *     /prompt <name>            insert a specific prompt directly
 *
 * The prompt text lands in the editor for review/editing before you send.
 * It is never auto-read by the agent and never sent without you pressing Enter —
 * unlike skills, which the agent may load on its own.
 *
 * Optional first line in a prompt file:
 *
 *     description: Commit and push current changes
 *
 * becomes the command's description (shown in `/` autocomplete).
 *
 * Add or edit prompt files at any time, then run /reload to pick them up.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROMPT_EXTS = new Set([".md", ".txt", ".prompt"]);
const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "prompts");
const COMMAND_NAME = "prompt";

interface PromptDef {
  name: string;
  description: string;
  body: string;
}

/** Parse an optional `description: ...` first line; the rest of the file is the prompt body. */
function parsePromptFile(content: string): { description: string; body: string } {
  const lines = content.split("\n");
  const match = (lines[0] ?? "").match(/^\s*description\s*:\s*(.+)\s*$/);
  if (match) {
    return { description: match[1].trim(), body: lines.slice(1).join("\n").trim() };
  }
  return { description: "", body: content.trim() };
}

export default async function piPrompt(pi: ExtensionAPI) {
  const prompts = new Map<string, PromptDef>();

  /** Scan the prompts directory and rebuild the registry. */
  async function loadPrompts(): Promise<void> {
    prompts.clear();

    let files: string[];
    try {
      files = await readdir(PROMPTS_DIR);
    } catch {
      return; // prompts directory does not exist yet
    }

    for (const file of files.sort()) {
      const ext = extname(file).toLowerCase();
      if (!PROMPT_EXTS.has(ext)) continue;

      const name = basename(file, ext);
      if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) continue; // keep command names safe

      try {
        const { description, body } = parsePromptFile(await readFile(join(PROMPTS_DIR, file), "utf8"));
        if (!body) continue; // empty prompt
        if (!prompts.has(name)) prompts.set(name, { name, description, body });
      } catch {
        // unreadable file: skip it
      }
    }
  }

  /** Put the prompt text into the input box so the user can review/edit before sending. */
  function insertPrompt(prompt: PromptDef, ctx: ExtensionCommandContext): void {
    if (ctx.mode !== "tui") {
      // No input box to fill outside interactive mode.
      if (ctx.hasUI) {
        ctx.ui.notify(
          `Prompt "${prompt.name}" can only be inserted into the input box in interactive mode.`,
          "info",
        );
      }
      return;
    }

    const existing = ctx.ui.getEditorText();
    const text = existing.trim()
      ? `${existing.replace(/\s+$/, "")}\n\n${prompt.body}`
      : prompt.body;
    ctx.ui.setEditorText(text);
    ctx.ui.notify(`Prompt "${prompt.name}" inserted — review, edit, then send.`, "info");
  }

  await loadPrompts();

  // Register one command per configured prompt: /prompt:<name>
  for (const prompt of prompts.values()) {
    pi.registerCommand(`${COMMAND_NAME}:${prompt.name}`, {
      description: prompt.description || `Insert prompt "${prompt.name}" into the input box`,
      handler: async (_args, ctx) => insertPrompt(prompt, ctx),
    });
  }

  // Bare /prompt: list & pick, or /prompt <name> to insert directly
  pi.registerCommand(COMMAND_NAME, {
    description: "Insert a configured prompt into the input box",
    getArgumentCompletions: (prefix) => {
      const matches = [...prompts.keys()].filter((n) => n.startsWith(prefix));
      return matches.length > 0 ? matches.map((n) => ({ value: n, label: n })) : null;
    },
    handler: async (args, ctx) => {
      const arg = args.trim();

      if (arg) {
        const prompt = prompts.get(arg);
        if (prompt) {
          insertPrompt(prompt, ctx);
        } else {
          ctx.ui.notify(`Unknown prompt "${arg}". Available: ${[...prompts.keys()].join(", ")}`, "error");
        }
        return;
      }

      const names = [...prompts.keys()];
      if (names.length === 0) {
        ctx.ui.notify(`No prompts configured. Add files to ${PROMPTS_DIR} and run /reload.`, "info");
        return;
      }

      const selected = await ctx.ui.select("Available prompts:", names);
      if (selected && prompts.has(selected)) insertPrompt(prompts.get(selected)!, ctx);
    },
  });

  // Catch unknown /prompt:<name> before it reaches the agent.
  pi.on("input", async (event, ctx) => {
    if (!event.text.startsWith(`/${COMMAND_NAME}:`)) return { action: "continue" };
    if (!ctx.hasUI) return { action: "continue" }; // non-interactive: let it pass through

    const name = event.text.slice(COMMAND_NAME.length + 2).split(/\s+/)[0] ?? "";
    if (prompts.has(name)) return { action: "continue" }; // registered command, not our concern

    const names = [...prompts.keys()];
    ctx.ui.notify(
      names.length === 0
        ? `No prompts configured. Add files to ${PROMPTS_DIR} and run /reload.`
        : name
          ? `Unknown prompt "${name}". Available: ${names.join(", ")}`
          : `Available prompts: ${names.join(", ")}`,
      "error",
    );
    return { action: "handled" };
  });
}
