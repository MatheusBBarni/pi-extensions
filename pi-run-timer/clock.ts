export type IntervalHandle = object | number | string;

export type ClockDeps = {
	now?: () => number;
	setInterval?: (fn: () => void, ms: number) => IntervalHandle;
	clearInterval?: (handle: IntervalHandle) => void;
};

const SECOND_MS = 1000;
const MINUTE_S = 60;
const HOUR_S = 3600;

export function formatElapsed(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / SECOND_MS));
	const hours = Math.floor(totalSeconds / HOUR_S);
	const minutes = Math.floor((totalSeconds % HOUR_S) / MINUTE_S);
	const seconds = totalSeconds % MINUTE_S;

	if (hours > 0) return `${hours}h${minutes}m${seconds}s`;
	if (minutes > 0) return `${minutes}m${seconds}s`;
	return `${seconds}s`;
}

export class RunClock {
	private startedAt: number | null = null;
	private endedAt: number | null = null;
	private timer: IntervalHandle | null = null;
	private readonly now: () => number;
	private readonly setIntervalFn: (fn: () => void, ms: number) => IntervalHandle;
	private readonly clearIntervalFn: (handle: IntervalHandle) => void;

	constructor(deps: ClockDeps = {}) {
		this.now = deps.now ?? Date.now;
		this.setIntervalFn = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
		this.clearIntervalFn = deps.clearInterval ?? ((handle) => {
			clearInterval(handle as ReturnType<typeof setInterval>);
		});
	}

	get isRunning(): boolean {
		return this.startedAt !== null && this.endedAt === null;
	}

	get isFrozen(): boolean {
		return this.endedAt !== null;
	}

	get hasDisplay(): boolean {
		return this.startedAt !== null;
	}

	start(): boolean {
		if (this.isRunning) return false;
		this.startedAt = this.now();
		this.endedAt = null;
		return true;
	}

	elapsedMs(): number {
		if (this.startedAt === null) return 0;
		const end = this.endedAt ?? this.now();
		return Math.max(0, end - this.startedAt);
	}

	label(): string {
		return formatElapsed(this.elapsedMs());
	}

	display(): string {
		const state = this.isFrozen ? "Worked" : "Running";
		return `${state} • ${this.label()}`;
	}

	onTick(fn: () => void, intervalMs = SECOND_MS): void {
		this.clearTick();
		this.timer = this.setIntervalFn(fn, intervalMs);
	}

	freeze(): boolean {
		if (!this.isRunning) return false;
		this.endedAt = this.now();
		this.clearTick();
		return true;
	}

	stop(): void {
		this.startedAt = null;
		this.endedAt = null;
		this.clearTick();
	}

	clearTick(): void {
		if (this.timer === null) return;
		this.clearIntervalFn(this.timer);
		this.timer = null;
	}
}
