// tests/live.ts — LIVE verification against the real router (manual; not part of npm test).
// Run: timeout 90 npx jiti tests/live.ts
import ext from "../src/index.ts";

const BASE = "http://aurora.home.lan:10000";
const MODEL = "Qwen3.6-35B-A3B";

const lines: string[] = [];
const events: Array<string | undefined> = [];
const urls: string[] = [];
const handlers: Record<string, (e?: unknown, ctx?: unknown) => void> = {};

ext({
	on: (n: string, h: (e?: unknown, ctx?: unknown) => void) => {
		handlers[n] = h;
	},
} as never);

const realFetch = globalThis.fetch.bind(globalThis);
(globalThis as { fetch: unknown }).fetch = (async (
	input: string,
	init?: { body?: unknown },
) => {
	urls.push(input);
	console.log(
		`[live] ${new Date().toISOString().slice(11, 19)} → ${input.replace(BASE, "")}`,
	);
	return realFetch(input, init as RequestInit | undefined);
}) as never;

async function main() {
	handlers.session_start(
		{ reason: "startup" } as never,
		{
			model: { id: MODEL, provider: `llama-server=${BASE}` },
			ui: {
				setStatus: (_k: string, v: string | undefined) => {
					events.push(v);
					if (v) {
						lines.push(v);
						console.log("[live] footer:", v);
					}
				},
			},
			cwd: process.cwd(),
			isProjectTrusted: () => false,
		} as never,
	);

	await new Promise((r) => setTimeout(r, 1500)); // first status poll settles

	const t0 = Date.now();
	const body = JSON.stringify({
		model: MODEL,
		stream: true,
		messages: [{ role: "user", content: "Reply with exactly one short word." }],
		max_tokens: 64,
	});
	const res = (await (
		globalThis as {
			fetch: (
				u: string,
				i?: { method?: string; body?: string },
			) => Promise<Response>;
		}
	).fetch(`${BASE}/chat/completions`, { method: "POST", body })) as Response;
	await res.text();
	const dt = ((Date.now() - t0) / 1000).toFixed(1);

	await new Promise((r) => setTimeout(r, 2500)); // post-turn poll settles
	// non-llama model → footer clears
	handlers.model_select(
		undefined,
		{
			model: { id: "not-llama", provider: "openai" },
			ui: {
				setStatus: (_k: string, v: string | undefined) => events.push(v),
			},
		} as never,
	);
	const cleared = events[events.length - 1] === undefined;

	const count = (frag: string) => urls.filter((u) => u.includes(frag)).length;
	console.log(`[live] turn took ${dt}s`);
	console.log(
		`[live] requests: models=${count("/v1/models")} metrics=${count("/metrics")} chat=${count("/chat/completions")} slots=${count("/slots")}`,
	);

	const idleLine = `${MODEL} · idle · pf - · tg3s - · cache - · draft -`;
	const hasPf = lines.some((l) => l.includes("active · pf "));
	const hasTg = lines.some((l) => l.includes("active · pf - · tg3s "));
	const idle = lines[lines.length - 1] === idleLine;
	const sixFields = lines.every(
		(l) => l.split(" · ").length === 6,
	);
	const ok =
		hasPf && hasTg && idle && sixFields && cleared && count("/slots") === 0;
	console.log(
		`[live] prefill=${hasPf} generating=${hasTg} idle=${idle} sixFields=${sixFields} nonLlamaClear=${cleared} noSlots=${count("/slots") === 0}`,
	);
	console.log(ok ? "[live] PASS" : "[live] FAIL");
	process.exit(ok ? 0 : 1);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
