#!/usr/bin/env bash
# Register the queohoh MCP server with one or more agent CLIs (stdio).
#
# Usage:
#   scripts/mcp-register.sh              # every supported CLI present on PATH
#   scripts/mcp-register.sh claude       # only Claude Code
#   scripts/mcp-register.sh codex grok   # Codex + Grok Build
#   scripts/mcp-register.sh agy          # only Antigravity
#
# Supported agents: claude, codex, grok, agy (Antigravity — keyed by its CLI
# name, since that is what must be on PATH). Missing CLIs are skipped with a
# warning; exit 1 only when none of the requested agents could be registered
# (or when node / the daemon CLI is missing).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="${ROOT}/packages/daemon/dist/cli.js"
NAME="queohoh"
# Stable user-bin shim — never register an ephemeral fnm multishell node path
# (those vanish when the parent shell exits and break Grok/Claude MCP handshakes).
SHIM="${HOME}/.local/bin/queohoh"

if ! command -v node >/dev/null 2>&1; then
	echo "node not found on PATH" >&2
	exit 1
fi

if [ ! -f "$CLI" ]; then
	echo "daemon CLI not built: $CLI" >&2
	echo "run: mise run build   (or pnpm -r build)" >&2
	exit 1
fi

# Install/refresh a PATH-stable launcher that resolves `node` at runtime.
mkdir -p "$(dirname "$SHIM")"
cat >"$SHIM" <<EOF
#!/usr/bin/env bash
set -euo pipefail
CLI="$CLI"
if [ ! -f "\$CLI" ]; then
	echo "queohoh: daemon CLI missing at \$CLI (build with mise run build in the queohoh repo)" >&2
	exit 1
fi
if ! command -v node >/dev/null 2>&1; then
	echo "queohoh: node not found on PATH" >&2
	exit 1
fi
exec node "\$CLI" "\$@"
EOF
chmod +x "$SHIM"
echo "shim: $SHIM → node $CLI"

# Default: all supported agents. Positional args filter to a subset.
if [ "$#" -eq 0 ]; then
	AGENTS=(claude codex grok agy)
else
	AGENTS=("$@")
fi

ok=0
skipped=0
failed=0

register_claude() {
	# Claude's `mcp add` is not an upsert: drop a prior entry so re-runs are
	# idempotent (scope must match the install below).
	claude mcp remove --scope user "$NAME" >/dev/null 2>&1 || true
	claude mcp add --scope user "$NAME" -- "$SHIM" mcp
}

register_codex() {
	# Codex also replaces by name only if we remove first; list/get fail on a
	# broken user config, so remove is best-effort.
	codex mcp remove "$NAME" >/dev/null 2>&1 || true
	codex mcp add "$NAME" -- "$SHIM" mcp
}

register_grok() {
	# Grok's `mcp add` is documented as "add or update" — still remove first so
	# a stale command path is never left behind if update semantics change.
	grok mcp remove --scope user "$NAME" >/dev/null 2>&1 || true
	grok mcp add --scope user "$NAME" -- "$SHIM" mcp
}

register_agy() {
	# Antigravity's `mcp add` is "add or update", and it has NO --scope flag
	# (config is per-user already). `--` is required before the command so the
	# shim path is not parsed as a flag. Remove first for the same
	# stale-path reason as grok.
	agy mcp remove "$NAME" >/dev/null 2>&1 || true
	agy mcp add "$NAME" -- "$SHIM" mcp
}

for agent in "${AGENTS[@]}"; do
	case "$agent" in
	claude | codex | grok | agy) ;;
	*)
		echo "unknown agent: $agent (want claude|codex|grok|agy)" >&2
		failed=$((failed + 1))
		continue
		;;
	esac

	if ! command -v "$agent" >/dev/null 2>&1; then
		echo "skip $agent — not on PATH"
		skipped=$((skipped + 1))
		continue
	fi

	echo "registering $NAME MCP with $agent …"
	if "register_${agent}"; then
		echo "  ok: $agent"
		ok=$((ok + 1))
	else
		echo "  failed: $agent" >&2
		failed=$((failed + 1))
	fi
done

if [ "$ok" -eq 0 ]; then
	echo "registered with 0 agents (skipped=$skipped failed=$failed)" >&2
	exit 1
fi

echo "registered with $ok agent(s) (skipped=$skipped failed=$failed)"
# Partial success (some agents failed) is still exit 0 — the user got at least
# one working registration; the failed line above is the signal.
exit 0
