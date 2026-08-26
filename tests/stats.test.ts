// stats.test.ts — assert-based checks for the pure stats core.
// Run: npm test
import assert from "node:assert/strict";

import {
	type RenderView,
	type SlotView,
	cachePct,
	createState,
	observe,
	pickSlot,
	renderLine,
	reset,
	specAcceptance,
	updateSpec,
} from "../src/stats.ts";

const slot = (o: Partial<SlotView> & { id: number }): SlotView => ({
	isProcessing: true,
	promptTotal: 100,
	promptProcessed: 0,
	promptCache: 0,
	decoded: 0,
	...o,
});

// --- turn detection via observe -------------------------------------------
{
	const s = createState();
	// turn 1: prefill, then generating
	let v = observe(s, 0, [slot({ id: 0, promptProcessed: 10 })]);
	assert.equal(v.phase, "prefill", "first sighting is prefill");
	v = observe(s, 1000, [
		slot({ id: 0, promptTotal: 110, promptProcessed: 10, decoded: 5 }),
	]);
	assert.equal(v.phase, "generating", "decoded>0 is generating");
	// turn 2: processed drops to 0, decoded resets → fresh window (no stale speed)
	v = observe(s, 5000, [slot({ id: 0, promptTotal: 50, promptProcessed: 0 })]);
	assert.equal(v.phase, "prefill", "counter drop starts a new turn");
	assert.equal(v.pf, 0, "fresh window → no speed yet");
}

// --- 3s sliding window -----------------------------------------------------
{
	const s = createState();
	// 40 decoded over the last 2 s ⇒ 20 t/s (spec: steady generation)
	observe(s, 3000, [
		slot({ id: 0, promptTotal: 100, promptProcessed: 100, decoded: 0 }),
	]);
	const v = observe(s, 5000, [
		slot({ id: 0, promptTotal: 140, promptProcessed: 100, decoded: 40 }),
	]);
	assert.equal(v.phase, "generating");
	assert.ok(Math.abs((v.tg ?? 0) - 20) < 0.01, `tg≈20, got ${v.tg}`);
	// window expiry: the t=3000 sample (5 s back) is outside the 3 s window;
	// oldest in window is t=5000 (decoded=40): (45-40)/3.0s
	const v2 = observe(s, 8000, [
		slot({ id: 0, promptTotal: 150, promptProcessed: 100, decoded: 45 }),
	]);
	assert.ok(Math.abs((v2.tg ?? 0) - 5 / 3) < 0.01, `tg≈1.67, got ${v2.tg}`);
}

// --- prefill progress + cache ----------------------------------------------
{
	const s = createState();
	// fully cached: nothing processed, all from cache ⇒ 100%
	observe(s, 0, [
		slot({ id: 0, promptTotal: 1000, promptProcessed: 0, promptCache: 1000 }),
	]);
	const v = observe(s, 200, [
		slot({ id: 0, promptTotal: 1000, promptProcessed: 0, promptCache: 1000 }),
	]);
	assert.equal(v.phase, "prefill");
	assert.equal(v.cachePct, 100, "fully cached ⇒ 100%");
	assert.ok(Math.abs((v.barFrac ?? 0) - 0) < 1e-9);
	// partial cache: 970/(970+340) = 74%
	const s2 = createState();
	observe(s2, 0, [
		slot({ id: 0, promptTotal: 1310, promptProcessed: 0, promptCache: 970 }),
	]);
	const v2 = observe(s2, 200, [
		slot({ id: 0, promptTotal: 1310, promptProcessed: 340, promptCache: 970 }),
	]);
	assert.equal(v2.cachePct, 74, "970/1310 = 74%");
	assert.ok(Math.abs((v2.barFrac ?? 0) - 340 / 1310) < 1e-9);
	// mostly cached: 270 of 300
	const s3 = createState();
	observe(s3, 0, [
		slot({ id: 0, promptTotal: 300, promptProcessed: 0, promptCache: 0 }),
	]);
	const v3 = observe(s3, 200, [
		slot({ id: 0, promptTotal: 300, promptProcessed: 30, promptCache: 270 }),
	]);
	assert.equal(v3.cachePct, 90, "270/300 = 90%");
	assert.equal(cachePct(0, 0), null, "zero tokens → null");
}

// --- busiest slot -----------------------------------------------------------
{
	const pre = slot({ id: 0, promptProcessed: 900, decoded: 0 });
	const gen = slot({ id: 1, promptProcessed: 10, decoded: 1 });
	assert.equal(pickSlot([pre, gen])?.id, 1, "generating beats prefill");
	assert.equal(
		pickSlot([pre, slot({ id: 2, promptProcessed: 500, decoded: 0 })])?.id,
		0,
		"tie-break on in-flight",
	);
	assert.equal(
		pickSlot([slot({ id: 0, isProcessing: false })]),
		null,
		"idle → null",
	);
}

// --- spec acceptance ---------------------------------------------------------
{
	assert.equal(
		specAcceptance(null, { draftSteps: 10, accepted: 9 }),
		null,
		"no prev sample",
	);
	assert.equal(
		specAcceptance(
			{ draftSteps: 10, accepted: 9 },
			{ draftSteps: 10, accepted: 9 },
		),
		null,
		"no draft activity",
	);
	assert.equal(
		specAcceptance(
			{ draftSteps: 100, accepted: 0 },
			{ draftSteps: 200, accepted: 90 },
		),
		1.9,
		"1+90/100=1.9",
	);
	const s = createState();
	updateSpec(s, { draftSteps: 0, accepted: 0 });
	updateSpec(s, { draftSteps: 100, accepted: 890 });
	const v = observe(s, 0, [
		slot({ id: 0, promptTotal: 100, promptProcessed: 100, decoded: 1 }),
	]);
	assert.equal(v.spec, 9.9, "1+890/100=9.9");
	const v2 = observe(s, 500, [
		slot({ id: 0, promptTotal: 101, promptProcessed: 100, decoded: 2 }),
	]);
	assert.equal(v2.spec, 9.9, "spec persists between metrics polls");
}

// --- model switch resets -----------------------------------------------------
{
	const s = createState();
	observe(s, 0, [
		slot({ id: 0, promptTotal: 100, promptProcessed: 100, decoded: 40 }),
	]);
	reset(s);
	const v = observe(s, 1000, [
		slot({ id: 0, promptTotal: 100, promptProcessed: 0, decoded: 0 }),
	]);
	assert.equal(v.pf, 0, "reset clears windows");
	assert.equal(v.spec, undefined);
}

// --- render formats (D9) ------------------------------------------------------
{
	const R = (
		o: Partial<RenderView> & { phase: RenderView["phase"] },
	): RenderView => o;
	assert.equal(renderLine("M", R({ phase: "idle" })), "M · idle");
	assert.equal(renderLine("M", R({ phase: "loading" })), "M · loading");
	assert.equal(renderLine("M", R({ phase: "unloaded" })), "M · unloaded");
	assert.equal(renderLine("M", R({ phase: "offline" })), "M · offline");
	assert.equal(
		renderLine(
			"M",
			R({ phase: "prefill", pf: 1800, barFrac: 0.34, cachePct: 97 }),
		),
		"M · pf 1.8k/s ▓▓░░░░ 34% cache 97%",
	);
	assert.equal(
		renderLine("M", R({ phase: "prefill", pf: 78, barFrac: 0, cachePct: null })),
		"M · pf 78/s ░░░░░░ 0%",
	);
	assert.equal(
		renderLine("M", R({ phase: "generating", tg: 78, spec: 1.9 })),
		"M · tg 78/s spec 1.9x",
	);
	assert.equal(
		renderLine("M", R({ phase: "generating", tg: 1234 })),
		"M · tg 1.2k/s",
	);
	assert.equal(
		renderLine("M", R({ phase: "generating", tg: 78 })),
		"M · tg 78/s",
	);
}

console.log("stats.test.ts: all checks passed");
