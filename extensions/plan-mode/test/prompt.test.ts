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
		const prompt = buildPlanModePrompt(true, true);
		expect(prompt).toContain("LSP tools are installed and available");
		expect(prompt).toContain("map symbols, definitions, references, implementations");
		expect(prompt).toContain("use grep or AST search only to fill gaps");
		expect(prompt.indexOf("First determine whether LSP")).toBeLessThan(
			prompt.indexOf("After the initial LSP pass, inspect the available third-party subagent tools"),
		);
	});
});
