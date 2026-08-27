// stats.ts — pure core for the llama-stats footer (no pi imports, no I/O).
// Type-checks and runs standalone under jiti/node.
//
// In-turn stats come from the tapped SSE stream: prompt_progress events,
// per-token arrivals, and the final chunk's server `timings` (which also
// carry the per-turn draft spec-decoding stats). Only the lifecycle status is
// polled (in index.ts).


/** Per-turn server timings from the final SSE chunk (llama.cpp `timings`). */
export interface TurnTimings {
	/** prompt tokens computed this turn (non-cached; + cacheN = total prompt) */
	promptN: number;
	/** prompt tokens served from KV cache */
	cacheN: number;
	/** ms spent prefilling (server) */
	promptMs: number;
	/** server-computed prefill rate (tokens/s) — ground truth for the cross-check */
	promptPerSecond: number;
	/** generated tokens this turn */
	completionN: number;
	/** ms spent generating (server) */
	predictedMs: number;
	/** server-computed generation rate (tokens/s) */
	predictedPerSecond: number;
	/** speculative draft tokens generated this turn (absent on older builds) */
	draftN: number | null;
	/** speculative draft tokens accepted this turn (absent on older builds) */
	draftNAccepted: number | null;
}

/** Persistent draft field state: no verdict yet, last computed pair, or "not supported". */
export type DraftState =
	| { kind: "none" }
	| { kind: "value"; ratioPct: number; meanLen: number }
	| { kind: "unsupported" };

export interface RenderView {
	phase: "idle" | "prefill" | "generating" | "offline" | "loading" | "unloaded";
	tg?: number; // tokens/s, 3s sliding window
	pf?: number; // tokens/s, 3s sliding window
	barFrac?: number; // 0..1 prefill progress
	cachePct?: number | null; // 0..100
	draft?: DraftState; // draft field state (defaults to none)
}

/** One window sample: cumulative value v at time t (ms). */
interface Sample {
	t: number;
	v: number;
}

interface TurnState {
	pf: Sample[]; // {t: server ms, v: processed}
	tg: Sample[]; // {t: wall ms, v: decoded count}
	decoded: number;
	phase: "prefill" | "generating";
	total: number;
	processed: number;
	cache: number;
}

export interface StatsState {
	turn: TurnState | null;
	draft: DraftState;
}

const WINDOW_MS = 3000;
// Below this sample span the window would divide a small delta by a
// millisecond span (turn-start MTP bursts); rendered 0/s via the null path.
const MIN_SPAN_MS = 500;

export function createState(): StatsState {
	return { turn: null, draft: { kind: "none" } };
}

export function reset(s: StatsState): void {
	s.turn = null;
	s.draft = { kind: "none" };
}

/** Clear only the live turn windows (a stream is superseded). The model-level
 * draft state is kept — it resets only on a model switch. */
export function resetTurn(s: StatsState): void {
	s.turn = null;
}

function ensureTurn(s: StatsState): TurnState {
	if (!s.turn) {
		s.turn = {
			pf: [],
			tg: [],
			decoded: 0,
			phase: "prefill",
			total: 0,
			processed: 0,
			cache: 0,
		};
	}
	return s.turn;
}

/**
 * tokens/s over at most the last 3 s, using the samples' own timestamps (so a
 * server-time window and a wall-time window share one implementation).
 * Partial window while history is shorter than 3 s.
 */
function speed(samples: Sample[]): number | null {
	if (samples.length < 2) return null;
	const cur = samples[samples.length - 1];
	let oldest = samples[0];
	for (const smp of samples) {
		if (cur.t - smp.t <= WINDOW_MS) {
			oldest = smp;
			break;
		}
	}
	if (oldest === cur) return null;
	const dt = cur.t - oldest.t;
	if (dt < MIN_SPAN_MS) return null; // min-span floor: burst-safe 0/s
	return Math.max(0, cur.v - oldest.v) / (dt / 1000);
}

/** Drop samples older than the window, keeping at least the last two. */
function prune(samples: Sample[]): void {
	if (samples.length < 3) return;
	const cur = samples[samples.length - 1];
	while (samples.length > 2 && cur.t - samples[0].t > WINDOW_MS) samples.shift();
}

export function cachePct(cache: number, processed: number): number | null {
	const total = cache + processed;
	if (total <= 0) return null;
	return Math.round((cache / total) * 100);
}


function view(s: StatsState, turn: TurnState): RenderView {
	const generating = turn.phase === "generating";
	const barFrac = generating
		? 1
		: turn.total > 0
			? Math.min(1, Math.max(0, turn.processed / turn.total))
			: 0;
	return {
		phase: turn.phase,
		pf: speed(turn.pf) ?? 0,
		tg: speed(turn.tg) ?? 0,
		barFrac,
		cachePct: generating ? null : cachePct(turn.cache, turn.processed),
		draft: s.draft,
	};
}

/** Feed one prompt-progress event (server-timed). Returns the render view. */
export function onProgress(
	s: StatsState,
	ev: { total: number; processed: number; cache: number; timeMs: number },
): RenderView {
	const turn = ensureTurn(s);
	if (turn.phase === "generating") return view(s, turn); // progress stops at generation
	turn.pf.push({ t: ev.timeMs, v: ev.processed });
	prune(turn.pf);
	turn.total = ev.total;
	turn.processed = ev.processed;
	turn.cache = ev.cache;
	return view(s, turn);
}

/** Feed one generated-token arrival (wall-timed). Flips to the generating phase. */
export function onToken(s: StatsState, now: number): RenderView {
	const turn = ensureTurn(s);
	if (turn.phase !== "generating") turn.phase = "generating";
	turn.decoded += 1;
	turn.tg.push({ t: now, v: turn.decoded });
	prune(turn.tg);
	return view(s, turn);
}

/**
 * Turn-end draft verdict from the final chunk's per-turn timings. The server
 * emits the draft fields iff its spec counter path ran for the task, so their
 * presence IS the support detection (no spec-type lists): stats present →
 * value (update or self-heal from unsupported); no stats + generated tokens +
 * no verdict yet → unsupported. `not supported` is never latched.
 */
export function onTurnEnd(s: StatsState, timings?: TurnTimings | null): void {
	if (!timings) return; // aborted / no usage chunk: no verdict
	if (timings.draftN != null && timings.draftN > 0) {
		const accepted = timings.draftNAccepted ?? 0;
		const steps = timings.completionN - accepted; // = verification steps
		// ponytail: steps > 0 holds whenever this verdict applies; the guard
		// only fires on malformed data (field keeps its previous state)
		if (steps > 0)
			s.draft = {
				kind: "value",
				ratioPct: Math.round((accepted / timings.draftN) * 100),
				// double round: 2.8466 → 2.85 (llama.cpp's 2-dec stdout value) → 2.9x
				meanLen:
					Math.round(Math.round((1 + accepted / steps) * 100) / 10) / 10,
			};
		return;
	}
	if (timings.completionN >= 1 && s.draft.kind === "none")
		s.draft = { kind: "unsupported" };
}

/**
 * The stream is done. Records the server's final prefill sample (authoritative
 * for the cross-check) as the turn's last sample, returns the final view, and
 * clears the turn. `timings` may be absent (no usage chunk / aborted turn).
 */
export function onStreamEnd(
	s: StatsState,
	timings?: TurnTimings | null,
): RenderView {
	const turn = s.turn;
	if (!turn) return { phase: "idle", draft: s.draft };
	if (timings && timings.promptMs > 0) {
		// timings.prompt_n is computed-tokens-only; the window's basis is total
		// prompt progress (cached + new), so the final sample uses the total.
		const totalPromptN = timings.promptN + timings.cacheN;
		turn.pf.push({ t: timings.promptMs, v: totalPromptN });
		prune(turn.pf);
		turn.processed = totalPromptN;
		turn.total = Math.max(turn.total, totalPromptN);
	}
	onTurnEnd(s, timings);
	const v = view(s, turn);
	s.turn = null;
	return v;
}

// ─── SSE parsing + stream tracking (pure, pi-free) ──────────────────────────

/** A normalized event parsed from one `data: {...}` SSE chunk. */
export type SseEvent =
	| {
			kind: "progress";
			total: number;
			processed: number;
			cache: number;
			timeMs: number;
	  }
	| { kind: "token" }
	| { kind: "usage"; timings: TurnTimings | null }
	| { kind: "done" };

function num(v: unknown): number {
	return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Like `num`, but null marks an absent field (older server builds). */
function numOrNull(v: unknown): number | null {
	return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Parse the JSON string of one SSE `data:` field (or `[DONE]`). Returns the
 * normalized event, or null for chunks that carry no stats signal (role-only,
 * empty content, or non-OpenAI shapes).
 */
export function parseChunk(json: string): SseEvent | null {
	if (json === "[DONE]") return { kind: "done" };
	let o: Record<string, unknown>;
	try {
		o = JSON.parse(json);
	} catch {
		return null;
	}
	if (!o || typeof o !== "object") return null;

	const pp = o.prompt_progress as Record<string, unknown> | undefined;
	if (pp) {
		return {
			kind: "progress",
			total: num(pp.total),
			processed: num(pp.processed),
			cache: num(pp.cache),
			timeMs: num(pp.time_ms),
		};
	}

	if (o.usage || o.timings) {
		const t = o.timings as Record<string, unknown> | undefined;
		const timings: TurnTimings | null = t
			? {
					promptN: num(t.prompt_n),
					cacheN: num(t.cache_n),
					promptMs: num(t.prompt_ms),
					promptPerSecond: num(t.prompt_per_second),
					completionN: num(t.predicted_n),
					predictedMs: num(t.predicted_ms),
					predictedPerSecond: num(t.predicted_per_second),
					draftN: numOrNull(t.draft_n),
					draftNAccepted: numOrNull(t.draft_n_accepted),
				}
			: null;
		return { kind: "usage", timings };
	}

	const choices = o.choices as
		| Array<{ delta?: { content?: unknown; reasoning_content?: unknown } }>
		| undefined;
	const delta = choices?.[0]?.delta;
	// Thinking models stream reasoning_content instead of content; both are
	// generated tokens on the wire and both drive the tg window.
	const content = delta?.content;
	const reasoning = delta?.reasoning_content;
	if (
		(typeof content === "string" && content.length > 0) ||
		(typeof reasoning === "string" && reasoning.length > 0)
	)
		return { kind: "token" };

	return null;
}

/**
 * Map a parsed event onto the stats state and return the render view. `now`
 * (wall clock) timestamps token arrivals; progress events carry their own
 * server time.
 */
export function applyEvent(
	s: StatsState,
	ev: SseEvent,
	now: number,
): RenderView {
	switch (ev.kind) {
		case "progress":
			return onProgress(s, ev);
		case "token":
			return onToken(s, now);
		case "usage":
			return onStreamEnd(s, ev.timings);
		case "done":
			return onStreamEnd(s, null);
	}
}

/**
 * Latest-wins stream tracking. The most recently first-seen stream is active;
 * its events are shown. A stream's first chunk (an unseen id) supersedes the
 * current one. Late chunks from superseded streams are dropped; closing a
 * superseded stream does not idle out the active one.
 */
export interface StreamTracker {
	activeId: string | null;
	open: Set<string>;
}

export function createTracker(): StreamTracker {
	return { activeId: null, open: new Set() };
}

/** Classify a chunk's stream id relative to the current streams. */
export function classify(
	tr: StreamTracker,
	id: string,
): "new" | "active" | "stale" {
	if (!tr.open.has(id)) return "new";
	return id === tr.activeId ? "active" : "stale";
}

/** A new stream opens and becomes active (superseding the previous one). */
export function openStream(tr: StreamTracker, id: string): void {
	tr.open.add(id);
	tr.activeId = id;
}

/**
 * A stream closes. Returns true if it was the active stream (so the caller
 * should end the turn / go idle); false if it was already superseded (no-op).
 */
export function closeStream(tr: StreamTracker, id: string): boolean {
	tr.open.delete(id);
	if (id === tr.activeId) {
		tr.activeId = null;
		return true;
	}
	return false;
}

// ─── rendering ──────────────────────────────────────────────────────────────

function fmt(n: number): string {
	if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
	return String(Math.round(n));
}

function bar(frac: number): string {
	const w = 6;
	const f = Math.round(Math.min(1, Math.max(0, frac)) * w);
	return "▓".repeat(f) + "░".repeat(w - f);
}

/** Render the single footer line: six uniform fields joined by `sep`. */
export function renderLine(model: string, v: RenderView, sep: string = " · "): string {
	const status =
		v.phase === "prefill" || v.phase === "generating" ? "active" : v.phase;
	const pf =
		v.phase === "prefill"
			? `${fmt(v.pf ?? 0)}/s ${bar(v.barFrac ?? 0)} ${Math.round((v.barFrac ?? 0) * 100)}%`
			: "-";
	const tg = v.phase === "generating" ? `${fmt(v.tg ?? 0)}/s` : "-";
	const cache =
		v.phase === "prefill" && v.cachePct != null ? `${v.cachePct}%` : "-";
	// persistent model-level state: same value in every phase
	const draft =
		v.draft?.kind === "value"
			? `${v.draft.ratioPct}% ${v.draft.meanLen.toFixed(1)}x`
			: v.draft?.kind === "unsupported"
				? "not supported"
				: "-";
	return [model, status, `pf ${pf}`, `tg3s ${tg}`, `cache ${cache}`, `draft ${draft}`].join(sep);
}
