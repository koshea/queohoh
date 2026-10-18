import { describe, expect, it } from "vitest";
import { antigravityAdapter } from "../antigravity.js";

/** The fields every buildArgs call needs; spread-and-override per case. */
const base = {
	prompt: "do the thing",
	model: "gemini-3.1-pro-high",
	cwd: "/wt/platform.pr-2315",
	timeoutMs: 60_000,
};

describe("antigravityAdapter.buildArgs", () => {
	it("builds the live-verified print-mode argv", () => {
		expect(antigravityAdapter.buildArgs({ ...base })).toEqual([
			"-p",
			"do the thing",
			"--output-format",
			"stream-json",
			"--model",
			"gemini-3.1-pro-high",
			"--add-dir",
			"/wt/platform.pr-2315",
			"--print-timeout",
			// 60s budget + the 60s margin.
			"120s",
			"--disable-slash-commands",
			"--dangerously-skip-permissions",
		]);
	});

	it("passes cwd as --add-dir so tools run in the worktree, not the CLI scratch project", () => {
		// Regression guard for the behaviour that makes this adapter usable at
		// all: without --add-dir a live run's `run_command` reported a pwd of
		// ~/.gemini/antigravity-cli/scratch instead of the task's worktree.
		const args = antigravityAdapter.buildArgs({
			...base,
			cwd: "/wt/some-tree",
		});
		expect(args[args.indexOf("--add-dir") + 1]).toBe("/wt/some-tree");
	});

	it("derives --print-timeout from timeoutMs with a margin above queohoh's own ceiling", () => {
		// The CLI default is 5m, which would truncate a `timeout: 2h` task; the
		// margin keeps queohoh's reaper (which lands the canonical `timed out`
		// outcome) the one that fires first.
		const args = antigravityAdapter.buildArgs({
			...base,
			timeoutMs: 2 * 60 * 60_000,
		});
		expect(args[args.indexOf("--print-timeout") + 1]).toBe("7260s");
	});

	it("omits --dangerously-skip-permissions for a discuss turn", () => {
		const args = antigravityAdapter.buildArgs({ ...base, mode: "discuss" });
		expect(args).not.toContain("--dangerously-skip-permissions");
		// …but still keeps the rest of the invocation intact.
		expect(args).toContain("--output-format");
	});

	it("resumes in place via --conversation <id>", () => {
		const args = antigravityAdapter.buildArgs({
			...base,
			resumeSessionId: "55666f5c-2842-4ade-9a8d-2fabf4002fc0",
		});
		expect(args.slice(-2)).toEqual([
			"--conversation",
			"55666f5c-2842-4ade-9a8d-2fabf4002fc0",
		]);
	});

	it("prepends the system prompt into the prompt body (no CLI flag exists)", () => {
		const args = antigravityAdapter.buildArgs({ ...base, systemPrompt: "SP" });
		expect(args[1]).toBe("SP\n\n---\n\ndo the thing");
		expect(args).not.toContain("--append-system-prompt");
	});

	it("appends provider-config extraArgs last", () => {
		const args = antigravityAdapter.buildArgs({
			...base,
			extraArgs: ["--effort", "high"],
		});
		expect(args.slice(-2)).toEqual(["--effort", "high"]);
	});
});

describe("antigravityAdapter.parseEvent", () => {
	it("takes the session id from the init event's conversation_id", () => {
		expect(
			antigravityAdapter.parseEvent({
				event: "init",
				conversation_id: "abc-123",
				init: { model: "gemini-3.1-pro-high", cwd: "/wt" },
			}),
		).toEqual({ sessionId: "abc-123" });
	});

	it("streams agent_response text_delta on both ACTIVE and DONE", () => {
		// DONE carries the LAST fragment, not the full text — dropping it would
		// silently truncate the transcript's final token.
		expect(
			antigravityAdapter.parseEvent({
				event: "step_update",
				step_update: {
					step_type: "agent_response",
					state: "ACTIVE",
					text_delta: "hello",
				},
			}),
		).toEqual({ textDelta: "hello" });
		expect(
			antigravityAdapter.parseEvent({
				event: "step_update",
				step_update: {
					step_type: "agent_response",
					state: "DONE",
					text_delta: "\n",
				},
			}),
		).toEqual({ textDelta: "\n" });
	});

	it("renders a tool call as a delta (ordered with surrounding text), not transcriptMd", () => {
		const parsed = antigravityAdapter.parseEvent({
			event: "step_update",
			step_update: {
				step_type: "tool",
				state: "ACTIVE",
				tool_name: "run_command",
				tool_info: { name: "run_command", parameters: { CommandLine: "pwd" } },
			},
		});
		// Routed through textDelta on purpose: transcriptMd writes straight to
		// disk while deltas are line-buffered, so mixing the two would let a tool
		// heading overtake the half-written sentence before it.
		expect(parsed.transcriptMd).toBeUndefined();
		expect(parsed.textDelta).toContain("### Tool: run_command");
		expect(parsed.textDelta).toContain("pwd");
	});

	it("marks an errored tool step and skips the DONE repeat", () => {
		const errored = antigravityAdapter.parseEvent({
			event: "step_update",
			step_update: {
				step_type: "tool",
				state: "ERROR",
				tool_name: "view_file",
				tool_info: { name: "view_file", parameters: { AbsolutePath: "/nope" } },
			},
		});
		expect(errored.textDelta).toContain("### Tool: view_file (error)");
		// DONE repeats the parameters and adds a potentially file-sized `output`.
		expect(
			antigravityAdapter.parseEvent({
				event: "step_update",
				step_update: {
					step_type: "tool",
					state: "DONE",
					tool_name: "view_file",
					tool_info: { name: "view_file", output: "x".repeat(5000) },
				},
			}),
		).toEqual({});
	});

	it("ignores user_input and system_message steps", () => {
		for (const step_type of ["user_input", "system_message"]) {
			expect(
				antigravityAdapter.parseEvent({
					event: "step_update",
					step_update: { step_type, state: "DONE" },
				}),
			).toEqual({});
		}
	});

	it("takes the authoritative text, turns, duration and tokens from the result event", () => {
		expect(
			antigravityAdapter.parseEvent({
				event: "result",
				result: {
					conversation_id: "abc-123",
					status: "SUCCESS",
					response: "hello from antigravity.\n",
					duration_seconds: 1.138544521,
					num_turns: 1,
					usage: { input_tokens: 13174, output_tokens: 5 },
				},
			}),
		).toEqual({
			result: {
				text: "hello from antigravity.\n",
				// This CLI exposes no cost field — tokens without a price, like grok.
				costUsd: null,
				turns: 1,
				durationMs: 1139,
				inputTokens: 13174,
				outputTokens: 5,
			},
		});
	});

	it("tolerates a result event with no usage object", () => {
		const parsed = antigravityAdapter.parseEvent({
			event: "result",
			result: { status: "SUCCESS", response: "ok" },
		});
		expect(parsed.result).toMatchObject({
			text: "ok",
			turns: null,
			durationMs: null,
			inputTokens: null,
			outputTokens: null,
		});
	});
});

describe("antigravityAdapter.classifyUnavailable", () => {
	it.each([
		["RESOURCE_EXHAUSTED: quota exceeded for model", "stderr"],
		["Error 429: too many requests", "stderr"],
		["401 unauthorized", "stderr"],
	])("classifies %s as provider unavailable", (text) => {
		expect(
			antigravityAdapter.classifyUnavailable({
				exitCode: 1,
				stderr: text,
				resultText: "",
			}),
		).toBe("provider unavailable");
	});

	it("leaves a genuine task failure unclassified", () => {
		expect(
			antigravityAdapter.classifyUnavailable({
				exitCode: 1,
				stderr: "the tests did not pass",
				resultText: "I could not fix the build",
			}),
		).toBeNull();
	});
});
