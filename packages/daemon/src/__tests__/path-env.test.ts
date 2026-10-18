import type { Exec } from "@queohoh/core";
import { describe, expect, it, vi } from "vitest";
import {
	ensureDaemonTerm,
	GH_MISSING_WARNING,
	HOOK_FALLBACK_TERM,
	mergePathEntries,
	normalizeDaemonPath,
	probeGh,
	wellKnownUserBinDirs,
} from "../path-env.js";

describe("mergePathEntries", () => {
	it("appends login-shell entries not already present, existing first", () => {
		// The daemon's inherited PATH (`current`) may carry deliberate overrides,
		// so it keeps precedence — new entries are only appended after it.
		expect(
			mergePathEntries("/usr/bin:/bin", "/opt/homebrew/bin:/usr/bin"),
		).toBe("/usr/bin:/bin:/opt/homebrew/bin");
	});

	it("dedups entries within and across both inputs (first occurrence wins)", () => {
		expect(mergePathEntries("/a:/b:/a", "/b:/c:/c")).toBe("/a:/b:/c");
	});

	it("returns login-shell entries when current PATH is empty", () => {
		expect(mergePathEntries("", "/opt/homebrew/bin:/usr/bin")).toBe(
			"/opt/homebrew/bin:/usr/bin",
		);
	});

	it("returns current PATH unchanged when login shell is empty", () => {
		expect(mergePathEntries("/usr/bin:/bin", "")).toBe("/usr/bin:/bin");
	});

	it("strips a trailing newline from the bash output", () => {
		// `echo "$PATH"` appends a newline; the last entry would otherwise carry it.
		expect(mergePathEntries("/usr/bin", "/opt/homebrew/bin\n")).toBe(
			"/usr/bin:/opt/homebrew/bin",
		);
	});

	it("drops empty segments (leading/trailing/doubled colons)", () => {
		expect(mergePathEntries("/usr/bin:", ":/opt/homebrew/bin::")).toBe(
			"/usr/bin:/opt/homebrew/bin",
		);
	});

	it("returns empty string when both inputs are empty", () => {
		expect(mergePathEntries("", "")).toBe("");
	});
});

/** An Exec stub that records its calls and returns a fixed result. */
function recordingExec(
	result: { stdout: string; exitCode: number },
	calls: { command: string; args: string[]; cwd: string }[],
): Exec {
	return async (command, args, opts) => {
		calls.push({ command, args, cwd: opts.cwd });
		return result;
	};
}

describe("wellKnownUserBinDirs", () => {
	it("lists the standard user agent-CLI install locations under home", () => {
		expect(wellKnownUserBinDirs("/home/op")).toEqual([
			"/home/op/.local/bin",
			"/home/op/.grok/bin",
			"/home/op/.cargo/bin",
			"/home/op/bin",
			"/opt/homebrew/bin",
			"/usr/local/bin",
		]);
	});
});

describe("normalizeDaemonPath", () => {
	it("resolves the login-shell PATH via `/bin/bash -lc` and merges well-known user bins", async () => {
		const calls: { command: string; args: string[]; cwd: string }[] = [];
		const exec = recordingExec(
			// bash -lc on a zsh-primary box often returns a PATH that never saw
			// ~/.local/bin or ~/.grok/bin — only system + cargo-style dirs.
			{ stdout: "/opt/homebrew/bin:/usr/bin\n", exitCode: 0 },
			calls,
		);
		const env = { PATH: "/usr/bin:/bin" };

		await normalizeDaemonPath(exec, { env, home: "/home/op" });

		expect(calls).toHaveLength(1);
		expect(calls[0]?.command).toBe("/bin/bash");
		expect(calls[0]?.args).toEqual(["-lc", 'echo "$PATH"']);
		// Inherited + bash login + well-known (dedup: /opt/homebrew/bin and
		// /usr/bin already present from earlier inputs keep first position).
		expect(env.PATH).toBe(
			"/usr/bin:/bin:/opt/homebrew/bin:/home/op/.local/bin:/home/op/.grok/bin:/home/op/.cargo/bin:/home/op/bin:/usr/local/bin",
		);
	});

	it("still appends well-known user bins when the bash call exits non-zero", async () => {
		// bash unhappy must not skip the well-known layer — that's the whole
		// point of the zsh-primary rescue (finding 2).
		const calls: { command: string; args: string[]; cwd: string }[] = [];
		const exec = recordingExec({ stdout: "", exitCode: 1 }, calls);
		const env = { PATH: "/usr/bin:/bin" };

		await normalizeDaemonPath(exec, { env, home: "/home/op" });

		expect(env.PATH).toBe(
			"/usr/bin:/bin:/home/op/.local/bin:/home/op/.grok/bin:/home/op/.cargo/bin:/home/op/bin:/opt/homebrew/bin:/usr/local/bin",
		);
	});

	it("still appends well-known user bins when the bash call throws", async () => {
		const exec: Exec = async () => {
			throw new Error("spawn failed");
		};
		const env = { PATH: "/usr/bin:/bin" };

		await normalizeDaemonPath(exec, { env, home: "/home/op" });

		expect(env.PATH).toBe(
			"/usr/bin:/bin:/home/op/.local/bin:/home/op/.grok/bin:/home/op/.cargo/bin:/home/op/bin:/opt/homebrew/bin:/usr/local/bin",
		);
	});
});

describe("probeGh", () => {
	it("returns true and does not warn when `gh --version` succeeds", async () => {
		const calls: { command: string; args: string[]; cwd: string }[] = [];
		const exec = recordingExec(
			{ stdout: "gh version 2.0\n", exitCode: 0 },
			calls,
		);
		const warn = vi.fn();

		const ok = await probeGh(exec, { warn });

		expect(ok).toBe(true);
		expect(warn).not.toHaveBeenCalled();
		expect(calls[0]?.command).toBe("gh");
		expect(calls[0]?.args).toEqual(["--version"]);
	});

	it("returns false and warns once when `gh --version` exits non-zero", async () => {
		const calls: { command: string; args: string[]; cwd: string }[] = [];
		const exec = recordingExec({ stdout: "", exitCode: 127 }, calls);
		const warn = vi.fn();

		const ok = await probeGh(exec, { warn });

		expect(ok).toBe(false);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith(GH_MISSING_WARNING);
	});

	it("returns false and warns when the probe throws", async () => {
		const exec: Exec = async () => {
			throw new Error("gh not found");
		};
		const warn = vi.fn();

		const ok = await probeGh(exec, { warn });

		expect(ok).toBe(false);
		expect(warn).toHaveBeenCalledTimes(1);
	});
});

/**
 * Hooks and discovery run through `/bin/bash -lc`. A LOGIN shell runs
 * ~/.bash_logout on exit, the stock skel version runs `clear`, and `clear`
 * without TERM exits non-zero — which bash reports as the hook's status. So a
 * hook that fully succeeded gets recorded as `hook failed (exit 1)`.
 *
 * Invisible when the daemon is launched from a terminal (TERM inherited),
 * fatal to every hook the moment it runs under systemd, which passes no TERM:
 * ~620 runs failed this way over four days.
 */
describe("ensureDaemonTerm", () => {
	it("supplies a TERM when the daemon inherited none", () => {
		const env: { TERM?: string } = {};
		ensureDaemonTerm(env);
		expect(env.TERM).toBe(HOOK_FALLBACK_TERM);
	});

	it("replaces 'dumb', which silences the warning but still fails `clear`", () => {
		// Measured: TERM=dumb -> exit 1 (quiet), TERM=xterm -> exit 0. Leaving
		// `dumb` in place would hide the bug rather than fix it.
		const env = { TERM: "dumb" };
		ensureDaemonTerm(env);
		expect(env.TERM).toBe(HOOK_FALLBACK_TERM);
	});

	it("never overrides an operator's real TERM", () => {
		const env = { TERM: "xterm-ghostty" };
		ensureDaemonTerm(env);
		expect(env.TERM).toBe("xterm-ghostty");
	});

	it("picks a TERM that actually has a clear capability", () => {
		expect(HOOK_FALLBACK_TERM).not.toBe("dumb");
		expect(HOOK_FALLBACK_TERM.length).toBeGreaterThan(0);
	});
});
