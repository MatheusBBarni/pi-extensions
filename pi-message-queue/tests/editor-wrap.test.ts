import assert from "node:assert/strict";
import { test } from "node:test";
import {
	attachQueueFollowUp,
	createQueueEditorFactory,
	installQueueEditor,
	isQueueEditorFactory,
	QUEUE_EDITOR_BASE,
	resolveBaseEditorFactory,
	type BaseEditorFactory,
	type QueueEditorLike,
} from "../extensions/editor-wrap.js";

function fakeKeybindings(followUpData = "alt+enter") {
	return {
		matches(data: string, action: string) {
			return action === "app.message.followUp" && data === followUpData;
		},
	};
}

function fakeEditor(initial = "keep amp chrome"): QueueEditorLike & {
	inputs: string[];
	actions: string[];
	history: string[];
	submitted: string[];
	text: string;
} {
	return {
		inputs: [],
		actions: [],
		history: [],
		submitted: [],
		text: initial,
		handleInput(data: string) {
			this.inputs.push(data);
		},
		onAction(action: string) {
			this.actions.push(action);
		},
		getExpandedText() {
			return this.text;
		},
		getText() {
			return this.text;
		},
		setText(text: string) {
			this.text = text;
		},
		addToHistory(text: string) {
			this.history.push(text);
		},
		onSubmit(text: string) {
			this.submitted.push(text);
		},
	};
}

function fakeFactory(editor: ReturnType<typeof fakeEditor>): BaseEditorFactory {
	return () => editor as never;
}

test("wrapping keeps the previous editor instance", () => {
	const previous = fakeEditor();
	const factory = createQueueEditorFactory({
		previous: fakeFactory(previous),
		steerInput: () => false,
		onReady: () => {},
	});

	const installed = factory({} as never, {} as never, fakeKeybindings() as never);
	assert.equal(installed, previous);
	assert.equal(isQueueEditorFactory(factory), true);
	assert.equal(typeof factory[QUEUE_EDITOR_BASE], "function");
});

test("a wrapped editor still forwards keys the queue does not own", () => {
	const previous = fakeEditor();
	attachQueueFollowUp(previous, fakeKeybindings(), () => false);

	previous.handleInput?.("/");

	assert.deepEqual(previous.inputs, ["/"]);
	assert.equal(previous.text, "keep amp chrome");
});

test("a wrapped editor intercepts follow-up without calling the previous handler", () => {
	const previous = fakeEditor("steer this turn");
	let steered = "";
	attachQueueFollowUp(previous, fakeKeybindings(), (text) => {
		steered = text;
		return true;
	});

	previous.handleInput?.("alt+enter");

	assert.equal(steered, "steer this turn");
	assert.deepEqual(previous.inputs, []);
	assert.deepEqual(previous.history, ["steer this turn"]);
	assert.equal(previous.text, "");
});

test("reinstalling unwraps our own factory instead of nesting wrappers", () => {
	const amp = fakeEditor();
	const ampFactory = fakeFactory(amp);
	const first = createQueueEditorFactory({
		previous: ampFactory,
		steerInput: () => false,
		onReady: () => {},
	});
	const second = createQueueEditorFactory({
		previous: first,
		steerInput: () => false,
		onReady: () => {},
	});

	assert.equal(resolveBaseEditorFactory(second), ampFactory);
	assert.equal(second[QUEUE_EDITOR_BASE], ampFactory);
	assert.equal(second({} as never, {} as never, fakeKeybindings() as never), amp);
});

test("installQueueEditor wraps whatever getEditorComponent already returned", () => {
	const amp = fakeEditor();
	const ampFactory = fakeFactory(amp);
	let installed: unknown;
	const ready: unknown[] = [];

	installQueueEditor(
		{
			getEditorComponent: () => ampFactory,
			setEditorComponent(factory) {
				installed = factory;
			},
		},
		{
			steerInput: () => false,
			onReady: (handle) => ready.push(handle),
		},
	);

	assert.equal(isQueueEditorFactory(installed), true);
	const editor = (installed as BaseEditorFactory)({} as never, {} as never, fakeKeybindings() as never);
	assert.equal(editor, amp);
	assert.equal(ready.length, 1);
});
