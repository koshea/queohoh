import { describe, expect, it } from "vitest";
import { DISCOVERY_TIMEOUT_MS, discoverItems } from "../discovery.js";
import type { Exec } from "../resolver-io.js";

function execReturning(stdout: string, exitCode = 0): Exec {
	return async () => ({ stdout, exitCode });
}

describe("discoverItems", () => {
	it("parses a JSON array and stringifies values", async () => {
		const exec = execReturning('[{"number": 1423, "title": "fix auth"}]');
		const items = await discoverItems("gh pr list --json number,title", exec, {
			cwd: "/repo",
		});
		expect(items).toEqual([{ number: "1423", title: "fix auth" }]);
	});

	it("throws on nonzero exit", async () => {
		const exec = execReturning("", 1);
		await expect(discoverItems("boom", exec, { cwd: "/repo" })).rejects.toThrow(
			// The timeout is named in the message: a discovery that normally works
			// failing with a bare "exit 1" is an unreadable clue, and a timeout is
			// exactly the failure that used to be invisible.
			/discovery command failed \(exit 1; timeout \d+s\)/,
		);
	});

	it("throws on non-array JSON", async () => {
		const exec = execReturning('{"not": "array"}');
		await expect(discoverItems("x", exec, { cwd: "/repo" })).rejects.toThrow(
			"discovery command must return a JSON array",
		);
	});

	it("passes the command through bash -lc with cwd", async () => {
		let seen: { command: string; args: string[]; cwd: string } | null = null;
		const exec: Exec = async (command, args, opts) => {
			seen = { command, args, cwd: opts.cwd };
			return { stdout: "[]", exitCode: 0 };
		};
		await discoverItems("echo '[]'", exec, { cwd: "/repo" });
		expect(seen).toEqual({
			command: "/bin/bash",
			args: ["-lc", "echo '[]'"],
			cwd: "/repo",
		});
	});
});

/**
 * A discovery shell-out MUST be bounded. `fireCron` holds the definition's key
 * in the engine's in-flight set until this promise settles, so an unbounded
 * hang retired that definition's cron permanently — silently, while every other
 * definition kept firing. pr-hygiene sat dead for 12 hours this way.
 */
describe("discoverItems timeout", () => {
	function recordingExec(): Exec & {
		opts: { cwd: string; timeoutMs?: number }[];
	} {
		const opts: { cwd: string; timeoutMs?: number }[] = [];
		const exec = (async (
			_c: string,
			_a: string[],
			o: { cwd: string; timeoutMs?: number },
		) => {
			opts.push(o);
			return { stdout: "[]", exitCode: 0 };
		}) as Exec & { opts: typeof opts };
		exec.opts = opts;
		return exec;
	}

	it("always passes a timeout to exec, so a hung command cannot wedge the cron", async () => {
		const exec = recordingExec();
		await discoverItems("slow", exec, { cwd: "/repo" });
		expect(exec.opts[0]?.timeoutMs).toBe(DISCOVERY_TIMEOUT_MS);
	});

	it("honors an explicit timeoutMs override", async () => {
		const exec = recordingExec();
		await discoverItems("slow", exec, { cwd: "/repo", timeoutMs: 1234 });
		expect(exec.opts[0]?.timeoutMs).toBe(1234);
	});

	it("keeps the default well under the tightest cron interval (20m)", () => {
		// Otherwise a wedged discovery would still skip slots instead of self-healing.
		expect(DISCOVERY_TIMEOUT_MS).toBeLessThan(20 * 60_000);
	});
});
