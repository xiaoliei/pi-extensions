/**
 * Pure state machine for the ask_question TUI component.
 *
 * Separated from index.ts (rendering + raw key routing) so the interaction
 * logic — navigation, selection, multi-select toggling, custom answers,
 * required gating — is unit-testable without a terminal.
 */
import type { Answer, AnswerItem, NormalizedQuestion } from "./format.ts";

export interface TuiState {
	/** 0..questions.length; questions.length = submit tab. */
	currentTab: number;
	cursor: number;
	inputMode: boolean;
	inputQuestionId: string | null;
	/** single/free-text answers per question id. */
	single: Map<string, AnswerItem>;
	/** multi-select: chosen option indices per question id. */
	multiple: Map<string, Set<number>>;
	/** custom-typed entries per question id. */
	custom: Map<string, string[]>;
}

/** Key events the machine understands; index.ts maps raw key data onto these. */
export type UiKey = "up" | "down" | "enter" | "space" | "escape" | "tabNext" | "tabPrev";

/** Side effects index.ts must perform after a machine transition. */
export type UiEvent = { kind: "refresh" } | { kind: "openEditor" } | { kind: "submit"; cancelled: boolean };

export type DisplayOption = { kind: "option"; index: number } | { kind: "custom"; text: string } | { kind: "other" };

export function makeTuiState(): TuiState {
	return {
		currentTab: 0,
		cursor: 0,
		inputMode: false,
		inputQuestionId: null,
		single: new Map(),
		multiple: new Map(),
		custom: new Map(),
	};
}

function isFreeText(q: NormalizedQuestion): boolean {
	return q.options.length === 0;
}

export function displayOptions(q: NormalizedQuestion, state: TuiState): DisplayOption[] {
	const opts: DisplayOption[] = q.options.map((_, i) => ({ kind: "option", index: i }));
	for (const text of state.custom.get(q.id) ?? []) {
		opts.push({ kind: "custom", text });
	}
	if (q.allowCustom) opts.push({ kind: "other" });
	return opts;
}

export function isAnswered(q: NormalizedQuestion, state: TuiState): boolean {
	if (q.type === "multiple") {
		return (state.multiple.get(q.id)?.size ?? 0) > 0 || (state.custom.get(q.id)?.length ?? 0) > 0;
	}
	return state.single.has(q.id);
}

function answerFor(q: NormalizedQuestion, state: TuiState): Answer | undefined {
	if (!isAnswered(q, state)) return undefined;
	const items: AnswerItem[] = [];
	if (q.type === "multiple") {
		for (const index of state.multiple.get(q.id) ?? []) {
			items.push({ value: q.options[index].value, label: q.options[index].label, custom: false });
		}
		for (const text of state.custom.get(q.id) ?? []) {
			items.push({ value: text, label: text, custom: true });
		}
	} else {
		const item = state.single.get(q.id);
		if (item) items.push(item);
	}
	return { id: q.id, items };
}

export function collectAnswers(questions: NormalizedQuestion[], state: TuiState): Answer[] {
	return questions.map((q) => answerFor(q, state)).filter((a): a is Answer => a !== undefined);
}

export function allRequiredAnswered(questions: NormalizedQuestion[], state: TuiState): boolean {
	return questions.every((q) => !q.required || isAnswered(q, state));
}

function currentQuestion(questions: NormalizedQuestion[], state: TuiState): NormalizedQuestion | undefined {
	return questions[state.currentTab];
}

/** Editor text submitted for the question currently in input mode. */
export function handleEditorSubmit(state: TuiState, questions: NormalizedQuestion[], text: string): UiEvent {
	const questionId = state.inputQuestionId;
	if (!questionId) return { kind: "refresh" };
	const trimmed = text.trim();
	if (!trimmed) return { kind: "refresh" }; // empty: keep editing
	const q = questions.find((qq) => qq.id === questionId);
	if (!q) return { kind: "refresh" };
	if (q.type === "multiple") {
		const entries = state.custom.get(q.id) ?? [];
		entries.push(trimmed);
		state.custom.set(q.id, entries);
		state.cursor = 0;
		state.inputMode = false;
		state.inputQuestionId = null;
		return { kind: "refresh" };
	}
	state.single.set(q.id, { value: trimmed, label: trimmed, custom: true });
	state.inputMode = false;
	state.inputQuestionId = null;
	return advanceAfterAnswer(state, questions);
}

function advanceAfterAnswer(state: TuiState, questions: NormalizedQuestion[]): UiEvent {
	const nextTab = state.currentTab < questions.length - 1 ? state.currentTab + 1 : questions.length;
	return switchTab(state, questions, nextTab);
}

function switchTab(state: TuiState, questions: NormalizedQuestion[], tab: number): UiEvent {
	const totalTabs = questions.length + 1;
	state.currentTab = (tab + totalTabs) % totalTabs;
	state.cursor = 0;
	const q = currentQuestion(questions, state);
	if (q && q.type !== "multiple" && !isAnswered(q, state) && isFreeText(q)) {
		state.inputMode = true;
		state.inputQuestionId = q.id;
		return { kind: "openEditor" };
	}
	return { kind: "refresh" };
}

export function handleUiKey(state: TuiState, questions: NormalizedQuestion[], key: UiKey): UiEvent {
	if (key === "tabNext" || key === "tabPrev") {
		if (questions.length > 1) {
			return switchTab(state, questions, state.currentTab + (key === "tabNext" ? 1 : -1));
		}
		return { kind: "refresh" };
	}

	if (state.currentTab === questions.length) {
		// Submit tab: Enter submits (gated on required); Esc goes back to the last question.
		if (key === "enter" && allRequiredAnswered(questions, state)) {
			return { kind: "submit", cancelled: false };
		}
		if (key === "escape") {
			return switchTab(state, questions, state.currentTab - 1);
		}
		return { kind: "refresh" };
	}

	const q = currentQuestion(questions, state);
	if (!q) return { kind: "refresh" };

	if (key === "up") {
		state.cursor = Math.max(0, state.cursor - 1);
		return { kind: "refresh" };
	}
	if (key === "down") {
		const opts = displayOptions(q, state);
		state.cursor = Math.min(opts.length - 1, state.cursor + 1);
		return { kind: "refresh" };
	}

	if (key === "escape") {
		return { kind: "submit", cancelled: true };
	}

	if (key !== "enter" && key !== "space") {
		return { kind: "refresh" };
	}

	const opt = displayOptions(q, state)[state.cursor];
	if (!opt) return { kind: "refresh" };

	if (opt.kind === "other") {
		state.inputMode = true;
		state.inputQuestionId = q.id;
		return { kind: "openEditor" };
	}

	if (q.type === "multiple") {
		if (key === "space") {
			// Space toggles: check/uncheck options, remove custom entries.
			if (opt.kind === "option") {
				const selected = state.multiple.get(q.id) ?? new Set<number>();
				if (selected.has(opt.index)) {
					selected.delete(opt.index);
				} else {
					selected.add(opt.index);
				}
				state.multiple.set(q.id, selected);
			} else if (opt.kind === "custom") {
				const entries = state.custom.get(q.id) ?? [];
				entries.splice(entries.indexOf(opt.text), 1);
				state.custom.set(q.id, entries);
				state.cursor = Math.min(state.cursor, displayOptions(q, state).length - 1);
			}
			return { kind: "refresh" };
		}
		// Enter confirms the current selection and advances.
		return advanceAfterAnswer(state, questions);
	}

	// single: Enter/Space selects the option under the cursor and advances.
	if (opt.kind === "option") {
		state.single.set(q.id, {
			value: q.options[opt.index].value,
			label: q.options[opt.index].label,
			custom: false,
		});
	}
	return advanceAfterAnswer(state, questions);
}
