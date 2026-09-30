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
});
