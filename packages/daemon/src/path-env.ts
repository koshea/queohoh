import { homedir } from "node:os";
import type { Exec } from "@queohoh/core";

/**
 * Why this module exists — the minimal-PATH launch scenario.
 *
 * When the daemon is launched from something other than the user's interactive
 * login shell (launchd, a bare `execFile`, a stripped-down CI/test shell), it
 * inherits a minimal PATH that typically lacks `/opt/homebrew/bin`. Every DIRECT
 * tool call the daemon makes goes through `defaultExec` (a plain `execFile` with
 * NO shell — see `packages/core/src/resolver-io.ts`), so command resolution uses
 * `process.env.PATH` verbatim with no rescue. On such a launch `gh` is invisible:
 * `ghPrMap` fails every enrichment sweep, and gh-backed discovery scripts fail.
 *
 * The asymmetry that hides this: task DISCOVERY runs through `/bin/bash -lc`
 * (`packages/core/src/discovery.ts`), and a login shell on macOS runs
 * `path_helper` (via `/etc/paths.d/homebrew`) which restores `/opt/homebrew/bin`.
 * So discovery quietly survives a minimal PATH while the bare `execFile` calls
 * do not — the same gh binary is reachable from one code path and not the other.
 *
 * The fix (below) borrows the login shell's own PATH once at startup and merges
 * it into `process.env.PATH`, so every subsequent bare `execFile` sees the same
 * directories the `-lc` discovery path already enjoyed — then appends well-known
 * user bin dirs (`~/.local/bin`, `~/.grok/bin`, …). The well-known layer is
 * load-bearing for zsh-primary machines: bash `-lc` never loads zinit/oh-my-zsh
 * PATH hooks, so without it a minimal-PATH launch cannot find `claude`/`grok`
 * and every job lands as "provider unavailable".
 */

/** The one-time warning emitted when `gh` is still unresolvable after the PATH
 * merge. Exported so the startup probe and its test assert on the same string. */
export const GH_MISSING_WARNING =
	"[queohoh] gh not found on PATH — PR enrichment and gh-backed discovery will fail; install gh or fix the daemon's PATH";

/**
 * Merge the login shell's PATH into the daemon's current PATH, pure and
 * order-preserving. EXISTING entries come first (the inherited PATH may hold a
 * deliberate override that must keep winning over a login-shell default of the
 * same tool), then any login-shell entry not already present is appended.
 *
 * Each entry is trimmed so a trailing newline from `echo "$PATH"` never rides
 * along on the last segment, and empty segments (leading/trailing/doubled
 * colons) are dropped. Dedup is first-occurrence-wins across both inputs.
 */
export function mergePathEntries(current: string, loginShell: string): string {
	const seen = new Set<string>();
	const merged: string[] = [];
	const add = (raw: string): void => {
		const entry = raw.trim();
		// Drop empty segments (a trailing `:` or the newline-only tail) and any
		// entry we've already taken — the first occurrence keeps its position.
		if (entry.length === 0 || seen.has(entry)) return;
		seen.add(entry);
		merged.push(entry);
	};
	for (const entry of current.split(":")) add(entry);
	for (const entry of loginShell.split(":")) add(entry);
	return merged.join(":");
}

/** A mutable PATH carrier — defaults to `process.env` in production, but a plain
 * object in tests so the merge can be asserted without touching real env. */
interface PathEnv {
	PATH?: string;
	TERM?: string;
}

/**
 * TERM handed to hook/discovery subshells when the daemon inherited none.
 *
 * `xterm` rather than `dumb` ON PURPOSE: `dumb` silences the warning but
 * `clear` still fails (a dumb terminal has no clear capability), so the shell's
 * exit status stays non-zero and the bug survives in silent form — which is
 * strictly worse. Verified: `dumb` → exit 1 (quiet), `xterm` → exit 0.
 */
export const HOOK_FALLBACK_TERM = "xterm";

/**
 * Guarantee a usable TERM for the `/bin/bash -lc` subshells that run hooks
 * (`execHook`) and discovery (`discoverItems`).
 *
 * Why this is load-bearing: `-l` makes those LOGIN shells, and a login shell
 * runs `~/.bash_logout` on exit. The stock skel logout file runs `clear`, which
 * fails when TERM is unset and takes the shell's exit status with it — so a
 * hook whose own script succeeded (it printed its output and `exit 0`'d) is
 * still reported as `hook failed (exit 1)`, and the task fails.
 *
 * It hides completely when the daemon is started from a terminal, because TERM
 * is inherited. Move the daemon under systemd — which passes no TERM — and
 * EVERY hook starts failing. That is exactly what happened here: ~620 runs over
 * four days, across pre_run and post_run alike, with the real cause masked
 * because `execHook` used to report the script instead of its stderr.
 *
 * Only an absent or `dumb` TERM is replaced; an operator's real TERM is left
 * alone. Mutates in place (like `normalizeDaemonPath`) so every child spawned
 * afterwards inherits it.
 */
export function ensureDaemonTerm(env: PathEnv = process.env): void {
	if (!env.TERM || env.TERM === "dumb") env.TERM = HOOK_FALLBACK_TERM;
}

/**
 * Directories user-installed agent CLIs commonly land in, independent of which
 * login shell (bash vs zsh) the PATH rescue probes. Appended AFTER the login-
 * shell merge so an inherited/shell entry still wins on name collisions.
 *
 * Why this exists: the bash `-lc` rescue alone is not enough on a zsh-primary
 * machine. Bash login profiles typically never load zinit/oh-my-zsh PATH
 * hooks, so `~/.local/bin` (claude) and `~/.grok/bin` never appear — and every
 * provider then fails at spawn with ENOENT, classified as "provider
 * unavailable". These well-known dirs close that gap without requiring the
 * operator's interactive shell.
 */
export function wellKnownUserBinDirs(home: string = homedir()): string[] {
	return [
		`${home}/.local/bin`,
		`${home}/.grok/bin`,
		`${home}/.cargo/bin`,
		`${home}/bin`,
		// macOS Homebrew — also usually restored by bash -lc via path_helper,
		// but kept here so a PATH-less launch on macOS still finds gh/etc.
		"/opt/homebrew/bin",
		"/usr/local/bin",
	];
}

/**
 * Resolve the login shell's PATH via `/bin/bash -lc 'echo "$PATH"'` (the same
 * `-lc` invocation that lets discovery survive a minimal PATH), merge it into
 * `env.PATH`, then append well-known user bin dirs so agent CLIs installed for
 * a zsh-only PATH still resolve. Injectable `exec` so the effect is
 * unit-testable without spawning bash. On ANY failure of the bash probe —
 * non-zero exit or a throwing exec — the current PATH is kept and only the
 * well-known dirs are appended (a merge is a best-effort improvement, never a
 * hard dependency).
 *
 * Must run BEFORE the engine starts ticking so the first enrichment sweep and
 * the first discovery already see the widened PATH.
 */
export async function normalizeDaemonPath(
	exec: Exec,
	opts: { env?: PathEnv; home?: string } = {},
): Promise<void> {
	const env = opts.env ?? process.env;
	const home = opts.home ?? homedir();
	let base = env.PATH ?? "";
	try {
		const { stdout, exitCode } = await exec(
			"/bin/bash",
			["-lc", 'echo "$PATH"'],
			// cwd is irrelevant to `echo "$PATH"`; home is a stable, always-present
			// directory so the spawn itself never fails on a missing cwd.
			{ cwd: home },
		);
		if (exitCode === 0) {
			base = mergePathEntries(base, stdout);
		}
		// exitCode !== 0: bash unhappy — keep current PATH, still append well-known.
	} catch {
		// Spawn failed outright (no /bin/bash, injected reject) — keep PATH as-is.
	}
	// Always layer well-known user bins after the shell merge so a zsh-only
	// install of claude/grok is visible even when bash -lc returned a PATH that
	// never saw them. No-op when they are already present (first-wins dedup).
	const merged = mergePathEntries(base, wellKnownUserBinDirs(home).join(":"));
	if (merged.length > 0) env.PATH = merged;
}

/**
 * One-time startup probe: run `gh --version` through the (now PATH-normalized)
 * exec plumbing. If it fails, emit ONE prominent warning and return false — the
 * daemon must NOT crash, since enrichment/discovery are optional and it has
 * non-gh duties. Returns true when gh is reachable.
 */
export async function probeGh(
	exec: Exec,
	opts: { warn?: (message: string) => void } = {},
): Promise<boolean> {
	const warn = opts.warn ?? console.warn;
	try {
		const { exitCode } = await exec("gh", ["--version"], { cwd: homedir() });
		if (exitCode === 0) return true;
	} catch {
		// fall through to the single warning below
	}
	warn(GH_MISSING_WARNING);
	return false;
}
