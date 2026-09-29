import { describe, expect, it } from "vitest";
import { extractProposedPlan } from "../src/plan-detect.ts";

describe("extractProposedPlan", () => {
	it("extracts content between standalone tags", () => {
		const text = "前言\n<proposed_plan>\n# 标题\n内容\n</proposed_plan>\n后记";
		expect(extractProposedPlan(text)).toBe("# 标题\n内容");
	});

	it("returns undefined without a complete block", () => {
		expect(extractProposedPlan("<proposed_plan>\n未闭合")).toBeUndefined();
		expect(extractProposedPlan("没有标签")).toBeUndefined();
		expect(extractProposedPlan("</proposed_plan>\n只有结束标签")).toBeUndefined();
	});

	it("returns the last complete block when several exist", () => {
		const text = "<proposed_plan>\n旧计划\n</proposed_plan>\n中間文本\n<proposed_plan>\n新计划\n</proposed_plan>";
		expect(extractProposedPlan(text)).toBe("新计划");
	});

	it("tolerates whitespace around tag lines", () => {
		const text = "  <proposed_plan>  \n计划\n\t</proposed_plan>\t";
		expect(extractProposedPlan(text)).toBe("计划");
	});

	it("does not match tags embedded in a line with other text", () => {
		const text = "见 <proposed_plan> 标签\n</proposed_plan>";
		expect(extractProposedPlan(text)).toBeUndefined();
	});

	it("handles CRLF line endings", () => {
		const text = "<proposed_plan>\r\n计划\r\n</proposed_plan>";
		expect(extractProposedPlan(text)).toBe("计划");
	});

	it("preserves blank lines and code fences inside the block", () => {
		const text = "<proposed_plan>\n# T\n\n```ts\nconst a = 1;\n```\n</proposed_plan>";
		expect(extractProposedPlan(text)).toBe("# T\n\n```ts\nconst a = 1;\n```");
	});
});
