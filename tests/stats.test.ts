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
	onTurnEnd,
	applyEvent,
	openStream,
	parseChunk,
	renderLine,
	reset,
	type DraftState,
	type TurnTimings,
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
		draftN: null,
		draftNAccepted: null,
	});
	assert.ok(
		Math.abs((v.pf ?? 0) - 100) < 0.5,
		`window pf (${v.pf}) ≈ server 100`,
	);
}

// --- timings cross-check with KV cache reuse (prompt_n excludes cached) ------
{
	const s = createState();
	onProgress(s, { total: 59, processed: 55, cache: 55, timeMs: 320 });
	onProgress(s, { total: 59, processed: 59, cache: 55, timeMs: 1610 });
	// server: 4 non-cached + 55 cached; prompt_n is non-cached only
	const v = onStreamEnd(s, {
		promptN: 4,
		cacheN: 55,
		promptMs: 1625,
		promptPerSecond: 2.46,
		completionN: 64,
		predictedMs: 2754,
		predictedPerSecond: 22.9,
		draftN: null,
		draftNAccepted: null,
	});
	// final sample must be total (59), not prompt_n (4), or the window goes negative
	assert.ok((v.pf ?? 0) > 1, `cached cross-check pf (${v.pf}) stays positive`);
	assert.ok(
		Math.abs((v.pf ?? 0) - 2.46) < 20,
		`pf (${v.pf}) within margin of server 2.46`,
	);
}

// --- draft state machine + formulas (1.3) --------------------------------------
{
	const T = (o: Partial<TurnTimings>): TurnTimings => ({
		promptN: 0,
		cacheN: 0,
		promptMs: 0,
		promptPerSecond: 0,
		completionN: 0,
		predictedMs: 0,
		predictedPerSecond: 0,
		draftN: null,
		draftNAccepted: null,
		...o,
	});

	// live case: predicted 48, draft 40, accepted 33 → 83% 3.2x
	const s1 = createState();
	onTurnEnd(s1, T({ completionN: 48, draftN: 40, draftNAccepted: 33 }));
	assert.deepEqual(s1.draft, { kind: "value", ratioPct: 83, meanLen: 3.2 });

	// log-line case: 811 generated drafts, 349 accepted, 538 predicted
	// → ratio 43%, steps 189, mean len 1+349/189 = 2.85 → 2.9x
	const s2 = createState();
	onTurnEnd(s2, T({ completionN: 538, draftN: 811, draftNAccepted: 349 }));
	assert.deepEqual(s2.draft, { kind: "value", ratioPct: 43, meanLen: 2.9 });

	// accepted = 0 → 0% 1.0x
	const s3 = createState();
	onTurnEnd(s3, T({ completionN: 10, draftN: 10, draftNAccepted: 0 }));
	assert.deepEqual(s3.draft, { kind: "value", ratioPct: 0, meanLen: 1.0 });

	// absent fields (older build) with generated tokens → unsupported verdict
	const s4 = createState();
	onTurnEnd(s4, T({ completionN: 5 }));
	assert.equal(s4.draft.kind, "unsupported");
	// absent fields, no generated tokens → stays none
	const s4b = createState();
	onTurnEnd(s4b, T({ completionN: 0 }));
	assert.equal(s4b.draft.kind, "none");

	// no stats after a value: keep the value
	onTurnEnd(s2, T({ completionN: 7 }));
	assert.deepEqual(s2.draft, { kind: "value", ratioPct: 43, meanLen: 2.9 });

	// unsupported is never latched: stats self-heal back to a value
	onTurnEnd(s4, T({ completionN: 12, draftN: 8, draftNAccepted: 6 }));
	assert.deepEqual(s4.draft, { kind: "value", ratioPct: 75, meanLen: 2.0 });

	// value updates with each new turn
	onTurnEnd(s2, T({ completionN: 11, draftN: 8, draftNAccepted: 6 }));
	assert.deepEqual(s2.draft, { kind: "value", ratioPct: 75, meanLen: 2.2 });

	// unsupported verdict persists across stats-less turns
	const s5 = createState();
	onTurnEnd(s5, T({ completionN: 3 }));
	onTurnEnd(s5, T({ completionN: 4 }));
	assert.equal(s5.draft.kind, "unsupported");

	// no timings at all (aborted / no usage chunk) → no verdict
	const s6 = createState();
	onTurnEnd(s6, null);
	assert.equal(s6.draft.kind, "none");

	// draftN present but degenerate steps → keep previous state
	const s7 = createState();
	onTurnEnd(s7, T({ completionN: 48, draftN: 40, draftNAccepted: 33 }));
	onTurnEnd(s7, T({ completionN: 5, draftN: 9, draftNAccepted: 9 }));
	assert.deepEqual(s7.draft, { kind: "value", ratioPct: 83, meanLen: 3.2 });

	// state flows into the render view in every phase
	const s8 = createState();
	onTurnEnd(s8, T({ completionN: 11, draftN: 8, draftNAccepted: 6 }));
	const v8 = onProgress(s8, { total: 10, processed: 10, cache: 0, timeMs: 0 });
	assert.equal(v8.draft?.kind, "value", "value visible during a new turn's prefill");
	assert.equal(renderLine("M", v8).endsWith("draft 75% 2.2x"), true);

	// unsupported renders as literal text
	const unsup: RenderView = { phase: "idle", draft: { kind: "unsupported" } };
	assert.equal(
		renderLine("M", unsup),
		"M · idle · pf - · tg3s - · cache - · draft not supported",
	);
}

// --- min-span floor for speed() (1.2) ------------------------------------------
{
	// turn-start burst: 4 tokens within 2 ms, then steady 66 ms/token (~15 t/s)
	const s = createState();
	let maxSeen = 0;
	for (const t of [0, 1, 1, 2]) {
		maxSeen = Math.max(maxSeen, (onToken(s, t).tg ?? 0));
	}
	for (let t = 50; t <= 2000; t += 66) {
		const v = onToken(s, t);
		if (t <= 2000) maxSeen = Math.max(maxSeen, v.tg ?? 0);
	}
	assert.ok(
		maxSeen <= 100,
		`burst never exceeds 100/s during the first 2 s, got ${maxSeen}`,
	);

	// 3 tokens over 400 ms: below the 500 ms floor → 0/s throughout
	const s2 = createState();
	const short = [onToken(s2, 0), onToken(s2, 150), onToken(s2, 400)];
	for (const v of short) assert.equal(v.tg ?? 0, 0, "span < 500 ms → 0/s");

	// full window unchanged: 40 tokens over 2 s → 20 t/s
	const s3 = createState();
	const v3 = tokens(s3, Array.from({ length: 41 }, (_, i) => 1000 + i * 50));
	assert.ok(
		Math.abs((v3.tg ?? 0) - 20) < 0.5,
		`full window tg≈20, got ${v3.tg}`,
	);
}

// --- parseChunk draft fields (1.1) ---------------------------------------------
{
	const u = parseChunk(
		"{\"usage\":{\"prompt_tokens\":3},\"timings\":{\"predicted_n\":11,\"draft_n\":8,\"draft_n_accepted\":6}}",
	);
	assert.equal(u?.kind, "usage");
	assert.equal(u?.timings?.draftN, 8);
	assert.equal(u?.timings?.draftNAccepted, 6);

	const bare = parseChunk(
		'{"usage":{"prompt_tokens":3},"timings":{"predicted_n":11,"prompt_ms":5,"predicted_ms":30}}',
	);
	assert.equal(bare?.kind, "usage");
	assert.equal(bare?.timings?.draftN, null, "absent → null (older build)");
	assert.equal(bare?.timings?.draftNAccepted, null);
}

// --- draft rendering per phase (1.4) -------------------------------------------
{
	const R = (o: Partial<RenderView> & { phase: RenderView["phase"] }): RenderView => o;
	const val: DraftState = { kind: "value", ratioPct: 43, meanLen: 2.9 };
	for (const phase of [
		"idle",
		"prefill",
		"generating",
		"loading",
		"unloaded",
		"offline",
	] as const) {
		const line = renderLine("M", R({ phase, draft: val }));
		assert.ok(
			line.endsWith("draft 43% 2.9x"),
			`draft value shown in ${phase} phase: ${line}`,
		);
	}
	assert.equal(
		renderLine("M", R({ phase: "idle", draft: { kind: "unsupported" } })),
		"M · idle · pf - · tg3s - · cache - · draft not supported",
	);
	assert.equal(
		renderLine("M", R({ phase: "generating", tg: 15, draft: val })),
		"M · active · pf - · tg3s 15/s · cache - · draft 43% 2.9x",
	);

	// reset clears the draft state
	const s = createState();
	onTurnEnd(s, { promptN: 0, cacheN: 0, promptMs: 0, promptPerSecond: 0, completionN: 11, predictedMs: 0, predictedPerSecond: 0, draftN: 8, draftNAccepted: 6 });
	reset(s);
	assert.equal(s.draft.kind, "none");
}

// --- model switch / reset -------------------------------------------------------
{
	const s = createState();
	onProgress(s, { total: 100, processed: 100, cache: 0, timeMs: 0 });
	tokens(s, [100, 200, 300]);
	reset(s);
	const v = onProgress(s, { total: 100, processed: 0, cache: 0, timeMs: 0 });
	assert.equal(v.pf, 0, "reset clears windows");
	assert.equal(v.draft?.kind, "none", "reset clears the draft state");
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
	assert.equal(
		renderLine("M", R({ phase: "idle" })),
		"M · idle · pf - · tg3s - · cache - · draft -",
	);
	assert.equal(
		renderLine("M", R({ phase: "loading" })),
		"M · loading · pf - · tg3s - · cache - · draft -",
	);
	assert.equal(
		renderLine("M", R({ phase: "unloaded" })),
		"M · unloaded · pf - · tg3s - · cache - · draft -",
	);
	assert.equal(
		renderLine("M", R({ phase: "offline" })),
		"M · offline · pf - · tg3s - · cache - · draft -",
	);
	// prefill: speed + bar + pct, cache value, tg3s/draft dashes
	assert.equal(
		renderLine("M", R({ phase: "prefill", pf: 1800, barFrac: 0.34, cachePct: 97 })),
		"M · active · pf 1.8k/s ▓▓░░░░ 34% · tg3s - · cache 97% · draft -",
	);
	// prefill: null cachePct → cache dash
	assert.equal(
		renderLine("M", R({ phase: "prefill", pf: 78, barFrac: 0, cachePct: null })),
		"M · active · pf 78/s ░░░░░░ 0% · tg3s - · cache - · draft -",
	);
	// prefill: missing barFrac/pf → 0
	assert.equal(
		renderLine("M", R({ phase: "prefill" })),
		"M · active · pf 0/s ░░░░░░ 0% · tg3s - · cache - · draft -",
	);
	// generating: tg3s + draft value
	assert.equal(
		renderLine("M", R({ phase: "generating", tg: 78, draft: { kind: "value", ratioPct: 43, meanLen: 2.9 } })),
		"M · active · pf - · tg3s 78/s · cache - · draft 43% 2.9x",
	);
	// generating: no draft state → draft dash
	assert.equal(
		renderLine("M", R({ phase: "generating", tg: 1234 })),
		"M · active · pf - · tg3s 1.2k/s · cache - · draft -",
	);
	// custom separator
	assert.equal(
		renderLine("M", R({ phase: "idle" }), " | "),
		"M | idle | pf - | tg3s - | cache - | draft -",
	);
}

console.log("stats.test.ts: all checks passed");
