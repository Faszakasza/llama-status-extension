// stats.ts — pure logic for the llama-stats footer.
// No pi imports: runs under `node --experimental-strip-types` for tests.

export interface SlotView {
	id: number;
	isProcessing: boolean;
	/** prompt+generated total (grows during generation); stable during prefill */
	promptTotal: number;
	/** prompt tokens processed this turn */
	promptProcessed: number;
	/** prompt tokens served from KV cache this turn */
	promptCache: number;
	/** generated tokens this turn */
	decoded: number;
}

export interface SpecCounters {
	/** spec_decode_num_drafts_total — verification steps (server-cumulative) */
	draftSteps: number;
	/** spec_decode_num_accepted_tokens_total (server-cumulative) */
	accepted: number;
}

export interface RenderView {
	phase:
		| "idle"
		| "prefill"
		| "generating"
		| "offline"
		| "loading"
		| "unloaded";
	tg?: number; // tokens/s, 3s sliding window
	pf?: number; // tokens/s, 3s sliding window
	barFrac?: number; // 0..1 prefill progress
	cachePct?: number | null; // 0..100
	spec?: number | null; // e.g. 1.9
}

interface Sample {
	t: number;
	decoded: number;
	processed: number;
}

interface SlotState {
	samples: Sample[];
	lastProcessed: number;
	lastDecoded: number;
	seen: boolean;
}

export interface StatsState {
	slots: Map<number, SlotState>;
	specPrev: SpecCounters | null;
	specValue: number | null;
}

const WINDOW_MS = 3000;

export function createState(): StatsState {
	return { slots: new Map(), specPrev: null, specValue: null };
}

export function reset(s: StatsState): void {
	s.slots.clear();
	s.specPrev = null;
	s.specValue = null;
}

function ensure(s: StatsState, id: number): SlotState {
	let st = s.slots.get(id);
	if (!st) {
		st = { samples: [], lastProcessed: 0, lastDecoded: 0, seen: false };
		s.slots.set(id, st);
	}
	return st;
}

function speed(
	samples: Sample[],
	now: number,
	field: "decoded" | "processed",
): number | null {
	if (samples.length < 2) return null;
	const cur = samples[samples.length - 1];
	let oldest: Sample | null = null;
	for (const smp of samples) {
		if (now - smp.t <= WINDOW_MS) {
			oldest = smp;
			break;
		}
	}
	if (!oldest || oldest === cur) return null;
	const dt = now - oldest.t;
	if (dt <= 0) return null;
	return Math.max(0, cur[field] - oldest[field]) / (dt / 1000);
}

/** New turn ⇔ first sight, processed counter dropped, or decoded reset to 0. */
export function isTurnStart(
	st: SlotState,
	processed: number,
	decoded: number,
): boolean {
	if (!st.seen) return true;
	if (processed < st.lastProcessed) return true;
	if (decoded === 0 && st.lastDecoded > 0) return true;
	return false;
}

export function cachePct(cache: number, processed: number): number | null {
	const total = cache + processed;
	if (total <= 0) return null;
	return Math.round((cache / total) * 100);
}

/** Busiest slot: generating beats prefill; tie-break on tokens in flight. */
export function pickSlot(slots: SlotView[]): SlotView | null {
	const busy = slots.filter((s) => s.isProcessing);
	if (busy.length === 0) return null;
	const gen = busy.filter((s) => s.decoded > 0);
	const pool = gen.length > 0 ? gen : busy;
	return pool.reduce((a, b) =>
		b.promptProcessed + b.decoded > a.promptProcessed + a.decoded ? b : a,
	);
}

/** 1 + Δaccepted/Δverification-steps, or null when no draft activity. */
export function specAcceptance(
	prev: SpecCounters | null,
	cur: SpecCounters,
): number | null {
	if (!prev) return null;
	const dSteps = cur.draftSteps - prev.draftSteps;
	if (dSteps <= 0) return null;
	return 1 + (cur.accepted - prev.accepted) / dSteps;
}

/** Feed one /metrics sample; stores the spec value for the next render. */
export function updateSpec(s: StatsState, cur: SpecCounters): void {
	s.specValue = specAcceptance(s.specPrev, cur);
	s.specPrev = cur;
}

/** Feed one /slots poll; returns the render view (no model name). */
export function observe(
	s: StatsState,
	now: number,
	slots: SlotView[],
): RenderView {
	const slot = pickSlot(slots);
	if (!slot) return { phase: "idle" };

	const st = ensure(s, slot.id);
	if (isTurnStart(st, slot.promptProcessed, slot.decoded)) st.samples = [];

	st.samples.push({
		t: now,
		decoded: slot.decoded,
		processed: slot.promptProcessed,
	});
	while (st.samples.length > 2 && now - st.samples[0].t > WINDOW_MS)
		st.samples.shift();
	st.lastProcessed = slot.promptProcessed;
	st.lastDecoded = slot.decoded;
	st.seen = true;

	const generating = slot.decoded > 0;
	const frac = generating
		? 0
		: slot.promptTotal > 0
			? slot.promptProcessed / slot.promptTotal
			: 0;

	const view: RenderView = {
		phase: generating ? "generating" : "prefill",
	};
	if (generating) {
		view.tg = speed(st.samples, now, "decoded") ?? 0;
		view.spec = s.specValue;
	} else {
		view.pf = speed(st.samples, now, "processed") ?? 0;
		view.barFrac = Math.min(1, Math.max(0, frac));
		view.cachePct = cachePct(slot.promptCache, slot.promptProcessed);
	}
	return view;
}

function fmt(n: number): string {
	if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
	return String(Math.round(n));
}

function bar(frac: number): string {
	const w = 6;
	const f = Math.round(Math.min(1, Math.max(0, frac)) * w);
	return "▓".repeat(f) + "░".repeat(w - f);
}

/** Render the single footer line. */
export function renderLine(model: string, v: RenderView): string {
	switch (v.phase) {
		case "offline":
			return `${model} · offline`;
		case "idle":
			return `${model} · idle`;
		case "prefill": {
			const pct = Math.round((v.barFrac ?? 0) * 100);
			const cache = v.cachePct == null ? "" : ` cache ${v.cachePct}%`;
			return `${model} · pf ${fmt(v.pf ?? 0)}/s ${bar(v.barFrac ?? 0)} ${pct}%${cache}`;
		}
		case "generating": {
			const spec = v.spec == null ? "" : ` spec ${v.spec.toFixed(1)}x`;
			return `${model} · tg ${fmt(v.tg ?? 0)}/s${spec}`;
		}
		case "loading":
			return `${model} · loading`;
		case "unloaded":
			return `${model} · unloaded`;
	}
}
