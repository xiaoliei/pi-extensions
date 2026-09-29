/**
 * Pure logic for the ask_question tool: parameter schema, normalization,
 * non-TUI dialog fallback flow, and result formatting.
 *
 * Kept free of the TUI custom component so it is unit-testable and shared
 * by the TUI path (index.ts) and the RPC dialog fallback.
 */
import { StringEnum } from "@mariozechner/pi-ai";
import { type Static, Type } from "typebox";

export const QuestionOptionSchema = Type.Object({
	value: Type.String({ description: "Machine-readable value returned when the option is chosen" }),
	label: Type.String({ description: "Display label shown to the user" }),
	description: Type.Optional(Type.String({ description: "Optional one-line description shown under the label" })),
});

export const QuestionSchema = Type.Object({
	id: Type.String({ description: "Unique identifier for this question, echoed in the tool result" }),
	label: Type.Optional(
		Type.String({ description: "Short contextual label used in tab bars and result lines (defaults to Q1, Q2)" }),
	),
	type: Type.Optional(
		StringEnum(["single", "multiple"] as const, {
			description: '"single" picks one option; "multiple" lets the user toggle several. Default: "single"',
			default: "single",
		}),
	),
	prompt: Type.String({ description: "The full question text shown to the user" }),
	options: Type.Array(QuestionOptionSchema, {
		description:
			"Concrete options for the user to choose from. Provide 2-6 per question. An empty array means a free-text question.",
	}),
	allowCustom: Type.Optional(
		Type.Boolean({
			description: "Allow the user to type their own answer instead of picking an option. Default: true",
		}),
	),
	required: Type.Optional(
		Type.Boolean({ description: "Whether the user must answer before submitting. Default: true" }),
	),
});

export const AskQuestionParamsSchema = Type.Object({
	questions: Type.Array(QuestionSchema, { description: "One or more questions to ask the user" }),
});

export type QuestionOption = Static<typeof QuestionOptionSchema>;
export type AskQuestionParams = Static<typeof AskQuestionParamsSchema>;

export interface NormalizedQuestion {
	id: string;
	type: "single" | "multiple";
	prompt: string;
	/** Short label used in tab bars and result lines. */
	label: string;
	options: QuestionOption[];
	allowCustom: boolean;
	required: boolean;
}

/** One answered item: a picked option or a custom-typed answer. */
export interface AnswerItem {
	value: string;
	label: string;
	custom: boolean;
}

export interface Answer {
	id: string;
	items: AnswerItem[];
}

export interface NormalizeResult {
	questions: NormalizedQuestion[];
	error?: string;
}

export function normalizeQuestions(input: AskQuestionParams): NormalizeResult {
	if (input.questions.length === 0) {
		return { questions: [], error: "Error: no questions provided" };
	}
	const seen = new Set<string>();
	const questions: NormalizedQuestion[] = [];
	for (let i = 0; i < input.questions.length; i++) {
		const q = input.questions[i];
		if (seen.has(q.id)) {
			return { questions: [], error: `Error: duplicate question id "${q.id}"` };
		}
		seen.add(q.id);
		if (!q.prompt.trim()) {
			return { questions: [], error: `Error: question ${i + 1} has an empty prompt` };
		}
		const options = q.options ?? [];
		if (options.length === 0 && q.allowCustom === false) {
			return { questions: [], error: `Error: question "${q.id}" has no options and allowCustom is false` };
		}
		questions.push({
			id: q.id,
			type: q.type ?? "single",
			prompt: q.prompt,
			label: q.label?.trim() || `Q${i + 1}`,
			options,
			allowCustom: options.length === 0 ? true : (q.allowCustom ?? true),
			required: q.required ?? true,
		});
	}
	return { questions };
}

// ---------------------------------------------------------------------------
// Non-TUI dialog fallback (RPC mode): select + input per question.
// ---------------------------------------------------------------------------

/** Minimal UI surface used by the fallback; ctx.ui.select/input satisfy it. */
export interface DialogUI {
	select(title: string, options: string[]): Promise<string | undefined>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
}

export interface DialogFlowResult {
	answers: Answer[];
	cancelled: boolean;
}

export async function runDialogFlow(questions: NormalizedQuestion[], ui: DialogUI): Promise<DialogFlowResult> {
	const answers: Answer[] = [];
	for (const q of questions) {
		const answer = await askOneViaDialogs(q, ui);
		if (answer === null) return { answers, cancelled: true };
		answers.push(answer);
	}
	return { answers, cancelled: false };
}

async function askOneViaDialogs(q: NormalizedQuestion, ui: DialogUI): Promise<Answer | null> {
	if (q.options.length === 0) {
		const item = await askCustomText(q, ui);
		if (item === null) return null;
		return { id: q.id, items: [item] };
	}
	if (q.type === "multiple") return askMultipleViaDialogs(q, ui);
	return askSingleViaDialogs(q, ui);
}

/** Ask for a custom text answer, re-asking until non-empty; null = cancelled. */
async function askCustomText(q: NormalizedQuestion, ui: DialogUI): Promise<AnswerItem | null> {
	while (true) {
		const text = await ui.input(q.prompt);
		if (text === undefined) return null;
		const trimmed = text.trim();
		if (trimmed) return { value: trimmed, label: trimmed, custom: true };
	}
}

const OTHER_ENTRY = "Type something.";
const DONE_PREFIX = "Done";

function optionEntry(option: QuestionOption, index: number, checked: boolean): string {
	return `${index + 1}. ${option.label}${checked ? " [x]" : ""}`;
}

function parseOptionIndex(pick: string): number {
	const index = Number.parseInt(pick, 10) - 1;
	return Number.isNaN(index) ? -1 : index;
}

async function askSingleViaDialogs(q: NormalizedQuestion, ui: DialogUI): Promise<Answer | null> {
	while (true) {
		const entries = q.options.map((o, i) => optionEntry(o, i, false));
		if (q.allowCustom) entries.push(OTHER_ENTRY);
		const pick = await ui.select(q.prompt, entries);
		if (pick === undefined) return null;
		if (pick === OTHER_ENTRY) {
			const item = await askCustomText(q, ui);
			if (item === null) return null;
			return { id: q.id, items: [item] };
		}
		const index = parseOptionIndex(pick);
		if (index < 0 || index >= q.options.length) continue;
		const option = q.options[index];
		return { id: q.id, items: [{ value: option.value, label: option.label, custom: false }] };
	}
}

async function askMultipleViaDialogs(q: NormalizedQuestion, ui: DialogUI): Promise<Answer | null> {
	const selected = new Set<number>();
	const custom: AnswerItem[] = [];
	while (true) {
		const doneLabel = `${DONE_PREFIX}${selected.size > 0 ? ` (${selected.size} selected)` : ""}`;
		const entries = [doneLabel, ...q.options.map((o, i) => optionEntry(o, i, selected.has(i)))];
		if (q.allowCustom) entries.push(OTHER_ENTRY);
		const pick = await ui.select(q.prompt, entries);
		if (pick === undefined) return null;
		if (pick.startsWith(DONE_PREFIX)) {
			if (selected.size > 0 || custom.length > 0 || !q.required) {
				const items: AnswerItem[] = [...selected]
					.map((i) => ({ value: q.options[i].value, label: q.options[i].label, custom: false }))
					.concat(custom);
				return { id: q.id, items };
			}
			continue; // required and nothing selected yet: keep asking
		}
		if (pick === OTHER_ENTRY) {
			const item = await askCustomText(q, ui);
			if (item === null) return null;
			custom.push(item);
			continue;
		}
		const index = parseOptionIndex(pick);
		if (index < 0 || index >= q.options.length) continue;
		if (selected.has(index)) {
			selected.delete(index);
		} else {
			selected.add(index);
		}
	}
}

// ---------------------------------------------------------------------------
// Result formatting (the text the LLM sees in tool result content).
// ---------------------------------------------------------------------------

function describeItem(item: AnswerItem): string {
	if (item.custom) return `user wrote: ${item.label}`;
	return item.value !== item.label
		? `user selected: ${item.label} (value: ${item.value})`
		: `user selected: ${item.label}`;
}

export function formatAnswers(questions: NormalizedQuestion[], answers: Answer[]): string {
	if (answers.length === 0) return "(no answers)";
	return answers
		.map((answer) => {
			const question = questions.find((q) => q.id === answer.id);
			const label = question?.label ?? answer.id;
			const parts = answer.items.map(describeItem).join("; ");
			return `${label}: ${parts}`;
		})
		.join("\n");
}
