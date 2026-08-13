export const STATE_VERSION = 1;

export type QueuePosition = "back" | "front";
export type QueuedBuiltinCommandName = "new" | "reload";

export interface QueuedMessage {
	id: number;
	text: string;
	createdAt: string;
}

export interface QueueStateSnapshot {
	version: 1;
	queue: QueuedMessage[];
	paused: boolean;
	nextId: number;
	widgetVisible: boolean;
	updatedAt: string;
}

export interface PendingDispatch {
	id: number;
	accepted: boolean;
}

export function isQueuedMessage(value: unknown): value is QueuedMessage {
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

export function restoreSnapshot(data: unknown): QueueStateSnapshot | undefined {
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

export class QueueEngine {
	queue: QueuedMessage[] = [];
	paused = false;
	nextId = 1;
	widgetVisible = true;
	dispatching: PendingDispatch | undefined;
	private liveCommandContext = false;

	snapshot(): QueueStateSnapshot {
		return {
			version: STATE_VERSION,
			queue: [...this.queue],
			paused: this.paused,
			nextId: this.nextId,
			widgetVisible: this.widgetVisible,
			updatedAt: new Date().toISOString(),
		};
	}

	restoreFrom(snapshot: QueueStateSnapshot): void {
		this.queue = [...snapshot.queue];
		this.paused = snapshot.paused;
		this.nextId = snapshot.nextId;
		this.widgetVisible = snapshot.widgetVisible;
		this.dispatching = undefined;
		this.liveCommandContext = false;
	}

	reset(): void {
		this.queue = [];
		this.paused = false;
		this.nextId = 1;
		this.widgetVisible = true;
		this.dispatching = undefined;
		this.liveCommandContext = false;
	}

	enqueue(text: string, position: QueuePosition = "back", createdAt = new Date().toISOString()): QueuedMessage | undefined {
		const trimmed = text.trim();
		if (!trimmed) return undefined;

		const item: QueuedMessage = {
			id: this.nextId++,
			text: trimmed,
			createdAt,
		};

		if (position === "front") this.queue.unshift(item);
		else this.queue.push(item);
		return item;
	}

	isSending(): boolean {
		return this.dispatching !== undefined;
	}

	isInFlight(id: number): boolean {
		return this.dispatching?.id === id;
	}

	canPump(state: { idle: boolean; pending: boolean }): boolean {
		if (this.dispatching || this.paused || this.queue.length === 0) return false;
		return state.idle && !state.pending;
	}

	markSending(id: number): void {
		this.dispatching = { id, accepted: false };
	}

	failSend(): void {
		this.dispatching = undefined;
		this.paused = true;
	}

	clearSending(): boolean {
		if (!this.dispatching?.accepted) return false;
		this.dispatching = undefined;
		return true;
	}

	acceptPendingDispatch(): QueuedMessage | undefined {
		if (!this.dispatching || this.dispatching.accepted) return undefined;

		const pending = this.dispatching;
		const next = this.queue[0];
		if (!next || next.id !== pending.id) {
			this.dispatching = undefined;
			return undefined;
		}

		this.queue.shift();
		this.dispatching = { ...pending, accepted: true };
		return next;
	}

	handleUnexpandedSlashCommand(options: { canRestoreToEditor: boolean }): { action: "kept" | "restored"; item?: QueuedMessage } {
		if (!options.canRestoreToEditor) {
			this.paused = true;
			return { action: "kept" };
		}

		const item = this.queue.shift();
		return { action: "restored", item };
	}

	rememberLiveCommandContext(): void {
		this.liveCommandContext = true;
	}

	invalidateCommandContext(): void {
		this.liveCommandContext = false;
	}

	hasLiveCommandContext(): boolean {
		return this.liveCommandContext;
	}

	prepareBuiltinCommand(name: QueuedBuiltinCommandName): {
		action?: "blocked";
		item?: QueuedMessage;
		handoffQueue: QueuedMessage[];
	} {
		if (!this.liveCommandContext) {
			return { action: "blocked", handoffQueue: [] };
		}

		const item = this.queue.shift();
		const handoffQueue = name === "new" ? this.queue.splice(0) : [];
		return { item, handoffQueue };
	}

	requeue(item: QueuedMessage, extras: QueuedMessage[] = []): void {
		this.queue.unshift(...extras, item);
	}

	remove(selector: string): QueuedMessage | undefined {
		const trimmed = selector.trim();
		if (!trimmed) return undefined;

		let index = -1;
		if (trimmed.startsWith("#")) {
			const id = Number.parseInt(trimmed.slice(1), 10);
			if (Number.isInteger(id)) index = this.queue.findIndex((item) => item.id === id);
		} else {
			const position = Number.parseInt(trimmed, 10);
			if (Number.isInteger(position) && position > 0) index = position - 1;
		}

		const item = index >= 0 ? this.queue[index] : undefined;
		if (!item || this.isInFlight(item.id)) return undefined;
		this.queue.splice(index, 1);
		return item;
	}

	popLastEditable(): QueuedMessage | undefined {
		for (let index = this.queue.length - 1; index >= 0; index--) {
			const item = this.queue[index];
			if (!item || this.isInFlight(item.id)) continue;
			this.queue.splice(index, 1);
			return item;
		}
		return undefined;
	}

	clear(): number {
		const kept = this.queue.filter((item) => this.isInFlight(item.id));
		const removed = this.queue.length - kept.length;
		this.queue = kept;
		return removed;
	}

	setPaused(paused: boolean): void {
		this.paused = paused;
	}

	setWidgetVisible(visible: boolean): void {
		this.widgetVisible = visible;
	}

}

export type WorkingInputSource = "submit" | "followUp" | "queueCommand";

export function workingInputIntent(source: WorkingInputSource): "native" | "queue" {
	return source === "submit" ? "native" : "queue";
}

