// tests/tap.test.ts — tap integration: original bytes pass through unmodified,
// flag injection is target-only, phases fire in order, draft figures persist
// across turns/models per the state machine, offline/abort semantics, zero
// /metrics and /slots requests.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ext from "../src/index.ts";

// hermetic: point the global settings path at an empty dir so the default
// separator is used regardless of the host's real ~/.pi/agent/settings.json
const globalDir = mkdtempSync(join(tmpdir(), "llama-stats-global-"));
process.env.PI_CODING_AGENT_DIR = globalDir;

const statuses: Array<string | undefined> = [];
const handlers: Record<string, (e?: unknown, ctx?: unknown) => void> = {};

const pi = {
	on: (name: string, h: (e?: unknown, ctx?: unknown) => void) => {
		handlers[name] = h;
	},
} as never;
ext(pi);

const ctx = {
	model: { id: "m1", provider: "llama-server=http://fake.local:9" },
	ui: { setStatus: (_k: string, v: string | undefined) => statuses.push(v) },
	cwd: process.cwd(),
	isProjectTrusted: () => false,
};

// ─── fake transport (installed before the tap, so the tap captures it) ───
const requested: Array<{ url: string; body: unknown }> = [];
let failModels = false;
let nextStreamId = "c1";

// final chunk carries draft_n/draft_n_accepted iff `draft` is [n, accepted, predictedN]
const sseFor = (id: string, draft: [number, number, number] | null): string => {
	const f = draft ? `,"draft_n":${draft[0]},"draft_n_accepted":${draft[1]}` : "";
	return [
		`data: {"id":"${id}","prompt_progress":{"total":100,"processed":40,"cache":20,"time_ms":400}}\n\n`,
		`data: {"id":"${id}","prompt_progress":{"total":100,"processed":100,"cache":20,"time_ms":1000}}\n\n`,
		`data: {"id":"${id}","choices":[{"delta":{"content":"a"}}]}\n\n`,
		`data: {"id":"${id}","usage":{"prompt_tokens":100,"completion_tokens":3},"timings":{"prompt_n":100,"prompt_ms":1000,"prompt_per_second":100,"predicted_n":${draft?.[2] ?? 3},"predicted_ms":30,"predicted_per_second":100${f}}}\n\n`,
		"data: [DONE]\n\n",
	].join("");
};

const fakeTransport = async (
	input: string,
	init?: { body?: unknown },
): Promise<Response> => {
	requested.push({ url: input, body: init?.body });
	if (failModels && input.includes("/v1/models")) throw new Error("down");
	if (input.includes("/chat/completions"))
		return new Response(new Blob([sseFor(nextStreamId, currentDraft)]), {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	return Response.json({ data: [] });
};
let currentDraft: [number, number, number] | null = null;
globalThis.fetch = fakeTransport as never;

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const lines = () => statuses.filter((v): v is string => v != null);

async function main() {
	handlers.session_start({ reason: "startup" }, ctx);
	const tapped = globalThis.fetch as (
		u: string,
		i?: { body?: unknown },
	) => Promise<Response>;
	assert.notEqual(tapped, fakeTransport, "tap installed over the transport");
	await tick(); // let the immediate /v1/models poll settle

	const body = JSON.stringify({ model: "m1", stream: true });

	// ── target request: bytes through, body mutated ──
	currentDraft = [8, 6, 11]; // → 75% 2.2x
	const res = await tapped("http://fake.local:9/chat/completions", { body });
	const text = await res.text();
	assert.equal(
		text,
		sseFor("c1", [8, 6, 11]),
		"original SSE bytes re-emitted unchanged",
	);

	const chat = requested.find(
		(r) => r.url === "http://fake.local:9/chat/completions",
	)!;
	const mutated = JSON.parse(chat.body as string) as Record<string, unknown>;
	assert.equal(mutated.return_progress, true, "return_progress injected");
	assert.equal(
		(mutated.stream_options as Record<string, unknown>)?.include_usage,
		true,
		"stream_options.include_usage injected",
	);
	assert.equal(mutated.stream, true, "stream flag preserved");

	// ── non-target request: body untouched ──
	await tapped("http://other.local/chat/completions", { body });
	assert.equal(
		requested[requested.length - 1].body,
		body,
		"non-target body passes through unmutated",
	);

	// ── phase sequence in the footer (turn 1, before the verdict: draft -) ──
	assert.ok(
		lines().some(
			(l) =>
				l.includes("active · pf") &&
				l.includes("tg3s -") &&
				l.includes("cache 33%") &&
				l.endsWith("draft -"),
		),
		`prefill line with bar+cache and draft - seen, got: ${JSON.stringify(lines())}`,
	);

	// ── turn end: draft figure appears on the idle line ──
	assert.equal(
		lines()[lines().length - 1],
		"m1 · idle · pf - · tg3s - · cache - · draft 75% 2.2x",
		"turn end computes the draft figure",
	);

	// ── turn 2: previous value persists through prefill and generating ──
	nextStreamId = "c2";
	currentDraft = [10, 3, 5]; // → 30% 2.5x
	await tapped("http://fake.local:9/chat/completions", { body });
	assert.ok(
		lines().some(
			(l) => l.includes("active · pf ") && l.endsWith("draft 75% 2.2x"),
		),
		`previous draft value persists during the new turn's prefill, got: ${JSON.stringify(lines().slice(-6))}`,
	);
	assert.ok(
		lines().some(
			(l) => l.includes("active · pf - · tg3s ") && l.endsWith("draft 75% 2.2x"),
		),
		`previous draft value persists during generating, got: ${JSON.stringify(lines().slice(-6))}`,
	);
	assert.equal(
		lines()[lines().length - 1],
		"m1 · idle · pf - · tg3s - · cache - · draft 30% 2.5x",
		"second turn updates the draft figure",
	);

	// ── offline: status poll fails with no active stream ──
	failModels = true;
	handlers.session_start({ reason: "startup" }, ctx);
	await tick();
	assert.equal(
		lines()[lines().length - 1],
		"m1 · offline · pf - · tg3s - · cache - · draft 30% 2.5x",
		"poll failure → offline, draft value persists",
	);

	// ── abort: stream cancelled mid-flight → idle, draft state kept ──
	failModels = false;
	nextStreamId = "c2b";
	currentDraft = null; // aborted streams never end with a usage chunk
	const res2 = await tapped("http://fake.local:9/chat/completions", { body });
	const r2 = res2.body!.getReader();
	await r2.read(); // first chunk: stream c2 opens, prefill line renders
	await r2.cancel();
	await tick();
	assert.equal(
		lines()[lines().length - 1],
		"m1 · idle · pf - · tg3s - · cache - · draft 30% 2.5x",
		"abort → idle, draft state unchanged",
	);

	// ── separator: trusted project .pi/settings.json wins over the default ──
	const sepDir = mkdtempSync(join(tmpdir(), "llama-stats-sep-"));
	mkdirSync(join(sepDir, ".pi"), { recursive: true });
	writeFileSync(
		join(sepDir, ".pi", "settings.json"),
		JSON.stringify({ separator: " | " }),
	);
	handlers.session_start(
		{ reason: "startup" },
		{
			model: ctx.model,
			ui: ctx.ui,
			cwd: sepDir,
			isProjectTrusted: () => true,
		},
	);
	await tick();
	assert.ok(
		lines().some(
			(l) => l === "m1 | unloaded | pf - | tg3s - | cache - | draft 30% 2.5x",
		),
		`project separator used, got: ${JSON.stringify(lines().slice(-3))}`,
	);
	rmSync(sepDir, { recursive: true, force: true });

	// ── model switch: draft state resets to - ──
	handlers.model_select(undefined, {
		...ctx,
		model: { id: "m2", provider: "llama-server=http://fake.local:9" },
	});
	await tick();
	assert.equal(
		lines()[lines().length - 1],
		"m2 | unloaded | pf - | tg3s - | cache - | draft -",
		"model select resets the draft state",
	);

	// ── fresh model, turn without draft fields → not supported ──
	nextStreamId = "c3";
	currentDraft = null;
	await tapped("http://fake.local:9/chat/completions", { body });
	assert.equal(
		lines()[lines().length - 1],
		"m2 | idle | pf - | tg3s - | cache - | draft not supported",
		"stats-less completed turn → not supported",
	);

	// ── zero /metrics and /slots requests over the whole run ──
	assert.equal(
		requested.filter((r) => r.url.includes("/metrics")).length,
		0,
		"no /metrics requests",
	);
	assert.equal(
		requested.filter((r) => r.url.includes("/slots")).length,
		0,
		"no /slots requests",
	);

	// ── shutdown: fetch restored, status cleared ──
	handlers.session_shutdown();
	assert.equal(globalThis.fetch, fakeTransport, "original fetch restored");
	assert.equal(statuses[statuses.length - 1], undefined, "status cleared");
	rmSync(globalDir, { recursive: true, force: true });
	console.log("tap.test.ts: all checks passed");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
