/**
 * Tests for the ask_question TUI state machine: navigation, single/multi
 * selection, custom answers, required gating, and cancel.
 * Run: npm test (from packages/ask-question)
 */

import { describe, expect, it } from "vitest";
import type { NormalizedQuestion } from "../src/format.ts";
import {
	allRequiredAnswered,
	collectAnswers,
	displayOptions,
	handleEditorSubmit,
	handleUiKey,
	isAnswered,
	makeTuiState,
} from "../src/interaction.ts";

function makeQuestions(overrides: Array<Partial<NormalizedQuestion>> = []): NormalizedQuestion[] {
	const base: NormalizedQuestion[] = [
		{
			id: "lang",
			type: "single",
			prompt: "Which language?",
			label: "Language",
			options: [
				{ value: "ts", label: "TypeScript" },
				{ value: "go", label: "Go" },
			],
			allowCustom: true,
			required: true,
		},
		{
			id: "feats",
			type: "multiple",
			prompt: "Which features?",
			label: "Features",
			options: [
				{ value: "auth", label: "Auth" },
				{ value: "search", label: "Search" },
			],
			allowCustom: true,
			required: true,
		},
	];
	return base.map((q, i) => ({ ...q, ...overrides[i] }));
}

describe("single-choice questions", () => {
	it("selects an option and advances to the next question", () => {
		const state = makeTuiState();
		const questions = makeQuestions();
		expect(handleUiKey(state, questions, "enter")).toEqual({ kind: "refresh" });
		expect(state.currentTab).toBe(1);
		expect(state.single.get("lang")).toEqual({ value: "ts", label: "TypeScript", custom: false });
	});

	it("moving down then enter picks the second option", () => {
		const state = makeTuiState();
		const questions = makeQuestions();
		handleUiKey(state, questions, "down");
		handleUiKey(state, questions, "enter");
		expect(state.single.get("lang")).toEqual({ value: "go", label: "Go", custom: false });
	});

	it("auto-advances a single question to the submit tab when it is the only question", () => {
		const state = makeTuiState();
		const questions = [makeQuestions()[0]];
		handleUiKey(state, questions, "enter");
		expect(state.currentTab).toBe(1); // submit tab
		expect(collectAnswers(questions, state)[0].items[0].value).toBe("ts");
	});

	it("advances multi-question flow to the next tab, not submit", () => {
		const state = makeTuiState();
		const questions = makeQuestions();
		handleUiKey(state, questions, "enter");
		expect(state.currentTab).toBe(1);
		expect(state.currentTab).not.toBe(questions.length);
	});

	it("opens the editor for the custom option and saves the typed answer", () => {
		const state = makeTuiState();
		const questions = [makeQuestions()[0]];
		handleUiKey(state, questions, "down");
		handleUiKey(state, questions, "down"); // cursor on "Type something."
		const event = handleUiKey(state, questions, "enter");
		expect(event).toEqual({ kind: "openEditor" });
		expect(state.inputMode).toBe(true);
		handleEditorSubmit(state, questions, "  Rust  ");
		expect(state.single.get("lang")).toEqual({ value: "Rust", label: "Rust", custom: true });
		expect(state.inputMode).toBe(false);
	});

	it("ignores empty editor submissions", () => {
		const state = makeTuiState();
		const questions = [makeQuestions()[0]];
		state.inputMode = true;
		state.inputQuestionId = "lang";
		handleEditorSubmit(state, questions, "   ");
		expect(state.single.has("lang")).toBe(false);
		expect(state.inputMode).toBe(true);
	});
});

describe("multi-choice questions", () => {
	it("space toggles options on a multi-select question", () => {
		const state = makeTuiState();
		const questions = makeQuestions();
		handleUiKey(state, questions, "tabNext"); // to Features
		handleUiKey(state, questions, "space"); // check Auth
		handleUiKey(state, questions, "down");
		handleUiKey(state, questions, "space"); // check Search
		handleUiKey(state, questions, "up");
		handleUiKey(state, questions, "space"); // uncheck Auth
		expect(state.multiple.get("feats")).toEqual(new Set([1]));
		expect(isAnswered(questions[1], state)).toBe(true);
	});

	it("enter on a multi-select question confirms and advances without a done entry", () => {
		const state = makeTuiState();
		const questions = makeQuestions();
		handleUiKey(state, questions, "tabNext"); // to Features
		handleUiKey(state, questions, "space"); // check Auth
		handleUiKey(state, questions, "enter");
		expect(state.currentTab).toBe(2); // submit tab (last question)
		expect(state.multiple.get("feats")).toEqual(new Set([0]));
		const answers = collectAnswers(questions, state);
		expect(answers).toHaveLength(1); // only feats answered (lang was skipped via tab)
		expect(answers[0].id).toBe("feats");
		expect(answers[0].items.map((i) => i.value)).toEqual(["auth"]);
	});

	it("adds custom entries via the editor and includes them in the answer", () => {
		const state = makeTuiState();
		const questions = makeQuestions();
		handleUiKey(state, questions, "tabNext"); // to Features
		handleUiKey(state, questions, "down");
		handleUiKey(state, questions, "down"); // Type something.
		handleUiKey(state, questions, "enter");
		expect(state.inputMode).toBe(true);
		handleEditorSubmit(state, questions, "Telemetry");
		expect(state.custom.get("feats")).toEqual(["Telemetry"]);
		expect(isAnswered(questions[1], state)).toBe(true);
		const answers = collectAnswers(questions, state);
		expect(answers).toHaveLength(1);
		expect(answers[0].items).toEqual([{ value: "Telemetry", label: "Telemetry", custom: true }]);
	});

	it("space on a custom entry removes it", () => {
		const state = makeTuiState();
		const questions = makeQuestions();
		state.custom.set("feats", ["Telemetry"]);
		state.currentTab = 1;
		handleUiKey(state, questions, "space"); // check Auth (cursor 0)
		expect(state.multiple.get("feats")).toEqual(new Set([0]));
		handleUiKey(state, questions, "down");
		handleUiKey(state, questions, "down"); // cursor on custom entry
		handleUiKey(state, questions, "space"); // remove it
		expect(state.custom.get("feats")).toEqual([]);
	});
});

describe("navigation and gating", () => {
	it("cancels with escape from a question page", () => {
		const state = makeTuiState();
		expect(handleUiKey(state, makeQuestions(), "escape")).toEqual({ kind: "submit", cancelled: true });
	});

	it("escape on the submit tab goes back to the last question instead of cancelling", () => {
		const state = makeTuiState();
		const questions = makeQuestions();
		state.single.set("lang", { value: "ts", label: "TypeScript", custom: false });
		state.currentTab = questions.length; // submit tab
		const event = handleUiKey(state, questions, "escape");
		expect(event).toEqual({ kind: "refresh" });
		expect(state.currentTab).toBe(questions.length - 1);
	});

	it("blocks submit on the submit tab until required questions are answered", () => {
		const state = makeTuiState();
		const questions = makeQuestions();
		state.currentTab = questions.length; // submit tab
		expect(handleUiKey(state, questions, "enter")).toEqual({ kind: "refresh" });
		expect(allRequiredAnswered(questions, state)).toBe(false);
	});

	it("submits once all required questions are answered", () => {
		const state = makeTuiState();
		const questions = makeQuestions();
		state.single.set("lang", { value: "ts", label: "TypeScript", custom: false });
		state.multiple.set("feats", new Set([0]));
		state.currentTab = questions.length;
		expect(handleUiKey(state, questions, "enter")).toEqual({ kind: "submit", cancelled: false });
	});

	it("skips the required gate for optional questions", () => {
		const questions = makeQuestions([{}, { required: false }]);
		const state = makeTuiState();
		state.single.set("lang", { value: "ts", label: "TypeScript", custom: false });
		state.currentTab = questions.length;
		expect(handleUiKey(state, questions, "enter")).toEqual({ kind: "submit", cancelled: false });
	});

	it("tab navigation is inert with a single question", () => {
		const state = makeTuiState();
		const questions = [makeQuestions()[0]];
		handleUiKey(state, questions, "tabNext");
		expect(state.currentTab).toBe(0);
	});

	it("free-text questions auto-open the editor when reached", () => {
		const questions = makeQuestions([
			{},
			{ id: "note", type: "single", options: [], allowCustom: true, required: false },
		]);
		const state = makeTuiState();
		expect(handleUiKey(state, questions, "tabNext")).toEqual({ kind: "openEditor" });
		expect(state.inputMode).toBe(true);
		expect(state.inputQuestionId).toBe("note");
	});

	it("does not re-open the editor for an already answered free-text question", () => {
		const questions = makeQuestions([
			{},
			{ id: "note", type: "single", options: [], allowCustom: true, required: false },
		]);
		const state = makeTuiState();
		state.single.set("note", { value: "x", label: "x", custom: true });
		expect(handleUiKey(state, questions, "tabNext")).toEqual({ kind: "refresh" });
		expect(state.inputMode).toBe(false);
	});

	it("displayOptions appends custom and other entries in order", () => {
		const state = makeTuiState();
		const questions = makeQuestions();
		expect(displayOptions(questions[1], state).map((o) => o.kind)).toEqual(["option", "option", "other"]);
		state.custom.set("feats", ["Telemetry"]);
		expect(displayOptions(questions[1], state).map((o) => o.kind)).toEqual(["option", "option", "custom", "other"]);
	});

	it("submitting with no answers returns an empty list", () => {
		const state = makeTuiState();
		expect(collectAnswers(makeQuestions(), state)).toEqual([]);
	});
});
