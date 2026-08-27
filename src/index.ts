// llama-stats — footer stats for the active llama.cpp model.
// In-turn stats come from a tap on the chat-completion SSE stream (zero extra
// requests); only the lifecycle status (/v1/models) is polled.
// Pure logic lives in stats.ts.
import {
	CONFIG_DIR_NAME,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
	type RenderView,
	type StatsState,
	applyEvent,
	closeStream,
	classify,
	createState,
	createTracker,
	onStreamEnd,
	openStream,
	parseChunk,
	renderLine,
	reset,
	resetTurn,
} from "./stats.ts";

const AUX_MS = 2000;
const STATUS_KEY = "llama-stats";
const DEBUG =
	typeof process !== "undefined" && !!process.env?.LLAMA_STATS_DEBUG;

interface Target {
	model: string;
	baseUrl: string;
}

function extractId(json: string): string | null {
	try {
		const o = JSON.parse(json) as { id?: unknown };
		return typeof o.id === "string" ? o.id : null;
	} catch {
		return null;
	}
}

const DEFAULT_SEPARATOR = " · ";
let separator = DEFAULT_SEPARATOR;

function readSeparator(path: string): string | null {
	try {
		const o = JSON.parse(readFileSync(path, "utf8")) as {
			separator?: unknown;
		};
		if (typeof o?.separator === "string" && o.separator.length > 0)
			return o.separator;
	} catch {
		// unreadable or corrupt settings file: fall through
	}
	return null;
}

// Project (trusted) > global > default. Read once per session; never throws.
function resolveSeparator(cwd: string, trusted: boolean): void {
	const paths = [
		...(trusted ? [join(cwd, CONFIG_DIR_NAME, "settings.json")] : []),
		join(getAgentDir(), "settings.json"),
	];
	for (const p of paths) {
		const sep = readSeparator(p);
		if (sep) {
			separator = sep;
			return;
		}
	}
	separator = DEFAULT_SEPARATOR;
}

// ponytail: no API key support; local routers without --api-key work.
// Add readStoredCredential(model.provider) header if a keyed server ever shows up.
export default function (pi: ExtensionAPI) {
	const state: StatsState = createState();
	const tracker = createTracker();
	let ui: ExtensionContext["ui"] | null = null;
	let target: Target | null = null;
	let auxTimer: ReturnType<typeof setInterval> | null = null;
	let originalFetch: typeof fetch | null = null;


	function render(v: RenderView | string): void {
		if (!ui || !target) return;
		ui.setStatus(
			STATUS_KEY,
			typeof v === "string" ? v : renderLine(target.model, v, separator),
		);
	}

	function renderIdle(): void {
		render({ phase: "idle", draft: state.draft });
	}

	// ─── SSE tap ──────────────────────────────────────────────────────────────

	function isTargetChatCompletions(input: unknown): boolean {
		if (!target) return false;
		const url =
			typeof input === "string" ? input : (input as { url?: unknown })?.url;
		if (typeof url !== "string") return false;
		return url.startsWith(target.baseUrl) && url.includes("/chat/completions");
	}

	function injectFlags(body: unknown): unknown {
		if (typeof body !== "string") return body; // non-string body: pass through
		let p: Record<string, unknown>;
		try {
			p = JSON.parse(body);
		} catch {
			return body;
		}
		if (!p || typeof p !== "object" || p.stream !== true) return body;
		p.return_progress = true;
		const so = (p.stream_options ?? {}) as Record<string, unknown>;
		p.stream_options = { ...so, include_usage: true };
		return JSON.stringify(p);
	}

	function wrapBody(
		original: ReadableStream<Uint8Array>,
	): ReadableStream<Uint8Array> {
		let streamId: string | null = null;
		let ended = false;

		const handleEnd = (): void => {
			if (ended || !streamId) return;
			ended = true;
			// end the turn only if this stream is still the active one
			if (closeStream(tracker, streamId)) {
				onStreamEnd(state, null);
				renderIdle();
			}
		};

		const handleLine = (jsonStr: string): void => {
			if (jsonStr === "[DONE]") {
				handleEnd();
				return;
			}
			const ev = parseChunk(jsonStr);
			if (!ev) return;
			const id = extractId(jsonStr);
			if (!id) return; // every chunk carries the chatcmpl id; skip if absent

			const c = classify(tracker, id);
			if (c === "new") {
				openStream(tracker, id);
				resetTurn(state); // supersede: fresh windows, draft state kept (model-level)
			} else if (c === "stale") {
				return; // late events from a superseded stream
			}
			streamId = id;

			const view = applyEvent(state, ev, Date.now());
			if (ev.kind === "usage" || ev.kind === "done") {
				// the final chunk: cross-check the window against the server value
				if (
					DEBUG &&
					ev.kind === "usage" &&
					ev.timings &&
					ev.timings.promptPerSecond > 0
				) {
					console.error(
						`[llama-stats] pf cross-check window=${(view.pf ?? 0).toFixed(1)} server=${ev.timings.promptPerSecond.toFixed(1)}`,
					);
				}
				handleEnd(); // close in the tracker too (usage-terminated turns leak activeId otherwise)
			} else {
				render(view);
			}
		};

		const reader = original.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		return new ReadableStream({
			async start(controller) {
				try {
					while (true) {
						const { done, value } = await reader.read();
						if (done) break;
						buffer += decoder.decode(value, { stream: true });
						const lines = buffer.split("\n");
						buffer = lines.pop() || "";
						for (const line of lines) {
							if (line.startsWith("data: ")) handleLine(line.slice(6));
						}
						controller.enqueue(value); // re-emit original bytes unchanged
					}
					controller.close(); // inner stream done: signal the consumer (else text() hangs)
				} finally {
					handleEnd();
				}
			},
			cancel(reason?: unknown) {
				reader.cancel(reason as never);
				handleEnd();
			},
		});
	}

	async function tapFetch(
		input: RequestInfo | URL,
		init?: RequestInit,
	): Promise<Response> {
		const orig = originalFetch ?? globalThis.fetch;
		if (!target || !isTargetChatCompletions(input)) return orig(input, init);

		const body = injectFlags(init?.body);
		const res = await orig(
			input,
			body === init?.body ? init : { ...init, body: body as BodyInit },
		);

		const isSse = (res.headers.get("content-type") ?? "").includes(
			"text/event-stream",
		);
		if (!res.ok || !res.body || !isSse) return res;

		return new Response(wrapBody(res.body), {
			status: res.status,
			statusText: res.statusText,
			headers: res.headers,
		});
	}

	// ─── polling (lifecycle only) ──────────────────────────────────────────────

	async function pollStatus(): Promise<void> {
		if (!target) return;
		try {
			const res = await globalThis.fetch(`${target.baseUrl}/v1/models`, {
				signal: AbortSignal.timeout(3000),
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = (await res.json()) as {
				data?: Array<{ id: string; status?: { value?: string } }>;
			};
			const found = data.data?.find((m) => m.id === target!.model);
			const value = found?.status?.value ?? "unloaded";
			if (tracker.activeId) return; // a turn is live: don't overwrite the phase line
			if (value === "loaded") renderIdle();
			else if (value === "loading" || value === "unloaded")
				render(renderLine(target.model, { phase: value, draft: state.draft } satisfies RenderView, separator));
			else render(`${target.model} · ${value}`); // failed/sleeping/etc
		} catch {
			if (tracker.activeId) return; // a live stream is the ground truth
			render(renderLine(target.model, { phase: "offline", draft: state.draft } satisfies RenderView, separator));
		}
	}


	// ─── lifecycle ────────────────────────────────────────────────────────────

	function installTap(): void {
		if (originalFetch) return;
		originalFetch = globalThis.fetch;
		globalThis.fetch = tapFetch;
	}

	function removeTap(): void {
		if (!originalFetch) return;
		globalThis.fetch = originalFetch;
		originalFetch = null;
	}

	function stop(): void {
		if (auxTimer) clearInterval(auxTimer);
		auxTimer = null;
		target = null;
		removeTap();
		ui?.setStatus(STATUS_KEY, undefined);
	}

	function start(t: Target): void {
		// the draft state is model-level: reset only when the model changes
		const switching = !target || target.model !== t.model;
		stop();
		if (switching) reset(state);
		target = t;
		installTap();
		auxTimer = setInterval(() => {
			void pollStatus();
		}, AUX_MS);
		void pollStatus();
	}

	function applyModel(ctx: ExtensionContext): void {
		ui = ctx.ui;
		const model = ctx.model;
		const baseUrl = model ? resolveBaseUrl(model.provider, ctx) : null;
		if (!model || !baseUrl) {
			stop();
			return;
		}
		start({ model: model.id, baseUrl });
	}

	function resolveBaseUrl(
		provider: string,
		ctx: ExtensionContext,
	): string | null {
		if (provider.startsWith("llama-server=")) {
			const url = provider.slice("llama-server=".length).replace(/\/+$/, "");
			if (url) return url;
		}
		// fallback: ask the registry for the provider's base URL
		try {
			const p = ctx.modelRegistry.getProvider(provider) as {
				baseUrl?: string;
			} | null;
			if (p?.baseUrl) return p.baseUrl.replace(/\/+$/, "");
		} catch {
			// registry lookup failed; treat as non-llama
		}
		return null;
	}

	pi.on("session_start", (event, ctx) => {
		resolveSeparator(ctx.cwd, ctx.isProjectTrusted());
		if (event.reason === "startup") applyModel(ctx);
	});
	pi.on("model_select", (_event, ctx) => {
		applyModel(ctx);
	});
	pi.on("session_shutdown", () => {
		stop();
	});
}
