import type { UsageProbe } from "./usage.js";
import { createClaudeUsageProbe } from "./usage-claude.js";
import { createCodexUsageProbe } from "./usage-codex.js";
import { createGrokUsageProbe } from "./usage-grok.js";

/**
 * Resolve a UsageProbe for a known provider id. Unknown names → null.
 * Fresh probe each call (no shared mutable state).
 *
 * antigravity has no probe on purpose: the `agy` CLI exposes no local token or
 * billing file to read (claude/grok probes both work off on-disk credentials),
 * so there is nothing to poll without inventing a network call. It returns null
 * here and simply contributes no usage gauge — which is also why it is a useful
 * fallback provider: nothing in queohoh can pre-emptively mark it exhausted.
 */
export function getUsageProbe(provider: string): UsageProbe | null {
	switch (provider) {
		case "claude":
			return createClaudeUsageProbe();
		case "grok":
			return createGrokUsageProbe();
		case "codex":
			return createCodexUsageProbe();
		default:
			return null;
	}
}
