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

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import { extractProposedPlan } from "./plan-detect.ts";
import { isAllowedSubagentCall, isSafeCommand, PLAN_WHITELIST } from "./policy.ts";
import { buildPlanModePrompt } from "./prompt.ts";

const EXECUTE_OPTION = "是，实施此计划";
const REFINE_OPTION = "否，告诉 PI 应该如何做的不同";

interface PlanModeState {
	enabled: boolean;
	toolsBeforePlanMode?: string[];
}

export default function planModeExtension(pi: ExtensionAPI): void {
	let planModeEnabled = false;
	let toolsBeforePlanMode: string[] | undefined;

	function updateStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus("plan-mode", planModeEnabled ? "plan mode" : undefined);
	}

	function enable(): void {
		if (toolsBeforePlanMode === undefined) {
			toolsBeforePlanMode = pi.getActiveTools();
		}
		// Unknown tool names are ignored by the loader, so listing tools that
		// are not installed (e.g. ask_question) is safe.
		pi.setActiveTools([...PLAN_WHITELIST]);
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
		description: "Toggle plan mode (read-only planning)",
		handler: async (_args, ctx) => togglePlanMode(ctx),
	});

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle plan mode",
		handler: async (ctx) => togglePlanMode(ctx),
	});

	// Hard guard: block anything outside the read-only whitelist, filter bash
	// commands, and restrict subagent to read-only exploration. Catches tools
	// hidden by setActiveTools and tools registered by other extensions.
	pi.on("tool_call", async (event) => {
		if (!planModeEnabled) return;

		if (!PLAN_WHITELIST.includes(event.toolName)) {
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

		if (event.toolName === "subagent" && !isAllowedSubagentCall(event.input)) {
			return {
				block: true,
				reason:
					'Plan mode is read-only: subagent is limited to the explore agent (single task, or agent="list" discovery). Exit plan mode with /plan to use other agents.',
			};
		}
	});

	// Inject the planning workflow prompt while plan mode is on.
	pi.on("before_agent_start", async () => {
		if (!planModeEnabled) return;

		const hasAskQuestion = pi.getAllTools().some((tool) => tool.name === "ask_question");
		return {
			message: {
				customType: "plan-mode-context",
				content: buildPlanModePrompt(hasAskQuestion),
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
		pi.sendUserMessage("请按照上面的 proposed_plan 计划开始实施。", { deliverAs: "followUp" });
	});
}
