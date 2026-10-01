/**
 * Load test: the extension factory runs against a stub ExtensionAPI and
 * registers everything without throwing. Catches runtime issues that
 * type-checking alone misses (import resolution via @mariozechner aliases).
 * Also covers the proposed_plan dialog flow (execute / refine).
 * Run: npm test (from packages/plan-mode)
 */

import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import planModeExtension from "../src/index.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

const PLAN_BLOCK = "<proposed_plan>\n# 标题\n计划内容\n</proposed_plan>";

function assistantMsg(text: string) {
	return { role: "assistant", content: [{ type: "text", text }] };
}

const AGENT_TOOL = { name: "delegate_research", description: "Delegate tasks to specialized subagents", sourceInfo: { source: "npm:agent-tool", path: "/agent-tool/index.ts" } };
const TODO_SOURCE = { source: "npm:task-tracker", path: "/task-tracker/index.ts" };
const TODO_READ = { name: "queue_view", description: "List Todo tasks and their status", sourceInfo: TODO_SOURCE };
const TODO_GET = { name: "queue_detail", description: "Get complete details for one Todo task", sourceInfo: TODO_SOURCE };
const TODO_WRITE = { name: "queue_record", description: "Create and update Todo tasks", sourceInfo: TODO_SOURCE };
const LENS_SOURCE = { source: "npm:pi-lens", path: "/pi-lens/index.js" };

function makeStubPi(tools: Array<{ name: string; description?: string; sourceInfo?: { source: string; path: string } }> = []) {
	const commandHandlers = new Map<string, (args: unknown, ctx: unknown) => void | Promise<void>>();
	const events = new Map<string, Handler>();
	const calls: { setActiveTools?: string[]; sendUserMessage?: [string, unknown] }[] = [];
	return {
		commandHandlers,
		events,
		calls,
		registerCommand: (name: string, def: { handler: () => void }) => void commandHandlers.set(name, def.handler),
		registerFlag: () => {},
		registerShortcut: () => {},
		on: (event: string, handler: Handler) => void events.set(event, handler),
		getActiveTools: () => ["read", "edit", "write", "bash"],
		setActiveTools: (tools: string[]) => void calls.push({ setActiveTools: tools }),
		getAllTools: () => [{ name: "read" }, { name: "bash" }, ...tools],
		getFlag: () => false,
		appendEntry: () => {},
		sendUserMessage: (content: string, options?: unknown) => void calls.push({ sendUserMessage: [content, options] }),
	};
}

function makeStubCtx(selectResult?: string) {
	const status: [string, string][] = [];
	const selects: string[][] = [];
	const editorTexts: string[] = [];
	return {
		ui: {
			setStatus: (id: string, text: string) => void status.push([id, text]),
			setEditorText: (text: string) => void editorTexts.push(text),
			notify: () => {},
			select: async (_title: string, options: string[]) => {
				selects.push(options);
				return selectResult;
			},
		},
		status,
		selects,
		editorTexts,
		mode: "tui" as const,
		hasUI: true,
		hasPendingMessages: () => false,
		sessionManager: { getEntries: () => [] },
	};
}

const runCommand = (pi: ReturnType<typeof makeStubPi>, name: string, ctx: unknown, args = "") =>
	pi.commandHandlers.get(name)?.(args, ctx);

function install(pi: ReturnType<typeof makeStubPi>, filePath = join(tmpdir(), `plan-mode-test-${randomUUID()}.json`)) {
	planModeExtension(pi as never, filePath);
	return filePath;
}

describe("plan-mode extension factory", () => {
	it("registers command, flag, shortcut, and event handlers", () => {
		const pi = makeStubPi();
		expect(() => install(pi)).not.toThrow();
		expect([...pi.commandHandlers.keys()]).toEqual(["plan"]);
		for (const event of ["tool_call", "before_agent_start", "context", "session_start", "agent_end"]) {
			expect(pi.events.has(event), event).toBe(true);
		}
	});

	it("/plan toggles the whitelist and tool_call guard", async () => {
		const pi = makeStubPi();
		install(pi);
		const ctx = makeStubCtx();
		const toolCallHandler = pi.events.get("tool_call");
		if (!toolCallHandler) throw new Error("tool_call handler missing");

		// Off by default: writes pass
		expect(await toolCallHandler({ toolName: "write", input: {} }, ctx)).toBeUndefined();

		// Enter plan mode
		await runCommand(pi, "plan", ctx);
		expect(pi.calls.at(-1)?.setActiveTools).toContain("read");
		expect(pi.calls.at(-1)?.setActiveTools).not.toContain("write");
		expect(ctx.status.at(-1)).toEqual(["plan-mode", "plan mode"]);

		// Write tool blocked, read allowed, unsafe bash blocked, safe bash allowed
		const blocked = (await toolCallHandler({ toolName: "write", input: {} }, ctx)) as {
			block: boolean;
			reason: string;
		};
		expect(blocked?.block).toBe(true);
		expect(await toolCallHandler({ toolName: "read", input: { path: "x" } }, ctx)).toBeUndefined();
		const blockedBash = (await toolCallHandler({ toolName: "bash", input: { command: "rm -rf /" } }, ctx)) as {
			block: boolean;
		};
		expect(blockedBash?.block).toBe(true);
		expect(await toolCallHandler({ toolName: "bash", input: { command: "ls -la" } }, ctx)).toBeUndefined();

		// Exit plan mode: writes pass again
		await runCommand(pi, "plan", ctx);
		expect(await toolCallHandler({ toolName: "write", input: {} }, ctx)).toBeUndefined();
	});

	it("/plan with a task enables planning and starts a turn without toggling it off", async () => {
		const pi = makeStubPi();
		install(pi);
		const ctx = makeStubCtx();
		await runCommand(pi, "plan", ctx, "  inspect auth  ");
		expect(ctx.status.at(-1)).toEqual(["plan-mode", "plan mode"]);
		expect(pi.calls.at(-1)?.sendUserMessage?.[0]).toBe("inspect auth");
		await runCommand(pi, "plan", ctx, "inspect routing");
		expect(ctx.status.at(-1)).toEqual(["plan-mode", "plan mode"]);
		expect(pi.calls.at(-1)?.sendUserMessage?.[0]).toBe("inspect routing");
		await runCommand(pi, "plan", ctx, "   ");
		expect(ctx.status.at(-1)).toEqual(["plan-mode", undefined]);
	});

	it("restores the planning command in the editor if sending fails", async () => {
		const pi = makeStubPi();
		pi.sendUserMessage = () => { throw new Error("send failed"); };
		install(pi);
		const ctx = makeStubCtx();
		await expect(runCommand(pi, "plan", ctx, "inspect auth")).rejects.toThrow("send failed");
		expect(ctx.editorTexts).toEqual(["/plan inspect auth"]);
		expect(ctx.status.at(-1)).toEqual(["plan-mode", "plan mode"]);
	});

	it("discovers read-only pi-lens tools and blocks writes", async () => {
		const pi = makeStubPi([
			{ name: "lsp_navigation", sourceInfo: LENS_SOURCE },
			{ name: "lens_diagnostics", sourceInfo: LENS_SOURCE },
			{ name: "module_report", sourceInfo: LENS_SOURCE },
			{ name: "ast_grep_replace", sourceInfo: LENS_SOURCE },
			{ name: "lens_diagnostic_mark", sourceInfo: LENS_SOURCE },
		]);
		install(pi);
		const ctx = makeStubCtx();
		await runCommand(pi, "plan", ctx);
		const active = pi.calls.at(-1)?.setActiveTools ?? [];
		expect(active).toContain("lsp_navigation");
		expect(active).toContain("lens_diagnostics");
		expect(active).toContain("module_report");
		expect(active).not.toContain("ast_grep_replace");
		const call = pi.events.get("tool_call")!;
		expect(await call({ toolName: "lsp_navigation", input: { operation: "references" } }, ctx)).toBeUndefined();
		expect((await call({ toolName: "lsp_navigation", input: { operation: "rename" } }, ctx) as { block: boolean }).block).toBe(true);
		expect((await call({ toolName: "lsp_navigation", input: { operation: "codeAction", apply: true } }, ctx) as { block: boolean }).block).toBe(true);
		expect((await call({ toolName: "ast_grep_replace", input: {} }, ctx) as { block: boolean }).block).toBe(true);
		expect((await call({ toolName: "lens_diagnostic_mark", input: {} }, ctx) as { block: boolean }).block).toBe(true);
	});

	it("requires consent for a discovered subagent and remembers the exact source globally", async () => {
		const filePath = join(tmpdir(), `plan-mode-trust-${randomUUID()}.json`);
		try {
			const pi = makeStubPi([AGENT_TOOL]);
			install(pi, filePath);
			const ctx = makeStubCtx("全局同意该扩展的所有只读工具调用");
			await runCommand(pi, "plan", ctx);
			expect(pi.calls.at(-1)?.setActiveTools).toContain(AGENT_TOOL.name);
			const call = pi.events.get("tool_call")!;
			expect(await call({ toolName: AGENT_TOOL.name, input: { mode: "general", prompt: "read only" } }, ctx)).toBeUndefined();
			expect(ctx.selects).toHaveLength(1);
			expect(ctx.selects[0]).toEqual(["仅本次允许", "全局同意该扩展的所有只读工具调用", "全局同意该扩展的所有工具调用（包括写入工具）", "拒绝"]);
			const anotherPi = makeStubPi([AGENT_TOOL]);
			install(anotherPi, filePath);
			await runCommand(anotherPi, "plan", ctx);
			expect(await anotherPi.events.get("tool_call")!({ toolName: AGENT_TOOL.name, input: { prompt: "read-only exploration; no changes" } }, ctx)).toBeUndefined();
			expect(ctx.selects).toHaveLength(1);
			const changed = { ...AGENT_TOOL, sourceInfo: { ...AGENT_TOOL.sourceInfo, path: "/new-source/index.ts" } };
			const changedPi = makeStubPi([changed]);
			install(changedPi, filePath);
			await runCommand(changedPi, "plan", ctx);
			const noUi = { ...ctx, hasUI: false };
			expect((await changedPi.events.get("tool_call")!({ toolName: changed.name, input: {} }, noUi) as { block: boolean }).block).toBe(true);
		} finally {
			await rm(filePath, { force: true });
		}
	});

	it("can globally trust every tool from an extension, including write tools", async () => {
		const writeTool = { name: "agent_write", description: "Write files for delegated tasks", sourceInfo: AGENT_TOOL.sourceInfo };
		const pi = makeStubPi([AGENT_TOOL, writeTool]);
		const filePath = join(tmpdir(), `plan-mode-all-${randomUUID()}.json`);
		try {
			install(pi, filePath);
			const ctx = makeStubCtx("全局同意该扩展的所有工具调用（包括写入工具）");
			await runCommand(pi, "plan", ctx);
			const call = pi.events.get("tool_call")!;
			expect(await call({ toolName: AGENT_TOOL.name, input: { prompt: "read only" } }, ctx)).toBeUndefined();
			expect(pi.calls.at(-1)?.setActiveTools).toContain(writeTool.name);
			expect(await call({ toolName: writeTool.name, input: { path: "x" } }, ctx)).toBeUndefined();
		} finally {
			await rm(filePath, { force: true });
		}
	});

	it("one-time approval does not persist and denial blocks the call", async () => {
		const pi = makeStubPi([AGENT_TOOL]);
		install(pi);
		const allowed = makeStubCtx("仅本次允许");
		await runCommand(pi, "plan", allowed);
		const call = pi.events.get("tool_call")!;
		expect(await call({ toolName: AGENT_TOOL.name, input: {} }, allowed)).toBeUndefined();
		const denied = makeStubCtx("拒绝");
		expect((await call({ toolName: AGENT_TOOL.name, input: {} }, denied) as { block: boolean }).block).toBe(true);
	});
	it("discovers Todo tools and requests consent before the first call", async () => {
		const pi = makeStubPi([TODO_READ, TODO_WRITE]);
		install(pi);
		const allowed = makeStubCtx("仅本次允许");
		await runCommand(pi, "plan", allowed);
		expect(pi.calls.at(-1)?.setActiveTools).toContain(TODO_READ.name);
		expect(pi.calls.at(-1)?.setActiveTools).toContain(TODO_WRITE.name);
		const call = pi.events.get("tool_call")!;
		expect(await call({ toolName: TODO_READ.name, input: {} }, allowed)).toBeUndefined();
		expect(allowed.selects).toHaveLength(1);
		const denied = makeStubCtx("拒绝");
		expect((await call({ toolName: TODO_WRITE.name, input: {} }, denied) as { block: boolean }).block).toBe(true);
		expect((await call({ toolName: TODO_READ.name, input: {} }, { ...allowed, hasUI: false }) as { block: boolean }).block).toBe(true);
	});

	it("Todo read-only trust excludes writes and source changes require approval", async () => {
		const filePath = join(tmpdir(), `plan-mode-todo-${randomUUID()}.json`);
		try {
			const pi = makeStubPi([TODO_READ, TODO_GET, TODO_WRITE]);
			install(pi, filePath);
			const ctx = makeStubCtx("全局同意该扩展的所有只读工具调用");
			await runCommand(pi, "plan", ctx);
			const call = pi.events.get("tool_call")!;
			expect(await call({ toolName: TODO_READ.name, input: {} }, ctx)).toBeUndefined();
			expect(await call({ toolName: TODO_GET.name, input: {} }, { ...ctx, hasUI: false })).toBeUndefined();
			expect((await call({ toolName: TODO_WRITE.name, input: {} }, { ...ctx, hasUI: false }) as { block: boolean }).block).toBe(true);
			const changed = { ...TODO_READ, sourceInfo: { ...TODO_SOURCE, path: "/new-task-tracker/index.ts" } };
			const changedPi = makeStubPi([changed]);
			install(changedPi, filePath);
			await runCommand(changedPi, "plan", ctx);
			expect((await changedPi.events.get("tool_call")!({ toolName: changed.name, input: {} }, { ...ctx, hasUI: false }) as { block: boolean }).block).toBe(true);
		} finally {
			await rm(filePath, { force: true });
		}
	});

	it("Todo all-tools trust permits persistent updates", async () => {
		const filePath = join(tmpdir(), `plan-mode-todo-all-${randomUUID()}.json`);
		try {
			const pi = makeStubPi([TODO_READ, TODO_WRITE]);
			install(pi, filePath);
			const ctx = makeStubCtx("全局同意该扩展的所有工具调用（包括写入工具）");
			await runCommand(pi, "plan", ctx);
			const call = pi.events.get("tool_call")!;
			expect(await call({ toolName: TODO_WRITE.name, input: {} }, ctx)).toBeUndefined();
			expect(await call({ toolName: TODO_READ.name, input: {} }, { ...ctx, hasUI: false })).toBeUndefined();
		} finally {
			await rm(filePath, { force: true });
		}
	});

	it("concurrent calls each require consent after a one-time approval", async () => {
		const pi = makeStubPi([AGENT_TOOL]);
		install(pi);
		const choices = ["仅本次允许", "拒绝"];
		const ctx = makeStubCtx();
		ctx.ui.select = async (_title: string, options: string[]) => {
			ctx.selects.push(options);
			return choices.shift();
		};
		await runCommand(pi, "plan", ctx);
		const call = pi.events.get("tool_call")!;
		const results = await Promise.all([
			call({ toolName: AGENT_TOOL.name, input: { mode: "explore" } }, ctx),
			call({ toolName: AGENT_TOOL.name, input: { mode: "explore" } }, ctx),
		]);
		expect(results.filter((result) => result === undefined)).toHaveLength(1);
		expect(results.filter((result) => (result as { block?: boolean } | undefined)?.block)).toHaveLength(1);
		expect(ctx.selects).toHaveLength(2);
	});
});

describe("proposed_plan dialog flow", () => {
	const getAgentEnd = (pi: ReturnType<typeof makeStubPi>) => {
		const h = pi.events.get("agent_end");
		if (!h) throw new Error("agent_end handler missing");
		return h;
	};

	it("selecting execute exits plan mode and sends the execute message", async () => {
		const pi = makeStubPi();
		install(pi);
		const ctx = makeStubCtx("是，实施此计划");
		await runCommand(pi, "plan", ctx); // enter

		await getAgentEnd(pi)({ messages: [assistantMsg(`前言\n${PLAN_BLOCK}`)] }, ctx);

		expect(ctx.selects).toHaveLength(1);
		expect(ctx.selects[0]).toEqual(["是，实施此计划", "否，告诉 PI 应该如何做的不同"]);
		// tools restored (write back in the active set) + execution message sent
		expect(pi.calls.some((c) => c.setActiveTools?.includes("write"))).toBe(true);
		expect(pi.calls.at(-1)?.sendUserMessage?.[0]).toContain("proposed_plan");
		expect(pi.calls.at(-1)?.sendUserMessage?.[0]).toContain("Todo tools");
		expect(pi.calls.at(-1)?.sendUserMessage?.[0]).toContain("subagents");
		expect(pi.calls.at(-1)?.sendUserMessage?.[0]).not.toContain("计划内容");
		expect(ctx.status.at(-1)).toEqual(["plan-mode", undefined]); // status cleared
	});

	it("selecting refine changes nothing", async () => {
		const pi = makeStubPi();
		install(pi);
		const ctx = makeStubCtx("否，告诉 PI 应该如何做的不同");
		await runCommand(pi, "plan", ctx);

		await getAgentEnd(pi)({ messages: [assistantMsg(PLAN_BLOCK)] }, ctx);

		expect(ctx.selects).toHaveLength(1);
		expect(pi.calls.some((c) => c.sendUserMessage)).toBe(false);
		expect(pi.calls.some((c) => c.setActiveTools?.includes("write"))).toBe(false);
		expect(ctx.status.at(-1)).toEqual(["plan-mode", "plan mode"]); // still on
	});

	it("does not prompt without a complete plan block", async () => {
		const pi = makeStubPi();
		install(pi);
		const ctx = makeStubCtx("是，实施此计划");
		await runCommand(pi, "plan", ctx);

		await getAgentEnd(pi)({ messages: [assistantMsg("<proposed_plan>\n未闭合")] }, ctx);

		expect(ctx.selects).toHaveLength(0);
		expect(pi.calls.some((c) => c.sendUserMessage)).toBe(false);
	});

	it("skips the dialog when UI is unavailable", async () => {
		const pi = makeStubPi();
		install(pi);
		const ctx = { ...makeStubCtx("是，实施此计划"), mode: "rpc" as const, hasUI: false };
		await runCommand(pi, "plan", ctx);

		await getAgentEnd(pi)({ messages: [assistantMsg(PLAN_BLOCK)] }, ctx);

		expect(ctx.selects).toHaveLength(0);
		expect(pi.calls.some((c) => c.sendUserMessage)).toBe(false);
	});

	it("skips the dialog when the user already queued input", async () => {
		const pi = makeStubPi();
		install(pi);
		const ctx = { ...makeStubCtx("是，实施此计划"), hasPendingMessages: () => true };
		await runCommand(pi, "plan", ctx);

		await getAgentEnd(pi)({ messages: [assistantMsg(PLAN_BLOCK)] }, ctx);

		expect(ctx.selects).toHaveLength(0);
	});

	it("does not prompt when plan mode is off", async () => {
		const pi = makeStubPi();
		install(pi);
		const ctx = makeStubCtx("是，实施此计划");

		await getAgentEnd(pi)({ messages: [assistantMsg(PLAN_BLOCK)] }, ctx);

		expect(ctx.selects).toHaveLength(0);
	});
});
