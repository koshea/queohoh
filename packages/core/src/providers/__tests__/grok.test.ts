import { describe, expect, it } from "vitest";
import { grokAdapter } from "../grok.js";

describe("grokAdapter", () => {
	it("builds --prompt-file + --output-format streaming-json + --always-approve (live-verified shape)", () => {
		expect(
			grokAdapter.buildArgs({
				prompt: "ignored-inline",
				model: "grok-4.5",
				promptFilePath: "/tmp/p.grok.txt",
			}),
		).toEqual([
			"--prompt-file",
			"/tmp/p.grok.txt",
			"--output-format",
			"streaming-json",
			"--always-approve",
			"--model",
			"grok-4.5",
		]);
	});
	it("appends --resume <id> when resuming (plain reuse, no fork)", () => {
		expect(
			grokAdapter.buildArgs({
				prompt: "p",
				model: "grok-4.5",
				resumeSessionId: "gsess-1",
				promptFilePath: "/tmp/p.grok.txt",
			}),
		).toEqual([
			"--prompt-file",
			"/tmp/p.grok.txt",
			"--output-format",
			"streaming-json",
			"--always-approve",
			"--model",
			"grok-4.5",
			"--resume",
			"gsess-1",
		]);
	});
	it("appends the system prompt via --rules", () => {
		expect(
			grokAdapter.buildArgs({
				prompt: "p",
				model: "grok-4.5",
				systemPrompt: "SP",
				promptFilePath: "/tmp/p.grok.txt",
			}),
		).toEqual([
			"--prompt-file",
			"/tmp/p.grok.txt",
			"--output-format",
			"streaming-json",
			"--always-approve",
			"--model",
			"grok-4.5",
			"--rules",
			"SP",
		]);
	});
	it("declares a prompt-file suffix and resume support", () => {
		expect(grokAdapter.promptFileSuffix).toBe(".grok.txt");
		expect(grokAdapter.supportsResume).toBe(true);
	});
	it("parses thought/text tokens as thinking/text deltas", () => {
		expect(
			grokAdapter.parseEvent({ type: "thought", data: "The user" }),
		).toEqual({ thinkingDelta: "The user" });
		expect(grokAdapter.parseEvent({ type: "text", data: "pong" })).toEqual({
			textDelta: "pong",
		});
	});
	it("parses sessionId + turns from the end event, empty result text (accumulated by the runner)", () => {
		const r = grokAdapter.parseEvent({
			type: "end",
			stopReason: "EndTurn",
			sessionId: "019f6b9a-1a1c-7303-a6c9-8fab67b4276f",
			requestId: "b9fa61cc-5638-44d7-a349-08da67f8f590",
			usage: {
				input_tokens: 16517,
				cache_read_input_tokens: 128,
				output_tokens: 31,
				reasoning_tokens: 26,
				total_tokens: 16676,
			},
			num_turns: 2,
		});
		expect(r.sessionId).toBe("019f6b9a-1a1c-7303-a6c9-8fab67b4276f");
		expect(r.result).toEqual({
			text: "",
			costUsd: null,
			turns: 2,
			durationMs: null,
			// grok reports no priced cost but DOES report token counts — these come
			// straight off `usage.input_tokens`/`output_tokens`, ignoring the
			// cache/reasoning/total fields the row deliberately doesn't display.
			inputTokens: 16517,
			outputTokens: 31,
		});
	});

	it("leaves inputTokens/outputTokens null when the end event carries no usage object", () => {
		const r = grokAdapter.parseEvent({
			type: "end",
			stopReason: "EndTurn",
			sessionId: "gsess-nousage",
			num_turns: 1,
		});
		expect(r.result).toEqual({
			text: "",
			costUsd: null,
			turns: 1,
			durationMs: null,
			inputTokens: null,
			outputTokens: null,
		});
	});
	it("classifies quota/subscription errors as unavailable, passes real failures through", () => {
		expect(
			grokAdapter.classifyUnavailable({
				exitCode: 1,
				stderr: "quota exceeded",
				resultText: "",
			}),
		).toBe("provider unavailable");
		expect(
			grokAdapter.classifyUnavailable({
				exitCode: 2,
				stderr: "compile error",
				resultText: "",
			}),
		).toBeNull();
	});
	it("throws if no prompt file is provided", () => {
		expect(() => grokAdapter.buildArgs({ prompt: "p", model: "m" })).toThrow();
	});
});

/**
 * Out-of-budget is the most likely failure a metered CLI has, so it must be the
 * best-covered. It was not: the exhausted-balance error below is what grok
 * actually returns (captured live 2026-09-27), and none of the original
 * patterns matched it — 402 is neither 401 nor 429, and the text says neither
 * "quota" nor "subscription". `classifyUnavailable` returned null, the run was
 * recorded as a genuine task failure, and the model chain never tried its
 * fallback, so every task died on the first provider while a working second one
 * sat unused.
 */
describe("grokAdapter.classifyUnavailable — exhausted balance", () => {
	const LIVE_402 = [
		"Error: Internal error: {",
		'  "message": "API error (status 402 Payment Required): Grok Build usage balance exhausted",',
		'  "http_status": 402',
		"}",
	].join("\n");

	it("classifies the live 402 exhausted-balance error as unavailable", () => {
		expect(
			grokAdapter.classifyUnavailable({
				exitCode: 1,
				stderr: LIVE_402,
				resultText: "",
			}),
		).toBe("provider unavailable");
	});

	it("matches on the status code, the reason phrase, and the balance wording independently", () => {
		// Any one of these alone must be enough — the exact envelope is not a
		// stable contract, so no single token can be load-bearing.
		for (const text of [
			"http_status: 402",
			"API error (status 402 Payment Required)",
			"Grok Build usage balance exhausted",
			"insufficient credits",
			"out of credits",
		]) {
			expect(
				grokAdapter.classifyUnavailable({
					exitCode: 1,
					stderr: text,
					resultText: "",
				}),
			).toBe("provider unavailable");
		}
	});

	it("still leaves a genuine task failure unclassified", () => {
		expect(
			grokAdapter.classifyUnavailable({
				exitCode: 1,
				stderr: "tests failed: 3 assertions",
				resultText: "I could not fix the build",
			}),
		).toBeNull();
	});
});
