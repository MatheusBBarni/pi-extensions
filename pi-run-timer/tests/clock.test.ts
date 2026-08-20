import assert from "node:assert/strict";
import { test } from "node:test";
import { formatElapsed, RunClock } from "../clock.js";

test("formatElapsed matches the compact 3m9s style", () => {
	assert.equal(formatElapsed(0), "0s");
	assert.equal(formatElapsed(999), "0s");
	assert.equal(formatElapsed(1000), "1s");
	assert.equal(formatElapsed(59_000), "59s");
	assert.equal(formatElapsed(60_000), "1m0s");
	assert.equal(formatElapsed(189_000), "3m9s");
	assert.equal(formatElapsed(3_600_000), "1h0m0s");
	assert.equal(formatElapsed(3_723_000), "1h2m3s");
	assert.equal(formatElapsed(-5), "0s");
});

test("RunClock keeps the original start across later start calls", () => {
	let now = 1_000;
	const clock = new RunClock({ now: () => now });

	assert.equal(clock.start(), true);
	now = 4_000;
	assert.equal(clock.start(), false);
	assert.equal(clock.elapsedMs(), 3_000);
	assert.equal(clock.display(), "Running • 3s");
});

test("RunClock stop clears elapsed time and the tick handle", () => {
	let now = 10_000;
	let ticks = 0;
	let cleared = 0;
	const handles: Array<() => void> = [];

	const clock = new RunClock({
		now: () => now,
		setInterval: (fn) => {
			handles.push(fn);
			return 1;
		},
		clearInterval: () => {
			cleared += 1;
		},
	});

	clock.start();
	clock.onTick(() => {
		ticks += 1;
	});
	handles[0]?.();
	assert.equal(ticks, 1);

	now = 70_000;
	assert.equal(clock.label(), "1m0s");

	clock.stop();
	assert.equal(clock.isRunning, false);
	assert.equal(clock.hasDisplay, false);
	assert.equal(clock.elapsedMs(), 0);
	assert.equal(clock.display(), "Running • 0s");
	assert.equal(cleared, 1);
});

test("RunClock freeze keeps the last duration and start resets it", () => {
	let now = 10_000;
	let cleared = 0;
	const clock = new RunClock({
		now: () => now,
		setInterval: () => 1,
		clearInterval: () => {
			cleared += 1;
		},
	});

	clock.start();
	clock.onTick(() => {});
	now = 15_000;

	assert.equal(clock.freeze(), true);
	assert.equal(clock.isRunning, false);
	assert.equal(clock.isFrozen, true);
	assert.equal(clock.hasDisplay, true);
	assert.equal(clock.display(), "Worked • 5s");
	assert.equal(cleared, 1);

	now = 40_000;
	assert.equal(clock.display(), "Worked • 5s");
	assert.equal(clock.freeze(), false);

	assert.equal(clock.start(), true);
	assert.equal(clock.isFrozen, false);
	assert.equal(clock.display(), "Running • 0s");
});
