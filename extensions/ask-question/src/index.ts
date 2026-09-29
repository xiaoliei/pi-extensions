/**
 * ask_question extension: lets the LLM ask the user to clarify requirements
 * or make choices. Guides the LLM to provide concrete options; supports
 * single-choice, multi-choice, free-text, and several questions per call.
 *
 * Compatible with both original pi (@earendil-works) and the customized
 * fork (@xiaoliyo): imports use the @mariozechner scope that both extension
 * loaders alias to their host modules, plus typebox.
 */
import type { ExtensionAPI, ThemeColor } from "@mariozechner/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, Text, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import {
	type Answer,
	type AskQuestionParams,
	AskQuestionParamsSchema,
	type DialogUI,
	formatAnswers,
	type NormalizedQuestion,
	normalizeQuestions,
	runDialogFlow,
} from "./format.ts";
import {
	allRequiredAnswered,
	collectAnswers,
	type DisplayOption,
	displayOptions,
	handleEditorSubmit,
	handleUiKey,
	isAnswered,
	makeTuiState,
	type UiEvent,
	type UiKey,
} from "./interaction.ts";

interface QuestionResult {
	questions: NormalizedQuestion[];
	answers: Answer[];
	cancelled: boolean;
}

function errorResult(
	message: string,
	questions: NormalizedQuestion[] = [],
): {
	content: { type: "text"; text: string }[];
	details: QuestionResult;
} {
	return {
		content: [{ type: "text", text: message }],
		details: { questions, answers: [], cancelled: true },
	};
}

export default function askQuestion(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_question",
		label: "Ask Question",
		description:
			"Ask the user to clarify requirements or make choices instead of guessing. Use whenever the request is ambiguous, " +
			"multiple interpretations are plausible, or a decision between alternatives is needed before proceeding. " +
			"Provide 2-6 concrete, well-labeled options per question. Each question can be single-choice, multi-choice, " +
			"or free-text (empty options); several questions can be asked in one call. The user can also type a custom " +
			"answer even when options are provided.",
		promptSnippet:
			"ask the user to pick between provided options (single/multi-choice, free-text, several questions at once)",
		promptGuidelines: [
			"When the user's request is ambiguous, could be interpreted multiple ways, or requires choosing between " +
				"alternatives, call ask_question with concrete options instead of guessing or picking arbitrarily.",
			"Provide 2-6 specific options per question. Prefer single-choice for mutually exclusive alternatives and " +
				"multi-choice when several can apply. Use free-text (empty options) only when no meaningful option list exists.",
		],
		parameters: AskQuestionParamsSchema,
		executionMode: "sequential",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const normalized = normalizeQuestions(params);
			if (normalized.error) {
				return errorResult(normalized.error, normalized.questions);
			}
			const questions = normalized.questions;

			let result: QuestionResult;
			if (ctx.mode === "tui") {
				result = await ctx.ui.custom<QuestionResult>((tui, theme, _kb, done) => {
					const state = makeTuiState();
					const editorTheme: EditorTheme = {
						borderColor: (s) => theme.fg("accent", s),
						selectList: {
							selectedPrefix: (t) => theme.fg("accent", t),
							selectedText: (t) => theme.fg("accent", t),
							description: (t) => theme.fg("muted", t),
							scrollInfo: (t) => theme.fg("dim", t),
							noMatch: (t) => theme.fg("warning", t),
						},
					};
					const editor = new Editor(tui, editorTheme);
					const isMulti = questions.length > 1;
					let cachedLines: string[] | undefined;

					function refresh() {
						cachedLines = undefined;
						tui.requestRender();
					}

					function currentQuestion(): NormalizedQuestion | undefined {
						return questions[state.currentTab];
					}

					function currentOptions(): DisplayOption[] {
						const q = currentQuestion();
						return q ? displayOptions(q, state) : [];
					}

					function applyEvent(event: UiEvent) {
						if (event.kind === "openEditor") {
							editor.setText("");
							refresh();
							return;
						}
						if (event.kind === "submit") {
							done({
								questions,
								answers: event.cancelled ? [] : collectAnswers(questions, state),
								cancelled: event.cancelled,
							});
							return;
						}
						refresh();
					}

					editor.onSubmit = (value) => {
						applyEvent(handleEditorSubmit(state, questions, value));
					};

					function handleInput(data: string) {
						if (state.inputMode) {
							if (matchesKey(data, Key.escape)) {
								state.inputMode = false;
								state.inputQuestionId = null;
								editor.setText("");
								refresh();
								return;
							}
							editor.handleInput(data);
							refresh();
							return;
						}

						let key: UiKey | undefined;
						if (matchesKey(data, Key.up)) key = "up";
						else if (matchesKey(data, Key.down)) key = "down";
						else if (matchesKey(data, Key.enter)) key = "enter";
						else if (matchesKey(data, Key.space)) key = "space";
						else if (matchesKey(data, Key.escape)) key = "escape";
						else if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) key = "tabNext";
						else if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) key = "tabPrev";
						if (key) applyEvent(handleUiKey(state, questions, key));
					}

					function render(width: number): string[] {
						if (cachedLines) return cachedLines;

						const lines: string[] = [];
						const renderWidth = Math.max(1, width);
						const q = currentQuestion();
						const opts = currentOptions();

						function addWrapped(text: string) {
							lines.push(...wrapTextWithAnsi(text, renderWidth));
						}

						function addWrappedWithPrefix(prefix: string, text: string) {
							const prefixWidth = visibleWidth(prefix);
							if (prefixWidth >= renderWidth) {
								addWrapped(prefix + text);
								return;
							}
							const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
							const continuationPrefix = " ".repeat(prefixWidth);
							for (let i = 0; i < wrapped.length; i++) {
								lines.push(`${i === 0 ? prefix : continuationPrefix}${wrapped[i]}`);
							}
						}

						lines.push(theme.fg("accent", "─".repeat(renderWidth)));

						// Tab bar (multi-question only)
						if (isMulti) {
							const tabs: string[] = ["← "];
							for (let i = 0; i < questions.length; i++) {
								const isActive = i === state.currentTab;
								const answered = isAnswered(questions[i], state);
								const lbl = questions[i].label;
								const box = answered ? "■" : "□";
								const color = answered ? "success" : "muted";
								const text = ` ${box} ${lbl} `;
								const styled = isActive
									? theme.bg("selectedBg", theme.fg("text", text))
									: theme.fg(color, text);
								tabs.push(`${styled} `);
							}
							const canSubmit = allRequiredAnswered(questions, state);
							const isSubmitTab = state.currentTab === questions.length;
							const submitText = " ✓ Submit ";
							const submitStyled = isSubmitTab
								? theme.bg("selectedBg", theme.fg("text", submitText))
								: theme.fg(canSubmit ? "success" : "dim", submitText);
							tabs.push(`${submitStyled} →`);
							addWrappedWithPrefix(" ", tabs.join(""));
							lines.push("");
						}

						function renderOptions() {
							const question = currentQuestion();
							if (!question) return;
							for (let i = 0; i < opts.length; i++) {
								const opt = opts[i];
								const selected = i === state.cursor;
								const prefix = selected ? theme.fg("accent", "> ") : "  ";
								let label: string;
								let color: ThemeColor;
								if (opt.kind === "other") {
									label = `Type something.${state.inputMode ? " ✎" : ""}`;
									color = selected || state.inputMode ? "accent" : "text";
								} else if (opt.kind === "custom") {
									label = `(custom) ${opt.text}`;
									color = "accent";
								} else if (question.type === "multiple") {
									const checked = state.multiple.get(question.id)?.has(opt.index) ?? false;
									label = `${checked ? "[x]" : "[ ]"} ${question.options[opt.index].label}`;
									color = checked ? "success" : "text";
								} else {
									label = `${opt.index + 1}. ${question.options[opt.index].label}`;
									color = selected ? "accent" : "text";
								}
								addWrappedWithPrefix(prefix, theme.fg(color, label));
								if (opt.kind === "option") {
									const description = question.options[opt.index].description;
									if (description) {
										addWrappedWithPrefix("     ", theme.fg("muted", description));
									}
								}
							}
						}

						if (state.inputMode && q) {
							addWrappedWithPrefix(" ", theme.fg("text", q.prompt));
							lines.push("");
							renderOptions();
							lines.push("");
							addWrappedWithPrefix(" ", theme.fg("muted", "Your answer:"));
							for (const line of editor.render(Math.max(1, renderWidth - 2))) {
								lines.push(` ${line}`);
							}
							lines.push("");
							addWrappedWithPrefix(" ", theme.fg("dim", "Enter to submit • Esc to cancel"));
						} else if (state.currentTab === questions.length) {
							addWrappedWithPrefix(" ", theme.fg("accent", theme.bold("Ready to submit")));
							lines.push("");
							const answers = collectAnswers(questions, state);
							for (const question of questions) {
								const answer = answers.find((a) => a.id === question.id);
								if (answer) {
									const summary = answer.items
										.map((item) => (item.custom ? `(wrote) ${item.label}` : item.label))
										.join(", ");
									addWrappedWithPrefix(
										" ",
										`${theme.fg("muted", `${question.label}: `)}${theme.fg("text", summary)}`,
									);
								}
							}
							lines.push("");
							if (allRequiredAnswered(questions, state)) {
								addWrappedWithPrefix(" ", theme.fg("success", "Press Enter to submit"));
							} else {
								const missing = questions
									.filter((question) => question.required && !isAnswered(question, state))
									.map((question) => question.label)
									.join(", ");
								addWrappedWithPrefix(" ", theme.fg("warning", `Unanswered: ${missing}`));
							}
						} else if (q) {
							addWrappedWithPrefix(" ", theme.fg("text", q.prompt));
							lines.push("");
							renderOptions();
						}

						lines.push("");
						if (!state.inputMode) {
							if (state.currentTab === questions.length) {
								addWrappedWithPrefix(" ", theme.fg("dim", "Enter to submit • Esc to go back"));
							} else {
								const help = isMulti
									? "Tab/←→ navigate • ↑↓ select • Space toggle • Enter confirm • Esc cancel"
									: "↑↓ navigate • Enter select • Esc cancel";
								addWrappedWithPrefix(" ", theme.fg("dim", help));
							}
						}
						lines.push(theme.fg("accent", "─".repeat(renderWidth)));

						cachedLines = lines;
						return lines;
					}

					return {
						render,
						invalidate: () => {
							cachedLines = undefined;
						},
						handleInput,
					};
				});
			} else if (ctx.hasUI) {
				const ui: DialogUI = {
					select: (title, options) => ctx.ui.select(title, options),
					input: (title, placeholder) => ctx.ui.input(title, placeholder),
				};
				const flow = await runDialogFlow(questions, ui);
				result = { questions, answers: flow.answers, cancelled: flow.cancelled };
			} else {
				return errorResult("Error: UI not available (running in non-interactive mode)");
			}

			if (result.cancelled) {
				return {
					content: [{ type: "text", text: "User cancelled the questions" }],
					details: result,
				};
			}

			return {
				content: [{ type: "text", text: formatAnswers(questions, result.answers) }],
				details: result,
			};
		},

		renderCall(args, theme, _context) {
			const qs = (args.questions ?? []) as AskQuestionParams["questions"];
			const count = qs.length;
			const labels = qs.map((q, i) => q.label || `Q${i + 1}`).join(", ");
			let text = theme.fg("toolTitle", theme.bold("ask_question "));
			text += theme.fg("muted", `${count} question${count !== 1 ? "s" : ""}`);
			if (labels) {
				text += theme.fg("dim", ` (${labels})`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as QuestionResult | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			if (details.cancelled) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}
			const lines = details.answers.map((answer) => {
				const question = details.questions.find((q) => q.id === answer.id);
				const label = question?.label ?? answer.id;
				const parts = answer.items.map((item) => (item.custom ? `(wrote) ${item.label}` : item.label)).join(", ");
				return `${theme.fg("success", "✓ ")}${theme.fg("accent", label)}: ${parts}`;
			});
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
