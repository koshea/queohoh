import type { Exec } from "./resolver-io.js";

/** Trailing characters of a failed hook's own output kept in the error. Enough
 * for an abort line plus a `git status -sb` dump, bounded so a chatty hook
 * cannot bloat the task record the TUI renders. */
export const HOOK_OUTPUT_LIMIT = 2000;

export async function execHook(
	cmd: string,
	exec: Exec,
	opts: { cwd: string },
): Promise<void> {
	const { exitCode, stderr, stdout } = await exec("/bin/bash", ["-lc", cmd], {
		cwd: opts.cwd,
	});
	if (exitCode !== 0) {
		// The hook's OWN output is the diagnosis; the script text is not — the
		// script is already on disk and in the definition. Reporting only `cmd`
		// made every pre_run failure look identical: pr-hygiene aborts with a
		// specific line ("abort: worktree on 'X', expected PR branch 'Y'",
		// "abort: worktree is dirty", or a bare `git rev-parse` fatal when the
		// path is not a repo at all), and losing it hid a whole class of worktree
		// bugs for days. Keep the tail, since aborts print last.
		const output = (stderr?.trim() || stdout?.trim() || "").slice(
			-HOOK_OUTPUT_LIMIT,
		);
		// Fall back to the command only when the hook said nothing at all, so
		// there is always some context to act on.
		const detail = output === "" ? cmd : output;
		throw new Error(`hook failed (exit ${exitCode}): ${detail}`);
	}
}
