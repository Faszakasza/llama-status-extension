// stats.test.ts — assert-based checks for the pure stats core.
// Run: npm test
import assert from "node:assert/strict";

import {
	type RenderView,
	type StatsState,
	cachePct,
	classify,
	closeStream,
	createState,
	createTracker,
	onProgress,
	onStreamEnd,
	onToken,
	applyEvent,
	openStream,
	parseChunk,
	renderLine,
	reset,
	specAcceptance,
	updateSpec,
} from "../src/stats.ts";

const tokens = (s: StatsState, times: number[]): RenderView => {
	let v: RenderView = { phase: "idle" };
	for (const t of times) v = onToken(s, t);
	return v;
};

// --- 3s sliding window: steady, partial, expiry --------------------------------
{
	const s = createState();
	// steady: tokens every 100 ms over 2 s ⇒ (21-1)/2.0 = 10 t/s
	const v = tokens(
		s,
		Array.from({ length: 21 }, (_, i) => 3000 + i * 100),
	);
	assert.ok(Math.abs((v.tg ?? 0) - 10) < 0.5, `steady tg≈10, got ${v.tg}`);
	assert.equal(v.phase, "generating");

	// partial window: only 1 s of history ⇒ (2-1)/1.0 = 1 t/s
	const sp = createState();
	const vp = tokens(sp, [4000, 5000]);
	assert.ok(Math.abs((vp.tg ?? 0) - 1) < 0.01, `partial tg≈1, got ${vp.tg}`);

	// expiry: t=1000 sample (6 s before t=7000) is dropped; (7-2)/3.0 ≈ 1.67
	const se = createState();
	const ve = tokens(se, [1000, 4000, 5000, 5500, 6000, 6500, 7000]);
	assert.ok(
		Math.abs((ve.tg ?? 0) - 5 / 3) < 0.01,
		`expiry tg≈1.67, got ${ve.tg}`,
	);
}

// --- prefill: progress + bar + cache ------------------------------------------
{
	const s = createState();
	// fully cached: nothing processed, all from cache ⇒ 100%, bar 0
	onProgress(s, { total: 1000, processed: 0, cache: 1000, timeMs: 0 });
	const v = onProgress(s, {
		total: 1000,
		processed: 0,
		cache: 1000,
		timeMs: 200,
	});
	assert.equal(v.phase, "prefill");
	assert.equal(v.cachePct, 100, "fully cached ⇒ 100%");
	assert.ok(Math.abs((v.barFrac ?? 0) - 0) < 1e-9);

	// partial cache: 970/(970+340) = 74%, bar 340/1310
	const s2 = createState();
	onProgress(s2, { total: 1310, processed: 0, cache: 970, timeMs: 0 });
	const v2 = onProgress(s2, {
		total: 1310,
		processed: 340,
		cache: 970,
		timeMs: 200,
	});
	assert.equal(v2.cachePct, 74, "970/1310 = 74%");
	assert.ok(Math.abs((v2.barFrac ?? 0) - 340 / 1310) < 1e-9);

	// mostly cached: 270 of 300
	const s3 = createState();
	onProgress(s3, { total: 300, processed: 0, cache: 0, timeMs: 0 });
	const v3 = onProgress(s3, {
		total: 300,
		processed: 30,
		cache: 270,
		timeMs: 200,
	});
	assert.equal(v3.cachePct, 90, "270/300 = 90%");
	assert.equal(cachePct(0, 0), null, "zero tokens → null");
}

// --- prefill speed window (server-timed) --------------------------------------
{
	const s = createState();
	// 100 t/s over 2 s ⇒ final pf ≈ 100
	onProgress(s, { total: 200, processed: 0, cache: 0, timeMs: 0 });
	onProgress(s, { total: 200, processed: 100, cache: 0, timeMs: 1000 });
	const v = onProgress(s, {
		total: 200,
		processed: 200,
		cache: 0,
		timeMs: 2000,
	});
	assert.ok(Math.abs((v.pf ?? 0) - 100) < 0.5, `pf≈100, got ${v.pf}`);
}

// --- phase: prefill → generating → stream end ---------------------------------
{
	const s = createState();
	let v = onProgress(s, { total: 50, processed: 10, cache: 0, timeMs: 0 });
	assert.equal(v.phase, "prefill", "first progress is prefill");
	v = onToken(s, 1000);
	assert.equal(v.phase, "generating", "first token flips to generating");
	assert.equal(v.cachePct, null, "cache hidden while generating");
	// progress events stop mattering once generating
	v = onProgress(s, { total: 50, processed: 10, cache: 0, timeMs: 1500 });
	assert.equal(v.phase, "generating", "late progress ignored in generating");
	v = onStreamEnd(s, null);
	assert.equal(v.phase, "generating", "final view is the last phase");
	// after end, a fresh turn starts clean
	const v2 = onProgress(s, { total: 40, processed: 0, cache: 0, timeMs: 0 });
	assert.equal(v2.phase, "prefill", "new turn after stream end");
	assert.equal(v2.pf, 0, "fresh window → no speed yet");
}

// --- timings cross-check: window final pf matches the server value (2.2) ------
{
	const s = createState();
	onProgress(s, { total: 200, processed: 0, cache: 0, timeMs: 0 });
	onProgress(s, { total: 200, processed: 100, cache: 0, timeMs: 1000 });
	onProgress(s, { total: 200, processed: 200, cache: 0, timeMs: 2000 });
	// server reports prompt_per_second = 100; onStreamEnd records it as the last sample
	const v = onStreamEnd(s, {
		promptN: 200,
		cacheN: 0,
		promptMs: 2000,
		promptPerSecond: 100,
		completionN: 1,
		predictedMs: 0,
		predictedPerSecond: 0,
	});
	assert.ok(
		Math.abs((v.pf ?? 0) - 100) < 0.5,
		`window pf (${v.pf}) ≈ server 100`,
	);
}

// --- timings cross-check with KV cache reuse (prompt_n excludes cached) ------
{
	const s = createState();
	onProgress(s, { total: 59, processed: 55, cache: 55, timeMs: 32 });
	onProgress(s, { total: 59, processed: 59, cache: 55, timeMs: 161 });
	// server: 4 non-cached + 55 cached; prompt_n is non-cached only
	const v = onStreamEnd(s, {
		promptN: 4,
		cacheN: 55,
		promptMs: 162.5,
		promptPerSecond: 24.6,
		completionN: 64,
		predictedMs: 2754,
		predictedPerSecond: 22.9,
	});
	// final sample must be total (59), not prompt_n (4), or the window goes negative
	assert.ok((v.pf ?? 0) > 10, `cached cross-check pf (${v.pf}) stays positive`);
	assert.ok(
		Math.abs((v.pf ?? 0) - 24.6) < 20,
		`pf (${v.pf}) within margin of server 24.6`,
	);
}

// --- spec acceptance -----------------------------------------------------------
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
	onProgress(s, { total: 100, processed: 100, cache: 0, timeMs: 0 });
	const v = onToken(s, 500);
	assert.equal(v.spec, 9.9, "1+890/100=9.9");
	const v2 = onToken(s, 1000);
	assert.equal(v2.spec, 9.9, "spec persists between metrics polls");
}

// --- model switch / reset -------------------------------------------------------
{
	const s = createState();
	onProgress(s, { total: 100, processed: 100, cache: 0, timeMs: 0 });
	tokens(s, [100, 200, 300]);
	reset(s);
	const v = onProgress(s, { total: 100, processed: 0, cache: 0, timeMs: 0 });
	assert.equal(v.pf, 0, "reset clears windows");
	assert.equal(v.spec, null);
}

// --- SSE chunk parsing ----------------------------------------------------------
{
	const p = parseChunk(
		'{"prompt_progress":{"total":377,"cache":12,"processed":42,"time_ms":957}}',
	);
	assert.deepEqual(p, {
		kind: "progress",
		total: 377,
		processed: 42,
		cache: 12,
		timeMs: 957,
	});

	assert.deepEqual(parseChunk('{"choices":[{"delta":{"content":"hi"}}]}'), {
		kind: "token",
	});

	// role-only / empty content carries no signal
	assert.equal(
		parseChunk('{"choices":[{"delta":{"role":"assistant","content":null}}]}'),
		null,
	);
	// thinking models (Qwen3) stream reasoning_content; it is a generated token too
	assert.deepEqual(
		parseChunk('{"choices":[{"delta":{"reasoning_content":"Thinking"}}]}'),
		{ kind: "token" },
	);

	const u = parseChunk(
		'{"usage":{"prompt_tokens":377},"timings":{"prompt_n":377,"prompt_ms":3663.8,"prompt_per_second":102.9,"predicted_n":1,"predicted_ms":0.001,"predicted_per_second":0}}',
	);
	assert.equal(u?.kind, "usage");
	if (u?.kind === "usage") {
		assert.equal(u.timings?.promptN, 377);
		assert.ok(Math.abs((u.timings?.promptPerSecond ?? 0) - 102.9) < 0.01);
	}

	assert.deepEqual(parseChunk("[DONE]"), { kind: "done" });
	assert.equal(parseChunk("not json"), null, "malformed → null");
	assert.equal(parseChunk("null"), null, "non-object → null");

	// applyEvent routes each kind
	const s = createState();
	const ev = parseChunk(
		'{"prompt_progress":{"total":10,"cache":0,"processed":5,"time_ms":100}}',
	)!;
	assert.equal(applyEvent(s, ev, 0).phase, "prefill");
}

// --- latest-wins stream tracking ------------------------------------------------
{
	const tr = createTracker();
	openStream(tr, "A");
	assert.equal(tr.activeId, "A");
	assert.equal(classify(tr, "A"), "active");
	assert.equal(classify(tr, "B"), "new", "unseen id is new");

	// B supersedes A
	openStream(tr, "B");
	assert.equal(tr.activeId, "B", "latest stream wins");
	assert.equal(classify(tr, "A"), "stale", "older stream is stale");
	assert.equal(classify(tr, "B"), "active");

	// closing the superseded stream does NOT idle out the active one
	assert.equal(closeStream(tr, "A"), false, "stale close is a no-op");
	assert.equal(tr.activeId, "B", "active stream survives stale close");

	// closing the active stream ends the turn
	assert.equal(closeStream(tr, "B"), true, "active close ends turn");
	assert.equal(tr.activeId, null);
	assert.equal(classify(tr, "C"), "new");
}

// --- render formats -------------------------------------------------------------
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
}

console.log("stats.test.ts: all checks passed");
