import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverItems } from "../discovery.js";
import { defaultExec } from "../resolver-io.js";

function killOwnedPid(pid: number) {
	try {
		process.kill(pid, "SIGKILL");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
	}
}

describe.each([
	false,
	true,
])("discovery timeout with grandchild=%s", (grandchild) => {
	it("bounds the command and kills descendants ignoring SIGTERM", async () => {
		const dir = mkdtempSync(join(tmpdir(), "qoo-pr8-timeout-"));
		const shellPidFile = join(dir, "shell-pid");
		const pidFile = join(dir, "pid");
		const fixture = join(dir, "child.mjs");
		// Exercise both an exec-replaced shell and a bash→node descendant.
		// Self-exit is a second cleanup bound if the test runner itself dies.
		writeFileSync(
			fixture,
			`import { writeFileSync } from 'node:fs';\nprocess.on('SIGTERM', () => {});\nwriteFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetTimeout(() => process.exit(0), 8000);\n`,
		);
		let settled = false;
		const command = grandchild
			? `echo $$ > ${JSON.stringify(shellPidFile)}; trap '' TERM; ${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)} & wait`
			: `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)}`;
		const run = discoverItems(command, defaultExec, {
			cwd: dir,
			timeoutMs: 1000,
		}).then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		let settledWithinBound = false;
		let childAlive = false;
		try {
			await new Promise((resolve) => setTimeout(resolve, 2500));
			settledWithinBound = settled;
			try {
				process.kill(Number(readFileSync(pidFile, "utf8")), 0);
				childAlive = true;
			} catch {}
		} finally {
			for (const file of grandchild ? [shellPidFile, pidFile] : [pidFile]) {
				const pid = Number(readFileSync(file, "utf8"));
				killOwnedPid(pid);
			}
			await run;
			rmSync(dir, { recursive: true, force: true });
		}
		expect(settledWithinBound).toBe(true);
		expect(childAlive).toBe(false);
	}, 10000);
});

it.each([
	undefined,
	2000,
])("preserves stdout and exit codes with deadline %s", async (timeoutMs) => {
	const result = await defaultExec(
		process.execPath,
		[
			"-e",
			"process.stdout.write('héllo'); process.stderr.write('detail'); process.exitCode = 7",
		],
		{ cwd: tmpdir(), timeoutMs },
	);
	expect(result).toEqual({ stdout: "héllo", stderr: "detail", exitCode: 7 });
});

it("reports spawn failures without leaving a deadline timer", async () => {
	const result = await defaultExec("/no-such-qoo-test-executable", [], {
		cwd: tmpdir(),
		timeoutMs: 1000,
	});
	expect(result.exitCode).toBe(1);
	expect(result.stderr).toContain("ENOENT");
});

it("rejects oversized discovery output instead of parsing truncated JSON", async () => {
	const result = await defaultExec(
		process.execPath,
		["-e", "process.stdout.write(' '.repeat(1024 * 1024 + 1) + '[]')"],
		{ cwd: tmpdir(), timeoutMs: 2000 },
	);
	expect(result.exitCode).toBe(1);
});
