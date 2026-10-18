import { describe, expect, it } from "vitest";
import type { WorktreeInfo } from "../resolver.js";
import {
	createResolverIO,
	type Exec,
	parseExistingDirPath,
	type ResolverFs,
} from "../resolver-io.js";

/**
 * Removal contract for the `wt` integration.
 *
 * `wt remove` deletes in the BACKGROUND and exits 0 once that is under way, so
 * exit 0 is not proof the path is free. On wt < 0.79 the delete happened in
 * place, so an interrupted pass left ~37G of husks here — directories that were
 * no longer worktrees, holding only the ignored `node_modules/.pnpm`, which
 * `wt switch` then refused forever with "Directory already exists".
 *
 * wt >= 0.79 renames the tree aside first, so the path is released before the
 * command returns and the settle below is a single `stat`. These tests pin the
 * behaviour that keeps us correct on EITHER version — the daemon must never
 * treat exit 0 as proof, and must never delete a path git still owns.
 */

const wt: WorktreeInfo = {
	name: "platform.feature-x",
	path: "/wt/platform.feature-x",
	branch: "feature/x",
} as WorktreeInfo;

/** Records argv and lets each command's exit code be scripted. */
function recordingExec(worktreeListOutput = ""): {
	exec: Exec;
	calls: string[][];
} {
	const calls: string[][] = [];
	const exec: Exec = async (command, args) => {
		calls.push([command, ...args]);
		if (command === "git" && args[0] === "worktree" && args[1] === "list") {
			return { stdout: worktreeListOutput, stderr: "", exitCode: 0 };
		}
		return { stdout: "", stderr: "", exitCode: 0 };
	};
	return { exec, calls };
}

/** An fs seam whose `exists` answers true for the first `trueFor` probes. */
function scriptedFs(trueFor: number): ResolverFs & { removed: string[] } {
	let seen = 0;
	const removed: string[] = [];
	return {
		removed,
		async exists() {
			seen += 1;
			return seen <= trueFor;
		},
		async remove(path) {
			removed.push(path);
		},
	};
}

const fast = { settleAttempts: 3, settleIntervalMs: 1 };

describe("removeWorktree", () => {
	it("clears IGNORED artifacts too (-fdx), not just -fd", async () => {
		// node_modules/.pnpm is gitignored and ~1.5G; leaving it is what made the
		// background delete slow enough to be interruptible.
		const { exec, calls } = recordingExec();
		await createResolverIO(exec, scriptedFs(0), fast).removeWorktree(
			"/repo",
			wt,
		);
		const clean = calls.find((c) => c[0] === "git" && c[1] === "clean");
		expect(clean).toEqual(["git", "clean", "-fdx"]);
	});

	it("returns as soon as the tree is actually gone, without forcing", async () => {
		const { exec } = recordingExec();
		const fs = scriptedFs(0); // gone on the first probe
		await createResolverIO(exec, fs, fast).removeWorktree("/repo", wt);
		expect(fs.removed).toEqual([]);
	});

	it("waits for the background delete rather than trusting exit 0", async () => {
		const { exec } = recordingExec();
		const fs = scriptedFs(2); // lingers for two probes, then vanishes
		await createResolverIO(exec, fs, fast).removeWorktree("/repo", wt);
		// It went on its own within the window — nothing forced.
		expect(fs.removed).toEqual([]);
	});

	it("finishes the removal itself when the background delete never lands", async () => {
		// The husk case. Worktree list no longer mentions the path, so git has
		// let go and what remains is leftovers, safe to delete.
		const { exec } = recordingExec(
			"worktree /repo\nHEAD abc\nbranch refs/heads/main\n",
		);
		const fs = scriptedFs(99); // never disappears
		await createResolverIO(exec, fs, fast).removeWorktree("/repo", wt);
		expect(fs.removed).toEqual(["/wt/platform.feature-x"]);
	});

	it("refuses to delete a path git still lists as a worktree", async () => {
		// wt claimed success but the registration survives — a contract violation.
		// Deleting here could destroy a live checkout, so surface it instead.
		const listing = `worktree ${wt.path}\nHEAD abc\nbranch refs/heads/feature/x\n`;
		const { exec } = recordingExec(listing);
		const fs = scriptedFs(99);
		await expect(
			createResolverIO(exec, fs, fast).removeWorktree("/repo", wt),
		).rejects.toThrow(/still registered/);
		expect(fs.removed).toEqual([]);
	});

	it("treats an unreadable worktree listing as 'still registered', never as safe", async () => {
		const failing: Exec = async (command, args) => {
			if (command === "git" && args[0] === "worktree" && args[1] === "list") {
				return { stdout: "", stderr: "git busy", exitCode: 1 };
			}
			return { stdout: "", stderr: "", exitCode: 0 };
		};
		const fs = scriptedFs(99);
		await expect(
			createResolverIO(failing, fs, fast).removeWorktree("/repo", wt),
		).rejects.toThrow(/still registered/);
		expect(fs.removed).toEqual([]);
	});

	it("still throws when wt remove itself fails, before any settling", async () => {
		const failing: Exec = async (command) =>
			command === "wt"
				? { stdout: "", stderr: "boom", exitCode: 1 }
				: { stdout: "", stderr: "", exitCode: 0 };
		const fs = scriptedFs(99);
		await expect(
			createResolverIO(failing, fs, fast).removeWorktree("/repo", wt),
		).rejects.toThrow(/failed to remove worktree/);
		expect(fs.removed).toEqual([]);
	});
});

/**
 * Spawn-side self-heal. A husk at the target path makes wt refuse outright
 * ("✗ Directory already exists: <path>"), and since nothing cleared it, every
 * later run on that branch failed identically — the branch was permanently
 * unrunnable. Both removal paths measured clean, so rather than keep hunting
 * the producer, spawn recovers: clear a directory git demonstrably does not own
 * (unregistered AND no `.git`), then retry once.
 */
describe("spawnWorktree husk recovery", () => {
	const HUSK = "/wt/platform.feature-x";
	const REFUSAL = `✗ Directory already exists: ${HUSK}`;
	const LISTING = (withWt: boolean) =>
		withWt
			? `worktree /repo\nHEAD a\nbranch refs/heads/main\n\nworktree ${HUSK}\nHEAD b\nbranch refs/heads/feature/x\n`
			: "worktree /repo\nHEAD a\nbranch refs/heads/main\n";

	/** wt refuses until the husk is cleared, then succeeds. */
	function healingExec(fs: { present: boolean }) {
		const calls: string[] = [];
		const exec: Exec = async (command, args) => {
			const key = [command, ...args].join(" ");
			calls.push(key);
			if (command === "git" && args[0] === "worktree" && args[1] === "list") {
				return { stdout: LISTING(!fs.present), stderr: "", exitCode: 0 };
			}
			if (command === "wt" && args[0] === "switch") {
				return fs.present
					? { stdout: "", stderr: REFUSAL, exitCode: 1 }
					: { stdout: "", stderr: "", exitCode: 0 };
			}
			return { stdout: "", stderr: "", exitCode: 0 };
		};
		return { exec, calls };
	}

	it("clears the husk and retries, turning a wedged branch into a working spawn", async () => {
		const state = { present: true };
		const { exec, calls } = healingExec(state);
		const fsio: ResolverFs = {
			async exists(p) {
				return p === HUSK ? state.present : false; // no .git inside
			},
			async remove() {
				state.present = false;
			},
		};
		const io = createResolverIO(exec, fsio, fast);
		const spawned = await io.spawnWorktree(
			"/repo",
			"platform.feature-x",
			"feature/x",
		);
		expect(spawned.path).toBe(HUSK);
		// It retried the switch rather than giving up after clearing.
		expect(calls.filter((c) => c.startsWith("wt switch")).length).toBe(2);
	});

	it("never deletes a path that still has a .git (a live worktree)", async () => {
		const state = { present: true };
		const { exec } = healingExec(state);
		const removed: string[] = [];
		const fsio: ResolverFs = {
			async exists() {
				return true; // both the dir AND its .git exist
			},
			async remove(p) {
				removed.push(p);
			},
		};
		await expect(
			createResolverIO(exec, fsio, fast).spawnWorktree(
				"/repo",
				"platform.feature-x",
				"feature/x",
			),
		).rejects.toThrow(/failed to spawn worktree/);
		expect(removed).toEqual([]);
	});

	it("leaves the filesystem alone when wt failed for any other reason", async () => {
		const exec: Exec = async (command, args) => {
			if (command === "git" && args[0] === "worktree" && args[1] === "list") {
				return { stdout: LISTING(false), stderr: "", exitCode: 0 };
			}
			if (command === "wt") {
				return { stdout: "", stderr: "✗ mise sync failed", exitCode: 1 };
			}
			return { stdout: "", stderr: "", exitCode: 0 };
		};
		const removed: string[] = [];
		const fsio: ResolverFs = {
			async exists() {
				return true;
			},
			async remove(p) {
				removed.push(p);
			},
		};
		await expect(
			createResolverIO(exec, fsio, fast).spawnWorktree(
				"/repo",
				"platform.feature-x",
				"feature/x",
			),
		).rejects.toThrow(/mise sync failed/);
		expect(removed).toEqual([]);
	});
});

describe("parseExistingDirPath", () => {
	it("extracts and home-expands the path wt refused", () => {
		expect(
			parseExistingDirPath(
				"✗ Directory already exists: ~/dev/platform.feature-x",
				"/home/op",
			),
		).toBe("/home/op/dev/platform.feature-x");
	});

	it("passes an absolute path through unchanged", () => {
		expect(
			parseExistingDirPath("✗ Directory already exists: /wt/thing", "/home/k"),
		).toBe("/wt/thing");
	});

	it("returns null for any other failure, so no path is ever guessed", () => {
		expect(parseExistingDirPath("✗ mise sync failed", "/home/k")).toBeNull();
		expect(parseExistingDirPath("", "/home/k")).toBeNull();
	});
});
