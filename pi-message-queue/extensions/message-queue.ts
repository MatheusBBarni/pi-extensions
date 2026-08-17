import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	CustomEditor,
	stripFrontmatter,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import {
	QueueEngine,
	restoreSnapshot,
	STATE_VERSION,
	workingInputIntent,
	type QueuedBuiltinCommandName,
	type QueuedMessage,
	type QueuePosition,
} from "./queue-engine.js";

const STATE_ENTRY_TYPE = "pi-message-queue:state";
const STATUS_KEY = "pi-message-queue";
const WIDGET_KEY = "pi-message-queue:widget";
const MAX_WIDGET_ITEMS = 5;
const MAX_PREVIEW_LENGTH = 96;
const SEND_CONFIRM_MS = 2000;

type QueuedBuiltinCommand = { name: QueuedBuiltinCommandName };

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

function parseSlashCommand(text: string): { name: string; args: string } | undefined {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/")) return undefined;
	const spaceIndex = trimmed.indexOf(" ");
	const name = spaceIndex === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIndex);
	const args = spaceIndex === -1 ? "" : trimmed.slice(spaceIndex + 1).trim();
	return name ? { name, args } : undefined;
}

function hasCommandContext(ctx: ExtensionContext): ctx is ExtensionCommandContext {
	return (
		"newSession" in ctx &&
		typeof ctx.newSession === "function" &&
		"reload" in ctx &&
		typeof ctx.reload === "function"
	);
}

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info") {
	if (!ctx.hasUI) return;
	ctx.ui.notify(message, type);
}

class MessageQueueEditor extends CustomEditor {
	constructor(
		tui: TUI,
		theme: EditorTheme,
		private readonly keybindingsManager: KeybindingsManager,
		private readonly steerInput: (text: string) => boolean,
	) {
		super(tui, theme, keybindingsManager);
	}

	async dispatchSubmittedText(text: string): Promise<void> {
		const result = this.onSubmit?.(text);
		await Promise.resolve(result);
	}

	handleInput(data: string): void {
		if (this.keybindingsManager.matches(data, "app.message.followUp")) {
			const text = this.getExpandedText();
			if (this.steerInput(text)) {
				this.addToHistory(text);
				this.setText("");
				return;
			}
		}

		super.handleInput(data);
	}
}

function parseCommandArgs(argsString: string): string[] {
	const args: string[] = [];
	let current = "";
	let inQuote: string | undefined;

	for (const char of argsString) {
		if (inQuote) {
			if (char === inQuote) inQuote = undefined;
			else current += char;
		} else if (char === '"' || char === "'") {
			inQuote = char;
		} else if (char === " " || char === "\t") {
			if (current) {
				args.push(current);
				current = "";
			}
		} else {
			current += char;
		}
	}

	if (current) args.push(current);
	return args;
}

function substitutePromptArgs(content: string, args: string[]): string {
	let result = content;
	result = result.replace(/\$(\d+)/g, (_match, num: string) => args[Number.parseInt(num, 10) - 1] ?? "");
	result = result.replace(/\$\{@:(\d+)(?::(\d+))?\}/g, (_match, startStr: string, lengthStr: string | undefined) => {
		const start = Math.max(0, Number.parseInt(startStr, 10) - 1);
		if (lengthStr) return args.slice(start, start + Number.parseInt(lengthStr, 10)).join(" ");
		return args.slice(start).join(" ");
	});
	const allArgs = args.join(" ");
	result = result.replace(/\$ARGUMENTS/g, allArgs);
	result = result.replace(/\$@/g, allArgs);
	return result;
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
		"steer",
	]);

	if (!known.has(head)) {
		return { command: "add", rest: trimmed };
	}

	return { command: head, rest };
}

export default function messageQueueExtension(pi: ExtensionAPI) {
	const engine = new QueueEngine();
	let pumpHandle: ReturnType<typeof setImmediate> | undefined;
	let sendWatchdog: ReturnType<typeof setTimeout> | undefined;
	let activeEditor: MessageQueueEditor | undefined;
	// Only the current session's command context is usable. Session replacement
	// invalidates this handle so later /new and /reload cannot call a stale ctx.
	let lastCommandCtx: ExtensionCommandContext | undefined;
	const commandContextNoticeIds = new Set<number>();

	function persist() {
		pi.appendEntry(STATE_ENTRY_TYPE, engine.snapshot());
	}

	function updateUi(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;

		const theme = ctx.ui.theme;
		const count = engine.queue.length;
		if (count === 0) {
			const status = engine.isSending()
				? theme.fg("accent", "↗ queue sending")
				: engine.paused
					? theme.fg("warning", "queue paused")
					: undefined;
			ctx.ui.setStatus(STATUS_KEY, status);
			ctx.ui.setWidget(WIDGET_KEY, undefined, { placement: "belowEditor" });
			return;
		}

		const statusTone = engine.paused ? "warning" : engine.isSending() ? "accent" : "muted";
		const statusText = `${engine.paused ? "⏸" : engine.isSending() ? "↗" : "↦"} queue ${count}`;
		ctx.ui.setStatus(STATUS_KEY, theme.fg(statusTone, statusText));

		if (!engine.widgetVisible) {
			ctx.ui.setWidget(WIDGET_KEY, undefined, { placement: "belowEditor" });
			return;
		}

		const titleText = `Queued follow-up inputs${engine.paused ? " (paused)" : ""}`;
		const lines = [`${theme.fg("dim", "•")} ${theme.bold(theme.fg(engine.paused ? "warning" : "text", titleText))}`];

		for (const item of engine.queue.slice(0, MAX_WIDGET_ITEMS)) {
			lines.push(`  ${theme.fg("dim", "↳")} ${theme.fg("muted", theme.italic(preview(item.text)))}`);
		}

		if (engine.queue.length > MAX_WIDGET_ITEMS) {
			lines.push(theme.fg("dim", `  … ${engine.queue.length - MAX_WIDGET_ITEMS} more queued inputs`));
		}

		lines.push(theme.fg("dim", "    alt+enter steer · shift + ← edit last queued message"));

		ctx.ui.setWidget(WIDGET_KEY, lines, { placement: "belowEditor" });
	}

	function clearSendWatchdog() {
		if (!sendWatchdog) return;
		clearTimeout(sendWatchdog);
		sendWatchdog = undefined;
	}

	function clearPump() {
		if (!pumpHandle) return;
		clearImmediate(pumpHandle);
		pumpHandle = undefined;
	}

	function forgetCommandContext() {
		lastCommandCtx = undefined;
		engine.invalidateCommandContext();
	}

	function rememberCommandContext(ctx: ExtensionCommandContext) {
		lastCommandCtx = ctx;
		engine.rememberLiveCommandContext();
	}

	function getCommandContext(ctx: ExtensionContext): ExtensionCommandContext | undefined {
		if (hasCommandContext(ctx)) {
			rememberCommandContext(ctx);
			return ctx;
		}

		if (lastCommandCtx && engine.hasLiveCommandContext()) return lastCommandCtx;
		return undefined;
	}

	function restore(ctx: ExtensionContext) {
		engine.reset();
		commandContextNoticeIds.clear();
		forgetCommandContext();
		clearSendWatchdog();
		clearPump();

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE) continue;
			const restored = restoreSnapshot(entry.data);
			if (!restored) continue;
			engine.restoreFrom(restored);
		}

		updateUi(ctx);
	}

	function enqueue(text: string, position: QueuePosition, ctx: ExtensionContext): QueuedMessage | undefined {
		const item = engine.enqueue(text, position);
		if (!item) {
			notify(ctx, "Nothing to queue.", "warning");
			return undefined;
		}

		persist();
		updateUi(ctx);
		return item;
	}

	function editLastQueued(ctx: ExtensionContext): boolean {
		if (!ctx.hasUI) return false;
		if (!engine.queue.some((item) => !engine.isInFlight(item.id))) {
			notify(ctx, "No queued messages to edit.", "info");
			return false;
		}

		if (ctx.ui.getEditorText().trim()) {
			notify(ctx, "Clear the editor before editing a queued message.", "warning");
			return false;
		}

		const last = engine.popLastEditable();
		if (!last) {
			notify(ctx, "No queued messages to edit.", "info");
			return false;
		}

		persist();
		ctx.ui.setEditorText(last.text);
		updateUi(ctx);
		notify(ctx, `Restored queued message #${last.id} to the editor.`, "info");
		return true;
	}

	function schedulePump(ctx: ExtensionContext) {
		if (pumpHandle) return;
		pumpHandle = setImmediate(() => {
			pumpHandle = undefined;
			void pump(ctx).catch((error) => {
				const message = error instanceof Error ? error.message : String(error);
				engine.failSend();
				persist();
				updateUi(ctx);
				notify(ctx, `Message queue paused after an unexpected error: ${message}`, "error");
			});
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

	function expandQueuedSlashCommand(text: string): string | undefined {
		const parsed = parseSlashCommand(text);
		if (!parsed) return text;

		const command = pi.getCommands().find((candidate) => candidate.name === parsed.name);
		if (!command) return undefined;

		const filePath = command.sourceInfo.path;
		try {
			if (command.source === "skill") {
				const body = stripFrontmatter(readFileSync(filePath, "utf8")).trim();
				const skillName = parsed.name.startsWith("skill:") ? parsed.name.slice("skill:".length) : parsed.name;
				const baseDir = command.sourceInfo.baseDir ?? dirname(filePath);
				const skillBlock = `<skill name="${skillName}" location="${filePath}">\nReferences are relative to ${baseDir}.\n\n${body}\n</skill>`;
				return parsed.args ? `${skillBlock}\n\n${parsed.args}` : skillBlock;
			}

			if (command.source === "prompt") {
				const body = stripFrontmatter(readFileSync(filePath, "utf8"));
				return substitutePromptArgs(body, parseCommandArgs(parsed.args));
			}
		} catch {
			return undefined;
		}

		return undefined;
	}

	function isWorking(ctx: ExtensionContext): boolean {
		return !ctx.isIdle() || ctx.hasPendingMessages();
	}

	function queueInputWhileWorking(text: string, ctx: ExtensionContext): boolean {
		const trimmed = text.trim();
		if (!isWorking(ctx) || !trimmed) return false;

		const item = enqueue(trimmed, "back", ctx);
		if (item) {
			notify(ctx, `Queued #${item.id} while Pi is working.`, "info");
			schedulePump(ctx);
		}
		return true;
	}

	function steerText(text: string, ctx: ExtensionContext): boolean {
		const trimmed = text.trim();
		if (!trimmed) {
			notify(ctx, "Nothing to steer with.", "warning");
			return false;
		}

		try {
			if (isWorking(ctx)) {
				pi.sendUserMessage(trimmed, { deliverAs: "steer" });
				notify(ctx, "Steering the current turn.", "info");
			} else {
				pi.sendUserMessage(trimmed);
			}
			return true;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			notify(ctx, `Failed to steer: ${message}`, "error");
			return false;
		}
	}

	function steerWhileWorking(text: string, ctx: ExtensionContext): boolean {
		if (!isWorking(ctx) || !text.trim()) return false;
		return steerText(text, ctx);
	}

	async function handleSteerCommand(args: string, ctx: ExtensionCommandContext) {
		rememberCommandContext(ctx);
		const fromArgs = args.trim();
		const fromEditor = ctx.hasUI ? ctx.ui.getEditorText() : "";
		const text = fromArgs || fromEditor;
		if (!steerText(text, ctx)) return;
		if (!fromArgs && ctx.hasUI) {
			activeEditor?.addToHistory(text);
			ctx.ui.setEditorText("");
		}
	}

	function startSendWatchdog(ctx: ExtensionContext, id: number) {
		clearSendWatchdog();
		sendWatchdog = setTimeout(() => {
			sendWatchdog = undefined;
			if (!engine.dispatching || engine.dispatching.accepted || engine.dispatching.id !== id) return;
			engine.failSend();
			persist();
			updateUi(ctx);
			notify(ctx, `Message queue paused because #${id} was not accepted by Pi.`, "error");
		}, SEND_CONFIRM_MS);
	}

	async function dispatchQueuedBuiltinCommand(
		item: QueuedMessage,
		command: QueuedBuiltinCommand,
		ctx: ExtensionContext,
	): Promise<void> {
		const commandCtx = getCommandContext(ctx);
		if (commandCtx) {
			const prepared = engine.prepareBuiltinCommand(command.name);
			if (prepared.action === "blocked" || !prepared.item) return;

			commandContextNoticeIds.delete(item.id);
			persist();
			updateUi(ctx);
			notify(ctx, `Running queued /${command.name}.`, "info");

			try {
				if (command.name === "new") {
					const result = await commandCtx.newSession({
						setup: async (sessionManager) => {
							if (prepared.handoffQueue.length === 0) return;
							sessionManager.appendCustomEntry(STATE_ENTRY_TYPE, {
								version: STATE_VERSION,
								queue: prepared.handoffQueue,
								paused: false,
								nextId: engine.nextId,
								widgetVisible: engine.widgetVisible,
								updatedAt: new Date().toISOString(),
							});
						},
					});
					if (result.cancelled) {
						engine.requeue(prepared.item, prepared.handoffQueue);
						persist();
						updateUi(ctx);
						notify(ctx, "Queued /new was cancelled.", "warning");
						return;
					}

					forgetCommandContext();
					return;
				}

				await commandCtx.reload();
				forgetCommandContext();
				return;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				engine.requeue(prepared.item, prepared.handoffQueue);
				forgetCommandContext();
				persist();
				updateUi(ctx);
				notify(ctx, `Message queue failed to run /${command.name}: ${message}`, "error");
				return;
			}
		}

		if (command.name === "reload" && activeEditor?.onSubmit) {
			engine.rememberLiveCommandContext();
			const prepared = engine.prepareBuiltinCommand("reload");
			if (prepared.action === "blocked" || !prepared.item) return;

			commandContextNoticeIds.delete(item.id);
			persist();
			updateUi(ctx);
			notify(ctx, "Running queued /reload.", "info");
			try {
				await activeEditor.dispatchSubmittedText("/reload");
				forgetCommandContext();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				engine.requeue(prepared.item);
				persist();
				updateUi(ctx);
				notify(ctx, `Message queue failed to run /reload: ${message}`, "error");
			}
			return;
		}

		engine.setPaused(true);
		persist();
		updateUi(ctx);
		if (!commandContextNoticeIds.has(item.id)) {
			commandContextNoticeIds.add(item.id);
			notify(
				ctx,
				`Queued /${command.name} needs an interactive command dispatcher. Run /queue resume after Pi is idle to dispatch it.`,
				"warning",
			);
		}
	}

	async function pump(ctx: ExtensionContext) {
		updateUi(ctx);
		if (!engine.canPump({ idle: ctx.isIdle(), pending: ctx.hasPendingMessages() })) return;

		const next = engine.queue[0];
		if (!next) return;

		const builtinCommand = getQueuedBuiltinCommand(next.text);
		if (builtinCommand) {
			await dispatchQueuedBuiltinCommand(next, builtinCommand, ctx);
			return;
		}

		const messageText = expandQueuedSlashCommand(next.text);
		if (messageText === undefined) {
			const canRestoreToEditor = Boolean(ctx.hasUI && !ctx.ui.getEditorText().trim());
			const result = engine.handleUnexpandedSlashCommand({ canRestoreToEditor });
			persist();
			updateUi(ctx);
			if (result.action === "restored" && result.item && ctx.hasUI) {
				ctx.ui.setEditorText(result.item.text);
				notify(ctx, `Queued slash command #${result.item.id} needs interactive execution; restored it to the editor.`, "warning");
				return;
			}

			notify(ctx, `Queued slash command #${next.id} needs interactive execution; left it in the queue.`, "warning");
			return;
		}

		const blocker = getDispatchBlocker(ctx);
		if (blocker) {
			notify(ctx, blocker, "warning");
			return;
		}

		engine.markSending(next.id);
		updateUi(ctx);
		startSendWatchdog(ctx, next.id);

		try {
			pi.sendUserMessage(messageText);
		} catch (error) {
			clearSendWatchdog();
			engine.failSend();
			persist();
			updateUi(ctx);
			const message = error instanceof Error ? error.message : String(error);
			notify(ctx, `Message queue failed to send #${next.id}: ${message}`, "error");
		}
	}

	function acceptPendingDispatch(ctx: ExtensionContext) {
		const accepted = engine.acceptPendingDispatch();
		clearSendWatchdog();
		if (accepted) persist();
		updateUi(ctx);
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
					notify(ctx, `Queued #${item.id}.`, "info");
					schedulePump(ctx);
				}
				return;
			}

			case "next":
			case "front": {
				const item = enqueue(rest, "front", ctx);
				if (item) {
					notify(ctx, `Queued #${item.id} at the front.`, "info");
					schedulePump(ctx);
				}
				return;
			}

			case "list":
			case "ls":
			case "status":
				updateUi(ctx);
				notify(ctx, formatQueue(engine.queue, engine.paused), "info");
				return;

			case "pause":
			case "stop":
				engine.setPaused(true);
				persist();
				updateUi(ctx);
				notify(ctx, "Message queue paused.", "info");
				return;

			case "resume":
			case "start":
				engine.setPaused(false);
				persist();
				updateUi(ctx);
				notify(ctx, "Message queue resumed.", "info");
				schedulePump(ctx);
				return;

			case "clear": {
				const count = engine.clear();
				persist();
				updateUi(ctx);
				notify(ctx, `Cleared ${count} queued message${count === 1 ? "" : "s"}.`, "info");
				return;
			}

			case "remove":
			case "rm":
			case "delete":
			case "del": {
				const removed = engine.remove(rest);
				if (!removed) {
					notify(ctx, "Usage: /queue remove <position> or /queue remove #<id>", "warning");
					return;
				}
				persist();
				updateUi(ctx);
				notify(ctx, `Removed #${removed.id}.`, "info");
				return;
			}

			case "edit":
			case "edit-last":
				editLastQueued(ctx);
				return;

			case "steer":
				await handleSteerCommand(rest, ctx);
				return;

			case "show":
				engine.setWidgetVisible(true);
				persist();
				updateUi(ctx);
				return;

			case "hide":
				engine.setWidgetVisible(false);
				persist();
				updateUi(ctx);
				notify(ctx, "Message queue widget hidden. Status still appears in the footer.", "info");
				return;

			case "help":
				notify(
					ctx,
					[
						"/queue <message> or /queue add <message> — append",
						"/queue next <message> — put at front",
						"/queue list | pause | resume | clear | remove <n|#id>",
						"/queue edit-last or Shift+Left — edit the last queued message",
						"/queue steer <message> or /steer <message> — steer the current turn",
						"Enter queues a follow-up here while Pi is working. Alt+Enter steers.",
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
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			const editor = new MessageQueueEditor(tui, theme, keybindings, (text) => steerWhileWorking(text, ctx));
			activeEditor = editor;
			return editor;
		});
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
		if (event.source === "extension") return { action: "continue" };
		// Native Enter arrives as streamingBehavior "steer". That is the default
		// submit while Pi is working, and this package queues it. Explicit steer
		// uses sendUserMessage({ deliverAs: "steer" }) with source "extension".
		const streamingBehavior = (event as { streamingBehavior?: "steer" | "followUp" }).streamingBehavior;
		if (workingInputIntent(streamingBehavior === "followUp" ? "followUp" : "submit") === "native") {
			return { action: "continue" };
		}
		return queueInputWhileWorking(event.text, ctx) ? { action: "handled" } : { action: "continue" };
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		acceptPendingDispatch(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		engine.clearSending();
		updateUi(ctx);
		schedulePump(ctx);
	});

	// agent_settled exists on newer Pi versions. Register loosely so this package
	// still typechecks against older hosts; canPump() prevents a double send.
	(
		pi as ExtensionAPI & {
			on(event: "agent_settled", handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void): void;
		}
	).on("agent_settled", async (_event, ctx) => {
		engine.clearSending();
		updateUi(ctx);
		schedulePump(ctx);
	});

	pi.on("session_shutdown", async () => {
		engine.failSend();
		forgetCommandContext();
		activeEditor = undefined;
		commandContextNoticeIds.clear();
		clearSendWatchdog();
		clearPump();
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
				"steer",
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

	pi.registerCommand("steer", {
		description: "Steer the current turn with a message, or send immediately if Pi is idle",
		handler: async (args, ctx) => handleSteerCommand(args, ctx),
	});

	pi.registerShortcut("alt+enter", {
		description: "Steer the current turn with the editor text",
		handler: async (ctx) => {
			if (!ctx.hasUI) return;
			const text = activeEditor?.getExpandedText() ?? ctx.ui.getEditorText();
			if (steerWhileWorking(text, ctx)) {
				activeEditor?.addToHistory(text);
				ctx.ui.setEditorText("");
				return;
			}
			if (isWorking(ctx) || !text.trim() || !activeEditor) return;
			activeEditor.setText("");
			await activeEditor.dispatchSubmittedText(text.trim());
		},
	});

	pi.registerShortcut("ctrl+shift+q", {
		description: "Queue current editor text for later execution",
		handler: async (ctx) => {
			if (!ctx.hasUI) return;
			const text = ctx.ui.getEditorText();
			const item = enqueue(text, "back", ctx);
			if (!item) return;
			ctx.ui.setEditorText("");
			notify(ctx, `Queued #${item.id}.`, "info");
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
