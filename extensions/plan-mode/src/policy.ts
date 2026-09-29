/**
 * Pure plan-mode policy: read-only tool whitelist, bash command filtering,
 * and subagent call restrictions. No pi imports — directly unit-testable.
 */

// Read-only built-in tools. bash stays active but is command-filtered.
export const CORE_READONLY_TOOLS: readonly string[] = ["read", "grep", "find", "ls", "bash"];

// Extensible read-only helper tools. Append future read-only tools (e.g. todo) here.
export const EXTRA_READONLY_TOOLS: readonly string[] = [
	"ask_question",
	"question", // upstream example extension
	"questionnaire", // upstream example extension
];

// subagent is allowed only for read-only exploration (see isAllowedSubagentCall).
export const SUBAGENT_TOOL = "subagent";
export const SUBAGENT_ALLOWED_AGENTS: ReadonlySet<string> = new Set(["explore"]);

export const PLAN_WHITELIST: readonly string[] = [...CORE_READONLY_TOOLS, ...EXTRA_READONLY_TOOLS, SUBAGENT_TOOL];

// Destructive patterns: any hit blocks the command regardless of prefix.
const DESTRUCTIVE_PATTERNS: RegExp[] = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bchgrp\b/i,
	/\bln\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,
	/\bshred\b/i,
	/(^|[^<])>(?!>)/, // output redirection (>, but not >>)
	/>>/, // append redirection
	/\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
	/\byarn\s+(add|remove|install|publish)/i,
	/\bpnpm\s+(add|remove|install|publish)/i,
	/\bpip\s+(install|uninstall)/i,
	/\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
	/\bbrew\s+(install|uninstall|upgrade)/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|switch|restore|clean|worktree|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone|rm|mv)\b/i,
	/\bgit\s+config\b(?!\s+--get)/i, // config write (config --get is read-only)
	/\bsudo\b/i,
	/\bsu\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\breboot\b/i,
	/\bshutdown\b/i,
	/\bsystemctl\s+(start|stop|restart|enable|disable)/i,
	/\bservice\s+\S+\s+(start|stop|restart)/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
	/\bcurl\b[^|]*\s(-o|-O|--output)\b/i, // download to file
	/\bfind\b[^|]*\s(-delete|-exec)\b/i, // find -delete / find -exec rm
];

// Safe commands must match one of these read-only prefixes.
const SAFE_PATTERNS: RegExp[] = [
	/^\s*cat\b/,
	/^\s*head\b/,
	/^\s*tail\b/,
	/^\s*less\b/,
	/^\s*more\b/,
	/^\s*grep\b/,
	/^\s*find\b/,
	/^\s*ls\b/,
	/^\s*pwd\b/,
	/^\s*echo\b/,
	/^\s*printf\b/,
	/^\s*wc\b/,
	/^\s*sort\b/,
	/^\s*uniq\b/,
	/^\s*diff\b/,
	/^\s*file\b/,
	/^\s*stat\b/,
	/^\s*du\b/,
	/^\s*df\b/,
	/^\s*tree\b/,
	/^\s*which\b/,
	/^\s*whereis\b/,
	/^\s*type\b/,
	/^\s*env\b/,
	/^\s*printenv\b/,
	/^\s*uname\b/,
	/^\s*whoami\b/,
	/^\s*id\b/,
	/^\s*date\b/,
	/^\s*cal\b/,
	/^\s*uptime\b/,
	/^\s*ps\b/,
	/^\s*top\b/,
	/^\s*htop\b/,
	/^\s*free\b/,
	/^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)\b/i,
	/^\s*git\s+ls-/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit)\b/i,
	/^\s*yarn\s+(list|info|why|audit)\b/i,
	/^\s*node\s+--version/i,
	/^\s*python\s+--version/i,
	/^\s*curl\s/,
	/^\s*wget\s+-O\s*-\s/,
	/^\s*jq\b/,
	/^\s*sed\s+-n/i,
	/^\s*awk\b/,
	/^\s*rg\b/,
	/^\s*fd\b/,
	/^\s*bat\b/,
	/^\s*eza\b/,
];

// ponytail: heuristic prefix+regex guard, not a sandbox; awk/sed script-internal
// writes and base64|sh style chains are known gaps. Shell-level sandboxing is
// the upgrade path if this ever matters.
export function isSafeCommand(command: string): boolean {
	const isDestructive = DESTRUCTIVE_PATTERNS.some((p) => p.test(command));
	const isSafe = SAFE_PATTERNS.some((p) => p.test(command));
	return !isDestructive && isSafe;
}

interface SubagentCallInput {
	agent?: unknown;
	task?: unknown;
	tasks?: unknown;
	chain?: unknown;
}

/** Allowed: read-only exploration via the explore agent (single mode) or roster discovery. */
export function isAllowedSubagentCall(input: unknown): boolean {
	if (typeof input !== "object" || input === null) return false;
	const call = input as SubagentCallInput;

	const hasTasks = Array.isArray(call.tasks) && call.tasks.length > 0;
	const hasChain = Array.isArray(call.chain) && call.chain.length > 0;
	if (hasTasks || hasChain) return false;

	if (call.agent === "list" && call.task === undefined) return true; // discovery
	return call.agent === "explore" && typeof call.task === "string" && call.task.trim().length > 0;
}
