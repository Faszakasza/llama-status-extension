// tests/tap.test.ts — tap integration: original bytes pass through unmodified,
// flag injection is target-only, phases fire in order, offline/abort semantics.
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

const sseFor = (id: string): string =>
	[
		`data: {"id":"${id}","prompt_progress":{"total":100,"processed":40,"cache":20,"time_ms":400}}\n\n`,
		`data: {"id":"${id}","prompt_progress":{"total":100,"processed":100,"cache":20,"time_ms":1000}}\n\n`,
		`data: {"id":"${id}","choices":[{"delta":{"content":"a"}}]}\n\n`,
		`data: {"id":"${id}","usage":{"prompt_tokens":100,"completion_tokens":3},"timings":{"prompt_n":100,"prompt_ms":1000,"prompt_per_second":100,"predicted_n":3,"predicted_ms":30,"predicted_per_second":100}}\n\n`,
		"data: [DONE]\n\n",
	].join("");

const fakeTransport = async (
	input: string,
	init?: { body?: unknown },
): Promise<Response> => {
	requested.push({ url: input, body: init?.body });
	if (failModels && input.includes("/v1/models")) throw new Error("down");
	if (input.includes("/chat/completions"))
		return new Response(new Blob([sseFor(nextStreamId)]), {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	return Response.json({ data: [] });
};
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
	const res = await tapped("http://fake.local:9/chat/completions", { body });
	const text = await res.text();
	assert.equal(text, sseFor("c1"), "original SSE bytes re-emitted unchanged");

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

	// ── phase sequence in the footer ──
	assert.ok(
		lines().some(
			(l) => l.includes("active · pf") && l.includes("tg3s -") && l.includes("cache 33%"),
		),
		`prefill line with bar+cache seen, got: ${JSON.stringify(lines())}`,
	);
	assert.ok(
		lines().some((l) => l.includes("active · pf ") && l.includes("100/s")),
		`pf speed line seen, got: ${JSON.stringify(lines())}`,
	);
	assert.ok(
		lines().some((l) => l.includes("active · pf - · tg3s ")),
		`generating line seen, got: ${JSON.stringify(lines())}`,
	);
	assert.equal(
		lines()[lines().length - 1],
		"m1 · idle · pf - · tg3s - · cache - · draft -",
		"turn end returns to idle",
	);

	// ── offline: status poll fails with no active stream ──
	failModels = true;
	handlers.session_start({ reason: "startup" }, ctx);
	await tick();
	assert.equal(
		lines()[lines().length - 1],
		"m1 · offline · pf - · tg3s - · cache - · draft -",
		"poll failure → offline",
	);

	// ── abort: stream cancelled mid-flight → idle, not offline ──
	failModels = false;
	nextStreamId = "c2";
	const res2 = await tapped("http://fake.local:9/chat/completions", { body });
	const r2 = res2.body!.getReader();
	await r2.read(); // first chunk: stream c2 opens, prefill line renders
	await r2.cancel();
	await tick();
	assert.equal(
		lines()[lines().length - 1],
		"m1 · idle · pf - · tg3s - · cache - · draft -",
		"abort → idle",
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
		lines().some((l) => l === "m1 | unloaded | pf - | tg3s - | cache - | draft -"),
		`project separator used, got: ${JSON.stringify(lines().slice(-3))}`,
	);
	rmSync(sepDir, { recursive: true, force: true });

	// ── shutdown: fetch restored, status cleared ──
	handlers.session_shutdown();
	assert.equal(globalThis.fetch, fakeTransport, "original fetch restored");
	assert.equal(statuses[statuses.length - 1], undefined, "status cleared");
	rmSync(globalDir, { recursive: true, force: true });
	console.log("tap.test.ts: all checks passed");
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
