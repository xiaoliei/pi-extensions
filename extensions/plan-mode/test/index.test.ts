/**
 * Load test: the extension factory runs against a stub ExtensionAPI and
 * registers everything without throwing. Catches runtime issues that
 * type-checking alone misses (import resolution via @mariozechner aliases).
 * Also covers the proposed_plan dialog flow (execute / refine).
 * Run: npm test (from packages/plan-mode)
 */

import { describe, expect, it } from "vitest";
import planModeExtension from "../src/index.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

const PLAN_BLOCK = "<proposed_plan>\n# 标题\n计划内容\n</proposed_plan>";

function assistantMsg(text: string) {
	return { role: "assistant", content: [{ type: "text", text }] };
}

function makeStubPi(selectResult?: string) {
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
		getAllTools: () => [{ name: "read" }, { name: "bash" }],
		getFlag: () => false,
		appendEntry: () => {},
		sendUserMessage: (content: string, options?: unknown) => void calls.push({ sendUserMessage: [content, options] }),
		selectResult,
	};
}

function makeStubCtx(selectResult?: string) {
	const status: [string, string][] = [];
	const selects: string[][] = [];
	return {
		ui: {
			setStatus: (id: string, text: string) => void status.push([id, text]),
			notify: () => {},
			select: async (_title: string, options: string[]) => {
				selects.push(options);
				return selectResult;
			},
		},
		status,
		selects,
		mode: "tui" as const,
		hasUI: true,
		hasPendingMessages: () => false,
		sessionManager: { getEntries: () => [] },
	};
}

const runCommand = (pi: ReturnType<typeof makeStubPi>, name: string, ctx: unknown) =>
	pi.commandHandlers.get(name)?.(undefined, ctx);

describe("plan-mode extension factory", () => {
	it("registers command, flag, shortcut, and event handlers", () => {
		const pi = makeStubPi();
		expect(() => planModeExtension(pi as never)).not.toThrow();
		expect([...pi.commandHandlers.keys()]).toEqual(["plan"]);
		for (const event of ["tool_call", "before_agent_start", "context", "session_start", "agent_end"]) {
			expect(pi.events.has(event), event).toBe(true);
		}
	});

	it("/plan toggles the whitelist and tool_call guard", async () => {
		const pi = makeStubPi();
		planModeExtension(pi as never);
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
		const blockedSubagent = (await toolCallHandler(
			{ toolName: "subagent", input: { agent: "general", task: "x" } },
			ctx,
		)) as { block: boolean };
		expect(blockedSubagent?.block).toBe(true);

		// Exit plan mode: writes pass again
		await runCommand(pi, "plan", ctx);
		expect(await toolCallHandler({ toolName: "write", input: {} }, ctx)).toBeUndefined();
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
		planModeExtension(pi as never);
		const ctx = makeStubCtx("是，实施此计划");
		await runCommand(pi, "plan", ctx); // enter

		await getAgentEnd(pi)({ messages: [assistantMsg(`前言\n${PLAN_BLOCK}`)] }, ctx);

		expect(ctx.selects).toHaveLength(1);
		expect(ctx.selects[0]).toEqual(["是，实施此计划", "否，告诉 PI 应该如何做的不同"]);
		// tools restored (write back in the active set) + execution message sent
		expect(pi.calls.some((c) => c.setActiveTools?.includes("write"))).toBe(true);
		expect(pi.calls.at(-1)?.sendUserMessage?.[0]).toContain("proposed_plan");
		expect(ctx.status.at(-1)).toEqual(["plan-mode", undefined]); // status cleared
	});

	it("selecting refine changes nothing", async () => {
		const pi = makeStubPi();
		planModeExtension(pi as never);
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
		planModeExtension(pi as never);
		const ctx = makeStubCtx("是，实施此计划");
		await runCommand(pi, "plan", ctx);

		await getAgentEnd(pi)({ messages: [assistantMsg("<proposed_plan>\n未闭合")] }, ctx);

		expect(ctx.selects).toHaveLength(0);
		expect(pi.calls.some((c) => c.sendUserMessage)).toBe(false);
	});

	it("skips the dialog when UI is unavailable", async () => {
		const pi = makeStubPi();
		planModeExtension(pi as never);
		const ctx = { ...makeStubCtx("是，实施此计划"), mode: "rpc" as const, hasUI: false };
		await runCommand(pi, "plan", ctx);

		await getAgentEnd(pi)({ messages: [assistantMsg(PLAN_BLOCK)] }, ctx);

		expect(ctx.selects).toHaveLength(0);
		expect(pi.calls.some((c) => c.sendUserMessage)).toBe(false);
	});

	it("skips the dialog when the user already queued input", async () => {
		const pi = makeStubPi();
		planModeExtension(pi as never);
		const ctx = { ...makeStubCtx("是，实施此计划"), hasPendingMessages: () => true };
		await runCommand(pi, "plan", ctx);

		await getAgentEnd(pi)({ messages: [assistantMsg(PLAN_BLOCK)] }, ctx);

		expect(ctx.selects).toHaveLength(0);
	});

	it("does not prompt when plan mode is off", async () => {
		const pi = makeStubPi();
		planModeExtension(pi as never);
		const ctx = makeStubCtx("是，实施此计划");

		await getAgentEnd(pi)({ messages: [assistantMsg(PLAN_BLOCK)] }, ctx);

		expect(ctx.selects).toHaveLength(0);
	});
});
