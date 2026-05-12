/**
 * Interactive Codex Goal Extension for Pi.
 *
 * Provides a stateful /goal command inspired by @tmustier/pi-ralph-wiggum,
 * but delegates work to Codex CLI sessions and persists enough metadata to
 * resume them later with `codex exec resume`.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const GOAL_DIR = ".codex-goals";
const COMPLETE_MARKER = "<codex-goal>COMPLETE</codex-goal>";
const NEEDS_RESUME_MARKER = "<codex-goal>NEEDS_RESUME</codex-goal>";
const DEFAULT_TIMEOUT_MS = 1_200_000;
const DEFAULT_SANDBOX = "workspace-write" as const;
const DEFAULT_MODEL = undefined as string | undefined;
const DEFAULT_PROFILE = undefined as string | undefined;
const SANDBOX_VALUES = ["read-only", "workspace-write", "danger-full-access"] as const;

const DEFAULT_TEMPLATE = `# Codex Goal

## Objective
Describe what Codex should accomplish.

## Checklist
- [ ] Understand the task and inspect relevant files
- [ ] Implement the change
- [ ] Run verification and record evidence

## Progress
- Goal file created. Update this section after each Codex run.
`;

const RESUME_PROMPT = "Continue the Codex /goal session.";

type SandboxMode = (typeof SANDBOX_VALUES)[number];
type GoalStatus = "running" | "paused" | "completed" | "failed";
type NotifyLevel = "info" | "warning" | "error";
type TextContent = { type: "text"; text: string };
type ToolUpdate = { content?: TextContent[]; details?: Record<string, unknown> };

interface GoalState {
	version: 1;
	name: string;
	taskFile: string;
	status: GoalStatus;
	active: boolean;
	runs: number;
	startedAt: string;
	updatedAt: string;
	completedAt?: string;
	sessionId?: string;
	sandbox: SandboxMode;
	timeoutMs: number;
	model?: string;
	profile?: string;
	lastPrompt?: string;
	lastExitCode?: number | null;
	lastOutput?: string;
	lastError?: string;
	lastLogFile?: string;
	lastMessageFile?: string;
	lastDurationMs?: number;
	lastCommand?: string[];
}

interface ParsedArgs {
	positionals: string[];
	name?: string;
	file?: string;
	sandbox: SandboxMode;
	timeoutMs: number;
	model?: string;
	profile?: string;
	force: boolean;
	noRun: boolean;
	edit: boolean;
	all: boolean;
	yes: boolean;
}

interface CodexIndexEntry {
	id?: string;
	thread_name?: string;
	updated_at?: string;
}

interface CodexRunResult {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	aborted: boolean;
	timedOut: boolean;
	sessionId?: string;
	lastMessage?: string;
	summary: string;
	logFile: string;
	lastMessageFile: string;
	durationMs: number;
	args: string[];
}

const STATUS_ICONS: Record<GoalStatus, string> = {
	running: "▶",
	paused: "⏸",
	completed: "✓",
	failed: "✗",
};

const SandboxSchema = StringEnum(SANDBOX_VALUES);

export default function codexGoalInteractive(pi: ExtensionAPI) {
	let currentGoal: string | null = null;
	let runningGoal: { name: string; abort: () => void } | null = null;

	// --- filesystem helpers -------------------------------------------------

	const goalDir = (ctx: ExtensionContext) => path.resolve(ctx.cwd, GOAL_DIR);
	const logsDir = (ctx: ExtensionContext) => path.join(goalDir(ctx), "logs");
	const archiveDir = (ctx: ExtensionContext) => path.join(goalDir(ctx), "archive");

	function sanitize(name: string): string {
		const value = name.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
		return value || "goal";
	}

	function getStatePath(ctx: ExtensionContext, name: string, archived = false): string {
		return path.join(archived ? archiveDir(ctx) : goalDir(ctx), `${sanitize(name)}.state.json`);
	}

	function getTaskPath(ctx: ExtensionContext, name: string, archived = false): string {
		return path.join(archived ? archiveDir(ctx) : goalDir(ctx), `${sanitize(name)}.md`);
	}

	function ensureDir(filePath: string): void {
		const dir = path.dirname(filePath);
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	}

	function tryRead(filePath: string): string | null {
		try {
			return fs.readFileSync(filePath, "utf-8");
		} catch {
			return null;
		}
	}

	function tryDelete(filePath: string): void {
		try {
			if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
		} catch {
			/* ignore */
		}
	}

	function isInternalGoalFile(ctx: ExtensionContext, filePath: string): boolean {
		const absolute = path.resolve(ctx.cwd, filePath);
		const dir = goalDir(ctx) + path.sep;
		return absolute.startsWith(dir) && !absolute.startsWith(archiveDir(ctx) + path.sep);
	}

	function writeFile(filePath: string, content: string): void {
		ensureDir(filePath);
		fs.writeFileSync(filePath, content, "utf-8");
	}

	// --- state --------------------------------------------------------------

	function migrateState(raw: Partial<GoalState> & { name: string }): GoalState {
		const now = new Date().toISOString();
		const status = raw.status ?? (raw.active ? "paused" : "completed");
		return {
			version: 1,
			name: sanitize(raw.name),
			taskFile: raw.taskFile ?? path.join(GOAL_DIR, `${sanitize(raw.name)}.md`),
			status,
			active: status !== "completed",
			runs: raw.runs ?? 0,
			startedAt: raw.startedAt ?? now,
			updatedAt: raw.updatedAt ?? now,
			completedAt: raw.completedAt,
			sessionId: raw.sessionId,
			sandbox: isSandbox(raw.sandbox) ? raw.sandbox : DEFAULT_SANDBOX,
			timeoutMs: raw.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			model: raw.model,
			profile: raw.profile,
			lastPrompt: raw.lastPrompt,
			lastExitCode: raw.lastExitCode,
			lastOutput: raw.lastOutput,
			lastError: raw.lastError,
			lastLogFile: raw.lastLogFile,
			lastMessageFile: raw.lastMessageFile,
			lastDurationMs: typeof raw.lastDurationMs === "number" ? raw.lastDurationMs : undefined,
			lastCommand: raw.lastCommand,
		};
	}

	function loadState(ctx: ExtensionContext, name: string, archived = false): GoalState | null {
		const content = tryRead(getStatePath(ctx, name, archived));
		if (!content) return null;
		try {
			return migrateState(JSON.parse(content));
		} catch {
			return null;
		}
	}

	function saveState(ctx: ExtensionContext, state: GoalState, archived = false): void {
		state.active = state.status !== "completed";
		state.updatedAt = new Date().toISOString();
		const filePath = getStatePath(ctx, state.name, archived);
		writeFile(filePath, JSON.stringify(state, null, 2));
	}

	function listGoals(ctx: ExtensionContext, archived = false): GoalState[] {
		const dir = archived ? archiveDir(ctx) : goalDir(ctx);
		if (!fs.existsSync(dir)) return [];
		return fs
			.readdirSync(dir)
			.filter((f) => f.endsWith(".state.json"))
			.map((f) => {
				const content = tryRead(path.join(dir, f));
				if (!content) return null;
				try {
					return migrateState(JSON.parse(content));
				} catch {
					return null;
				}
			})
			.filter((s): s is GoalState => s !== null)
			.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
	}

	function getMostRecentResumable(ctx: ExtensionContext): GoalState | null {
		return listGoals(ctx).find((goal) => goal.status !== "completed") ?? null;
	}

	// --- formatting / UI ----------------------------------------------------

	function notify(ctx: ExtensionContext, message: string, level: NotifyLevel = "info"): void {
		if (ctx.hasUI) ctx.ui.notify(message, level);
	}

	function truncateText(text: string, maxChars = 3000): string {
		if (!text) return "";
		if (text.length <= maxChars) return text;
		return `${text.slice(0, maxChars)}\n…truncated ${text.length - maxChars} chars`;
	}

	function cleanMarkers(text: string): string {
		return text.replaceAll(COMPLETE_MARKER, "").replaceAll(NEEDS_RESUME_MARKER, "").trim();
	}

	function formatGoal(goal: GoalState): string {
		const session = goal.sessionId ? ` session ${goal.sessionId.slice(0, 8)}` : " no session yet";
		const duration = goal.lastDurationMs ? `, last run ${formatDuration(goal.lastDurationMs)}` : "";
		return `${goal.name}: ${STATUS_ICONS[goal.status]} ${goal.status} (${goal.runs} run${goal.runs === 1 ? "" : "s"},${session}${duration})`;
	}

	function updateUI(ctx: ExtensionContext, progress?: string): void {
		if (!ctx.hasUI) return;

		const state = currentGoal ? loadState(ctx, currentGoal) : null;
		if (!state) {
			ctx.ui.setStatus("codex-goal", undefined);
			ctx.ui.setWidget("codex-goal", undefined);
			return;
		}

		const { theme } = ctx.ui;
		const status = `${STATUS_ICONS[state.status]} ${state.status}`;
		ctx.ui.setStatus("codex-goal", theme.fg("accent", `🎯 ${state.name} ${status}`));

		const lines = [
			theme.fg("accent", theme.bold("Codex /goal")),
			theme.fg("muted", state.name),
			theme.fg("dim", `${status} • ${state.runs} run${state.runs === 1 ? "" : "s"}`),
			theme.fg("dim", `Task: ${state.taskFile}`),
		];
		if (state.sessionId) lines.push(theme.fg("dim", `Codex session: ${state.sessionId}`));
		if (progress) lines.push("", theme.fg("muted", truncateText(progress, 220)));
		if (state.status === "running") {
			lines.push("", theme.fg("warning", "Codex is running. Press ESC if Pi exposes abort; /goal stop can abort when idle."));
		} else if (state.status !== "completed") {
			lines.push("", theme.fg("dim", `Resume with /goal resume ${state.name}`));
		}
		ctx.ui.setWidget("codex-goal", lines);
	}

	function formatDuration(ms: number): string {
		const totalSeconds = Math.max(0, Math.floor(ms / 1000));
		const hours = Math.floor(totalSeconds / 3600);
		const minutes = Math.floor((totalSeconds % 3600) / 60);
		const seconds = totalSeconds % 60;
		if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
		if (minutes > 0) return `${minutes}m ${seconds}s`;
		return `${seconds}s`;
	}

	function shellQuoteForDisplay(arg: string): string {
		if (/^[a-zA-Z0-9_./:=@+-]+$/.test(arg)) return arg;
		return JSON.stringify(arg);
	}

	function formatCommandForDisplay(args: string[]): string {
		return ["codex", ...args]
			.map((arg, index) => {
				if (arg.includes("\n")) {
					const label = index === args.length ? "prompt" : "arg";
					return `<${label}:${arg.length} chars>`;
				}
				return shellQuoteForDisplay(arg);
			})
			.join(" ");
	}

	function wrapPlainText(text: string, width: number): string[] {
		const targetWidth = Math.max(10, width);
		const output: string[] = [];
		const paragraphs = text.split(/\r?\n/);

		for (const paragraph of paragraphs) {
			if (!paragraph.trim()) {
				output.push("");
				continue;
			}

			let line = "";
			for (const word of paragraph.trim().split(/\s+/)) {
				if (word.length > targetWidth) {
					if (line) {
						output.push(line);
						line = "";
					}
					for (let i = 0; i < word.length; i += targetWidth) {
						output.push(word.slice(i, i + targetWidth));
					}
					continue;
				}

				const next = line ? `${line} ${word}` : word;
				if (next.length > targetWidth) {
					if (line) output.push(line);
					line = word;
				} else {
					line = next;
				}
			}
			if (line) output.push(line);
		}

		return output.length > 0 ? output : [""];
	}

	type ProgressKind = "info" | "agent" | "command" | "stderr" | "error" | "done";

	function classifyProgress(message: string): ProgressKind {
		if (message.startsWith("stderr:")) return "stderr";
		if (message.startsWith("Codex error")) return "error";
		if (message.startsWith("Codex:")) return "agent";
		if (message.startsWith("$ ") || message.startsWith("Command ")) return "command";
		if (/\berror\b/i.test(message)) return "error";
		return "info";
	}

	interface ProgressEntry {
		kind: ProgressKind;
		message: string;
		at: number;
	}

	function createCodexProgressPanel(
		ctx: ExtensionContext,
		options: {
			name: string;
			mode: string;
			command: string[];
			logFile: string;
			lastMessageFile: string;
			taskFile?: string;
			sessionId?: string;
		},
	) {
		if (!ctx.hasUI) {
			return {
				start() {},
				event(_message: string, _kind?: ProgressKind) {},
				finish(_message?: string, _kind?: ProgressKind) {},
				stop() {},
			};
		}

		const startedAt = Date.now();
		const entries: ProgressEntry[] = [];
		let status = "starting";
		let timer: ReturnType<typeof setInterval> | undefined;

		const normalizeMessage = (message: string): string => {
			if (message.includes("Reading additional input from stdin")) {
				return "Codex CLI started; waiting for model/tool events…";
			}
			return message;
		};

		const render = () => {
			ctx.ui.setWidget("codex-goal", (_tui, theme) => ({
				render(width: number) {
					const elapsed = formatDuration(Date.now() - startedAt);
					const recent = entries.slice(-6);
					const lines = [
						theme.fg("accent", theme.bold("Codex /goal")) + " " + theme.fg("dim", `${status} • ${elapsed}`),
					];
					const meta = `${options.mode}${options.name !== "one-shot" ? ` • ${options.name}` : ""} • log ${path.relative(ctx.cwd, options.logFile)}`;
					for (const line of wrapPlainText(meta, width)) lines.push(theme.fg("dim", line));

					if (recent.length === 0) {
						lines.push(theme.fg("dim", "• waiting for Codex…"));
					} else {
						for (const entry of recent) {
							const age = formatDuration(Date.now() - entry.at);
							const icon =
								entry.kind === "agent" ? "›" :
								entry.kind === "command" ? "•" :
								entry.kind === "stderr" ? "!" :
								entry.kind === "error" ? "✗" :
								entry.kind === "done" ? "✓" :
								"·";
							const color =
								entry.kind === "agent" ? "text" :
								entry.kind === "command" ? "muted" :
								entry.kind === "stderr" || entry.kind === "error" ? "warning" :
								entry.kind === "done" ? "success" :
								"dim";
							const prefix = `${icon} ${age} `;
							const message = entry.kind === "agent" ? entry.message.replace(/^Codex:\s*/, "") : entry.message;
							const wrapped = wrapPlainText(message, Math.max(20, width - prefix.length - 2));
							for (let i = 0; i < wrapped.length; i++) {
								const left = i === 0 ? prefix : " ".repeat(prefix.length);
								lines.push(theme.fg(color, `${left}${wrapped[i]}`));
							}
						}
					}

					for (const line of wrapPlainText(`full transcript: ${path.relative(ctx.cwd, options.logFile)}`, width)) {
						lines.push(theme.fg("dim", line));
					}
					return lines;
				},
				invalidate() {},
			}));
			ctx.ui.setStatus("codex-goal", ctx.ui.theme.fg("accent", `🎯 codex /goal • ${status} • ${formatDuration(Date.now() - startedAt)}`));
		};

		const add = (message: string, kind: ProgressKind = classifyProgress(message)) => {
			const normalized = normalizeMessage(message);
			status = kind === "done" ? "finished" : kind === "error" ? "error" : "running";
			const last = entries[entries.length - 1];
			if (!last || last.message !== normalized || last.kind !== kind) {
				entries.push({ kind, message: normalized, at: Date.now() });
			}
			render();
		};

		return {
			start() {
				render();
				timer = setInterval(render, 1000);
				timer.unref?.();
			},
			event(message: string, kind?: ProgressKind) {
				add(message, kind ?? classifyProgress(message));
			},
			finish(message = "Codex run finished", kind: ProgressKind = "done") {
				add(message, kind);
			},
			stop() {
				if (timer) clearInterval(timer);
				timer = undefined;
				ctx.ui.setWidget("codex-goal", undefined);
				ctx.ui.setStatus("codex-goal", undefined);
			},
		};
	}

	// --- command arg parsing -----------------------------------------------

	function tokenize(input: string): string[] {
		const tokens: string[] = [];
		const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|\S+/g;
		let match: RegExpExecArray | null;
		while ((match = pattern.exec(input)) !== null) {
			const raw = match[1] ?? match[2] ?? match[0];
			tokens.push(raw.replace(/\\(["'\\])/g, "$1"));
		}
		return tokens;
	}

	function isSandbox(value: unknown): value is SandboxMode {
		return typeof value === "string" && SANDBOX_VALUES.includes(value as SandboxMode);
	}

	function parseArgs(argsStr: string): ParsedArgs {
		const tokens = tokenize(argsStr);
		const result: ParsedArgs = {
			positionals: [],
			sandbox: DEFAULT_SANDBOX,
			timeoutMs: DEFAULT_TIMEOUT_MS,
			model: DEFAULT_MODEL,
			profile: DEFAULT_PROFILE,
			force: false,
			noRun: false,
			edit: false,
			all: false,
			yes: false,
		};

		for (let i = 0; i < tokens.length; i++) {
			const tok = tokens[i];
			const next = tokens[i + 1];
			if ((tok === "--name" || tok === "-n") && next) {
				result.name = sanitize(next);
				i++;
			} else if ((tok === "--file" || tok === "-f") && next) {
				result.file = next;
				i++;
			} else if (tok === "--sandbox" && next) {
				if (isSandbox(next)) result.sandbox = next;
				i++;
			} else if ((tok === "--timeout-ms" || tok === "--timeout") && next) {
				result.timeoutMs = Math.max(5_000, parseInt(next, 10) || DEFAULT_TIMEOUT_MS);
				i++;
			} else if ((tok === "--model" || tok === "-m") && next) {
				result.model = next;
				i++;
			} else if ((tok === "--profile" || tok === "-p") && next) {
				result.profile = next;
				i++;
			} else if (tok === "--force") {
				result.force = true;
			} else if (tok === "--no-run") {
				result.noRun = true;
			} else if (tok === "--edit") {
				result.edit = true;
			} else if (tok === "--all") {
				result.all = true;
			} else if (tok === "--yes" || tok === "-y") {
				result.yes = true;
			} else {
				result.positionals.push(tok);
			}
		}
		return result;
	}

	// --- Codex session discovery -------------------------------------------

	function codexHome(): string {
		return process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : path.join(os.homedir(), ".codex");
	}

	function readCodexIndex(): CodexIndexEntry[] {
		const indexPath = path.join(codexHome(), "session_index.jsonl");
		const content = tryRead(indexPath);
		if (!content) return [];
		return content
			.split(/\r?\n/)
			.filter((line) => line.trim())
			.map((line) => {
				try {
					return JSON.parse(line) as CodexIndexEntry;
				} catch {
					return {} as CodexIndexEntry;
				}
			})
			.filter((entry) => typeof entry.id === "string");
	}

	function newestSessionIdSince(before: CodexIndexEntry[], startedAtMs: number): string | undefined {
		const beforeIds = new Set(before.map((entry) => entry.id).filter(Boolean));
		const candidates = readCodexIndex()
			.filter((entry) => entry.id)
			.filter((entry) => !beforeIds.has(entry.id) || Date.parse(entry.updated_at ?? "") >= startedAtMs - 1000)
			.sort((a, b) => Date.parse(b.updated_at ?? "") - Date.parse(a.updated_at ?? ""));
		return candidates[0]?.id;
	}

	function findSessionId(value: unknown, depth = 0): string | undefined {
		if (!value || typeof value !== "object" || depth > 5) return undefined;
		const obj = value as Record<string, unknown>;
		for (const [key, candidate] of Object.entries(obj)) {
			const normalized = key.toLowerCase().replace(/[-_]/g, "");
			if (
				(normalized === "sessionid" || normalized === "conversationid" || normalized === "threadid") &&
				typeof candidate === "string" &&
				candidate.length >= 8
			) {
				return candidate;
			}
		}
		for (const candidate of Object.values(obj)) {
			const found = findSessionId(candidate, depth + 1);
			if (found) return found;
		}
		return undefined;
	}

	// --- Codex JSON/text parsing -------------------------------------------

	function textFromContent(content: unknown): string {
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";
		return content
			.map((part) => {
				if (!part || typeof part !== "object") return "";
				const item = part as Record<string, unknown>;
				return typeof item.text === "string" ? item.text : "";
			})
			.filter(Boolean)
			.join("\n");
	}

	function extractCodexEventText(event: unknown): string[] {
		if (!event || typeof event !== "object") return [];
		const obj = event as Record<string, unknown>;
		const payload = (obj.payload && typeof obj.payload === "object" ? obj.payload : obj) as Record<string, unknown>;
		const item = payload.item && typeof payload.item === "object" ? (payload.item as Record<string, unknown>) : undefined;
		const texts: string[] = [];

		if (payload.type === "agent_message" && typeof payload.message === "string") texts.push(payload.message);
		if (item?.type === "agent_message" && typeof item.text === "string") texts.push(item.text);
		if (payload.type === "message" && payload.role === "assistant") {
			const text = textFromContent(payload.content);
			if (text) texts.push(text);
		}
		if (obj.type === "response_item" && payload.type === "message" && payload.role === "assistant") {
			const text = textFromContent(payload.content);
			if (text) texts.push(text);
		}
		for (const key of ["message", "text", "output", "content"] as const) {
			if (typeof obj[key] === "string") texts.push(obj[key] as string);
			if (typeof payload[key] === "string") texts.push(payload[key] as string);
		}
		const response = obj.response;
		if (response && typeof response === "object") {
			const text = textFromContent((response as Record<string, unknown>).content);
			if (text) texts.push(text);
		}
		return texts.filter((text) => text.trim());
	}

	function describeCodexEvent(event: unknown): string | undefined {
		if (!event || typeof event !== "object") return undefined;
		const obj = event as Record<string, unknown>;
		const payload = (obj.payload && typeof obj.payload === "object" ? obj.payload : obj) as Record<string, unknown>;
		const item = payload.item && typeof payload.item === "object" ? (payload.item as Record<string, unknown>) : undefined;
		const type = String(payload.type ?? obj.type ?? "");

		if (type === "thread.started") return `Codex thread started ${String(payload.thread_id ?? "").slice(0, 8)}`.trim();
		if (type === "turn.started") return "Codex turn started";
		if (type === "turn.completed") return "Codex turn completed";
		if (type === "task_started") return "Codex task started";
		if (type === "agent_message" && typeof payload.message === "string") {
			return `Codex: ${payload.message}`;
		}
		if ((type === "item.started" || type === "item.completed") && item) {
			const itemType = String(item.type ?? "item");
			if (itemType === "agent_message" && typeof item.text === "string") {
				return `Codex: ${item.text}`;
			}
			if (itemType === "command_execution") {
				const command = typeof item.command === "string" ? item.command : JSON.stringify(item.command ?? "");
				if (type === "item.started" || item.status === "in_progress") return `$ ${command}`;
				const exitCode = item.exit_code;
				const exit = typeof exitCode === "number" ? (exitCode === 0 ? "passed" : `exited ${exitCode}`) : "completed";
				return `Command ${exit}: ${command}`;
			}
			return `${itemType} ${type === "item.started" ? "started" : "completed"}`;
		}
		if (type === "exec_command_begin") {
			const command = typeof payload.command === "string" ? payload.command : JSON.stringify(payload.command ?? "");
			return `$ ${command}`;
		}
		if (type === "exec_command_end") return `Command exited ${String(payload.exit_code ?? payload.code ?? "")}`.trim();
		if (type === "patch_apply_begin") return "Applying patch";
		if (type === "patch_apply_end") return "Patch applied";
		if (type === "token_count") return "Codex token/rate-limit update";
		if (type === "error") return `Codex error: ${String(payload.message ?? payload.error ?? "unknown")}`;

		const texts = extractCodexEventText(event);
		if (texts.length > 0) return texts[texts.length - 1];
		return undefined;
	}

	function extractCodexText(output: string): string {
		const snippets: string[] = [];
		for (const line of output.split(/\r?\n/)) {
			if (!line.trim()) continue;
			try {
				snippets.push(...extractCodexEventText(JSON.parse(line)));
			} catch {
				// Raw non-JSON output is handled below.
			}
		}
		return snippets.length > 0 ? snippets.join("\n") : output.trim();
	}

	// --- Prompt builders ----------------------------------------------------

	function titleFromName(name: string): string {
		return name
			.split(/[-_]/g)
			.filter(Boolean)
			.map((part) => part[0]?.toUpperCase() + part.slice(1))
			.join(" ") || "Codex /goal";
	}

	function taskFromObjective(name: string, objective: string): string {
		return `# ${titleFromName(name)}

## Objective
${objective.trim()}

## Checklist
- [ ] Inspect relevant files and understand the current state
- [ ] Implement the requested changes
- [ ] Run appropriate verification
- [ ] Summarize what changed and any follow-up needed

## Progress
- ${new Date().toISOString()}: Goal created.
`;
	}

	function buildStartPrompt(_state: GoalState, taskContent: string): string {
		return taskContent.trim();
	}

	function buildResumePrompt(_state: GoalState, _taskContent: string, userPrompt?: string): string {
		return userPrompt?.trim() || RESUME_PROMPT;
	}

	function buildOneShotPrompt(goal: string): string {
		return goal.trim();
	}

	// --- Codex runner -------------------------------------------------------

	function buildCodexArgs(state: GoalState, mode: "start" | "resume", prompt: string, lastMessageFile: string): string[] {
		if (mode === "resume") {
			const args = ["exec", "resume", "--json", "--skip-git-repo-check", "-o", lastMessageFile];
			if (state.model) args.push("-m", state.model);
			if (state.sessionId) args.push(state.sessionId);
			else args.push("--last");
			args.push(prompt);
			return args;
		}

		const args = [
			"exec",
			`--sandbox=${state.sandbox}`,
			"--skip-git-repo-check",
			"--json",
			"-o",
			lastMessageFile,
		];
		if (state.model) args.push("-m", state.model);
		if (state.profile) args.push("-p", state.profile);
		args.push("--", prompt);
		return args;
	}

	async function runCodexProcess(
		ctx: ExtensionContext,
		args: string[],
		options: {
			timeoutMs: number;
			logFile: string;
			lastMessageFile: string;
			signal?: AbortSignal;
			onProgress?: (message: string) => void;
			onUpdate?: (update: ToolUpdate) => void;
			onAbortReady?: (abort: (() => void) | null) => void;
		},
	): Promise<CodexRunResult> {
		const beforeIndex = readCodexIndex();
		const startedAtMs = Date.now();
		ensureDir(options.logFile);
		ensureDir(options.lastMessageFile);
		tryDelete(options.lastMessageFile);

		return await new Promise<CodexRunResult>((resolve) => {
			let stdout = "";
			let stderr = "";
			let stdoutBuffer = "";
			let stderrBuffer = "";
			let sessionId: string | undefined;
			let aborted = false;
			let timedOut = false;
			let settled = false;
			let lastProgress = "Starting Codex…";
			let child: ReturnType<typeof spawn> | null = null;

			const stdoutLog = fs.createWriteStream(options.logFile, { flags: "a" });

			const emitProgress = (message: string, kind = classifyProgress(message)) => {
				lastProgress = message;
				options.onProgress?.(message);
				options.onUpdate?.({ content: [{ type: "text", text: truncateText(message, 600) }], details: { progress: message, kind } });
			};

			const abort = () => {
				aborted = true;
				if (child && !child.killed) {
					child.kill("SIGTERM");
					setTimeout(() => {
						if (child && !child.killed) child.kill("SIGKILL");
					}, 2000).unref?.();
				}
			};

			const timeout = setTimeout(() => {
				timedOut = true;
				abort();
			}, options.timeoutMs);

			const abortListener = () => abort();
			options.signal?.addEventListener("abort", abortListener, { once: true });
			options.onAbortReady?.(abort);

			const processStdoutLine = (line: string) => {
				if (!line.trim()) return;
				try {
					const event = JSON.parse(line) as unknown;
					sessionId = findSessionId(event) ?? sessionId;
					const summary = describeCodexEvent(event);
					if (summary) emitProgress(summary);
				} catch {
					emitProgress(truncateText(line.trim(), 180));
				}
			};

			const flushStdoutBuffer = () => {
				if (stdoutBuffer.trim()) processStdoutLine(stdoutBuffer);
				stdoutBuffer = "";
			};

			const finish = (code: number | null, signal: NodeJS.Signals | null) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				options.signal?.removeEventListener("abort", abortListener);
				options.onAbortReady?.(null);
				flushStdoutBuffer();
				stdoutLog.end();

				const durationMs = Date.now() - startedAtMs;
				const lastMessage = tryRead(options.lastMessageFile)?.trim() || undefined;
				const fallbackText = extractCodexText(stdout) || stderr.trim() || lastProgress || "Codex finished with no output.";
				const newestId = newestSessionIdSince(beforeIndex, startedAtMs);
				resolve({
					code,
					signal,
					stdout,
					stderr,
					aborted,
					timedOut,
					sessionId: sessionId ?? newestId,
					lastMessage,
					summary: truncateText(lastMessage ?? fallbackText, 4000),
					logFile: options.logFile,
					lastMessageFile: options.lastMessageFile,
					durationMs,
					args,
				});
			};

			try {
				child = spawn("codex", args, { cwd: ctx.cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
				emitProgress(`Codex process started (pid ${child.pid ?? "unknown"})`);
			} catch (error) {
				stderr += error instanceof Error ? error.message : String(error);
				emitProgress(`Codex spawn failed: ${stderr}`, "error");
				finish(1, null);
				return;
			}

			child.stdout.on("data", (chunk: Buffer) => {
				const text = chunk.toString("utf-8");
				stdout += text;
				stdoutLog.write(text);
				stdoutBuffer += text;
				let newlineIndex = stdoutBuffer.indexOf("\n");
				while (newlineIndex >= 0) {
					const line = stdoutBuffer.slice(0, newlineIndex);
					stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
					processStdoutLine(line);
					newlineIndex = stdoutBuffer.indexOf("\n");
				}
			});

			child.stderr.on("data", (chunk: Buffer) => {
				const text = chunk.toString("utf-8");
				stderr += text;
				stderrBuffer += text;
				let newlineIndex = stderrBuffer.indexOf("\n");
				while (newlineIndex >= 0) {
					const line = stderrBuffer.slice(0, newlineIndex).trim();
					stderrBuffer = stderrBuffer.slice(newlineIndex + 1);
					if (line) emitProgress(`stderr: ${truncateText(line, 180)}`, "stderr");
					newlineIndex = stderrBuffer.indexOf("\n");
				}
			});

			child.on("error", (error) => {
				stderr += error.message;
				finish(1, null);
			});

			child.on("close", finish);
		});
	}

	async function runGoal(
		ctx: ExtensionContext,
		state: GoalState,
		mode: "start" | "resume",
		prompt: string,
		options: { signal?: AbortSignal; onUpdate?: (update: ToolUpdate) => void } = {},
	): Promise<CodexRunResult> {
		state.status = "running";
		state.runs += 1;
		state.lastPrompt = truncateText(prompt, 6000);
		const runId = String(state.runs).padStart(3, "0");
		const logFile = path.join(logsDir(ctx), `${state.name}-${runId}.jsonl`);
		const lastMessageFile = path.join(logsDir(ctx), `${state.name}-${runId}.last-message.txt`);
		state.lastLogFile = path.relative(ctx.cwd, logFile);
		state.lastMessageFile = path.relative(ctx.cwd, lastMessageFile);
		const args = buildCodexArgs(state, mode, prompt, lastMessageFile);
		state.lastCommand = ["codex", ...args];
		saveState(ctx, state);
		currentGoal = state.name;

		const progressPanel = createCodexProgressPanel(ctx, {
			name: state.name,
			mode,
			command: args,
			logFile,
			lastMessageFile,
			taskFile: state.taskFile,
			sessionId: state.sessionId,
		});
		progressPanel.start();
		progressPanel.event("Starting Codex process…");

		if (ctx.hasUI) ctx.ui.setWorkingMessage(`Codex /goal ${state.name} running…`);
		const result = await runCodexProcess(ctx, args, {
			timeoutMs: state.timeoutMs,
			logFile,
			lastMessageFile,
			signal: options.signal,
			onUpdate: options.onUpdate,
			onProgress: (message) => progressPanel.event(message),
			onAbortReady: (abort) => {
				runningGoal = abort ? { name: state.name, abort } : null;
			},
		});
		if (ctx.hasUI) ctx.ui.setWorkingMessage();

		if (result.sessionId) state.sessionId = result.sessionId;
		state.lastExitCode = result.code;
		state.lastOutput = truncateText(cleanMarkers(result.summary), 8000);
		state.lastError = result.stderr ? truncateText(result.stderr, 4000) : undefined;
		state.lastLogFile = path.relative(ctx.cwd, result.logFile);
		state.lastMessageFile = path.relative(ctx.cwd, result.lastMessageFile);
		state.lastDurationMs = result.durationMs;
		state.lastCommand = ["codex", ...result.args];

		const combined = `${result.summary}\n${result.stderr}`;
		if (result.timedOut) {
			state.status = "failed";
			state.lastError = `Timed out after ${state.timeoutMs}ms. ${state.lastError ?? ""}`.trim();
		} else if (result.aborted || options.signal?.aborted) {
			state.status = "paused";
			state.lastError = "Codex run aborted.";
		} else if (result.code !== 0) {
			state.status = "failed";
		} else if (combined.includes(COMPLETE_MARKER)) {
			state.status = "completed";
			state.completedAt = new Date().toISOString();
		} else {
			state.status = "paused";
		}

		saveState(ctx, state);
		progressPanel.finish(`Codex goal ${state.status} in ${formatDuration(result.durationMs)}`, state.status === "failed" ? "error" : "done");
		progressPanel.stop();
		return result;
	}

	async function runOneShot(
		ctx: ExtensionContext,
		goal: string,
		args: ParsedArgs,
		options: { signal?: AbortSignal; onUpdate?: (update: ToolUpdate) => void } = {},
	): Promise<CodexRunResult> {
		const runId = `oneshot-${Date.now()}`;
		const logFile = path.join(logsDir(ctx), `${runId}.jsonl`);
		const lastMessageFile = path.join(logsDir(ctx), `${runId}.last-message.txt`);
		const prompt = buildOneShotPrompt(goal);
		const codexArgs = [
			"exec",
			`--sandbox=${args.sandbox}`,
			"--skip-git-repo-check",
			"--json",
			"-o",
			lastMessageFile,
		];
		if (args.model) codexArgs.push("-m", args.model);
		if (args.profile) codexArgs.push("-p", args.profile);
		codexArgs.push("--", prompt);

		const progressPanel = createCodexProgressPanel(ctx, {
			name: "one-shot",
			mode: "one-shot",
			command: codexArgs,
			logFile,
			lastMessageFile,
		});
		progressPanel.start();
		progressPanel.event("Starting Codex process…");

		if (ctx.hasUI) ctx.ui.setWorkingMessage("Codex /goal running…");
		const result = await runCodexProcess(ctx, codexArgs, {
			timeoutMs: args.timeoutMs,
			logFile,
			lastMessageFile,
			signal: options.signal,
			onUpdate: options.onUpdate,
			onAbortReady: (abort) => {
				runningGoal = abort ? { name: runId, abort } : null;
			},
			onProgress: (message) => progressPanel.event(message),
		});
		if (ctx.hasUI) ctx.ui.setWorkingMessage();
		progressPanel.finish(result.code === 0 ? `Codex one-shot finished in ${formatDuration(result.durationMs)}` : `Codex one-shot failed (${result.code ?? "signal"}) in ${formatDuration(result.durationMs)}`, result.code === 0 ? "done" : "error");
		progressPanel.stop();
		return result;
	}

	// --- command handlers ---------------------------------------------------

	async function ensureGoalContent(ctx: ExtensionContext, name: string, taskFile: string, objective: string, edit: boolean) {
		const fullPath = path.resolve(ctx.cwd, taskFile);
		let content = tryRead(fullPath);
		if (!content) {
			content = objective.trim() ? taskFromObjective(name, objective) : DEFAULT_TEMPLATE;
		}
		if ((edit || !objective.trim()) && ctx.hasUI) {
			const edited = await ctx.ui.editor(`Edit Codex goal: ${name}`, content);
			if (edited === undefined) return null;
			content = edited;
		}
		writeFile(fullPath, content);
		return content;
	}

	async function handleStart(rest: string, ctx: ExtensionContext) {
		const args = parseArgs(rest);
		let name = args.name;
		let taskFile = args.file;
		let positionals = [...args.positionals];

		if (!name && positionals[0]?.includes(path.sep)) {
			taskFile = positionals.shift();
			name = sanitize(path.basename(taskFile!, path.extname(taskFile!)));
		} else if (!name && positionals.length > 0) {
			name = sanitize(positionals.shift()!);
		}

		if (!name && ctx.hasUI) {
			const entered = await ctx.ui.input("Codex goal name", "my-goal");
			if (!entered) return;
			name = sanitize(entered);
		}
		if (!name) {
			notify(ctx, "Usage: /goal start <name|path> [objective] [--edit] [--no-run]", "warning");
			return;
		}

		taskFile = taskFile ?? path.join(GOAL_DIR, `${name}.md`);
		const existing = loadState(ctx, name);
		if (existing && existing.status !== "completed" && !args.force) {
			notify(ctx, `Goal "${name}" already exists (${existing.status}). Use /goal resume ${name} or /goal start ${name} --force.`, "warning");
			return;
		}

		const objective = positionals.join(" ");
		const content = await ensureGoalContent(ctx, name, taskFile, objective, args.edit);
		if (content === null) {
			notify(ctx, "Goal creation cancelled.", "info");
			return;
		}

		const state: GoalState = {
			version: 1,
			name,
			taskFile,
			status: "paused",
			active: true,
			runs: 0,
			startedAt: existing?.startedAt ?? new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			sandbox: args.sandbox,
			timeoutMs: args.timeoutMs,
			model: args.model,
			profile: args.profile,
		};

		saveState(ctx, state);
		currentGoal = name;
		updateUI(ctx);
		notify(ctx, `Created Codex goal "${name}" at ${taskFile}.`, "info");

		if (args.noRun) return;

		const result = await runGoal(ctx, state, "start", buildStartPrompt(state, content));
		showRunResult(ctx, state, result);
	}

	async function chooseGoal(ctx: ExtensionContext, prompt = "Pick a Codex goal"): Promise<string | undefined> {
		const goals = listGoals(ctx).filter((goal) => goal.status !== "completed");
		if (goals.length === 0) return undefined;
		if (!ctx.hasUI) return goals[0].name;
		const labels = goals.map((goal) => formatGoal(goal));
		const selected = await ctx.ui.select(prompt, labels);
		if (!selected) return undefined;
		const index = labels.indexOf(selected);
		return goals[index]?.name;
	}

	async function handleResume(rest: string, ctx: ExtensionContext) {
		const args = parseArgs(rest);
		let name = args.name ?? args.positionals.shift();
		if (!name) name = await chooseGoal(ctx, "Resume Codex goal");
		if (!name) {
			notify(ctx, "Usage: /goal resume <name> [prompt]", "warning");
			return;
		}

		const state = loadState(ctx, name);
		if (!state) {
			notify(ctx, `Goal "${name}" not found.`, "error");
			return;
		}
		if (state.status === "completed" && !args.force) {
			notify(ctx, `Goal "${name}" is completed. Use --force to resume anyway.`, "warning");
			return;
		}

		state.timeoutMs = args.timeoutMs !== DEFAULT_TIMEOUT_MS ? args.timeoutMs : state.timeoutMs;
		state.model = args.model ?? state.model;
		state.profile = args.profile ?? state.profile;
		const taskContent = tryRead(path.resolve(ctx.cwd, state.taskFile));
		if (!taskContent) {
			notify(ctx, `Could not read task file: ${state.taskFile}`, "error");
			return;
		}

		let userPrompt = args.positionals.join(" ");
		if (args.edit && ctx.hasUI) {
			const edited = await ctx.ui.editor("Resume prompt", userPrompt || buildResumePrompt(state, taskContent));
			if (edited === undefined) return;
			userPrompt = edited;
		}

		const prompt = userPrompt && args.edit ? userPrompt : buildResumePrompt(state, taskContent, userPrompt);
		const result = await runGoal(ctx, state, "resume", prompt);
		showRunResult(ctx, state, result);
	}

	async function handleRun(rest: string, ctx: ExtensionContext) {
		const args = parseArgs(rest);
		let goal = args.positionals.join(" ");
		if (!goal && ctx.hasUI) {
			const edited = await ctx.ui.editor("Codex /goal", "Describe the goal for Codex...");
			if (!edited) return;
			goal = edited;
		}
		if (!goal.trim()) {
			notify(ctx, "Usage: /goal run <goal text> or /goal <goal text>", "warning");
			return;
		}
		const result = await runOneShot(ctx, goal, args);
		notify(ctx, `codex /goal finished in ${formatDuration(result.durationMs)}:\n${truncateText(cleanMarkers(result.summary), 2500)}`, result.code === 0 ? "info" : "error");
	}

	function handleStop(_rest: string, ctx: ExtensionContext) {
		if (runningGoal) {
			runningGoal.abort();
			notify(ctx, `Abort requested for Codex goal "${runningGoal.name}".`, "warning");
			return;
		}
		const active = currentGoal ? loadState(ctx, currentGoal) : getMostRecentResumable(ctx);
		if (!active) {
			notify(ctx, "No active Codex goal.", "warning");
			return;
		}
		if (active.status === "running") active.status = "paused";
		saveState(ctx, active);
		currentGoal = active.name;
		updateUI(ctx);
		notify(ctx, `Paused Codex goal: ${active.name}`, "info");
	}

	function handleStatus(rest: string, ctx: ExtensionContext) {
		const archived = parseArgs(rest).positionals.includes("archived") || rest.includes("--archived");
		const goals = listGoals(ctx, archived);
		if (goals.length === 0) {
			notify(ctx, archived ? "No archived Codex goals." : "No Codex goals found.", "info");
			return;
		}
		notify(ctx, `${archived ? "Archived" : "Codex"} goals:\n${goals.map((goal) => `  • ${formatGoal(goal)}`).join("\n")}`, "info");
	}

	function handleLog(rest: string, ctx: ExtensionContext) {
		const args = parseArgs(rest);
		const name = args.name ?? args.positionals[0] ?? currentGoal;
		if (!name) {
			notify(ctx, "Usage: /goal log <name>", "warning");
			return;
		}
		const state = loadState(ctx, name);
		if (!state) {
			notify(ctx, `Goal "${name}" not found.`, "error");
			return;
		}
		const log = state.lastLogFile ? path.resolve(ctx.cwd, state.lastLogFile) : undefined;
		const msg = state.lastMessageFile ? path.resolve(ctx.cwd, state.lastMessageFile) : undefined;
		const output = state.lastOutput ?? (msg ? tryRead(msg) : undefined) ?? "No output captured yet.";
		const duration = state.lastDurationMs ? `\nDuration: ${formatDuration(state.lastDurationMs)}` : "";
		notify(ctx, `Codex goal ${name}\nLog: ${log ?? "none"}\nLast message: ${msg ?? "none"}${duration}\n\n${truncateText(output, 2500)}`, "info");
	}

	async function handleEdit(rest: string, ctx: ExtensionContext) {
		const args = parseArgs(rest);
		const name = args.name ?? args.positionals[0] ?? currentGoal;
		if (!name) {
			notify(ctx, "Usage: /goal edit <name>", "warning");
			return;
		}
		const state = loadState(ctx, name);
		if (!state) {
			notify(ctx, `Goal "${name}" not found.`, "error");
			return;
		}
		const taskPath = path.resolve(ctx.cwd, state.taskFile);
		const current = tryRead(taskPath) ?? DEFAULT_TEMPLATE;
		if (!ctx.hasUI) {
			notify(ctx, `/goal edit requires interactive mode. File: ${state.taskFile}`, "warning");
			return;
		}
		const edited = await ctx.ui.editor(`Edit ${state.taskFile}`, current);
		if (edited === undefined) return;
		writeFile(taskPath, edited);
		notify(ctx, `Updated ${state.taskFile}`, "info");
	}

	function handleCancel(rest: string, ctx: ExtensionContext) {
		const args = parseArgs(rest);
		const name = args.name ?? args.positionals[0];
		if (!name) {
			notify(ctx, "Usage: /goal cancel <name> [--all]", "warning");
			return;
		}
		const state = loadState(ctx, name);
		if (!state) {
			notify(ctx, `Goal "${name}" not found.`, "error");
			return;
		}
		if (runningGoal?.name === state.name) runningGoal.abort();
		tryDelete(getStatePath(ctx, state.name));
		if (args.all && isInternalGoalFile(ctx, state.taskFile)) tryDelete(path.resolve(ctx.cwd, state.taskFile));
		if (currentGoal === state.name) currentGoal = null;
		updateUI(ctx);
		notify(ctx, `Cancelled Codex goal: ${state.name}${args.all ? " (state + internal task file)" : ""}`, "info");
	}

	function handleArchive(rest: string, ctx: ExtensionContext) {
		const args = parseArgs(rest);
		const name = args.name ?? args.positionals[0];
		if (!name) {
			notify(ctx, "Usage: /goal archive <name>", "warning");
			return;
		}
		const state = loadState(ctx, name);
		if (!state) {
			notify(ctx, `Goal "${name}" not found.`, "error");
			return;
		}
		if (state.status === "running") {
			notify(ctx, "Cannot archive a running goal. Stop it first.", "warning");
			return;
		}
		const srcState = getStatePath(ctx, state.name);
		const dstState = getStatePath(ctx, state.name, true);
		ensureDir(dstState);
		fs.renameSync(srcState, dstState);

		if (isInternalGoalFile(ctx, state.taskFile)) {
			const srcTask = path.resolve(ctx.cwd, state.taskFile);
			const dstTask = getTaskPath(ctx, state.name, true);
			if (fs.existsSync(srcTask)) fs.renameSync(srcTask, dstTask);
		}
		if (currentGoal === state.name) currentGoal = null;
		updateUI(ctx);
		notify(ctx, `Archived Codex goal: ${state.name}`, "info");
	}

	function handleClean(rest: string, ctx: ExtensionContext) {
		const args = parseArgs(rest);
		const completed = listGoals(ctx).filter((goal) => goal.status === "completed");
		if (completed.length === 0) {
			notify(ctx, "No completed Codex goals to clean.", "info");
			return;
		}
		for (const goal of completed) {
			tryDelete(getStatePath(ctx, goal.name));
			if (args.all && isInternalGoalFile(ctx, goal.taskFile)) tryDelete(path.resolve(ctx.cwd, goal.taskFile));
			if (currentGoal === goal.name) currentGoal = null;
		}
		updateUI(ctx);
		notify(ctx, `Cleaned ${completed.length} completed Codex goal(s)${args.all ? " and internal task files" : ""}.`, "info");
	}

	async function handleNuke(rest: string, ctx: ExtensionContext) {
		const args = parseArgs(rest);
		const warning = "This deletes all .codex-goals state, internal task files, logs, and archives.";
		if (!args.yes) {
			if (!ctx.hasUI) {
				notify(ctx, `Run /goal nuke --yes to confirm. ${warning}`, "warning");
				return;
			}
			const confirmed = await ctx.ui.confirm("Delete all Codex goal files?", warning);
			if (!confirmed) return;
		}
		if (runningGoal) runningGoal.abort();
		try {
			fs.rmSync(goalDir(ctx), { recursive: true, force: true });
			currentGoal = null;
			updateUI(ctx);
			notify(ctx, "Removed .codex-goals.", "info");
		} catch (error) {
			notify(ctx, `Failed to remove .codex-goals: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	}

	function showRunResult(ctx: ExtensionContext, state: GoalState, result: CodexRunResult): void {
		const clean = truncateText(cleanMarkers(result.summary), 2500);
		const session = state.sessionId ? `\nSession: ${state.sessionId}` : "";
		const log = state.lastLogFile ? `\nLog: ${state.lastLogFile}` : "";
		const duration = `\nDuration: ${formatDuration(result.durationMs)}`;
		const level: NotifyLevel = state.status === "failed" ? "error" : "info";
		notify(ctx, `Codex goal "${state.name}" ${state.status} in ${formatDuration(result.durationMs)}.${session}${log}${duration}\n\n${clean}`, level);
	}

	const HELP = `Codex Goal - interactive Codex /goal sessions

Commands:
  /goal <text>                         Run one-shot Codex goal (compat mode)
  /goal run <text> [options]           Run one-shot Codex goal
  /goal start <name|path> [objective]  Create and run a managed goal
  /goal resume [name] [prompt]         Resume a managed Codex session
  /goal continue [name] [prompt]       Alias for resume
  /goal stop                           Abort/pause the current goal
  /goal status                         Show goals
  /goal list [--archived]              Show goals
  /goal log [name]                     Show last output/log path
  /goal edit [name]                    Edit the task file
  /goal cancel <name> [--all]          Delete goal state (and internal task file with --all)
  /goal archive <name>                 Move state/task to archive
  /goal clean [--all]                  Remove completed goals
  /goal nuke [--yes]                   Delete all .codex-goals data

Options:
  --sandbox read-only|workspace-write|danger-full-access
  --timeout-ms N
  --model MODEL
  --profile PROFILE (start/run only)
  --edit        Open the generated/resume prompt in an editor first
  --no-run      Create the managed goal without launching Codex
  --force       Recreate/resume completed goal

Examples:
  /goal start auth-refactor "Refactor auth and add tests" --sandbox workspace-write
  /goal resume auth-refactor "Continue with failing tests"
  /goal status`;

	pi.registerCommand("goal", {
		description: "Interactive Codex /goal sessions with start/resume/status",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (!trimmed) {
				notify(ctx, HELP, "info");
				return;
			}

			const command = trimmed.split(/\s+/, 1)[0] ?? "";
			const rest = trimmed.slice(command.length).trim();
			try {
				switch (command) {
					case "help":
						notify(ctx, HELP, "info");
						break;
					case "start":
					case "new":
						await handleStart(rest, ctx);
						break;
					case "resume":
					case "continue":
						await handleResume(rest, ctx);
						break;
					case "run":
						await handleRun(rest, ctx);
						break;
					case "stop":
					case "pause":
						handleStop(rest, ctx);
						break;
					case "status":
					case "list":
						handleStatus(rest, ctx);
						break;
					case "log":
						handleLog(rest, ctx);
						break;
					case "edit":
						await handleEdit(rest, ctx);
						break;
					case "cancel":
						handleCancel(rest, ctx);
						break;
					case "archive":
						handleArchive(rest, ctx);
						break;
					case "clean":
						handleClean(rest, ctx);
						break;
					case "nuke":
						await handleNuke(rest, ctx);
						break;
					default:
						await handleRun(trimmed, ctx);
				}
			} catch (error) {
				notify(ctx, error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	// --- agent tools --------------------------------------------------------

	pi.registerTool({
		name: "codex_goal_run",
		label: "Codex Goal Run",
		description: "Run a one-shot Codex /goal non-interactively with progress updates.",
		promptSnippet: "Run a one-shot Codex /goal objective through the Codex CLI.",
		promptGuidelines: ["Use codex_goal_run when the user asks for a one-off Codex /goal execution and does not need a resumable session."],
		parameters: Type.Object({
			goal: Type.String({ description: "Objective to give Codex." }),
			timeoutMs: Type.Optional(Type.Integer({ minimum: 5000, maximum: 3_600_000 })),
			sandbox: Type.Optional(SandboxSchema),
			model: Type.Optional(Type.String({ description: "Optional Codex model." })),
			profile: Type.Optional(Type.String({ description: "Optional Codex config profile." })),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const parsed: ParsedArgs = {
				positionals: [],
				sandbox: (params.sandbox ?? DEFAULT_SANDBOX) as SandboxMode,
				timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
				model: params.model,
				profile: params.profile,
				force: false,
				noRun: false,
				edit: false,
				all: false,
				yes: false,
			};
			const result = await runOneShot(ctx, params.goal, parsed, { signal, onUpdate });
			return {
				content: [{ type: "text", text: `Codex /goal finished in ${formatDuration(result.durationMs)}.\n${truncateText(cleanMarkers(result.summary), 2500)}` }],
				details: { result },
			};
		},
	});

	pi.registerTool({
		name: "codex_goal_start",
		label: "Start Codex Goal",
		description: "Create a managed Codex /goal session with persistent state that can be resumed later.",
		promptSnippet: "Start a persistent Codex /goal session with /goal resume support.",
		promptGuidelines: [
			"Use codex_goal_start when the user asks for an interactive, resumable Codex /goal workflow.",
			"Prefer codex_goal_resume for an existing managed goal instead of starting a duplicate.",
		],
		parameters: Type.Object({
			name: Type.String({ description: "Goal name, e.g. auth-refactor." }),
			goal: Type.String({ description: "Goal content in markdown or plain text." }),
			run: Type.Optional(Type.Boolean({ description: "Launch Codex immediately. Defaults to true." })),
			timeoutMs: Type.Optional(Type.Integer({ minimum: 5000, maximum: 3_600_000 })),
			sandbox: Type.Optional(SandboxSchema),
			model: Type.Optional(Type.String({ description: "Optional Codex model." })),
			profile: Type.Optional(Type.String({ description: "Optional Codex config profile." })),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const name = sanitize(params.name);
			const taskFile = path.join(GOAL_DIR, `${name}.md`);
			const content = params.goal.trim().startsWith("#") ? params.goal : taskFromObjective(name, params.goal);
			writeFile(path.resolve(ctx.cwd, taskFile), content);
			const state: GoalState = {
				version: 1,
				name,
				taskFile,
				status: "paused",
				active: true,
				runs: 0,
				startedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				sandbox: (params.sandbox ?? DEFAULT_SANDBOX) as SandboxMode,
				timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
				model: params.model,
				profile: params.profile,
			};
			saveState(ctx, state);
			currentGoal = name;
			updateUI(ctx);

			if (params.run === false) {
				return {
					content: [{ type: "text", text: `Created Codex goal "${name}" at ${taskFile}. Resume with /goal resume ${name}.` }],
					details: { state },
				};
			}

			const result = await runGoal(ctx, state, "start", buildStartPrompt(state, content), { signal, onUpdate });
			return {
				content: [{ type: "text", text: `Codex goal "${name}" ${state.status} in ${formatDuration(result.durationMs)}.\n${truncateText(cleanMarkers(result.summary), 2500)}` }],
				details: { state, result },
			};
		},
	});

	pi.registerTool({
		name: "codex_goal_resume",
		label: "Resume Codex Goal",
		description: "Resume an existing managed Codex /goal session by name.",
		promptSnippet: "Resume a persistent Codex /goal session created by codex_goal_start or /goal start.",
		promptGuidelines: ["Use codex_goal_resume when continuing a managed Codex /goal after prior output, failure, or user feedback."],
		parameters: Type.Object({
			name: Type.String({ description: "Managed goal name." }),
			prompt: Type.Optional(Type.String({ description: "Optional resume note or instruction." })),
			timeoutMs: Type.Optional(Type.Integer({ minimum: 5000, maximum: 3_600_000 })),
			model: Type.Optional(Type.String({ description: "Optional Codex model override for resume." })),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const name = sanitize(params.name);
			const state = loadState(ctx, name);
			if (!state) return { content: [{ type: "text", text: `Codex goal "${name}" not found.` }], details: {} };
			if (params.timeoutMs) state.timeoutMs = params.timeoutMs;
			if (params.model) state.model = params.model;
			const taskContent = tryRead(path.resolve(ctx.cwd, state.taskFile));
			if (!taskContent) return { content: [{ type: "text", text: `Could not read task file: ${state.taskFile}` }], details: { state } };
			const result = await runGoal(ctx, state, "resume", buildResumePrompt(state, taskContent, params.prompt), { signal, onUpdate });
			return {
				content: [{ type: "text", text: `Codex goal "${name}" ${state.status} in ${formatDuration(result.durationMs)}.\n${truncateText(cleanMarkers(result.summary), 2500)}` }],
				details: { state, result },
			};
		},
	});

	// --- lifecycle ----------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		for (const state of listGoals(ctx)) {
			if (state.status === "running") {
				state.status = "paused";
				state.lastError = "Recovered after Pi reload/shutdown while Codex was marked running.";
				saveState(ctx, state);
			}
		}

		const current = getMostRecentResumable(ctx);
		if (current) currentGoal = current.name;
		if (ctx.hasUI) {
			const goals = listGoals(ctx).filter((goal) => goal.status !== "completed");
			if (goals.length > 0) {
				ctx.ui.notify(`Codex goals available:\n${goals.slice(0, 5).map((goal) => `  • ${formatGoal(goal)}`).join("\n")}\n\nUse /goal resume <name> to continue.`, "info");
			}
		}
		updateUI(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (runningGoal) runningGoal.abort();
		if (currentGoal) {
			const state = loadState(ctx, currentGoal);
			if (state && state.status === "running") {
				state.status = "paused";
				state.lastError = "Pi session shutdown interrupted this Codex goal.";
				saveState(ctx, state);
			}
		}
	});
}
