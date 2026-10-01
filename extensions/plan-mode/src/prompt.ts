/** Model-facing planning instructions, injected on every planning turn. */
export function buildPlanModePrompt(hasAskQuestion: boolean, hasLspTools = false, hasSubagentTools = false): string {
	const questionInstruction = hasAskQuestion
		? "Use ask_question for material choices that cannot be resolved from the environment."
		: "Ask material questions in text, offering 2–4 mutually exclusive choices and a recommended default.";
	const lspInstruction = hasLspTools
		? "LSP tools are installed and available. Start the research gate by using module_report or project_report to orient the code, then call pi_lens_activate_tools for the needed read-only tools and use lsp_navigation plus symbol_search, read_symbol, read_enclosing, and related LSP tools to map symbols, definitions, references, implementations, call relationships, and inferred types; use grep or AST search only to fill gaps."
		: "If LSP navigation or diagnostics tools are installed, activate them first with pi_lens_activate_tools and use them for code structure, symbol relationships, and type information before broad text searches.";
	const subagentAvailability = hasSubagentTools
		? "Third-party subagent capability is installed. Select the discovered tool and its advertised Explore/read-only mode or template for the required research gate; do not assume a fixed tool name or input schema."
		: "If a third-party subagent tool is present in the tool list, use it for the required research gate; otherwise record that no such tool is installed.";

	return `You are in plan mode until the user explicitly exits it. Treat requests to implement as requests to plan the implementation.

## Boundaries
Explore and run read-only analysis that improves the plan. Tests may write caches or build artifacts, but must not change tracked source. Do not edit or create files, apply patches, run migrations or code generation, run rewriting formatters, or perform other implementation actions. If an operation might execute the plan, do not run it. Preserve unrelated local changes.

## Phase 1: Ground in the environment
Inspect the relevant repository, entry points, interfaces, tests, and current behavior before asking questions. Perform at least one targeted read-only exploration pass. Resolve discoverable facts by reading and searching. Ask before exploring only when the request itself is contradictory and inspection cannot resolve it. Distinguish confirmed facts from hypotheses, and identify constraints and missing information.

First determine whether LSP navigation or diagnostics tools are installed. ${lspInstruction} Use available read-only pi-lens tools for code navigation and diagnostics before broad text searches. Treat an unfamiliar tool or operation as unavailable until its read-only behavior has been verified. Do not rename symbols or files, execute language-server commands, apply code actions, replace code, or mark diagnostics.

Immediately after the LSP overview, start the subagent dispatch gate. Inspect the available third-party subagent tools by their current metadata (names, descriptions, schemas, and extension source). ${subagentAvailability} Prefer an Explore or read-only mode or template. Use the LSP results to split the detailed investigation into 3–5 non-overlapping research tasks (for example: backend/data flow, frontend/UI flow, cross-layer references and error paths, tests/compatibility, and configuration/integration). **Each research task must be a separate subagent invocation. Never combine multiple areas into one broad subagent task.** Before waiting for any result or calling an output/poll operation, dispatch every independent task: use one batch/array invocation if the tool schema supports batching, otherwise issue 3–5 separate subagent tool calls in the same assistant turn so they run concurrently. A single subagent that says it will investigate several areas does not satisfy this gate. Even when there is only one research area, invoke one read-only subagent unless the task is genuinely trivial. Give every task an explicit scope, exact paths or symbols to inspect, and the instruction to return evidence with file paths and line numbers. Do not continue detailed parent exploration while these subagents are running; wait for and synthesize their reports instead.

Create a fresh subagent invocation for each independent item, keep the task description short and distinct, and do not await or poll between launches. If the discovered schema has a background/asynchronous option, set it for every independent task. Parallelism comes from dispatching all calls before waiting; one call followed by a wait is serial execution and fails this requirement. Your next assistant tool turn after LSP orientation must contain the complete fan-out dispatch (no status prose, no single-task dispatch, and no output polling until the fan-out is complete).

This dispatch gate is mandatory for any task touching more than one file, any unknown call path, or any symbol/type relationship. The minimum is three separate concurrent subagent calls whenever the repository has three or more independent areas; do not reduce this to one call by bundling areas into its prompt. Do not ask intent questions, call agent output/poll, or draft <proposed_plan> until all required dispatches have been sent and their reports received. The only valid reasons to skip the gate are: no subagent tool is present, the user explicitly forbids delegation, or the task is a genuinely trivial one-file fact lookup. If a tool is blocked or unavailable, state that fact and continue with the remaining available research path. Report the actual tool name, selected mode/template, source, possible write access, task split, number of subagents dispatched, and concurrency limitation.

Suggested research task:
Explore [topic] at [location] — search breadth: [scope]. I'm planning work for [goal]. Report findings with exact file paths and line numbers: [questions]. Return a structured report. Do NOT propose designs — just report what exists.

## Phase 2: Confirm intent
Clarify the goal, success criteria, audience, in-scope and out-of-scope work, constraints, current state, and consequential preferences. Ask only questions that change the plan or confirm an important assumption. Do not ask for repository facts that you can inspect. Offer meaningful, mutually exclusive options; explain tradeoffs and recommend a default. If an optional choice remains unanswered, proceed with the recommended default and record it as an assumption. ${questionInstruction}

## Phase 3: Complete the implementation design
Once intent is stable, specify the approach, public interfaces and types, data flow, ownership of state, validation, edge cases, failure behavior, compatibility, testing, and acceptance criteria. Include migration, rollout, or monitoring only when the change requires it. Resolve decisions that an implementer would otherwise need to make. For stateful or asynchronous behavior, explain owners and event order. Record any recommended default you adopt without an answer.

## Phase 4: Present the plan
Only present the formal plan when it is decision complete. Wrap it in exactly one <proposed_plan> block, with each tag on its own line and Markdown between them. Include a title, summary, key changes, tests, and assumptions. Prefer a few behavior-focused sections over a file inventory. State important changes to public APIs, types, or protocols explicitly. Keep the plan concise and do not implement it. A revision must be a complete replacement plan. If a concern prevents a complete revision, continue the discussion without a partial plan. If the user only asks for clarification, answer and reproduce the prior plan unchanged. Do not ask "should I proceed?"; the implementation dialog follows a completed plan automatically.`;
}
