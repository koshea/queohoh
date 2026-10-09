import { describe, expect, it } from "vitest";
import { execHook, HOOK_OUTPUT_LIMIT } from "../hooks.js";
import type { Exec } from "../resolver-io.js";

describe("execHook", () => {
	it("runs the command through bash -lc in cwd", async () => {
		let seen: unknown;
		const exec: Exec = async (command, args, opts) => {
			seen = { command, args, cwd: opts.cwd };
			return { stdout: "", exitCode: 0 };
		};
		await execHook("mise run setup", exec, { cwd: "/wt" });
		expect(seen).toEqual({
			command: "/bin/bash",
			args: ["-lc", "mise run setup"],
			cwd: "/wt",
		});
	});

	it("falls back to the command when the hook printed nothing", async () => {
		const exec: Exec = async () => ({ stdout: "", exitCode: 3 });
		await expect(execHook("boom", exec, { cwd: "/wt" })).rejects.toThrow(
			"hook failed (exit 3): boom",
		);
	});

	/**
	 * A failing hook's OWN output is the diagnosis; the script text is not.
	 * Reporting only the script made every pr-hygiene pre_run failure look
	 * identical, which hid a worktree bug for days — the abort line
	 * ("abort: worktree on 'X', expected …", or a bare `git rev-parse` fatal
	 * when the path is not a repo) never reached the task record.
	 */
	it("reports the hook's stderr rather than the script", async () => {
		const exec: Exec = async () => ({
			stdout: "",
			stderr: "abort: worktree on 'main', expected PR branch 'feature/x'",
			exitCode: 1,
		});
		await expect(
			execHook("long script…", exec, { cwd: "/wt" }),
		).rejects.toThrow(
			"hook failed (exit 1): abort: worktree on 'main', expected PR branch 'feature/x'",
		);
	});

	it("uses stdout when stderr is empty", async () => {
		const exec: Exec = async () => ({
			stdout: "fatal: not a git repository",
			stderr: "",
			exitCode: 128,
		});
		await expect(execHook("x", exec, { cwd: "/wt" })).rejects.toThrow(
			"hook failed (exit 128): fatal: not a git repository",
		);
	});

	it("keeps the TAIL of a chatty hook, bounded", async () => {
		// Aborts print last, so the tail is the part worth keeping.
		const exec: Exec = async () => ({
			stdout: "",
			stderr: `${"noise\n".repeat(2000)}abort: the real reason`,
			exitCode: 1,
		});
		let message = "";
		try {
			await execHook("x", exec, { cwd: "/wt" });
		} catch (e) {
			message = e instanceof Error ? e.message : String(e);
		}
		expect(message).toContain("abort: the real reason");
		expect(message.length).toBeLessThan(HOOK_OUTPUT_LIMIT + 200);
	});
});
