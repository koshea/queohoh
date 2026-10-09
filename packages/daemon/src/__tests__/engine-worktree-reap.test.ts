import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	Exec,
	GlobalConfig,
	ProviderConfig,
	ResolverIO,
	WorktreeInfo,
} from "@queohoh/core";
import {
	BUILTIN_CATALOG,
	makeRedactor,
	QueueStore,
	RunStore,
	SessionLineageStore,
	SessionRegistry,
} from "@queohoh/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Engine } from "../engine.js";

afterEach(() => {
	vi.restoreAllMocks();
});

const TEST_PROVIDERS: ProviderConfig[] = [{ name: "claude", enabled: true }];

const DAY = 86_400_000;
/** Fixed wall clock so age assertions never depend on real time. */
const NOW = Date.parse("2026-09-14T12:00:00.000Z");

interface Opts {
	worktrees: WorktreeInfo[];
	/** Worktree paths whose `git status --porcelain` reports changes. */
	dirtyPaths?: string[];
	/** Worktree paths whose `git status` exits non-zero → `dirty` is unknown. */
	statusFailPaths?: string[];
	/** Epoch SECONDS reported by `git log` for every worktree. */
	lastCommitEpoch?: number;
	worktreeRetentionDays?: number | null;
	favorites?: string[];
	protectedWorktrees?: string[];
	/** Branches that `gh pr list --state open` reports an open PR for. */
	openPrBranches?: string[];
	/** Make every `gh` call fail, as on a machine without gh / with bad auth. */
	ghUnavailable?: boolean;
	now?: number;
}

function setup(opts: Opts) {
	const base = mkdtempSync(join(tmpdir(), "qo-reap-"));
	const repoPath = join(base, "repo");
	mkdirSync(repoPath, { recursive: true });
	const workspace = join(base, "ws");
	mkdirSync(join(workspace, "platform"), { recursive: true });
	if (opts.protectedWorktrees) {
		writeFileSync(
			join(workspace, "platform", "vars.yaml"),
			`protected_worktrees:\n${opts.protectedWorktrees.map((n) => `  - ${n}\n`).join("")}`,
		);
	}
	const store = new QueueStore(join(base, "state"));
	const config: GlobalConfig = {
		workspace,
		projects: [{ name: "platform", path: repoPath }],
		maxConcurrentTasks: 3,
		purgeAfterDays: 3650, // never age-purge task records inside a test
		archiveAfterDays: 3650,
		worktreeRetentionDays: opts.worktreeRetentionDays ?? null,
		vars: {},
		catalog: BUILTIN_CATALOG,
		defaultModels: ["claude/claude-opus-5"],
		providers: TEST_PROVIDERS,
	};
	const removed: string[] = [];
	const resolverIO: ResolverIO = {
		listWorktrees: async () => opts.worktrees,
		prBranch: async () => null,
		spawnWorktree: async (_r, name) => ({
			name,
			path: join(base, `wt-${name}`),
			branch: name,
		}),
		removeWorktree: async (_repoPath, wt) => {
			removed.push(wt.name);
		},
	};
	const dirty = new Set(opts.dirtyPaths ?? []);
	const statusFail = new Set(opts.statusFailPaths ?? []);
	const epoch = opts.lastCommitEpoch ?? Math.floor(NOW / 1000);
	const openPrs = opts.openPrBranches ?? [];
	const exec: Exec = async (cmd, args) => {
		if (cmd === "gh") {
			if (opts.ghUnavailable) return { stdout: "", exitCode: 127 };
			const open = args.includes("open");
			return {
				stdout: JSON.stringify(
					open
						? openPrs.map((headRefName, i) => ({
								number: 900 + i,
								headRefName,
								baseRefName: "main",
								url: `https://example.test/pr/${900 + i}`,
								state: "OPEN",
								author: { name: "Kevin", login: "koshea" },
								labels: [],
							}))
						: [],
				),
				exitCode: 0,
			};
		}
		const at = args.indexOf("-C");
		const path = at >= 0 ? (args[at + 1] ?? "") : "";
		if (args.includes("status")) {
			if (statusFail.has(path)) return { stdout: "", exitCode: 1 };
			return { stdout: dirty.has(path) ? " M a.ts\n" : "", exitCode: 0 };
		}
		if (args.includes("log")) {
			return { stdout: `${epoch}\tKevin\tk@example.com\tabc1234`, exitCode: 0 };
		}
		return { stdout: "", exitCode: 0 };
	};
	const favorites = new Set(opts.favorites ?? []);
	// The sweep must skip a guarded worktree outright, not discover the guard by
	// calling removeWorktree and catching its throw — that would log an error on
	// every tick forever. Captured so a test can assert nothing was attempted.
	const errors: string[] = [];
	vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
		errors.push(args.map(String).join(" "));
	});
	const engine = new Engine({
		store,
		runStore: new RunStore(join(base, "runs")),
		registry: new SessionRegistry(join(base, "sessions.json")),
		config,
		resolverIO,
		exec,
		executeClaude: async () => {
			throw new Error("no runs in these tests");
		},
		executeVerify: async () => ({
			exitCode: 0,
			timedOut: false,
			signal: null,
			output: "",
		}),
		redact: makeRedactor(new Map()),
		lineage: new SessionLineageStore(join(base, "session-lineage.json")),
		now: () => opts.now ?? NOW,
		isWorktreeFavorite: (key) => favorites.has(key),
	});
	return { engine, store, removed, errors };
}

/** A task already settled on `worktree`, as the sweep will find it. */
function settledTask(
	store: QueueStore,
	worktree: string,
	extra: { ephemeralWorktree?: boolean; status?: "done" | "needs-input" } = {},
) {
	const t = store.create({
		prompt: "p",
		repo: "platform",
		ref: `worktree:${worktree}`,
		source: "tui",
	});
	store.update(t.id, {
		status: extra.status ?? "done",
		// Pinned to the fixed clock: left unset, the store stamps the REAL time,
		// and the retention assertions silently drift as the calendar moves.
		finishedAt: new Date(NOW).toISOString(),
		target: { repo: "platform", ref: `worktree:${worktree}`, worktree },
		ephemeralWorktree: extra.ephemeralWorktree ?? false,
	});
	return t;
}

/** Tick once to fill the worktree cache, land enrichment deterministically
 * (production kicks it fire-and-forget), then tick again to run the sweep. */
async function reapPass(engine: Engine) {
	await engine.tick();
	await engine.refreshGitEnrichment();
	await engine.tick();
}

const PRIMARY: WorktreeInfo = {
	name: "platform",
	path: "/repo/platform",
	branch: "main",
};

function spawned(name: string): WorktreeInfo {
	return { name, path: `/repo/${name}`, branch: name.replace("platform.", "") };
}

describe("Engine worktree reap", () => {
	it("removes an ephemeral worktree once its task has settled", async () => {
		const wt = spawned("platform.qoo-adhoc-ab12");
		const { engine, store, removed } = setup({ worktrees: [PRIMARY, wt] });
		settledTask(store, wt.name, { ephemeralWorktree: true });

		await reapPass(engine);

		expect(removed).toEqual([wt.name]);
	});

	it("keeps an ephemeral worktree while a live task still targets it", async () => {
		// `needs-input` is live but never scheduled, so this exercises the sweep's
		// live guard rather than the scheduler.
		const wt = spawned("platform.qoo-adhoc-ab12");
		const { engine, store, removed } = setup({ worktrees: [PRIMARY, wt] });
		settledTask(store, wt.name, {
			ephemeralWorktree: true,
			status: "needs-input",
		});

		await reapPass(engine);

		expect(removed).toEqual([]);
	});

	it("removes an idle {repo}.{branch} worktree past the retention window", async () => {
		const wt = spawned("platform.JUS-2763");
		const { engine, store, removed } = setup({
			worktrees: [PRIMARY, wt],
			worktreeRetentionDays: 14,
			lastCommitEpoch: Math.floor((NOW - 30 * DAY) / 1000),
			now: NOW + 30 * DAY, // task settled ~now, so push the clock past both
		});
		settledTask(store, wt.name);

		await reapPass(engine);

		expect(removed).toEqual([wt.name]);
	});

	it("keeps a {repo}.{branch} worktree inside the retention window", async () => {
		const wt = spawned("platform.JUS-2763");
		const { engine, store, removed } = setup({
			worktrees: [PRIMARY, wt],
			worktreeRetentionDays: 14,
			lastCommitEpoch: Math.floor((NOW - 2 * DAY) / 1000),
		});
		settledTask(store, wt.name);

		await reapPass(engine);

		expect(removed).toEqual([]);
	});

	it("never reaps a persistent worktree when retention is unset", async () => {
		const wt = spawned("platform.JUS-2763");
		const { engine, store, removed } = setup({
			worktrees: [PRIMARY, wt],
			worktreeRetentionDays: null,
			lastCommitEpoch: Math.floor((NOW - 900 * DAY) / 1000),
			now: NOW + 900 * DAY,
		});
		settledTask(store, wt.name);

		await reapPass(engine);

		expect(removed).toEqual([]);
	});

	it("never reaps a hand-made worktree outside the {repo}. convention", async () => {
		// platform-dns / platform-hotfix are the operator's own checkouts. Idle,
		// clean, and old is not permission to delete someone's working tree.
		const wt: WorktreeInfo = {
			name: "platform-dns",
			path: "/repo/platform-dns",
			branch: "feature/sourcing-p4-ui",
		};
		const { engine, store, removed } = setup({
			worktrees: [PRIMARY, wt],
			worktreeRetentionDays: 1,
			lastCommitEpoch: Math.floor((NOW - 900 * DAY) / 1000),
			now: NOW + 900 * DAY,
		});
		settledTask(store, wt.name);

		await reapPass(engine);

		expect(removed).toEqual([]);
	});

	it("never reaps a spawned-shape worktree with no task record", async () => {
		const wt = spawned("platform.JUS-9999");
		const { engine, removed } = setup({
			worktrees: [PRIMARY, wt],
			worktreeRetentionDays: 1,
			lastCommitEpoch: Math.floor((NOW - 900 * DAY) / 1000),
			now: NOW + 900 * DAY,
		});

		await reapPass(engine);

		expect(removed).toEqual([]);
	});

	it("never reaps a worktree with uncommitted changes", async () => {
		const wt = spawned("platform.qoo-adhoc-ab12");
		const { engine, store, removed } = setup({
			worktrees: [PRIMARY, wt],
			dirtyPaths: [wt.path],
		});
		settledTask(store, wt.name, { ephemeralWorktree: true });

		await reapPass(engine);

		expect(removed).toEqual([]);
	});

	it("never reaps a worktree whose dirty state is unknown", async () => {
		// git failed, so "clean" was never established. Fail closed: the one
		// thing removal destroys is uncommitted work.
		const wt = spawned("platform.qoo-adhoc-ab12");
		const { engine, store, removed } = setup({
			worktrees: [PRIMARY, wt],
			statusFailPaths: [wt.path],
		});
		settledTask(store, wt.name, { ephemeralWorktree: true });

		await reapPass(engine);

		expect(removed).toEqual([]);
	});

	it("never reaps a worktree whose branch has an open PR", async () => {
		// The branch is still in play: a review comment lands and the tree should
		// be there to answer it.
		const wt = spawned("platform.JUS-2763");
		const { engine, store, removed } = setup({
			worktrees: [PRIMARY, wt],
			worktreeRetentionDays: 1,
			openPrBranches: [wt.branch],
			lastCommitEpoch: Math.floor((NOW - 900 * DAY) / 1000),
			now: NOW + 900 * DAY,
		});
		settledTask(store, wt.name);

		await reapPass(engine);

		expect(removed).toEqual([]);
	});

	it("never reaps a persistent worktree when gh could not report PRs", async () => {
		// gh silence makes every prNumber null, which reads exactly like "no open
		// PR". Refuse to act on that absence rather than reap a live branch.
		const wt = spawned("platform.JUS-2763");
		const { engine, store, removed } = setup({
			worktrees: [PRIMARY, wt],
			worktreeRetentionDays: 1,
			ghUnavailable: true,
			lastCommitEpoch: Math.floor((NOW - 900 * DAY) / 1000),
			now: NOW + 900 * DAY,
		});
		settledTask(store, wt.name);

		await reapPass(engine);

		expect(removed).toEqual([]);
	});

	it("still reaps an ephemeral worktree when gh is unavailable", async () => {
		// Throwaway by construction: a gh-less machine must still clean up.
		const wt = spawned("platform.qoo-adhoc-ab12");
		const { engine, store, removed } = setup({
			worktrees: [PRIMARY, wt],
			ghUnavailable: true,
		});
		settledTask(store, wt.name, { ephemeralWorktree: true });

		await reapPass(engine);

		expect(removed).toEqual([wt.name]);
	});

	it("skips a protected worktree without attempting removal", async () => {
		const wt = spawned("platform.JUS-2763");
		const { engine, store, removed, errors } = setup({
			worktrees: [PRIMARY, wt],
			worktreeRetentionDays: 1,
			protectedWorktrees: ["JUS-2763"],
			lastCommitEpoch: Math.floor((NOW - 900 * DAY) / 1000),
			now: NOW + 900 * DAY,
		});
		settledTask(store, wt.name);

		await reapPass(engine);

		expect(removed).toEqual([]);
		// removeWorktree would also refuse — but reaching it means logging a
		// failure every tick for as long as the worktree lives.
		expect(errors).toEqual([]);
	});

	it("skips a favorited worktree without attempting removal", async () => {
		const wt = spawned("platform.JUS-2763");
		const { engine, store, removed, errors } = setup({
			worktrees: [PRIMARY, wt],
			worktreeRetentionDays: 1,
			favorites: [`platform/${wt.name}`],
			lastCommitEpoch: Math.floor((NOW - 900 * DAY) / 1000),
			now: NOW + 900 * DAY,
		});
		settledTask(store, wt.name);

		await reapPass(engine);

		expect(removed).toEqual([]);
		expect(errors).toEqual([]);
	});
});
