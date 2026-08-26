// llama-stats — footer stats for the active llama.cpp model.
// /v1/models status (2 s) gates /slots (500 ms) + /metrics (2 s) polling;
// renders one line via ctx.ui.setStatus. Logic lives in stats.ts.
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
	type RenderView,
	type SlotView,
	type StatsState,
	createState,
	observe,
	renderLine,
	reset,
	updateSpec,
} from "./stats.ts";

const SLOTS_MS = 500;
const AUX_MS = 2000;
const STATUS_KEY = "llama-stats";

interface Target {
	model: string;
	baseUrl: string;
}

// ponytail: no API key support; local routers without --api-key work.
// Add readStoredCredential(model.provider) header if a keyed server ever shows up.
export default function (pi: ExtensionAPI) {
	const state: StatsState = createState();
	let ui: ExtensionContext["ui"] | null = null;
	let target: Target | null = null;
	let slotsTimer: ReturnType<typeof setInterval> | null = null;
	let auxTimer: ReturnType<typeof setInterval> | null = null;
	let slotsInFlight = false;
	// ponytail: router unloads models after idle, so /slots only works when loaded
	let modelStatus = "unknown";

	const num = (v: unknown): number =>
		typeof v === "number" && Number.isFinite(v) ? v : 0;

	function parseSlot(r: Record<string, unknown>): SlotView {
		const nt = Array.isArray(r.next_token)
			? (r.next_token[0] as Record<string, unknown> | undefined)
			: undefined;
		return {
			id: num(r.id),
			isProcessing: r.is_processing === true,
			promptTotal: num(r.n_prompt_tokens),
			promptProcessed: num(r.n_prompt_tokens_processed),
			promptCache: num(r.n_prompt_tokens_cache),
			decoded: num(nt?.n_decoded),
		};
	}

	function parseMetric(text: string, name: string): number | null {
		const re = new RegExp(`^${name}\\s+(\\d+(?:\\.\\d+)?)$`, "m");
		const m = re.exec(text);
		return m ? Number(m[1]) : null;
	}

	async function pollStatus(): Promise<void> {
		if (!target) return;
		try {
			const res = await fetch(`${target.baseUrl}/v1/models`, {
				signal: AbortSignal.timeout(3000),
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = (await res.json()) as {
				data?: Array<{ id: string; status?: { value?: string } }>;
			};
			const found = data.data?.find((m) => m.id === target!.model);
			const value = found?.status?.value ?? "unloaded";
			modelStatus = value;
			if (value === "loaded") return; // slot polling takes over
			reset(state);
			if (value === "loading" || value === "unloaded")
				setStatus(renderLine(target.model, { phase: value } satisfies RenderView));
			else setStatus(`${target.model} · ${value}`); // failed/sleeping/etc
		} catch {
			modelStatus = "unknown";
			reset(state);
			setStatus(
				renderLine(target.model, { phase: "offline" } satisfies RenderView),
			);
		}
	}

	async function pollSlots(): Promise<void> {
		if (!target || slotsInFlight || modelStatus !== "loaded") return;
		slotsInFlight = true;
		try {
			const res = await fetch(
				`${target.baseUrl}/slots?model=${encodeURIComponent(target.model)}`,
				{
					signal: AbortSignal.timeout(2000),
				},
			);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = (await res.json()) as Array<Record<string, unknown>>;
			const view = observe(state, Date.now(), data.map(parseSlot));
			setStatus(renderLine(target.model, view));
		} catch {
			reset(state);
			setStatus(
				renderLine(target.model, { phase: "offline" } satisfies RenderView),
			);
		} finally {
			slotsInFlight = false;
		}
	}

	async function pollMetrics(): Promise<void> {
		if (!target || modelStatus !== "loaded") return;
		try {
			const res = await fetch(
				`${target.baseUrl}/metrics?model=${encodeURIComponent(target.model)}`,
				{
					signal: AbortSignal.timeout(3000),
				},
			);
			if (!res.ok) return;
			const text = await res.text();
			const draftSteps = parseMetric(
				text,
				"llamacpp:spec_decode_num_drafts_total",
			);
			const accepted = parseMetric(
				text,
				"llamacpp:spec_decode_num_accepted_tokens_total",
			);
			if (draftSteps != null && accepted != null)
				updateSpec(state, { draftSteps, accepted });
		} catch {
			// keep the last spec value; next poll refreshes it
		}
	}

	function setStatus(line: string): void {
		ui?.setStatus(STATUS_KEY, line);
	}

	function stop(): void {
		if (slotsTimer) clearInterval(slotsTimer);
		if (auxTimer) clearInterval(auxTimer);
		slotsTimer = null;
		auxTimer = null;
		target = null;
		modelStatus = "unknown";
		reset(state);
		ui?.setStatus(STATUS_KEY, undefined);
	}

	function start(t: Target): void {
		stop();
		target = t;
		slotsTimer = setInterval(pollSlots, SLOTS_MS);
		auxTimer = setInterval(() => {
			void pollStatus();
			void pollMetrics();
		}, AUX_MS);
		void pollStatus();
		void pollSlots();
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
		if (event.reason === "startup") applyModel(ctx);
	});
	pi.on("model_select", (_event, ctx) => {
		applyModel(ctx);
	});
}
