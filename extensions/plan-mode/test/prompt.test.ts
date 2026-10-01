import { describe, expect, it } from "vitest";
import { buildPlanModePrompt } from "../src/prompt.ts";

describe("planning prompt", () => {
	it("uses English model instructions and preserves the full planning workflow", () => {
		for (const hasAskQuestion of [true, false]) {
			const prompt = buildPlanModePrompt(hasAskQuestion);
			expect(prompt).not.toMatch(/[\u3400-\u9fff]/u);
			for (const section of ["Phase 1", "Phase 2", "Phase 3", "Phase 4", "<proposed_plan>"]) {
				expect(prompt).toContain(section);
			}
			expect(prompt).toContain("Prefer an Explore or read-only mode or template");
			expect(prompt).toContain("exact file paths and line numbers");
		}
	});

	it("prioritizes installed LSP tools for structure and type exploration", () => {
		const prompt = buildPlanModePrompt(true, true, true);
		expect(prompt).toContain("LSP tools are installed and available");
		expect(prompt).toContain("map symbols, definitions, references, implementations");
		expect(prompt).toContain("use grep or AST search only to fill gaps");
		expect(prompt.indexOf("First determine whether LSP")).toBeLessThan(
			prompt.indexOf("Immediately after the LSP overview, start the subagent dispatch gate"),
		);
		expect(prompt).toContain("dispatch every independent task");
		expect(prompt).toContain("Do not continue detailed parent exploration while these subagents are running");
		expect(prompt).toContain("Do not ask intent questions, call agent output/poll, or draft <proposed_plan>");
		expect(prompt).toContain("Parallelism comes from dispatching all calls before waiting");
		expect(prompt).toContain("Your next assistant tool turn after LSP orientation must contain the complete fan-out dispatch");
	});
});
