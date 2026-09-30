/**
 * Plan Mode extension package.
 *
 * Read-only planning workflow triggered by /plan: blocks all write operations,
 * and guides the model through environment exploration, intent confirmation,
 * and decision-complete design refinement. The final plan is emitted as a
 * <proposed_plan> Markdown block; a dialog then asks whether to execute it -
 * confirming exits plan mode and starts implementation automatically.
 *
 * Compatible with both original pi (@earendil-works) and the customized fork
 * (@xiaoliyo): imports use the @mariozechner scope that both extension loaders
 * alias to their host modules, plus typebox.
 */

import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import { join } from "node:path";
import { extractProposedPlan } from "./plan-detect.ts";
import {
	isAllowedPiLensCall, isLikelyReadOnlyTool, isPiLensQueryTool, isReadOnlySubagentRequest,
	isSafeCommand, isThirdPartySubagentTool, PLAN_WHITELIST, toolExtensionKey, type AvailableTool,
} from "./policy.ts";
import { buildPlanModePrompt } from "./prompt.ts";
import { createTrustStore, type ExtensionTrustScope } from "./trust.ts";

const EXECUTE_OPTION = "是，实施此计划";
const REFINE_OPTION = "否，告诉 PI 应该如何做的不同";
const ALLOW_ONCE_OPTION = "仅本次允许";
const TRUST_READONLY_EXTENSION_OPTION = "全局同意该扩展的所有只读工具调用";
const TRUST_ALL_EXTENSION_OPTION = "全局同意该扩展的所有工具调用（包括写入工具）";
const DENY_OPTION = "拒绝";

interface PlanModeState {
	enabled: boolean;
	toolsBeforePlanMode?: string[];
}

export default function planModeExtension(
	pi: ExtensionAPI,
	trustFilePath = join(getAgentDir(), "plan-mode", "trusted-subagents.json"),
): void {
	let planModeEnabled = false;
	let toolsBeforePlanMode: string[] | undefined;
	const trustStore = createTrustStore(trustFilePath);
	let approvalQueue: Promise<void> = Promise.resolve();

	function availableTool(name: string): AvailableTool | undefined {
		return pi.getAllTools().find((tool) => tool.name === name);
	}

	function planToolNames(): string[] {
		return [...new Set([
			...PLAN_WHITELIST,
			...pi.getAllTools()
				.filter((tool) => isPiLensQueryTool(tool) || isThirdPartySubagentTool(tool))
				.map((tool) => tool.name),
		])];
	}

	function toolsFromExtension(tool: AvailableTool): AvailableTool[] {
		const extension = toolExtensionKey(tool);
		return pi.getAllTools().filter((candidate) => toolExtensionKey(candidate) === extension);
	}

	function enableTrustedTools(tools: AvailableTool[], scope: ExtensionTrustScope): void {
		const names = tools
			.filter((tool) => scope === "all" || isLikelyReadOnlyTool(tool))
			.map((tool) => tool.name);
		pi.setActiveTools([...new Set([...pi.getActiveTools(), ...names])]);
	}

	function updateStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus("plan-mode", planModeEnabled ? "plan mode" : undefined);
	}

	function enable(): void {
		if (toolsBeforePlanMode === undefined) {
			toolsBeforePlanMode = pi.getActiveTools();
		}
		// Unknown tool names are ignored by the loader, so listing tools that
		// are not installed (e.g. ask_question) is safe.
		pi.setActiveTools(planToolNames());
	}

	function disable(): void {
		pi.setActiveTools(toolsBeforePlanMode ?? pi.getActiveTools());
		toolsBeforePlanMode = undefined;
	}

	function persistState(): void {
		pi.appendEntry("plan-mode", { enabled: planModeEnabled, toolsBeforePlanMode });
	}

	function togglePlanMode(ctx: ExtensionContext): void {
		planModeEnabled = !planModeEnabled;
		if (planModeEnabled) {
			enable();
			ctx.ui.notify("Plan mode enabled. Write operations are blocked.");
		} else {
			disable();
			ctx.ui.notify("Plan mode disabled. Full access restored.");
		}
		updateStatus(ctx);
		persistState();
	}

	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only planning)",
		type: "boolean",
		default: false,
	});

	pi.registerCommand("plan", {
		description: "Toggle plan mode, or start planning the supplied task",
		handler: async (args, ctx) => {
			const task = args?.trim() ?? "";
			if (!task) {
				togglePlanMode(ctx);
				return;
			}
			if (!planModeEnabled) togglePlanMode(ctx);
			try {
				pi.sendUserMessage(task, { deliverAs: "followUp" });
			} catch (error) {
				ctx.ui.setEditorText(`/plan ${task}`);
				ctx.ui.notify("Could not send the planning task. The command was restored in the editor.", "error");
				throw error;
			}
		},
	});

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle plan mode",
		handler: async (ctx) => togglePlanMode(ctx),
	});

	async function approveSubagent(tool: AvailableTool, input: unknown, ctx: ExtensionContext): Promise<boolean> {
		const existingScope = await trustStore.getScope(tool);
		if (existingScope === "all" || (existingScope === "readonly" && isReadOnlySubagentRequest(input))) return true;
		if (ctx.mode !== "tui" || !ctx.hasUI) return false;
		let release!: () => void;
		const current = new Promise<void>((resolve) => { release = resolve; });
		const previous = approvalQueue;
		approvalQueue = previous.then(() => current);
		await previous;
		try {
			const currentScope = await trustStore.getScope(tool);
			if (currentScope === "all" || (currentScope === "readonly" && isReadOnlySubagentRequest(input))) return true;
			const params = typeof input === "object" && input !== null ? input as Record<string, unknown> : {};
			const mode = ["mode", "template", "profile", "agentType", "agent"]
				.map((name) => params[name]).find((value) => typeof value === "string") ?? "not specified";
			const source = `${tool.sourceInfo?.source ?? "unknown"} (${tool.sourceInfo?.path ?? "unknown"})`;
			const extensionTools = toolsFromExtension(tool);
			const toolList = extensionTools
				.map((candidate) => `${candidate.name} [${isLikelyReadOnlyTool(candidate) ? "read-only" : "may write"}]`)
				.join(", ");
			const choice = await ctx.ui.select(
				`Plan mode extension tools\nTrigger: ${tool.name}\nSource: ${source}\nMode/template: ${mode}\nAvailable tools: ${toolList}\nWrite-capable tools require the “all tools” choice.`,
				[ALLOW_ONCE_OPTION, TRUST_READONLY_EXTENSION_OPTION, TRUST_ALL_EXTENSION_OPTION, DENY_OPTION],
			);
			if (choice === TRUST_READONLY_EXTENSION_OPTION || choice === TRUST_ALL_EXTENSION_OPTION) {
				const scope = choice === TRUST_ALL_EXTENSION_OPTION ? "all" : "readonly";
				await trustStore.trustExtension(tool, scope);
				enableTrustedTools(extensionTools, scope);
				return true;
			}
			return choice === ALLOW_ONCE_OPTION;
		} finally {
			release();
		}
	}

	// Check every call, including tools activated later by other extensions.
	pi.on("tool_call", async (event, ctx) => {
		if (!planModeEnabled) return;
		const tool = availableTool(event.toolName);
		const isPiLens = tool !== undefined && isPiLensQueryTool(tool);
		const isSubagent = tool !== undefined && isThirdPartySubagentTool(tool);
		const extensionScope = tool ? await trustStore.getScope(tool) : undefined;
		const globallyAllowed = tool !== undefined && extensionScope === "all";
		const globallyReadOnly = tool !== undefined && extensionScope === "readonly" && isLikelyReadOnlyTool(tool);
		if (!PLAN_WHITELIST.includes(event.toolName) && !isPiLens && !isSubagent && !globallyAllowed && !globallyReadOnly) {
			return {
				block: true,
				reason: `Plan mode is read-only: the "${event.toolName}" tool is blocked. Exit plan mode with /plan to use it.`,
			};
		}

		if (event.toolName === "bash") {
			const command = typeof event.input.command === "string" ? event.input.command : "";
			if (!isSafeCommand(command)) {
				return {
					block: true,
					reason: `Plan mode is read-only: this bash command is not on the read-only allowlist. Exit plan mode with /plan to run it.\nCommand: ${command}`,
				};
			}
		}

		if (isPiLens && !isAllowedPiLensCall(event.toolName, event.input)) {
			return {
				block: true,
				reason: "Plan mode allows pi-lens navigation queries only; mutation operations and apply:true are blocked.",
			};
		}
		if (isSubagent && !globallyAllowed && !(await approveSubagent(tool, event.input, ctx))) {
			return { block: true, reason: "This third-party subagent was not approved for plan mode." };
		}
	});

	// Inject the planning workflow prompt while plan mode is on.
	pi.on("before_agent_start", async () => {
		if (!planModeEnabled) return;

		const hasAskQuestion = pi.getAllTools().some((tool) => tool.name === "ask_question");
		const hasLspTools = pi.getAllTools().some((tool) =>
			isPiLensQueryTool(tool) && (tool.name === "pi_lens_activate_tools" || tool.name === "lsp_navigation" || tool.name === "lens_diagnostics"),
		);
		const hasSubagentTools = pi.getAllTools().some((tool) => isThirdPartySubagentTool(tool));
		return {
			message: {
				customType: "plan-mode-context",
				content: buildPlanModePrompt(hasAskQuestion, hasLspTools, hasSubagentTools),
				display: false,
			},
		};
	});

	// Drop stale plan-mode context once plan mode is off.
	pi.on("context", async (event) => {
		if (planModeEnabled) return;

		return {
			messages: event.messages.filter((m) => {
				const msg = m as { customType?: string };
				return msg.customType !== "plan-mode-context";
			}),
		};
	});

	// Restore persisted state on session start/resume.
	pi.on("session_start", async (_event, ctx) => {
		if (pi.getFlag("plan") === true) {
			planModeEnabled = true;
		}

		const entries = ctx.sessionManager.getEntries();
		const planModeEntry = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "plan-mode")
			.pop() as { data?: PlanModeState } | undefined;

		if (planModeEntry?.data) {
			planModeEnabled = planModeEntry.data.enabled ?? planModeEnabled;
			toolsBeforePlanMode = planModeEntry.data.toolsBeforePlanMode ?? toolsBeforePlanMode;
		}

		if (planModeEnabled) {
			enable();
		}
		updateStatus(ctx);
	});

	// When a plan-mode turn ends with a complete proposed_plan block, ask whether
	// to execute it. Confirming exits plan mode and triggers the execution turn.
	pi.on("agent_end", async (event, ctx) => {
		if (!planModeEnabled) return;
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		if (ctx.hasPendingMessages()) return; // user already queued input, don't interrupt

		const text = event.messages
			.filter((m) => m.role === "assistant")
			.map(
				(m) =>
					(m as { content?: Array<{ type: string; text?: string }> }).content
						?.filter((b) => b.type === "text")
						.map((b) => b.text ?? "")
						.join("") ?? "",
			)
			.join("\n");
		if (!extractProposedPlan(text)) return;

		const choice = await ctx.ui.select("是否执行此计划？", [EXECUTE_OPTION, REFINE_OPTION]);
		if (choice !== EXECUTE_OPTION || !planModeEnabled) return; // refine, or manually exited meanwhile

		disable();
		planModeEnabled = false;
		updateStatus(ctx);
		persistState();
		ctx.ui.notify("已退出计划模式，开始实施计划。");
		pi.sendUserMessage("Implement the approved <proposed_plan> above.", { deliverAs: "followUp" });
	});
}
