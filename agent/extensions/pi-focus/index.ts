/**
 * pi-focus — the single DEC 1004 focus-reporting owner for pi extensions.
 *
 * In TUI mode it enables terminal focus reporting (ESC[?1004h), consumes the
 * resulting ESC[I (focused) / ESC[O (unfocused) input, and broadcasts:
 *
 *   channel: "pi-focus:change"
 *   payload: { focused: boolean }
 *
 * Other extensions subscribe through pi.events and must not enable or consume
 * DEC 1004 themselves. Inside tmux, `set -g focus-events on` is required for
 * pane/window switches to be forwarded to the active application.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as piTui from "@earendil-works/pi-tui";

const FOCUS_CHANNEL = "pi-focus:change";

let active = false;
let focused = true;
let inputUnsub: (() => void) | null = null;

function write1004(enable: boolean): void {
	try { process.stdout.write(enable ? "\x1b[?1004h" : "\x1b[?1004l"); } catch { /* ignore */ }
}

function syncTerminalFocused(next: boolean): void {
	try {
		// pi-tui exports this in current builds; guard for older cached modules
		// so an outdated running process can still reload without crashing.
		const set = (piTui as unknown as { setTerminalFocused?: (focused: boolean) => void }).setTerminalFocused;
		set?.(next);
	} catch { /* ignore */ }
}

function stop(): void {
	if (inputUnsub) {
		inputUnsub();
		inputUnsub = null;
	}
	if (active) write1004(false);
	active = false;
	// Reset the TUI cursor to the focused state when the session/listener stops.
	syncTerminalFocused(true);
}

export default function (pi: ExtensionAPI): void {
	const emitFocus = (): void => {
		pi.events.emit(FOCUS_CHANNEL, { focused });
	};

	const start = (ctx: ExtensionContext): void => {
		stop();
		focused = true; // DEC 1004 reports changes, not a guaranteed initial state.
		syncTerminalFocused(true);
		active = ctx.mode === "tui";
		if (!active) return;

		inputUnsub = ctx.ui.onTerminalInput((data: string) => {
			if (data !== "\x1b[I" && data !== "\x1b[O") return undefined;
			const next = data === "\x1b[I";
			if (next !== focused) {
				focused = next;
				syncTerminalFocused(next);
				emitFocus();
			}
			return { consume: true };
		});

		write1004(true);
		emitFocus();
	};

	pi.on("session_start", (_event, ctx) => start(ctx));
	pi.on("session_shutdown", () => stop());

	pi.registerCommand("pi-focus", {
		description: "Show the shared DEC 1004 focus-listener state",
		handler: async (_args, ctx) => {
			const tmux = process.env.TMUX ? "tmux focus-events must be on" : "not in tmux";
			ctx.ui.notify(
				[
					`active: ${active}`,
					`focused: ${focused}`,
					`channel: ${FOCUS_CHANNEL}`,
					`${tmux}`,
				].join("\n"),
				"info",
			);
		},
	});
}
