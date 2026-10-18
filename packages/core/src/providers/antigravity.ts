import type {
	BuildArgsInput,
	ParsedEvent,
	ProviderAdapter,
	UnavailableInput,
} from "./types.js";

// Schema live-verified against the `agy` CLI on 2026-09-21 by running real
// print-mode sessions (plain, tool-using, and resumed) and diffing the NDJSON.
// The CLI's own changelog calls stream-json "a strongly-typed NDJSON event
// stream that emits typed `init`, `step_update`, and terminal `result` events
// with a stable, closed-vocabulary `step_type` discriminator", and the observed
// vocabulary was exactly: `init` / `step_update` / `result`, with step_type in
// {user_input, agent_response, tool, system_message} and state in
// {ACTIVE, DONE, ERROR}.
//
// Unlike grok, antigravity emits BOTH token-level `text_delta`s AND a terminal
// full-text `response`. This adapter streams the deltas (so the TUI live tail
// isn't empty for an hour-long run) but takes the final text from `response`,
// which is authoritative.

/** Matches quota/auth failures from the antigravity CLI — these mean the
 * provider is temporarily or structurally unusable, not that the run failed on
 * its merits. `RESOURCE_EXHAUSTED` is the Google-API-shaped quota status this
 * CLI sits behind; the rest mirror the grok/codex patterns. The exact
 * user-facing wording is NOT verified against a live quota failure (the
 * account had budget when this was written), so this stays permissive: a false
 * negative just falls back to the generic `exit code N` reason, never a crash. */
// Headless agy reports "authentication required" when cached login is absent.
// Classify it so the worker advances the user's provider chain.
const UNAVAILABLE_RE =
	/\b401\b|\b402\b|\b403\b|\b429\b|payment required|balance exhausted|usage balance|insufficient (?:credit|balance|funds)|out of credits?|resource.?exhausted|unauthorized|unauthenticated|authentication required|not logged in|invalid api key|rate limit|quota|too many requests/i;

/** Cap on a rendered tool-parameter blob, matching the 500-char slice the
 * claude event formatter applies — a `write_to_file` call carries the whole
 * file body in its parameters and would otherwise drown the transcript. */
const TOOL_PARAM_LIMIT = 500;

/** Safety margin added to queohoh's own `timeoutMs` when setting the CLI's
 * `--print-timeout`.
 *
 * Why a margin rather than the exact value: `agy`'s print mode defaults to a
 * 5-MINUTE timeout, which would silently truncate every real task (pr-hygiene
 * runs at `timeout: 2h`), so passing it is mandatory. But queohoh's runner
 * already owns two reapers (the idle window and the `timeoutMs` ceiling) whose
 * kill path produces the canonical `timed out` outcome the TUI matches
 * verbatim. Giving the CLI a slightly LATER deadline keeps queohoh's reaper the
 * one that fires, so a timeout still settles as `timed out` rather than as an
 * opaque CLI-side truncation. */
const PRINT_TIMEOUT_MARGIN_MS = 60_000;

/** Render one `step_update` tool event as a transcript fragment.
 *
 * Emitted through `textDelta` rather than `transcriptMd` ON PURPOSE: the runner
 * writes `transcriptMd` straight to disk but buffers deltas until a line is
 * complete, so mixing the two would let a tool heading jump AHEAD of the
 * half-written sentence that preceded it. Routing everything through the delta
 * buffer keeps the transcript in true stream order. Heading style matches the
 * claude formatter's `### Tool: <name>` so both providers' transcripts read the
 * same in the TUI. */
function renderToolStep(step: Record<string, unknown>): string | null {
	const state = step.state as string | undefined;
	// ACTIVE is the call being issued (parameters known) and ERROR is a failure
	// worth seeing. DONE is skipped: it repeats the same parameters and adds an
	// `output` that is frequently a whole file — the claude formatter likewise
	// renders tool *calls*, never tool results.
	if (state !== "ACTIVE" && state !== "ERROR") return null;
	const name = (step.tool_name as string | undefined) ?? "unknown";
	const info = step.tool_info as Record<string, unknown> | undefined;
	const params = info?.parameters;
	const heading =
		state === "ERROR" ? `### Tool: ${name} (error)` : `### Tool: ${name}`;
	const parts = ["", "", heading];
	if (params !== undefined) {
		parts.push("```json");
		parts.push(JSON.stringify(params, null, 2).slice(0, TOOL_PARAM_LIMIT));
		parts.push("```");
	}
	parts.push("");
	return parts.join("\n");
}

export const antigravityAdapter: ProviderAdapter = {
	name: "antigravity",
	defaultBin: "agy",
	supportsResume: true,
	// The CLI takes the prompt inline via `-p`; it has no --prompt-file form.
	promptFileSuffix: null,
	buildArgs({
		prompt,
		model,
		cwd,
		timeoutMs,
		resumeSessionId,
		systemPrompt,
		extraArgs,
		mode,
	}: BuildArgsInput): string[] {
		// No --append-system-prompt / --rules equivalent exists on this CLI, so a
		// configured provider `system_prompt:` is prepended to the prompt body.
		// Kept explicit (a labelled block, not a silent concat) so a run's
		// transcript still shows where the operator's standing instructions end
		// and the task prompt begins.
		const body = systemPrompt ? `${systemPrompt}\n\n---\n\n${prompt}` : prompt;
		// Agent-mode queohoh runs are autonomous and headless — with the default
		// `request-review` permission mode the agent blocks on an approval nobody
		// can give. Discuss turns are read-only review, so they keep the prompting
		// default (mirrors grok's --always-approve split).
		const approve =
			mode === "discuss" ? [] : ["--dangerously-skip-permissions"];
		return [
			"-p",
			body,
			"--output-format",
			"stream-json",
			"--model",
			model,
			// LOAD-BEARING: without --add-dir the agent ignores the process cwd and
			// runs its tools in the CLI's own scratch project
			// (~/.gemini/antigravity-cli/scratch) — verified by a run whose
			// `run_command` pwd came back as the scratch dir, not the worktree. Every
			// queohoh task is worktree-scoped, so this is what makes the run operate
			// on the right tree at all.
			"--add-dir",
			cwd,
			// See PRINT_TIMEOUT_MARGIN_MS — the 5m default would truncate real tasks.
			"--print-timeout",
			`${Math.ceil((timeoutMs + PRINT_TIMEOUT_MARGIN_MS) / 1000)}s`,
			// Task prompts are authored files, not chat input: a prompt whose line
			// happens to start with `/` must reach the model verbatim rather than be
			// expanded as a slash command or skill.
			"--disable-slash-commands",
			...approve,
			// Resumes in place (same conversation id comes back on the init event),
			// so finalizeRun's recordFork no-ops — same shape as grok's --resume.
			...(resumeSessionId ? ["--conversation", resumeSessionId] : []),
			...(extraArgs ?? []),
		];
	},
	parseEvent(event: Record<string, unknown>): ParsedEvent {
		const out: ParsedEvent = {};
		const type = event.event as string | undefined;

		// The session id rides on the top-level `init` event (and is echoed on
		// every step_update; first one wins in the runner either way).
		if (type === "init" && typeof event.conversation_id === "string") {
			out.sessionId = event.conversation_id;
		}

		if (type === "step_update") {
			const step = event.step_update as Record<string, unknown> | undefined;
			if (step) {
				const stepType = step.step_type as string | undefined;
				if (stepType === "agent_response") {
					// text_delta is a true delta on BOTH the ACTIVE and DONE states —
					// the DONE event carries the last fragment, not the full text — so
					// every occurrence is appended.
					if (typeof step.text_delta === "string" && step.text_delta) {
						out.textDelta = step.text_delta;
					}
				} else if (stepType === "tool") {
					const rendered = renderToolStep(step);
					if (rendered) out.textDelta = rendered;
				}
				// user_input / system_message carry no payload worth transcribing.
			}
		}

		if (type === "result") {
			const result = event.result as Record<string, unknown> | undefined;
			const usage = result?.usage as Record<string, unknown> | undefined;
			// `response` is the authoritative full text, so unlike grok this adapter
			// does NOT lean on the runner's delta accumulator for the result — which
			// matters here because the accumulator also holds the rendered tool
			// headings. No cost field is exposed by this CLI (costUsd stays null,
			// best-effort per the ParsedEvent contract); duration is seconds-as-float.
			const seconds = result?.duration_seconds;
			out.result = {
				text: typeof result?.response === "string" ? result.response : "",
				costUsd: null,
				turns: typeof result?.num_turns === "number" ? result.num_turns : null,
				durationMs:
					typeof seconds === "number" ? Math.round(seconds * 1000) : null,
				inputTokens:
					typeof usage?.input_tokens === "number" ? usage.input_tokens : null,
				outputTokens:
					typeof usage?.output_tokens === "number" ? usage.output_tokens : null,
			};
		}

		return out;
	},
	classifyUnavailable({ stderr, resultText }: UnavailableInput): string | null {
		if (UNAVAILABLE_RE.test(stderr) || UNAVAILABLE_RE.test(resultText)) {
			return "provider unavailable";
		}
		return null;
	},
};
