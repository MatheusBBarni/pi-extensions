import {
	CustomEditor,
	type ExtensionUIContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorComponent, EditorTheme, TUI } from "@earendil-works/pi-tui";

export const QUEUE_EDITOR_OWNER = Symbol("pi-message-queue:editor");
export const QUEUE_EDITOR_BASE = Symbol("pi-message-queue:base-factory");

export type BaseEditorFactory = (
	tui: TUI,
	theme: EditorTheme,
	keybindings: KeybindingsManager,
) => EditorComponent;

export type QueueEditorFactory = BaseEditorFactory & {
	[QUEUE_EDITOR_OWNER]?: true;
	[QUEUE_EDITOR_BASE]?: BaseEditorFactory;
};

export type QueueEditorLike = {
	handleInput?: (data: string) => void;
	onAction?: (action: never, handler: () => void) => void;
	getExpandedText?: () => string;
	getText?: () => string;
	setText?: (text: string) => void;
	addToHistory?: (text: string) => void;
	onSubmit?: (text: string) => unknown;
};

export type QueueEditorHandle = {
	addToHistory(text: string): void;
	dispatchSubmittedText(text: string): Promise<void>;
	readonly onSubmit?: (text: string) => unknown;
};

export type QueueFollowUpKeybindings = {
	matches(data: string, action: string): boolean;
};

export function isQueueEditorFactory(value: unknown): value is QueueEditorFactory {
	return typeof value === "function" && (value as QueueEditorFactory)[QUEUE_EDITOR_OWNER] === true;
}

export function resolveBaseEditorFactory(current: unknown): BaseEditorFactory | undefined {
	if (isQueueEditorFactory(current)) {
		const base = current[QUEUE_EDITOR_BASE];
		return typeof base === "function" ? base : undefined;
	}
	if (typeof current === "function") return current as BaseEditorFactory;
	return undefined;
}

export function toQueueEditorHandle(editor: QueueEditorLike): QueueEditorHandle {
	return {
		addToHistory(text: string) {
			editor.addToHistory?.(text);
		},
		async dispatchSubmittedText(text: string) {
			await Promise.resolve(editor.onSubmit?.(text));
		},
		get onSubmit() {
			return editor.onSubmit;
		},
	};
}

export function followUpFromEditor(editor: QueueEditorLike, steerInput: (text: string) => boolean): void {
	const text = editor.getExpandedText?.() ?? editor.getText?.() ?? "";
	if (steerInput(text)) {
		editor.addToHistory?.(text);
		editor.setText?.("");
		return;
	}
	const trimmed = text.trim();
	if (!trimmed) return;
	editor.setText?.("");
	void Promise.resolve(editor.onSubmit?.(trimmed));
}

function bindFollowUpAction(editor: QueueEditorLike, handler: () => void): void {
	if (typeof editor.onAction !== "function") return;
	editor.onAction("app.message.followUp" as never, handler);
}

export function attachQueueFollowUp(
	editor: QueueEditorLike,
	keybindings: QueueFollowUpKeybindings,
	steerInput: (text: string) => boolean,
): void {
	const run = () => followUpFromEditor(editor, steerInput);
	bindFollowUpAction(editor, run);
	if (typeof editor.handleInput !== "function") return;

	const original = editor.handleInput.bind(editor);
	editor.handleInput = (data: string) => {
		if (keybindings.matches(data, "app.message.followUp")) {
			run();
			return;
		}
		return original(data);
	};
}

export class MessageQueueEditor extends CustomEditor {
	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindingsManager: KeybindingsManager,
		steerInput: (text: string) => boolean,
	) {
		super(tui, theme, keybindingsManager);
		// app.message.followUp (default: alt+enter) is reserved. Intercept it here
		// instead of registerShortcut(), which Pi skips as a built-in conflict.
		this.onAction("app.message.followUp", () => followUpFromEditor(this as QueueEditorLike, steerInput));
	}

	async dispatchSubmittedText(text: string): Promise<void> {
		await Promise.resolve(this.onSubmit?.(text));
	}
}

export function createQueueEditorFactory(options: {
	previous: unknown;
	steerInput: (text: string) => boolean;
	onReady: (handle: QueueEditorHandle) => void;
}): QueueEditorFactory {
	const base = resolveBaseEditorFactory(options.previous);
	const factory = ((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => {
		if (base) {
			const editor = base(tui, theme, keybindings);
			attachQueueFollowUp(editor as QueueEditorLike, keybindings, options.steerInput);
			options.onReady(toQueueEditorHandle(editor as QueueEditorLike));
			return editor;
		}

		const editor = new MessageQueueEditor(tui, theme, keybindings, options.steerInput);
		options.onReady(toQueueEditorHandle(editor as QueueEditorLike));
		return editor;
	}) as QueueEditorFactory;
	factory[QUEUE_EDITOR_OWNER] = true;
	if (base) factory[QUEUE_EDITOR_BASE] = base;
	return factory;
}

export function installQueueEditor(
	ui: Pick<ExtensionUIContext, "getEditorComponent" | "setEditorComponent">,
	options: {
		steerInput: (text: string) => boolean;
		onReady: (handle: QueueEditorHandle) => void;
	},
): void {
	ui.setEditorComponent(
		createQueueEditorFactory({
			previous: ui.getEditorComponent(),
			steerInput: options.steerInput,
			onReady: options.onReady,
		}),
	);
}
