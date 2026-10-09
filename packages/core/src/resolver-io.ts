import { execFile } from "node:child_process";
import { rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename } from "node:path";
import {
	findWorktree,
	type ResolverIO,
	type WorktreeInfo,
} from "./resolver.js";

export type Exec = (
	command: string,
	args: string[],
	opts: { cwd: string },
) => Promise<{ stdout: string; stderr?: string; exitCode: number }>;

export const defaultExec: Exec = (command, args, opts) =>
	new Promise((resolve) => {
		execFile(command, args, { cwd: opts.cwd }, (error, stdout, stderr) => {
			const exitCode =
				error && typeof error.code === "number" ? error.code : error ? 1 : 0;
			resolve({
				stdout: stdout ?? "",
				stderr: stderr ?? "",
				exitCode,
			});
		});
	});

/**
 * Filesystem seam used only by the post-`wt remove` settle (below). Injected so
 * the removal contract is unit-testable without touching a real tree.
 */
export interface ResolverFs {
	exists(path: string): Promise<boolean>;
	remove(path: string): Promise<void>;
}

export const defaultResolverFs: ResolverFs = {
	async exists(path) {
		try {
			await stat(path);
			return true;
		} catch {
			return false;
		}
	},
	remove: (path) => rm(path, { recursive: true, force: true }),
};

/** How long to wait for the worktree path to actually be free before finishing
 * the job ourselves: 60 × 250ms = 15s. Bounded because a hung delete must not
 * stall the engine pass that is reaping.
 *
 * On wt >= 0.79 this costs one `stat` and returns immediately (see
 * `settleRemoval`); it is kept as version-agnostic insurance, not as the
 * primary mechanism. */
const REMOVE_SETTLE_ATTEMPTS = 60;
const REMOVE_SETTLE_INTERVAL_MS = 250;

const delay = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Pull the offending path out of wt's refusal, e.g.
 * `✗ Directory already exists: ~/dev/platform.feature-x`.
 *
 * Taken from wt's own message rather than rebuilt from repo + name because the
 * worktree layout is configurable (`wt config create`), so guessing the path
 * could point the husk cleanup at the wrong directory. `~` is expanded because
 * wt prints the home-relative form. Returns null when the output is any other
 * failure — the caller must then not touch the filesystem at all.
 */
export function parseExistingDirPath(
	output: string,
	home: string = homedir(),
): string | null {
	const match = /Directory already exists:\s*(\S+)/.exec(output);
	if (!match) return null;
	const raw = match[1];
	if (raw === undefined || raw.length === 0) return null;
	if (raw === "~") return home;
	if (raw.startsWith("~/")) return `${home}/${raw.slice(2)}`;
	return raw;
}

export function parseWorktreePorcelain(output: string): WorktreeInfo[] {
	const result: WorktreeInfo[] = [];
	let path: string | undefined;
	let branch: string | undefined;
	const flush = () => {
		// Only emit entries that have both a path and a branch; detached/bare
		// entries (no `branch` line) are skipped.
		if (path && branch) result.push({ name: basename(path), path, branch });
		path = undefined;
		branch = undefined;
	};
	// A new `worktree` line starts a fresh entry, so entries are separated by
	// their attribute lines rather than relying on blank-line terminators.
	for (const line of output.split("\n")) {
		if (line.startsWith("worktree ")) {
			flush();
			path = line.slice("worktree ".length);
		} else if (line.startsWith("branch ")) {
			branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
		}
	}
	flush();
	return result;
}

export function createResolverIO(
	exec: Exec,
	fsio: ResolverFs = defaultResolverFs,
	/** Settle tuning — tests shrink these so the linger path doesn't wait 15s. */
	opts: { settleAttempts?: number; settleIntervalMs?: number } = {},
): ResolverIO {
	const settleAttempts = opts.settleAttempts ?? REMOVE_SETTLE_ATTEMPTS;
	const settleIntervalMs = opts.settleIntervalMs ?? REMOVE_SETTLE_INTERVAL_MS;
	async function listWorktrees(repoPath: string): Promise<WorktreeInfo[]> {
		const { stdout, exitCode } = await exec(
			"git",
			["worktree", "list", "--porcelain"],
			{ cwd: repoPath },
		);
		// Fail loud so Engine.refreshWorktreeCache can KEEP the last-known list.
		// Returning [] on error (with listingOk still true) made every worktree
		// look deleted and hard-purged terminal tasks for still-existing WTs
		// (e.g. long-lived platform.TICK-1946 while cleaning up other branches).
		if (exitCode !== 0) {
			throw new Error(
				`git worktree list failed in ${repoPath} (exit ${exitCode})`,
			);
		}
		return parseWorktreePorcelain(stdout);
	}

	/**
	 * Wait for `wt remove`'s background delete to land, and finish it if it
	 * doesn't. Returns once `path` is gone.
	 *
	 * The forced removal is gated on the path no longer being a REGISTERED
	 * worktree: that is what proves git has let go of it and we are deleting a
	 * husk rather than racing a live checkout. If it is somehow still registered
	 * after `wt remove` returned 0, that is a contract violation worth surfacing,
	 * not something to paper over with a delete.
	 */
	async function settleRemoval(path: string, repoPath: string): Promise<void> {
		for (let i = 0; i < settleAttempts; i++) {
			if (!(await fsio.exists(path))) return;
			await delay(settleIntervalMs);
		}
		if (!(await fsio.exists(path))) return;
		let stillRegistered = false;
		try {
			stillRegistered = (await listWorktrees(repoPath)).some(
				(wt) => wt.path === path,
			);
		} catch {
			// Listing failed (git contention): treat as "unknown", which must not
			// read as "safe to delete" — same conservatism as the engine's reaper.
			stillRegistered = true;
		}
		if (stillRegistered) {
			throw new Error(
				`worktree ${path} still registered after wt remove reported success`,
			);
		}
		await fsio.remove(path);
	}

	return {
		listWorktrees,

		async prBranch(repoPath, number) {
			const { stdout, exitCode } = await exec(
				"gh",
				["pr", "view", String(number), "--json", "headRefName"],
				{ cwd: repoPath },
			);
			if (exitCode !== 0) return null;
			try {
				const parsed = JSON.parse(stdout) as { headRefName?: string };
				return parsed.headRefName ?? null;
			} catch {
				return null;
			}
		},

		async spawnWorktree(repoPath, name, branch) {
			// `branch` given (the PR flow) means "check out this EXISTING branch":
			// fetch it and switch WITHOUT -c — `wt switch -c` would mint a brand-new
			// branch of the same name off HEAD, silently landing the worktree on
			// main's tip instead of the PR. No branch (ticket/temp flows) keeps the
			// create-new-branch semantics.
			if (branch) {
				// Both best-effort: fetch may be offline, --track fails when the
				// local branch already exists. `wt switch` is the load-bearing step.
				await exec("git", ["fetch", "origin", branch], { cwd: repoPath });
				await exec("git", ["branch", "--track", branch, `origin/${branch}`], {
					cwd: repoPath,
				});
			}
			// `--yes` / `--no-cd` are SWITCH subcommand flags, not global wt
			// options (`wt --yes switch …` fails with "unexpected argument
			// '--yes'"; tip: `switch --yes`). Without `--yes` Worktrunk refuses
			// project post-start hooks in a non-TTY daemon ("Cannot prompt for
			// approval"). `--no-cd`: create only — never change the daemon cwd.
			const createArgs = branch
				? (["switch", "--yes", "--no-cd", branch] as string[])
				: (["switch", "--yes", "--no-cd", "-c", name] as string[]);
			let result = await exec("wt", createArgs, { cwd: repoPath });
			let detail = [result.stderr, result.stdout]
				.filter((s) => s && s.trim())
				.join("\n")
				.trim();

			// Ticket/temp create (-c): a prior partial spawn often left the
			// branch on disk. wt then prints "Branch X already exists" and
			// exits non-zero — open the existing branch without -c.
			if (result.exitCode !== 0 && !branch) {
				const reopen = await exec(
					"wt",
					["switch", "--yes", "--no-cd", name],
					{ cwd: repoPath },
				);
				const reopenDetail = [reopen.stderr, reopen.stdout]
					.filter((s) => s && s.trim())
					.join("\n")
					.trim();
				if (reopen.exitCode === 0) {
					result = reopen;
					detail = reopenDetail;
				} else if (reopenDetail) {
					detail = detail
						? `${detail}\n${reopenDetail}`
						: reopenDetail;
				}
			}

			// Always re-list: post-create hooks can exit non-zero AFTER the
			// worktree directory exists (mise sync / docker-setup). Adopt it so
			// the task runs instead of failing with a generic spawn error while
			// leaving an orphan worktree the ticket matcher used to miss.
			let after = await listWorktrees(repoPath);
			let spawned = findWorktree(after, name, branch);
			if (spawned) return spawned;

			// Self-heal a HUSK: a directory at the target path that git does not
			// own (no registration, no `.git`). wt refuses such a path outright
			// ("✗ Directory already exists: <path>"), and because nothing ever
			// cleared it, EVERY later run on that branch failed the same way —
			// pr-hygiene sat wedged for days this way, and ~37G accumulated.
			//
			// Deliberately not diagnosing WHO leaves the husk: both removal paths
			// were measured clean (`git worktree remove --force` deletes 1.36G
			// synchronously; wt >= 0.79 frees the path before returning), yet husks
			// still appear after a failed spawn — most likely a partial rollback
			// when wt's post-create hooks fail under the daemon's non-TTY env.
			// Whoever the producer is, recovery is the same and belongs here:
			// a branch must not be permanently unrunnable because of leftovers.
			//
			// The path comes from wt's own message rather than being reconstructed,
			// since worktree layout is configurable (`wt config create`). The gate
			// stays the one used everywhere else — unregistered AND no `.git` — so
			// a live checkout can never be deleted.
			const huskPath = parseExistingDirPath(detail);
			if (huskPath !== null && !after.some((wt) => wt.path === huskPath)) {
				if (
					(await fsio.exists(huskPath)) &&
					!(await fsio.exists(`${huskPath}/.git`))
				) {
					await fsio.remove(huskPath);
					const retry = await exec("wt", createArgs, { cwd: repoPath });
					after = await listWorktrees(repoPath);
					spawned = findWorktree(after, name, branch);
					if (spawned) return spawned;
					const retryDetail = [retry.stderr, retry.stdout]
						.filter((s) => s?.trim())
						.join("\n")
						.trim();
					if (retryDetail) detail = retryDetail;
				}
			}

			const suffix = detail ? `: ${detail.slice(0, 500)}` : "";
			throw new Error(`failed to spawn worktree: ${name}${suffix}`);
		},

		async removeWorktree(repoPath, worktree) {
			// Force the worktree clean so `wt remove` can proceed (mirrors
			// a cleanup-worktree script — this deliberately discards
			// uncommitted changes). `exec` never rejects, so reset/clean are
			// inherently best-effort; only `wt remove`'s exit code is load-bearing.
			await exec("git", ["reset", "--hard", "HEAD"], { cwd: worktree.path });
			// `-x`, not just `-fd`: without it the IGNORED artifacts survive, and a
			// platform worktree carries a pnpm `node_modules/.pnpm` store of ~1.5G.
			// That bulk is exactly what an interrupted background delete used to
			// leave behind (see the settle note below), so clearing it synchronously
			// here means even a failed removal cannot strand gigabytes.
			await exec("git", ["clean", "-fdx"], { cwd: worktree.path });
			// Same flag placement as switch: `remove --yes`, not `--yes remove`.
			const { exitCode } = await exec(
				"wt",
				["remove", "--yes", worktree.branch],
				{ cwd: repoPath },
			);
			if (exitCode !== 0) {
				throw new Error(`failed to remove worktree: ${worktree.name}`);
			}
			// `wt remove` deletes in the BACKGROUND and exits 0 as soon as that is
			// under way, so exit 0 alone is not proof the path is free.
			//
			// wt < 0.79 deleted in place, so an interrupted pass (daemon restart,
			// process-group kill, sleep) left a directory that was no longer a
			// registered worktree and had no `.git` — and `wt switch` then refused it
			// forever with "Directory already exists", wedging EVERY future run on
			// that branch. ~37G of such husks accumulated here, each holding only the
			// ignored `node_modules/.pnpm` that the delete never reached.
			//
			// wt >= 0.79 renames the worktree aside first, so the path is released
			// before the command returns (measured: 0.096s to return vs 0.77s to
			// actually delete 100k files) and this settle is a single `stat` that
			// returns immediately. Kept anyway: it costs nothing on a fixed wt and
			// is the only thing standing between an older/downgraded wt and a
			// permanently wedged branch.
			await settleRemoval(worktree.path, repoPath);
			// Best-effort: wt may have already deleted the branch.
			await exec("git", ["branch", "-D", worktree.branch], { cwd: repoPath });
		},
	};
}
