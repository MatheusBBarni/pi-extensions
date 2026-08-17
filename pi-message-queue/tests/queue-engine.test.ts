import assert from "node:assert/strict";
import { test } from "node:test";
import { QueueEngine, restoreSnapshot, workingInputIntent } from "../extensions/queue-engine.js";

test("a failed send keeps the message and allows later pumping", () => {
	const engine = new QueueEngine();
	const item = engine.enqueue("run the tests");
	assert.ok(item);

	engine.markSending(item.id);
	assert.equal(engine.isSending(), true);
	assert.equal(engine.canPump({ idle: true, pending: false }), false);

	engine.failSend();

	assert.equal(engine.isSending(), false);
	assert.equal(engine.paused, true);
	assert.equal(engine.queue[0]?.id, item.id);
	assert.equal(engine.canPump({ idle: true, pending: false }), false);
});

test("an unrestorable slash command stays queued and pauses dispatch", () => {
	const engine = new QueueEngine();
	const item = engine.enqueue("/compact");
	assert.ok(item);

	const result = engine.handleUnexpandedSlashCommand({
		canRestoreToEditor: false,
	});

	assert.equal(result.action, "kept");
	assert.equal(engine.queue[0]?.id, item.id);
	assert.equal(engine.paused, true);
});

test("queued /new hands remaining items to the replacement session", () => {
	const engine = new QueueEngine();
	const first = engine.enqueue("/new");
	const leftover = engine.enqueue("start the next feature");
	assert.ok(first);
	assert.ok(leftover);

	engine.rememberLiveCommandContext();
	const result = engine.prepareBuiltinCommand("new");

	assert.equal(result.item?.id, first.id);
	assert.deepEqual(
		result.handoffQueue.map((item) => item.text),
		["start the next feature"],
	);
	assert.equal(engine.queue.length, 0);
});

test("session-replacing commands refuse a stale command context", () => {
	const engine = new QueueEngine();
	const item = engine.enqueue("/reload");
	assert.ok(item);

	engine.rememberLiveCommandContext();
	engine.invalidateCommandContext();

	const result = engine.prepareBuiltinCommand("reload");

	assert.equal(result.action, "blocked");
	assert.equal(engine.queue[0]?.id, item.id);
	assert.equal(engine.hasLiveCommandContext(), false);
});

test("in-flight messages cannot be removed or cleared", () => {
	const engine = new QueueEngine();
	const sending = engine.enqueue("currently sending");
	const later = engine.enqueue("after that");
	assert.ok(sending);
	assert.ok(later);

	engine.markSending(sending.id);

	assert.equal(engine.remove("#" + sending.id), undefined);
	assert.equal(engine.popLastEditable(), later);
	assert.equal(engine.queue[0]?.id, sending.id);

	const cleared = engine.clear();
	assert.equal(cleared, 0);
	assert.equal(engine.queue[0]?.id, sending.id);
});

test("restore recovers queue items and next id from a snapshot", () => {
	const restored = restoreSnapshot({
		version: 1,
		queue: [
			{ id: 4, text: "keep me", createdAt: "2026-01-01T00:00:00.000Z" },
			{ id: "bad", text: "drop me" },
		],
		paused: true,
		nextId: 3,
		widgetVisible: false,
		updatedAt: "2026-01-02T00:00:00.000Z",
	});

	assert.ok(restored);
	assert.equal(restored.queue.length, 1);
	assert.equal(restored.queue[0]?.id, 4);
	assert.equal(restored.nextId, 5);
	assert.equal(restored.paused, true);
	assert.equal(restored.widgetVisible, false);
});

test("clearing a send only happens after Pi accepted it", () => {
	const engine = new QueueEngine();
	const item = engine.enqueue("wait for confirmation");
	assert.ok(item);

	engine.markSending(item.id);
	assert.equal(engine.clearSending(), false);
	assert.equal(engine.isSending(), true);

	engine.acceptPendingDispatch();
	assert.equal(engine.clearSending(), true);
	assert.equal(engine.isSending(), false);
});


test("ordinary submit while working goes to the queue", () => {
	assert.equal(workingInputIntent("submit"), "queue");
	assert.equal(workingInputIntent("followUp"), "queue");
	assert.equal(workingInputIntent("queueCommand"), "queue");
	assert.equal(workingInputIntent("steer"), "native");
});
