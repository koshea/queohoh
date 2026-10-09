import type { Exec } from "./resolver-io.js";

/**
 * Ceiling on a discovery shell-out.
 *
 * Why this exists: `fireCron` holds the definition's key in the engine's
 * `cronInFlight` set for the whole call, and only a SETTLED promise releases
 * it. Discovery is a shell-out to arbitrary operator code (pr-hygiene's
 * `discover.py` makes a dozen `gh` calls), so one network hang used to leave
 * that key in-flight forever — the definition's cron then never fired again,
 * silently, while every other definition kept running. pr-hygiene sat dead for
 * 12 hours exactly this way.
 *
 * 10 minutes is far above a healthy run (pr-hygiene's full sweep over ~27 PRs
 * takes well under a minute) and below the tightest cron interval in use
 * (every 20 minutes), so a wedged discovery self-heals within one slot instead
 * of needing a daemon restart.
 */
export const DISCOVERY_TIMEOUT_MS = 10 * 60_000;

export async function discoverItems(
	command: string,
	exec: Exec,
	opts: { cwd: string; timeoutMs?: number },
): Promise<Record<string, string>[]> {
	const timeoutMs = opts.timeoutMs ?? DISCOVERY_TIMEOUT_MS;
	const { stdout, exitCode } = await exec("/bin/bash", ["-lc", command], {
		cwd: opts.cwd,
		timeoutMs,
	});
	if (exitCode !== 0) {
		// A timeout surfaces here as a non-zero exit like any other failure. Say so
		// explicitly: "exit 1" on a discovery that normally works is otherwise an
		// unreadable clue, and this is the failure that used to be invisible.
		throw new Error(
			`discovery command failed (exit ${exitCode}; timeout ${Math.round(timeoutMs / 1000)}s)`,
		);
	}
	const parsed: unknown = JSON.parse(stdout.trim());
	if (!Array.isArray(parsed)) {
		throw new Error("discovery command must return a JSON array");
	}
	return parsed.map((raw) => {
		const item: Record<string, string> = {};
		for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
			item[k] = String(v);
		}
		return item;
	});
}
