/**
 * Tests for plan-mode policy: tool whitelist, bash command filtering,
 * and verified third-party tool boundaries.
 * Run: npm test (from packages/plan-mode)
 */

import { describe, expect, it } from "vitest";
import { isAllowedPiLensCall, isPiLensQueryTool, isSafeCommand, isThirdPartySubagentTool, PLAN_WHITELIST } from "../src/policy.ts";

const isPlanAllowedTool = (tool: string) => PLAN_WHITELIST.includes(tool);

describe("isPlanAllowedTool", () => {
	it("allows read-only built-in tools", () => {
		for (const tool of ["read", "grep", "find", "ls", "bash"]) {
			expect(isPlanAllowedTool(tool)).toBe(true);
		}
	});

	it("allows question tools", () => {
		expect(isPlanAllowedTool("ask_question")).toBe(true);
		expect(isPlanAllowedTool("question")).toBe(true);
		expect(isPlanAllowedTool("questionnaire")).toBe(true);
	});

	it("blocks write tools and unknown tools", () => {
		expect(isPlanAllowedTool("write")).toBe(false);
		expect(isPlanAllowedTool("edit")).toBe(false);
		expect(isPlanAllowedTool("apply_patch")).toBe(false);
		expect(isPlanAllowedTool("todo")).toBe(false);
		expect(isPlanAllowedTool("subagent")).toBe(false);
		expect(isPlanAllowedTool("")).toBe(false);
	});
});

describe("isSafeCommand", () => {
	it("allows read-only commands", () => {
		for (const cmd of [
			"cat a.txt",
			"head -5 a.txt",
			"grep -r foo src/",
			"find . -name '*.ts'",
			"ls -la",
			"pwd",
			"echo hello",
			"git status",
			"git log --oneline -3",
			"git diff HEAD",
			"git config --get user.name",
			"npm list",
			"node --version",
			"curl https://example.com/api",
			"rg pattern src/",
		]) {
			expect(isSafeCommand(cmd), cmd).toBe(true);
		}
	});

	it("blocks file-mutating commands", () => {
		for (const cmd of [
			"rm -rf /",
			"rm file.txt",
			"mv a b",
			"cp a b",
			"mkdir dir",
			"touch f",
			"chmod +x f",
			"tee out.txt",
			"echo x > out.txt",
			"echo x >> out.txt",
			"truncate -s 0 f",
		]) {
			expect(isSafeCommand(cmd), cmd).toBe(false);
		}
	});

	it("blocks redirection hidden behind safe prefixes", () => {
		expect(isSafeCommand("cat a.txt > b.txt")).toBe(false);
		expect(isSafeCommand("grep foo src/ >> log")).toBe(false);
	});

	it("blocks package installs and git write operations", () => {
		for (const cmd of [
			"npm install",
			"npm ci",
			"yarn add left-pad",
			"pnpm install",
			"pip install requests",
			"apt-get install curl",
			"brew install wget",
			"git add .",
			"git commit -m x",
			"git push",
			"git stash",
			"git checkout -b feature",
			"git switch main",
			"git restore f.txt",
			"git clean -fd",
			"git worktree add ../x",
			"git config user.name x",
			"git init",
		]) {
			expect(isSafeCommand(cmd), cmd).toBe(false);
		}
	});

	it("blocks system and editor commands", () => {
		for (const cmd of ["sudo rm x", "kill 123", "reboot", "vim file", "nano file", "code ."]) {
			expect(isSafeCommand(cmd), cmd).toBe(false);
		}
	});

	it("blocks download-to-file and destructive find variants", () => {
		expect(isSafeCommand("curl https://example.com -o out.html")).toBe(false);
		expect(isSafeCommand("curl -O https://example.com/f")).toBe(false);
		expect(isSafeCommand("curl --output f https://example.com")).toBe(false);
		expect(isSafeCommand("find . -delete")).toBe(false);
		expect(isSafeCommand("find . -exec rm {} \\;")).toBe(false);
	});
});

describe("third-party tool discovery", () => {
	const sourceInfo = { source: "npm:other-agents", path: "/extensions/other-agents/index.ts" };
	it("discovers agents from current tool metadata, not a legacy tool name", () => {
		expect(isThirdPartySubagentTool({ name: "delegate_research", description: "Delegate tasks to specialized subagents", sourceInfo })).toBe(true);
		expect(isThirdPartySubagentTool({ name: "write", description: "Write files", sourceInfo })).toBe(false);
		expect(isThirdPartySubagentTool({ name: "delegate_research", description: "Delegate tasks to specialized subagents" })).toBe(false);
	});
	it("accepts verified pi-lens query tools only", () => {
		const lens = { source: "npm:pi-lens", path: "/npm/pi-lens/index.js" };
		expect(isPiLensQueryTool({ name: "lens_diagnostics", sourceInfo: lens })).toBe(true);
		expect(isPiLensQueryTool({ name: "lsp_navigation", sourceInfo: lens })).toBe(true);
		expect(isPiLensQueryTool({ name: "lens_diagnostic_mark", sourceInfo: lens })).toBe(false);
		expect(isPiLensQueryTool({ name: "ast_grep_replace", sourceInfo: lens })).toBe(false);
		expect(isPiLensQueryTool({ name: "lsp_navigation", sourceInfo })).toBe(false);
	});
	it("permits LSP queries and blocks mutations or unknown operations", () => {
		for (const operation of ["definition", "references", "codeAction", "workspaceDiagnostics"]) {
			expect(isAllowedPiLensCall("lsp_navigation", { operation })).toBe(true);
		}
		for (const operation of ["rename", "rename_file", "executeCommand", "unknown"]) {
			expect(isAllowedPiLensCall("lsp_navigation", { operation })).toBe(false);
		}
		expect(isAllowedPiLensCall("lsp_navigation", { operation: "codeAction", apply: true })).toBe(false);
		expect(isAllowedPiLensCall("lsp_navigation", {})).toBe(false);
	});
});
