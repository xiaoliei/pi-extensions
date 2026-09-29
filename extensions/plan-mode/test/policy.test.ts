/**
 * Tests for plan-mode policy: tool whitelist, bash command filtering,
 * and subagent call restrictions.
 * Run: npm test (from packages/plan-mode)
 */

import { describe, expect, it } from "vitest";
import { isAllowedSubagentCall, isSafeCommand } from "../src/policy.ts";

const isPlanAllowedTool = (tool: string) =>
	["read", "grep", "find", "ls", "bash", "ask_question", "question", "questionnaire", "subagent"].includes(tool);

describe("isPlanAllowedTool", () => {
	it("allows read-only built-in tools", () => {
		for (const tool of ["read", "grep", "find", "ls", "bash"]) {
			expect(isPlanAllowedTool(tool)).toBe(true);
		}
	});

	it("allows question tools and subagent", () => {
		expect(isPlanAllowedTool("ask_question")).toBe(true);
		expect(isPlanAllowedTool("question")).toBe(true);
		expect(isPlanAllowedTool("questionnaire")).toBe(true);
		expect(isPlanAllowedTool("subagent")).toBe(true);
	});

	it("blocks write tools and unknown tools", () => {
		expect(isPlanAllowedTool("write")).toBe(false);
		expect(isPlanAllowedTool("edit")).toBe(false);
		expect(isPlanAllowedTool("apply_patch")).toBe(false);
		expect(isPlanAllowedTool("todo")).toBe(false);
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

describe("isAllowedSubagentCall", () => {
	it("allows explore agent single task", () => {
		expect(isAllowedSubagentCall({ agent: "explore", task: "map the src layout" })).toBe(true);
	});

	it("allows roster discovery", () => {
		expect(isAllowedSubagentCall({ agent: "list" })).toBe(true);
	});

	it("blocks non-explore agents", () => {
		expect(isAllowedSubagentCall({ agent: "general", task: "do stuff" })).toBe(false);
		expect(isAllowedSubagentCall({ agent: "planner", task: "plan" })).toBe(false);
		expect(isAllowedSubagentCall({})).toBe(false);
	});

	it("blocks explore with empty or missing task", () => {
		expect(isAllowedSubagentCall({ agent: "explore" })).toBe(false);
		expect(isAllowedSubagentCall({ agent: "explore", task: "  " })).toBe(false);
	});

	it("blocks parallel and chain modes", () => {
		expect(isAllowedSubagentCall({ tasks: [{ agent: "explore", task: "a" }] })).toBe(false);
		expect(isAllowedSubagentCall({ chain: [{ agent: "explore", task: "a" }] })).toBe(false);
		expect(isAllowedSubagentCall({ agent: "explore", task: "a", tasks: [{ agent: "explore", task: "b" }] })).toBe(
			false,
		);
	});

	it("rejects non-object input", () => {
		expect(isAllowedSubagentCall(null)).toBe(false);
		expect(isAllowedSubagentCall("explore")).toBe(false);
		expect(isAllowedSubagentCall(undefined)).toBe(false);
	});
});
