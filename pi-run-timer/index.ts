import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { RunClock } from "./clock.js";

export { formatElapsed, RunClock } from "./clock.js";

const WIDGET_KEY = "pi-run-timer";
const STATUS_KEY = "pi-run-timer";

type OptionalEventApi = {
	on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown): void;
};

type RenderTui = { requestRender(): void };

function onOptionalEvent(
	pi: ExtensionAPI,
	event: string,
	handler: (ctx: ExtensionContext) => void | Promise<void>,
) {
	(pi as OptionalEventApi).on(event, async (_event, ctx) => handler(ctx));
}

export default function (pi: ExtensionAPI) {
	const clock = new RunClock();
	let ctxRef: ExtensionContext | undefined;
	let tuiRef: RenderTui | undefined;
	let widgetBound = false;

	const paint = () => {
		if (!ctxRef?.hasUI) return;
		const label = clock.display();
		// Vanilla Pi still has a working row. Amp-themes hides it and draws its
		// own "Streaming" / "Thinking" chrome, so the widget is the visible one.
		ctxRef.ui.setWorkingMessage(label);
		ctxRef.ui.setStatus(STATUS_KEY, ctxRef.ui.theme.fg("muted", label));
		tuiRef?.requestRender();
	};

	const bindWidget = (ctx: ExtensionContext) => {
		if (!ctx.hasUI || widgetBound) return;
		widgetBound = true;
		ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
			tuiRef = tui;
			return {
				render() {
					if (!clock.hasDisplay) return [];
					return [theme.fg("muted", clock.display())];
				},
				invalidate() {},
			};
		});
	};

	const restoreChrome = () => {
		if (!ctxRef?.hasUI) return;
		ctxRef.ui.setWorkingMessage();
		ctxRef.ui.setStatus(STATUS_KEY, undefined);
		ctxRef.ui.setWidget(WIDGET_KEY, undefined);
		widgetBound = false;
		tuiRef = undefined;
	};

	const start = (ctx: ExtensionContext) => {
		ctxRef = ctx;
		if (!ctx.hasUI) return;

		const created = clock.start();
		bindWidget(ctx);
		paint();
		if (created) clock.onTick(paint);
	};

	const finish = () => {
		if (!clock.freeze()) return;
		paint();
		if (!ctxRef?.hasUI) return;
		ctxRef.ui.setWorkingMessage();
		ctxRef.ui.setStatus(STATUS_KEY, ctxRef.ui.theme.fg("muted", clock.display()));
	};

	const teardown = () => {
		restoreChrome();
		clock.stop();
	};

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		if (ctx.isIdle()) return;
		start(ctx);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		start(ctx);
	});

	pi.on("agent_start", async (_event, ctx) => {
		start(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		ctxRef = ctx;
		if (ctx.isIdle()) finish();
	});

	// Newer Pi emits agent_settled after retries/compaction. Older hosts ignore it.
	onOptionalEvent(pi, "agent_settled", (ctx) => {
		ctxRef = ctx;
		finish();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctxRef = ctx;
		teardown();
	});
}
