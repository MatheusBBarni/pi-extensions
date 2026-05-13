import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { JsonSchemaType, JsonSchemaValidator, jsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/types.js";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(EXTENSION_DIR, "config.json");
const CLIENT_VERSION = "0.1.1";
const REDACTED = "[redacted]";

const EMPTY_SCHEMA = {
	type: "object",
	properties: {},
	additionalProperties: false,
} as const;

const READ_RESOURCE_SCHEMA = {
	type: "object",
	properties: {
		uri: { type: "string", description: "MCP resource URI to read" },
	},
	required: ["uri"],
	additionalProperties: false,
} as const;

const GET_PROMPT_SCHEMA = {
	type: "object",
	properties: {
		name: { type: "string", description: "MCP prompt name" },
		arguments: {
			type: "object",
			description: "Optional prompt arguments",
			additionalProperties: true,
		},
	},
	required: ["name"],
	additionalProperties: false,
} as const;

const BUILTIN_TOOL_NAMES = [
	"stitch_mcp_status",
	"stitch_mcp_list_resources",
	"stitch_mcp_read_resource",
	"stitch_mcp_list_prompts",
	"stitch_mcp_get_prompt",
] as const;

type StitchConfig = {
	url?: string;
	apiKey?: string;
	headers?: Record<string, string>;
	toolPrefix?: string;
	connectTimeoutMs?: number;
	requestTimeoutMs?: number;
};

type ResolvedStitchConfig = Required<Pick<StitchConfig, "url" | "toolPrefix" | "connectTimeoutMs" | "requestTimeoutMs">> &
	StitchConfig;

type McpTool = {
	name: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
	annotations?: Record<string, unknown>;
	title?: string;
};

type PiContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

type ConnectionState = {
	client: Client | null;
	transport: StreamableHTTPClientTransport | null;
	tools: McpTool[];
	registeredToolNames: Map<string, string>;
	lastError?: string;
	connectedAt?: number;
	connecting?: Promise<Client>;
};

const permissiveJsonSchemaValidator: jsonSchemaValidator = {
	getValidator<T>(_schema: JsonSchemaType): JsonSchemaValidator<T> {
		return (input: unknown) => ({ valid: true as const, data: input as T, errorMessage: undefined });
	},
};

function readConfig(): ResolvedStitchConfig {
	let fileConfig: StitchConfig = {};
	if (existsSync(CONFIG_PATH)) {
		fileConfig = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as StitchConfig;
	}

	return {
		url: fileConfig.url ?? process.env.STITCH_MCP_URL ?? "https://stitch.googleapis.com/mcp",
		apiKey: fileConfig.apiKey ?? process.env.STITCH_MCP_API_KEY ?? process.env.GOOGLE_API_KEY,
		headers: fileConfig.headers ?? {},
		toolPrefix: fileConfig.toolPrefix ?? "stitch_",
		connectTimeoutMs: fileConfig.connectTimeoutMs ?? 15_000,
		requestTimeoutMs: fileConfig.requestTimeoutMs ?? 120_000,
	};
}

function secretCandidates(config?: StitchConfig): string[] {
	const values = [
		config?.apiKey,
		process.env.STITCH_MCP_API_KEY,
		process.env.GOOGLE_API_KEY,
		...Object.values(config?.headers ?? {}),
	];
	return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length >= 4))].sort(
		(a, b) => b.length - a.length,
	);
}

function redactSecrets(input: string, config?: StitchConfig): string {
	let output = input;
	for (const secret of secretCandidates(config)) {
		output = output.split(secret).join(REDACTED);
	}
	return output
		.replace(/([?&](?:key|api_key|apikey|token|access_token)=)[^&\s]+/gi, `$1${REDACTED}`)
		.replace(/((?:x-goog-api-key|api-key|apikey|apiKey)["'\s:=]+)[^"'\s,}]+/gi, `$1${REDACTED}`)
		.replace(/(authorization["'\s:=]+bearer\s+)[^"'\s,}]+/gi, `$1${REDACTED}`);
}

function headersFor(config: StitchConfig): Record<string, string> {
	const headers: Record<string, string> = { ...(config.headers ?? {}) };
	if (config.apiKey && !headers["X-Goog-Api-Key"]) {
		headers["X-Goog-Api-Key"] = config.apiKey;
	}
	return headers;
}

function errorMessage(error: unknown, config?: StitchConfig): string {
	const message = error instanceof Error ? error.message : String(error);
	return redactSecrets(message, config);
}

function toRedactedError(error: unknown, config?: StitchConfig): Error {
	return new Error(errorMessage(error, config));
}

function sanitizeToolName(prefix: string, original: string, used: Set<string>): string {
	const base = `${prefix}${original}`
		.replace(/[^a-zA-Z0-9_-]/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 64);

	let candidate = base || `${prefix}tool`;
	let suffix = 2;
	while (used.has(candidate)) {
		const marker = `_${suffix++}`;
		candidate = `${candidate.slice(0, Math.max(1, 64 - marker.length))}${marker}`;
	}
	used.add(candidate);
	return candidate;
}

function normalizeSchema(schema: unknown): Record<string, unknown> {
	if (!schema || typeof schema !== "object") return EMPTY_SCHEMA;
	const value = schema as Record<string, unknown>;
	if (value.type === "object") return value;
	return {
		type: "object",
		properties: {},
		additionalProperties: true,
	};
}

function stringify(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function mcpContentToPiContent(result: any): PiContent[] {
	const output: PiContent[] = [];

	if (result?.structuredContent !== undefined) {
		output.push({ type: "text", text: `Structured content:\n${stringify(result.structuredContent)}` });
	}

	if (Array.isArray(result?.content)) {
		for (const item of result.content) {
			if (!item || typeof item !== "object") {
				output.push({ type: "text", text: stringify(item) });
				continue;
			}

			switch (item.type) {
				case "text":
					output.push({ type: "text", text: String(item.text ?? "") });
					break;
				case "image":
					if (typeof item.data === "string" && typeof item.mimeType === "string") {
						output.push({ type: "image", data: item.data, mimeType: item.mimeType });
					} else {
						output.push({ type: "text", text: `[MCP image omitted: ${stringify(item)}]` });
					}
					break;
				case "resource": {
					const resource = item.resource ?? {};
					const uri = typeof resource.uri === "string" ? resource.uri : "unknown";
					if (typeof resource.text === "string") {
						output.push({ type: "text", text: `Resource ${uri}:\n${resource.text}` });
					} else if (typeof resource.blob === "string") {
						output.push({ type: "text", text: `Resource ${uri}: binary blob (${resource.blob.length} base64 chars)` });
					} else {
						output.push({ type: "text", text: `Resource ${uri}:\n${stringify(resource)}` });
					}
					break;
				}
				case "resource_link":
					output.push({
						type: "text",
						text: [
							`Resource link: ${item.name ?? item.uri ?? "unknown"}`,
							item.uri ? `URI: ${item.uri}` : undefined,
							item.mimeType ? `MIME: ${item.mimeType}` : undefined,
							item.description ? `Description: ${item.description}` : undefined,
						]
							.filter(Boolean)
							.join("\n"),
					});
					break;
				case "audio":
					output.push({ type: "text", text: `[MCP audio content omitted: ${item.mimeType ?? "unknown MIME"}]` });
					break;
				default:
					output.push({ type: "text", text: stringify(item) });
			}
		}
	}

	if (result?.toolResult !== undefined) {
		output.push({ type: "text", text: `Tool result:\n${stringify(result.toolResult)}` });
	}

	if (result?.isError) {
		output.unshift({ type: "text", text: "MCP tool returned isError=true." });
	}

	if (output.length === 0) {
		output.push({ type: "text", text: stringify(result ?? null) });
	}

	return output;
}

async function closeState(state: ConnectionState) {
	const transport = state.transport;
	state.client = null;
	state.transport = null;
	state.connectedAt = undefined;
	state.connecting = undefined;
	if (transport) {
		try {
			await transport.close();
		} catch {
			// Ignore close failures.
		}
	}
}

async function connect(state: ConnectionState): Promise<Client> {
	if (state.client) return state.client;
	if (state.connecting) return state.connecting;

	state.connecting = (async () => {
		const config = readConfig();
		const headers = headersFor(config);
		if (!headers["X-Goog-Api-Key"]) {
			throw new Error(`Missing Stitch MCP API key. Set STITCH_MCP_API_KEY or add apiKey to ${CONFIG_PATH}.`);
		}

		const client = new Client(
			{ name: "pi-stitch-mcp", version: CLIENT_VERSION },
			{ capabilities: {}, jsonSchemaValidator: permissiveJsonSchemaValidator },
		);
		const transport = new StreamableHTTPClientTransport(new URL(config.url), {
			requestInit: { headers },
		});

		client.onerror = (error) => {
			state.lastError = errorMessage(error, config);
		};
		transport.onerror = (error) => {
			state.lastError = errorMessage(error, config);
		};
		transport.onclose = () => {
			state.client = null;
			state.transport = null;
			state.connectedAt = undefined;
		};

		try {
			await client.connect(transport, { timeout: config.connectTimeoutMs });
			state.client = client;
			state.transport = transport;
			state.connectedAt = Date.now();
			state.lastError = undefined;
			return client;
		} catch (error) {
			state.lastError = errorMessage(error, config);
			try {
				await transport.close();
			} catch {
				// Ignore close failures.
			}
			throw error;
		} finally {
			state.connecting = undefined;
		}
	})();

	return state.connecting;
}

async function listAllTools(client: Client, timeout: number): Promise<McpTool[]> {
	const tools: McpTool[] = [];
	let cursor: string | undefined;
	do {
		const page = await client.listTools(cursor ? { cursor } : undefined, { timeout });
		tools.push(...(page.tools as McpTool[]));
		cursor = page.nextCursor;
	} while (cursor);
	return tools;
}

async function refreshTools(state: ConnectionState): Promise<McpTool[]> {
	const config = readConfig();
	try {
		const client = await connect(state);
		state.tools = await listAllTools(client, config.requestTimeoutMs);
		state.lastError = undefined;
		return state.tools;
	} catch (error) {
		state.lastError = errorMessage(error, config);
		throw error;
	}
}

function statusText(state: ConnectionState): string {
	const config = readConfig();
	const toolLines = state.tools.length
		? state.tools
				.map((tool) => {
					const piName = state.registeredToolNames.get(tool.name);
					return `- ${piName ?? "(not registered)"} → ${tool.name}${tool.description ? ` — ${tool.description}` : ""}`;
				})
				.join("\n")
		: "(no MCP tools discovered yet)";

	return [
		"Stitch MCP status",
		`URL: ${redactSecrets(config.url, config)}`,
		`Connected: ${state.client ? "yes" : "no"}`,
		state.connectedAt ? `Connected at: ${new Date(state.connectedAt).toISOString()}` : undefined,
		state.lastError ? `Last error: ${redactSecrets(state.lastError, config)}` : undefined,
		`MCP tools discovered: ${state.tools.length}`,
		toolLines,
	]
		.filter(Boolean)
		.join("\n");
}

export default async function stitchMcpExtension(pi: ExtensionAPI) {
	const state: ConnectionState = {
		client: null,
		transport: null,
		tools: [],
		registeredToolNames: new Map(),
	};
	const usedToolNames = new Set<string>(BUILTIN_TOOL_NAMES);

	function registerMcpTools(tools: McpTool[], config: ResolvedStitchConfig) {
		for (const tool of tools) {
			if (state.registeredToolNames.has(tool.name)) continue;

			const piToolName = sanitizeToolName(config.toolPrefix, tool.name, usedToolNames);
			state.registeredToolNames.set(tool.name, piToolName);

			pi.registerTool({
				name: piToolName,
				label: tool.title ?? `Stitch: ${tool.name}`,
				description: tool.description ?? `Call Stitch MCP tool ${tool.name}`,
				promptSnippet: `Call Stitch MCP tool ${tool.name}`,
				promptGuidelines: [`Use ${piToolName} when the user asks for Stitch MCP capability: ${tool.description ?? tool.name}.`],
				parameters: normalizeSchema(tool.inputSchema) as any,
				async execute(_toolCallId, params, signal, onUpdate) {
					const currentConfig = readConfig();
					try {
						const client = await connect(state);
						const result = await client.callTool(
							{ name: tool.name, arguments: params as Record<string, unknown> },
							CallToolResultSchema,
							{
								signal,
								timeout: currentConfig.requestTimeoutMs,
								resetTimeoutOnProgress: true,
								onprogress: (progress) => {
									onUpdate?.({
										content: [{ type: "text", text: `MCP progress: ${stringify(progress)}` }],
										details: { progress },
									});
								},
							},
						);

						return {
							content: mcpContentToPiContent(result),
							details: { mcpTool: tool.name, result },
						};
					} catch (error) {
						state.lastError = errorMessage(error, currentConfig);
						throw toRedactedError(error, currentConfig);
					}
				},
			});
		}
	}

	pi.registerTool({
		name: "stitch_mcp_status",
		label: "Stitch MCP Status",
		description: "Show Stitch MCP connection status and discovered MCP tools.",
		promptSnippet: "Show Stitch MCP connection status and discovered MCP tools",
		parameters: EMPTY_SCHEMA as any,
		async execute() {
			return {
				content: [{ type: "text", text: statusText(state) }],
				details: { tools: state.tools, lastError: state.lastError, connected: Boolean(state.client) },
			};
		},
	});

	pi.registerTool({
		name: "stitch_mcp_list_resources",
		label: "Stitch MCP List Resources",
		description: "List resources exposed by the Stitch MCP server, if supported.",
		parameters: EMPTY_SCHEMA as any,
		async execute(_toolCallId, _params, signal) {
			const config = readConfig();
			try {
				const client = await connect(state);
				const result = await client.listResources(undefined, { signal, timeout: config.requestTimeoutMs });
				return {
					content: [{ type: "text", text: stringify(result.resources) }],
					details: result,
				};
			} catch (error) {
				state.lastError = errorMessage(error, config);
				throw toRedactedError(error, config);
			}
		},
	});

	pi.registerTool({
		name: "stitch_mcp_read_resource",
		label: "Stitch MCP Read Resource",
		description: "Read a resource from the Stitch MCP server by URI.",
		parameters: READ_RESOURCE_SCHEMA as any,
		async execute(_toolCallId, params: any, signal) {
			const config = readConfig();
			try {
				const client = await connect(state);
				const result = await client.readResource({ uri: params.uri }, { signal, timeout: config.requestTimeoutMs });
				return {
					content: result.contents.map((content: any) => {
						if (typeof content.text === "string") {
							return { type: "text", text: `Resource ${content.uri}:\n${content.text}` };
						}
						return { type: "text", text: `Resource ${content.uri}: binary blob (${String(content.blob ?? "").length} base64 chars)` };
					}),
					details: result,
				};
			} catch (error) {
				state.lastError = errorMessage(error, config);
				throw toRedactedError(error, config);
			}
		},
	});

	pi.registerTool({
		name: "stitch_mcp_list_prompts",
		label: "Stitch MCP List Prompts",
		description: "List prompts exposed by the Stitch MCP server, if supported.",
		parameters: EMPTY_SCHEMA as any,
		async execute(_toolCallId, _params, signal) {
			const config = readConfig();
			try {
				const client = await connect(state);
				const result = await client.listPrompts(undefined, { signal, timeout: config.requestTimeoutMs });
				return {
					content: [{ type: "text", text: stringify(result.prompts) }],
					details: result,
				};
			} catch (error) {
				state.lastError = errorMessage(error, config);
				throw toRedactedError(error, config);
			}
		},
	});

	pi.registerTool({
		name: "stitch_mcp_get_prompt",
		label: "Stitch MCP Get Prompt",
		description: "Get a prompt from the Stitch MCP server by name and optional arguments.",
		parameters: GET_PROMPT_SCHEMA as any,
		async execute(_toolCallId, params: any, signal) {
			const config = readConfig();
			try {
				const client = await connect(state);
				const result = await client.getPrompt(
					{ name: params.name, arguments: params.arguments ?? {} },
					{ signal, timeout: config.requestTimeoutMs },
				);
				return {
					content: [{ type: "text", text: stringify(result) }],
					details: result,
				};
			} catch (error) {
				state.lastError = errorMessage(error, config);
				throw toRedactedError(error, config);
			}
		},
	});

	pi.registerCommand("stitch-mcp", {
		description: "Show, refresh, or reconnect the Stitch MCP bridge",
		handler: async (args, ctx) => {
			const command = args.trim().toLowerCase();
			if (command === "reconnect") {
				try {
					await closeState(state);
					const config = readConfig();
					await refreshTools(state);
					registerMcpTools(state.tools, config);
					ctx.ui.notify(`Reconnected Stitch MCP (${state.tools.length} tools).`, "info");
				} catch {
					ctx.ui.notify(`Stitch MCP reconnect failed: ${state.lastError ?? "unknown error"}`, "error");
				}
				return;
			}
			if (command === "refresh") {
				try {
					const config = readConfig();
					await refreshTools(state);
					registerMcpTools(state.tools, config);
					ctx.ui.notify(`Refreshed Stitch MCP (${state.tools.length} tools).`, "info");
				} catch {
					ctx.ui.notify(`Stitch MCP refresh failed: ${state.lastError ?? "unknown error"}`, "error");
				}
				return;
			}
			ctx.ui.notify(statusText(state), state.lastError ? "warning" : "info");
		},
	});

	pi.on("session_shutdown", async () => {
		await closeState(state);
	});

	let startupConfig: ResolvedStitchConfig | undefined;
	try {
		const config = readConfig();
		startupConfig = config;
		const tools = await refreshTools(state);
		registerMcpTools(tools, config);
	} catch (error) {
		state.lastError = errorMessage(error, startupConfig);
		// Keep the extension loaded with status/resource/prompt tools; users can run
		// /stitch-mcp reconnect after fixing configuration or network access.
	}
}
