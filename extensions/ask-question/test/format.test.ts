/**
 * Tests for the ask_question pure logic: normalization, dialog fallback flow,
 * and result formatting.
 * Run: npm test (from packages/ask-question)
 */

import { describe, expect, it } from "vitest";
import {
	type Answer,
	type DialogUI,
	formatAnswers,
	type NormalizedQuestion,
	normalizeQuestions,
	runDialogFlow,
} from "../src/format.ts";

const question = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
	id: "q1",
	prompt: "Which language?",
	options: [
		{ value: "ts", label: "TypeScript" },
		{ value: "py", label: "Python" },
	],
	...overrides,
});

describe("normalizeQuestions", () => {
	it("rejects empty question list", () => {
		expect(normalizeQuestions({ questions: [] }).error).toMatch(/no questions/i);
	});

	it("rejects duplicate ids", () => {
		const result = normalizeQuestions({
			questions: [question(), question()] as never,
		});
		expect(result.error).toMatch(/duplicate question id "q1"/i);
	});

	it("rejects empty prompt", () => {
		const result = normalizeQuestions({ questions: [question({ prompt: "  " })] } as never);
		expect(result.error).toMatch(/empty prompt/i);
	});

	it("rejects no options with allowCustom false", () => {
		const result = normalizeQuestions({
			questions: [question({ options: [], allowCustom: false })],
		} as never);
		expect(result.error).toMatch(/no options and allowCustom is false/i);
	});

	it("applies defaults", () => {
		const { questions, error } = normalizeQuestions({
			questions: [question({ label: "Scope" })],
		} as never);
		expect(error).toBeUndefined();
		expect(questions[0]).toMatchObject({
			type: "single",
			label: "Scope",
			allowCustom: true,
			required: true,
		});
	});

	it("forces allowCustom for free-text questions", () => {
		const { questions } = normalizeQuestions({ questions: [question({ options: [] })] } as never);
		expect(questions[0].allowCustom).toBe(true);
	});

	it("defaults label to Q1, Q2", () => {
		const { questions } = normalizeQuestions({
			questions: [question({ id: "a" }), question({ id: "b" })],
		} as never);
		expect(questions.map((q) => q.label)).toEqual(["Q1", "Q2"]);
	});
});

describe("runDialogFlow (RPC fallback)", () => {
	/** Scripted fake UI: each select/input call pops the next recorded value. */
	function fakeUi(script: (string | undefined)[]): DialogUI {
		let i = 0;
		return {
			select: async () => script[i++] ?? undefined,
			input: async () => script[i++] ?? undefined,
		};
	}

	const questions: NormalizedQuestion[] = [
		{
			id: "lang",
			type: "single",
			prompt: "Which language?",
			label: "Q1",
			options: [
				{ value: "ts", label: "TypeScript" },
				{ value: "py", label: "Python" },
			],
			allowCustom: true,
			required: true,
		},
		{
			id: "feats",
			type: "multiple",
			prompt: "Which features?",
			label: "Q2",
			options: [
				{ value: "a", label: "Auth" },
				{ value: "b", label: "Search" },
			],
			allowCustom: true,
			required: true,
		},
	];

	it("answers a single question via option pick", async () => {
		const { answers, cancelled } = await runDialogFlow([questions[0]], fakeUi(["1. TypeScript"]));
		expect(cancelled).toBe(false);
		expect(answers[0]).toEqual({ id: "lang", items: [{ value: "ts", label: "TypeScript", custom: false }] });
	});

	it("answers a single question via custom input", async () => {
		const { answers } = await runDialogFlow([questions[0]], fakeUi(["Type something.", "Rust"]));
		expect(answers[0].items).toEqual([{ value: "Rust", label: "Rust", custom: true }]);
	});

	it("re-asks after empty custom input", async () => {
		const { answers } = await runDialogFlow([questions[0]], fakeUi(["Type something.", "", "Go"]));
		expect(answers[0].items[0].value).toBe("Go");
	});

	it("propagates cancel from a select", async () => {
		const { cancelled, answers } = await runDialogFlow([questions[0]], fakeUi([undefined]));
		expect(cancelled).toBe(true);
		expect(answers).toEqual([]);
	});

	it("supports multi-select with toggling and done", async () => {
		const { answers, cancelled } = await runDialogFlow(
			[questions[1]],
			fakeUi(["2. Search", "1. Auth", "Done (2 selected)"]),
		);
		expect(cancelled).toBe(false);
		expect(answers[0].items).toEqual([
			{ value: "b", label: "Search", custom: false },
			{ value: "a", label: "Auth", custom: false },
		]);
	});

	it("supports multi-select custom entries", async () => {
		const { answers } = await runDialogFlow(
			[questions[1]],
			fakeUi(["Type something.", "Telemetry", "Done (1 selected)"]),
		);
		expect(answers[0].items).toEqual([{ value: "Telemetry", label: "Telemetry", custom: true }]);
	});

	it("blocks done for required unanswered multi-select", async () => {
		const { answers } = await runDialogFlow([questions[1]], fakeUi(["Done", "1. Auth", "Done (1 selected)"]));
		expect(answers[0].items).toEqual([{ value: "a", label: "Auth", custom: false }]);
	});

	it("allows done with no selection when not required", async () => {
		const optional = { ...questions[1], required: false };
		const { answers } = await runDialogFlow([optional], fakeUi(["Done"]));
		expect(answers[0].items).toEqual([]);
	});

	it("answers free-text questions via input", async () => {
		const freeText: NormalizedQuestion = {
			id: "note",
			type: "single",
			prompt: "Anything else?",
			label: "Q1",
			options: [],
			allowCustom: true,
			required: false,
		};
		const { answers } = await runDialogFlow([freeText], fakeUi(["Add pagination"]));
		expect(answers[0].items).toEqual([{ value: "Add pagination", label: "Add pagination", custom: true }]);
	});

	it("asks all questions in order", async () => {
		const { answers, cancelled } = await runDialogFlow(
			questions,
			fakeUi(["2. Python", "1. Auth", "Type something.", "Dark mode", "Done (2 selected)"]),
		);
		expect(cancelled).toBe(false);
		expect(answers).toHaveLength(2);
		expect(answers[0].items[0].value).toBe("py");
		expect(answers[1].items.map((i) => i.value)).toEqual(["a", "Dark mode"]);
	});
});

describe("formatAnswers", () => {
	const questions: NormalizedQuestion[] = [
		{
			id: "lang",
			type: "single",
			prompt: "Which language?",
			label: "Language",
			options: [{ value: "ts", label: "TypeScript" }],
			allowCustom: true,
			required: true,
		},
	];

	it("renders option picks with value when it differs from label", () => {
		const questionsWithValue: NormalizedQuestion[] = [
			{ ...questions[0], options: [{ value: "TypeScript", label: "TypeScript" }] },
		];
		const answers: Answer[] = [{ id: "lang", items: [{ value: "TypeScript", label: "TypeScript", custom: false }] }];
		expect(formatAnswers(questionsWithValue, answers)).toBe("Language: user selected: TypeScript");
	});

	it("renders value alongside label when they differ", () => {
		const questionsWithValue: NormalizedQuestion[] = [
			{ ...questions[0], options: [{ value: "typescript", label: "TypeScript" }] },
		];
		const answers: Answer[] = [{ id: "lang", items: [{ value: "typescript", label: "TypeScript", custom: false }] }];
		expect(formatAnswers(questionsWithValue, answers)).toBe(
			"Language: user selected: TypeScript (value: typescript)",
		);
	});

	it("renders custom answers", () => {
		const answers: Answer[] = [{ id: "lang", items: [{ value: "Rust", label: "Rust", custom: true }] }];
		expect(formatAnswers(questions, answers)).toBe("Language: user wrote: Rust");
	});

	it("renders multiple items joined by semicolons", () => {
		const answers: Answer[] = [
			{
				id: "lang",
				items: [
					{ value: "TypeScript", label: "TypeScript", custom: false },
					{ value: "dark", label: "Dark mode", custom: true },
				],
			},
		];
		expect(formatAnswers(questions, answers)).toBe("Language: user selected: TypeScript; user wrote: Dark mode");
	});

	it("handles empty answers", () => {
		expect(formatAnswers(questions, [])).toBe("(no answers)");
	});
});
