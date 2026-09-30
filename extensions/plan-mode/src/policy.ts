/**
 * Pure plan-mode policy. No pi imports — directly unit-testable.
 */

// Read-only built-in tools. bash stays active but is command-filtered.
export const CORE_READONLY_TOOLS: readonly string[] = ["read", "grep", "find", "ls", "bash"];

// Extensible read-only helper tools. Append future read-only tools (e.g. todo) here.
export const EXTRA_READONLY_TOOLS: readonly string[] = [
	"ask_question",
	"question", // upstream example extension
	"questionnaire", // upstream example extension
];

export const PLAN_WHITELIST: readonly string[] = [...CORE_READONLY_TOOLS, ...EXTRA_READONLY_TOOLS];

// These pi-lens tools have been reviewed against the installed 4.3.0 tool contract.
const PI_LENS_QUERY_TOOLS = new Set([
	"pi_lens_activate_tools",
	"lens_diagnostics",
	"lsp_navigation",
	"symbol_search",
	"module_report",
	"read_symbol",
	"read_enclosing",
	"project_report",
	"ast_grep_search",
	"ast_grep_outline",
]);

const LSP_QUERY_OPERATIONS = new Set([
	"definition", "typeDefinition", "declaration", "references", "hover", "signatureHelp",
	"documentSymbol", "findSymbol", "workspaceSymbol", "codeAction", "implementation",
	"prepareCallHierarchy", "incomingCalls", "outgoingCalls", "workspaceDiagnostics", "capabilities",
]);

export interface AvailableTool {
	name: string;
	description?: string;
	sourceInfo?: { path: string; source: string };
}

export function toolExtensionKey(tool: AvailableTool): string {
	return tool.sourceInfo?.source || tool.sourceInfo?.path || tool.name;
}

export function isLikelyReadOnlyTool(tool: AvailableTool): boolean {
	if (PLAN_WHITELIST.includes(tool.name) || isPiLensQueryTool(tool)) return true;
	const text = `${tool.name} ${tool.description ?? ""}`;
	return /(?:read|list|search|find|grep|inspect|explor|diagnos|navigat|symbol|report|query|lookup|discover|hover|definition|reference)/i.test(text)
		&& !/(?:write|edit|replace|rename|delete|remove|apply|execute|command|create|update|mark|suppress|fix)/i.test(text);
}

export function isReadOnlySubagentRequest(input: unknown): boolean {
	if (typeof input !== "object" || input === null) return false;
	const values = Object.values(input as Record<string, unknown>).filter((value): value is string => typeof value === "string");
	return /(?:read[- ]?only|explor|inspect|research|navigation|diagnos|no changes|do not (?:edit|write|modify))/i.test(values.join(" "));
}

export function isPiLensQueryTool(tool: AvailableTool): boolean {
	const source = `${tool.sourceInfo?.source ?? ""} ${tool.sourceInfo?.path ?? ""}`;
	return PI_LENS_QUERY_TOOLS.has(tool.name) && /(?:^|[\\/\s:@])pi-lens(?:[\\/\s@]|$)/i.test(source);
}

export function isThirdPartySubagentTool(tool: AvailableTool): boolean {
	if (!tool.sourceInfo?.path || !tool.sourceInfo.source) return false;
	const text = `${tool.name} ${tool.description ?? ""}`;
	const source = `${tool.sourceInfo.source} ${tool.sourceInfo.path}`;
	// Tool names and input schemas are extension-defined. Classify from the
	// advertised capability and source metadata instead of a fixed field list.
	const mentionsSubagent = /sub[ -]?agent|agent orchestrat|agent delegation|agent runner|agent manager/i.test(`${text} ${source}`);
	const mentionsDelegation = /delegat|(?:spawn|launch|dispatch).{0,40}(?:agent|task|worker|research|explor)|(?:agent|task|worker|research|explor).{0,40}(?:spawn|launch|dispatch)|parallel.{0,30}(?:task|research|agent)|background.{0,30}(?:task|agent)/i.test(text);
	const mentionsResearchAgent = /(?:explor|research|worker).{0,60}agent|agent.{0,60}(?:explor|research|worker)/i.test(text);
	return mentionsSubagent || mentionsDelegation || mentionsResearchAgent;
}

export function isAllowedPiLensCall(name: string, input: unknown): boolean {
	if (name === "pi_lens_activate_tools") {
		if (typeof input !== "object" || input === null) return false;
		const tools = (input as { tools?: unknown }).tools;
		return Array.isArray(tools) && tools.length > 0 && tools.every(
			(tool) => tool === "lsp_navigation" || tool === "ast_grep_search" || tool === "ast_grep_outline",
		);
	}
	if (name !== "lsp_navigation") return true;
	if (typeof input !== "object" || input === null) return false;
	const { operation, apply } = input as { operation?: unknown; apply?: unknown };
	return typeof operation === "string" && LSP_QUERY_OPERATIONS.has(operation) && apply !== true;
}

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
