import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { antigravityAdapter } from "../providers/index.js";
import { executeRun } from "../runner.js";

/** The fake CLI waits for an explicit release file, so observing the transcript
 * proves it arrived before the terminal result, without a
 * guessed process-spawn delay. It only reads/writes this disposable directory. */
async function waitFor(check: () => boolean): Promise<void> {
	const deadline = Date.now() + 3000;
	while (!check()) {
		if (Date.now() >= deadline)
			throw new Error("fake agy did not stream in time");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe("executeRun with antigravity", () => {
	it.each([
		undefined,
		"existing-conversation",
	])("streams init/text/tools and keeps the terminal result authoritative (resume=%s)", async (resumeSessionId) => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "qoo-agy-runner-")));
		const bin = join(dir, "agy");
		const eventsPath = join(dir, "events.jsonl");
		const transcriptPath = join(dir, "transcript.md");
		const capturePath = join(dir, "invocation.json");
		const releasePath = join(dir, "release");
		writeFileSync(
			bin,
			`#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.writeFileSync("invocation.json", JSON.stringify({ cwd: process.cwd(), args }));
const session = args.includes("--conversation") ? args[args.indexOf("--conversation") + 1] : "new-conversation";
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
emit({ event: "init", conversation_id: session });
emit({ event: "step_update", step_update: { step_type: "agent_response", state: "ACTIVE", text_delta: "Before the tool" } });
emit({ event: "step_update", step_update: { step_type: "tool", state: "ACTIVE", tool_name: "read_file", tool_info: { parameters: { path: "example.txt" } } } });
emit({ event: "step_update", step_update: { step_type: "tool", state: "DONE", tool_name: "read_file", tool_info: { parameters: { path: "example.txt" } } } });
emit({ event: "step_update", step_update: { step_type: "agent_response", state: "DONE", text_delta: "After the tool\\n" } });
const timer = setInterval(() => {
 if (!fs.existsSync("release")) return;
 clearInterval(timer);
 emit({ event: "result", result: { response: "Authoritative final answer", num_turns: 2, duration_seconds: 1.25, usage: { input_tokens: 42, output_tokens: 17 } } });
}, 10);
`,
		);
		chmodSync(bin, 0o755);
		let settled = false;
		const run = executeRun(antigravityAdapter, {
			prompt: "Inspect this worktree",
			model: "gemini-3.1-pro-high",
			cwd: dir,
			timeoutMs: 5000,
			claudeBin: bin,
			resumeSessionId,
			eventsPath,
			transcriptPath,
			redact: (value) => value,
		}).finally(() => {
			settled = true;
		});
		try {
			await waitFor(
				() =>
					existsSync(transcriptPath) &&
					readFileSync(transcriptPath, "utf-8").includes("After the tool"),
			);
			expect(settled).toBe(false);
			const invocation = JSON.parse(readFileSync(capturePath, "utf-8"));
			expect(invocation.cwd).toBe(dir);
			expect(invocation.args).toEqual([
				"-p",
				"Inspect this worktree",
				"--output-format",
				"stream-json",
				"--model",
				"gemini-3.1-pro-high",
				"--add-dir",
				dir,
				"--print-timeout",
				"65s",
				"--disable-slash-commands",
				"--dangerously-skip-permissions",
				...(resumeSessionId ? ["--conversation", resumeSessionId] : []),
			]);
			const liveTranscript = readFileSync(transcriptPath, "utf-8");
			expect(liveTranscript.indexOf("Before the tool")).toBeLessThan(
				liveTranscript.indexOf("### Tool: read_file"),
			);
			expect(liveTranscript.indexOf("### Tool: read_file")).toBeLessThan(
				liveTranscript.indexOf("After the tool"),
			);
			expect(liveTranscript.match(/### Tool: read_file/g)).toHaveLength(1);
			expect(liveTranscript).toContain('"path": "example.txt"');
			writeFileSync(releasePath, "");
			const result = await run;
			expect(result.exitCode).toBe(0);
			expect(result.timedOut).toBe(false);
			expect(result.sessionId).toBe(resumeSessionId ?? "new-conversation");
			expect(result.resultText).toBe("Authoritative final answer");
			expect(result.usage).toEqual({
				costUsd: null,
				turns: 2,
				durationMs: 1250,
				inputTokens: 42,
				outputTokens: 17,
			});
			const events = readFileSync(eventsPath, "utf-8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			expect(events.map((event) => event.event)).toEqual([
				"init",
				"step_update",
				"step_update",
				"step_update",
				"step_update",
				"result",
			]);
		} finally {
			writeFileSync(releasePath, "");
			await run;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
