import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";

const STATE_ENTRY_TYPE = "pi-message-queue:state";
const STATUS_KEY = "pi-message-queue";
const WIDGET_KEY = "pi-message-queue:widget";
const STATE_VERSION = 1;
const MAX_WIDGET_ITEMS = 5;
const MAX_PREVIEW_LENGTH = 96;

type QueuePosition = "back" | "front";
type QueuedBuiltinCommand = { name: "new" | "reload" };

interface QueuedMessage {
	id: number;
	text: string;
	createdAt: string;
}

interface QueueStateSnapshot {
	version: 1;
	queue: QueuedMessage[];
	paused: boolean;
	nextId: number;
	widgetVisible: boolean;
	updatedAt: string;
}

interface PendingDispatch {
	id: number;
	accepted: boolean;
}

function isQueuedMessage(value: unknown): value is QueuedMessage {
	if (!value || typeof value !== "object") return false;
	const msg = value as Partial<QueuedMessage>;
	return (
		typeof msg.id === "number" &&
		Number.isInteger(msg.id) &&
		msg.id > 0 &&
		typeof msg.text === "string" &&
		msg.text.trim().length > 0 &&
		typeof msg.createdAt === "string"
	);
}

function restoreSnapshot(data: unknown): QueueStateSnapshot | undefined {
	if (!data || typeof data !== "object") return undefined;
	const snapshot = data as Partial<QueueStateSnapshot>;
	if (snapshot.version !== STATE_VERSION) return undefined;
	if (!Array.isArray(snapshot.queue)) return undefined;

	const queue = snapshot.queue.filter(isQueuedMessage);
	const maxId = queue.reduce((max, item) => Math.max(max, item.id), 0);
	const parsedNextId = typeof snapshot.nextId === "number" && Number.isInteger(snapshot.nextId) ? snapshot.nextId : 1;

	return {
		version: STATE_VERSION,
		queue,
		paused: snapshot.paused === true,
		nextId: Math.max(parsedNextId, maxId + 1, 1),
		widgetVisible: snapshot.widgetVisible !== false,
		updatedAt: typeof snapshot.updatedAt === "string" ? snapshot.updatedAt : new Date().toISOString(),
	};
}

function preview(text: string, maxLength = MAX_PREVIEW_LENGTH): string {
	const singleLine = text.replace(/\s+/g, " ").trim();
	if (singleLine.length <= maxLength) return singleLine;
	return `${singleLine.slice(0, Math.max(0, maxLength - 1))}…`;
}

function formatQueue(queue: QueuedMessage[], paused: boolean): string {
	if (queue.length === 0) return paused ? "Queue is empty and paused." : "Queue is empty.";

	const header = `${paused ? "Paused" : "Ready"}: ${queue.length} queued message${queue.length === 1 ? "" : "s"}`;
	const items = queue.map((item, index) => `${index + 1}. #${item.id} ${preview(item.text, 140)}`);
	return [header, ...items].join("\n");
}

function getQueuedBuiltinCommand(text: string): QueuedBuiltinCommand | undefined {
	const trimmed = text.trim();
	if (trimmed === "/new") return { name: "new" };
	if (trimmed === "/reload") return { name: "reload" };
	return undefined;
}

function hasCommandContext(ctx: ExtensionContext): ctx is ExtensionCommandContext {
	return (
		"newSession" in ctx &&
		typeof ctx.newSession === "function" &&
		"reload" in ctx &&
		typeof ctx.reload === "function"
	);
}

class MessageQueueEditor extends CustomEditor {
	constructor(
		tui: TUI,
		theme: EditorTheme,
		private readonly keybindingsManager: KeybindingsManager,
		private readonly queueBuiltinCommand: (text: string) => boolean,
	) {
		super(tui, theme, keybindingsManager);
	}

	handleInput(data: string): void {
		if (this.keybindingsManager.matches(data, "tui.input.submit") && !this.isShowingAutocomplete()) {
			const text = this.getExpandedText();
			if (this.queueBuiltinCommand(text)) {
				this.setText("");
				return;
			}
		}

		super.handleInput(data);
	}
}

function splitCommand(args: string): { command: string; rest: string } {
	const trimmed = args.trim();
	if (!trimmed) return { command: "list", rest: "" };

	const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
	if (!match) return { command: "list", rest: "" };

	const head = match[1]!.toLowerCase();
	const rest = match[2]?.trim() ?? "";
	const known = new Set([
		"add",
		"push",
		"enqueue",
		"next",
		"front",
		"list",
		"ls",
		"status",
		"clear",
		"pause",
		"stop",
		"resume",
		"start",
		"remove",
		"rm",
		"delete",
		"del",
		"edit",
		"edit-last",
		"show",
		"hide",
		"help",
	]);

	if (!known.has(head)) {
		return { command: "add", rest: trimmed };
	}

	return { command: head, rest };
}

export default function messageQueueExtension(pi: ExtensionAPI) {
	let queue: QueuedMessage[] = [];
	let paused = false;
	let nextId = 1;
	let widgetVisible = true;
	let dispatching: PendingDispatch | undefined;
	let pumpHandle: ReturnType<typeof setImmediate> | undefined;
	// pi.sendUserMessage intentionally bypasses slash-command dispatch. Keep the latest
	// /queue command context so delayed built-in commands can use Pi's command API once idle.
	let lastCommandCtx: ExtensionCommandContext | undefined;
	const commandContextNoticeIds = new Set<number>();

	function snapshot(): QueueStateSnapshot {
		return {
			version: STATE_VERSION,
			queue: [...queue],
			paused,
			nextId,
			widgetVisible,
			updatedAt: new Date().toISOString(),
		};
	}

	function persist() {
		pi.appendEntry(STATE_ENTRY_TYPE, snapshot());
	}

	function updateUi(ctx: ExtensionContext, _note?: string) {
		if (!ctx.hasUI) return;

		const theme = ctx.ui.theme;
		const count = queue.length;
		if (count === 0) {
			const status = dispatching
				? theme.fg("accent", "↗ queue sending")
				: paused
					? theme.fg("warning", "queue paused")
					: undefined;
			ctx.ui.setStatus(STATUS_KEY, status);
			ctx.ui.setWidget(WIDGET_KEY, undefined, { placement: "belowEditor" });
			return;
		}

		const statusTone = paused ? "warning" : dispatching ? "accent" : "muted";
		const statusText = `${paused ? "⏸" : dispatching ? "↗" : "↦"} queue ${count}`;
		ctx.ui.setStatus(STATUS_KEY, theme.fg(statusTone, statusText));

		if (!widgetVisible) {
			ctx.ui.setWidget(WIDGET_KEY, undefined, { placement: "belowEditor" });
			return;
		}

		const titleText = `Queued follow-up inputs${paused ? " (paused)" : ""}`;
		const lines = [`${theme.fg("dim", "•")} ${theme.bold(theme.fg(paused ? "warning" : "text", titleText))}`];

		for (const item of queue.slice(0, MAX_WIDGET_ITEMS)) {
			lines.push(`  ${theme.fg("dim", "↳")} ${theme.fg("muted", theme.italic(preview(item.text)))}`);
		}

		if (queue.length > MAX_WIDGET_ITEMS) {
			lines.push(theme.fg("dim", `  … ${queue.length - MAX_WIDGET_ITEMS} more queued inputs`));
		}

		lines.push(theme.fg("dim", "    shift + ← edit last queued message"));

		ctx.ui.setWidget(WIDGET_KEY, lines, { placement: "belowEditor" });
	}

	function restore(ctx: ExtensionContext) {
		queue = [];
		paused = false;
		nextId = 1;
		widgetVisible = true;
		dispatching = undefined;
		lastCommandCtx = undefined;
		commandContextNoticeIds.clear();
		if (pumpHandle) clearImmediate(pumpHandle);
		pumpHandle = undefined;

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE) continue;
			const restored = restoreSnapshot(entry.data);
			if (!restored) continue;
			queue = restored.queue;
			paused = restored.paused;
			nextId = restored.nextId;
			widgetVisible = restored.widgetVisible;
		}

		updateUi(ctx);
	}

	function enqueue(text: string, position: QueuePosition, ctx: ExtensionContext): QueuedMessage | undefined {
		const trimmed = text.trim();
		if (!trimmed) {
			ctx.ui.notify("Nothing to queue.", "warning");
			return undefined;
		}

		const item: QueuedMessage = {
			id: nextId++,
			text: trimmed,
			createdAt: new Date().toISOString(),
		};

		if (position === "front") queue.unshift(item);
		else queue.push(item);

		persist();
		updateUi(ctx, position === "front" ? `queued #${item.id} at front` : `queued #${item.id}`);
		return item;
	}

	function removeQueued(selector: string): QueuedMessage | undefined {
		const trimmed = selector.trim();
		if (!trimmed) return undefined;

		let index = -1;
		if (trimmed.startsWith("#")) {
			const id = Number.parseInt(trimmed.slice(1), 10);
			if (Number.isInteger(id)) index = queue.findIndex((item) => item.id === id);
		} else {
			const position = Number.parseInt(trimmed, 10);
			if (Number.isInteger(position) && position > 0) index = position - 1;
		}

		if (index < 0 || index >= queue.length) return undefined;
		const [removed] = queue.splice(index, 1);
		return removed;
	}

	function editLastQueued(ctx: ExtensionContext): boolean {
		if (!ctx.hasUI) return false;
		const last = queue.at(-1);
		if (!last) {
			ctx.ui.notify("No queued messages to edit.", "info");
			return false;
		}

		if (ctx.ui.getEditorText().trim()) {
			ctx.ui.notify("Clear the editor before editing a queued message.", "warning");
			return false;
		}

		queue.pop();
		persist();
		ctx.ui.setEditorText(last.text);
		updateUi(ctx, `editing #${last.id}`);
		ctx.ui.notify(`Restored queued message #${last.id} to the editor.`, "info");
		return true;
	}

	function schedulePump(ctx: ExtensionContext) {
		if (pumpHandle) return;
		pumpHandle = setImmediate(() => {
			pumpHandle = undefined;
			void pump(ctx);
		});
	}

	function getDispatchBlocker(ctx: ExtensionContext): string | undefined {
		if (!ctx.model) {
			return "No model is selected. Select a model before resuming the message queue.";
		}

		if (!ctx.modelRegistry.hasConfiguredAuth(ctx.model)) {
			return `No configured auth for "${ctx.model.provider}". Fix authentication before resuming the message queue.`;
		}

		return undefined;
	}

	function rememberCommandContext(ctx: ExtensionCommandContext) {
		lastCommandCtx = ctx;
	}

	function getCommandContext(ctx: ExtensionContext): ExtensionCommandContext | undefined {
		if (hasCommandContext(ctx)) {
			rememberCommandContext(ctx);
			return ctx;
		}

		return lastCommandCtx;
	}

	function queueBuiltinCommandWhileWorking(text: string, ctx: ExtensionContext): boolean {
		const trimmed = text.trim();
		const isWorking = !ctx.isIdle() || ctx.hasPendingMessages();
		if (!isWorking || !getQueuedBuiltinCommand(trimmed)) return false;

		const item = enqueue(trimmed, "back", ctx);
		if (item) {
			ctx.ui.notify(`Queued #${item.id} while Pi is working.`, "info");
			schedulePump(ctx);
		}
		return true;
	}

	async function dispatchQueuedBuiltinCommand(
		item: QueuedMessage,
		command: QueuedBuiltinCommand,
		ctx: ExtensionContext,
	): Promise<boolean> {
		const commandCtx = getCommandContext(ctx);
		if (!commandCtx) {
			if (!commandContextNoticeIds.has(item.id)) {
				commandContextNoticeIds.add(item.id);
				ctx.ui.notify(
					`Queued /${command.name} needs a command-capable context. Run /queue resume after Pi is idle to dispatch it.`,
					"warning",
				);
			}
			return true;
		}

		const current = queue[0];
		if (!current || current.id !== item.id) return true;

		queue.shift();
		commandContextNoticeIds.delete(item.id);
		persist();
		updateUi(ctx, `running /${command.name}`);
		ctx.ui.notify(`Running queued /${command.name}.`, "info");

		try {
			if (command.name === "new") {
				const result = await commandCtx.newSession();
				if (result.cancelled) {
					queue.unshift(item);
					persist();
					updateUi(ctx, "cancelled /new");
					ctx.ui.notify("Queued /new was cancelled.", "warning");
				}
				return true;
			}

			await commandCtx.reload();
			return true;
		} catch (error) {
			queue.unshift(item);
			persist();
			updateUi(ctx, `failed to run /${command.name}`);
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Message queue failed to run /${command.name}: ${message}`, "error");
			return true;
		}
	}

	async function pump(ctx: ExtensionContext) {
		updateUi(ctx);
		if (dispatching || paused || queue.length === 0) return;
		if (!ctx.isIdle() || ctx.hasPendingMessages()) return;

		const next = queue[0];
		if (!next) return;

		const builtinCommand = getQueuedBuiltinCommand(next.text);
		if (builtinCommand) {
			await dispatchQueuedBuiltinCommand(next, builtinCommand, ctx);
			return;
		}

		const blocker = getDispatchBlocker(ctx);
		if (blocker) {
			ctx.ui.notify(blocker, "warning");
			return;
		}

		dispatching = { id: next.id, accepted: false };
		updateUi(ctx, `sending #${next.id}`);

		try {
			pi.sendUserMessage(next.text);
		} catch (error) {
			dispatching = undefined;
			updateUi(ctx, `failed to send #${next.id}`);
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Message queue failed to send #${next.id}: ${message}`, "error");
		}
	}

	function acceptPendingDispatch(ctx: ExtensionContext) {
		if (!dispatching || dispatching.accepted) return;

		const pending = dispatching;
		const next = queue[0];
		if (!next || next.id !== pending.id) {
			dispatching = undefined;
			updateUi(ctx);
			return;
		}

		queue.shift();
		dispatching = { ...pending, accepted: true };
		persist();
		updateUi(ctx, `accepted #${pending.id}`);
	}

	async function handleQueueCommand(args: string, ctx: ExtensionCommandContext) {
		rememberCommandContext(ctx);
		const { command, rest } = splitCommand(args);

		switch (command) {
			case "add":
			case "push":
			case "enqueue": {
				const item = enqueue(rest, "back", ctx);
				if (item) {
					ctx.ui.notify(`Queued #${item.id}.`, "info");
					schedulePump(ctx);
				}
				return;
			}

			case "next":
			case "front": {
				const item = enqueue(rest, "front", ctx);
				if (item) {
					ctx.ui.notify(`Queued #${item.id} at the front.`, "info");
					schedulePump(ctx);
				}
				return;
			}

			case "list":
			case "ls":
			case "status":
				updateUi(ctx);
				ctx.ui.notify(formatQueue(queue, paused), "info");
				return;

			case "pause":
			case "stop":
				paused = true;
				persist();
				updateUi(ctx, "paused");
				ctx.ui.notify("Message queue paused.", "info");
				return;

			case "resume":
			case "start":
				paused = false;
				persist();
				updateUi(ctx, "resumed");
				ctx.ui.notify("Message queue resumed.", "info");
				schedulePump(ctx);
				return;

			case "clear": {
				const count = queue.length;
				queue = [];
				persist();
				updateUi(ctx);
				ctx.ui.notify(`Cleared ${count} queued message${count === 1 ? "" : "s"}.`, "info");
				return;
			}

			case "remove":
			case "rm":
			case "delete":
			case "del": {
				const removed = removeQueued(rest);
				if (!removed) {
					ctx.ui.notify("Usage: /queue remove <position> or /queue remove #<id>", "warning");
					return;
				}
				persist();
				updateUi(ctx, `removed #${removed.id}`);
				ctx.ui.notify(`Removed #${removed.id}.`, "info");
				return;
			}

			case "edit":
			case "edit-last":
				editLastQueued(ctx);
				return;

			case "show":
				widgetVisible = true;
				persist();
				updateUi(ctx, "widget shown");
				return;

			case "hide":
				widgetVisible = false;
				persist();
				updateUi(ctx);
				ctx.ui.notify("Message queue widget hidden. Status still appears in the footer.", "info");
				return;

			case "help":
				ctx.ui.notify(
					[
						"/queue <message> or /queue add <message> — append",
						"/queue next <message> — put at front",
						"/queue list | pause | resume | clear | remove <n|#id>",
						"/queue edit-last or Shift+Left — edit the last queued message",
						"Queued /new and /reload entries run as Pi commands.",
						"/q <message> is a short alias. Ctrl+Shift+Q queues editor text.",
					].join("\n"),
					"info",
				);
				return;
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		restore(ctx);
		ctx.ui.setEditorComponent((tui, theme, keybindings) =>
			new MessageQueueEditor(tui, theme, keybindings, (text) => queueBuiltinCommandWhileWorking(text, ctx)),
		);
		schedulePump(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		restore(ctx);
		schedulePump(ctx);
	});

	pi.on("agent_start", async (_event, ctx) => {
		updateUi(ctx);
	});

	pi.on("input", async (event, ctx) => {
		const text = event.text.trim();
		const isWorking = !ctx.isIdle() || ctx.hasPendingMessages();
		if (event.source === "extension" || !isWorking || !text || text.startsWith("/")) {
			return { action: "continue" };
		}

		const item = enqueue(text, "back", ctx);
		if (item) {
			ctx.ui.notify(`Queued #${item.id} while Pi is working.`, "info");
			schedulePump(ctx);
		}

		return { action: "handled" };
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		acceptPendingDispatch(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		dispatching = undefined;
		updateUi(ctx);
		schedulePump(ctx);
	});

	pi.on("session_shutdown", async () => {
		dispatching = undefined;
		lastCommandCtx = undefined;
		commandContextNoticeIds.clear();
		if (pumpHandle) clearImmediate(pumpHandle);
		pumpHandle = undefined;
	});

	pi.registerCommand("queue", {
		description: "Queue user messages and send them to pi one after another",
		getArgumentCompletions: (prefix) => {
			const commands = [
				"add",
				"next",
				"list",
				"pause",
				"resume",
				"clear",
				"remove",
				"edit-last",
				"show",
				"hide",
				"help",
			];
			const token = prefix.trimStart().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
			if (prefix.trimStart().includes(" ")) return null;
			const matches = commands.filter((command) => command.startsWith(token));
			return matches.length > 0 ? matches.map((command) => ({ value: command, label: command })) : null;
		},
		handler: async (args, ctx) => handleQueueCommand(args, ctx),
	});

	pi.registerCommand("q", {
		description: "Shortcut for /queue add <message>",
		handler: async (args, ctx) => handleQueueCommand(args.trim() ? `add ${args}` : "list", ctx),
	});

	pi.registerShortcut("ctrl+shift+q", {
		description: "Queue current editor text for later execution",
		handler: async (ctx) => {
			if (!ctx.hasUI) return;
			const text = ctx.ui.getEditorText();
			const item = enqueue(text, "back", ctx);
			if (!item) return;
			ctx.ui.setEditorText("");
			ctx.ui.notify(`Queued #${item.id}.`, "info");
			schedulePump(ctx);
		},
	});

	pi.registerShortcut("shift+left", {
		description: "Edit the last queued message",
		handler: async (ctx) => {
			editLastQueued(ctx);
		},
	});
}
