# Plan Mode Extension Package

Planning workflow: `/plan` enters plan mode, blocks built-in code writes, and guides the model through environment exploration, intent confirmation, and design refinement. Authorized third-party extensions may update their own state, including Todo lists. The model outputs a formal plan in a `<proposed_plan>` Markdown block; afterwards a dialog asks whether to execute it - confirming exits plan mode and starts implementation automatically.

Compatible with both original pi (`@earendil-works`) and the customized fork (`@xiaoliyo`) - imports use the `@mariozechner` scope that both extension loaders alias to their host modules.

## Commands

- `/plan` - toggle plan mode
- `/plan <task>` - enable plan mode if needed and start a planning turn with the task
- `--plan` - start in plan mode
- `Ctrl+Alt+P` - toggle plan mode

## What is allowed in plan mode

- Read-only built-in tools: `read`, `grep`, `find`, `ls`, `bash` (read-only command allowlist)
- Question tools: `ask_question` (from `@xiaoliyo/pi-ask-question`), `question`, `questionnaire`
- Installed third-party subagent tools discovered from pi's current tool catalog, after one TUI consent dialog that lists the extension's available tools. The dialog can remember all read-only tools from that extension or all tools from that extension, including write tools.
- Todo/task-list tools discovered from the current catalog. Their first planning call uses the same third-party extension consent dialog and source-based trust choices.
- Read-only tools exposed by the trusted `pi-lens` extension, including `module_report`, `project_report`, `symbol_search`, `read_symbol`, `read_enclosing`, `lens_diagnostics`, and LSP query operations

Everything else is hidden via `setActiveTools` and blocked in `tool_call` (including tools activated later by other extensions). Pi-lens write tools and LSP mutations are blocked.

Third-party subagent and Todo consent displays the tool, source, selected mode if applicable, every discovered tool from that extension, and each tool's possible write-access risk. Noninteractive calls without prior global consent are blocked. Trust is tied to the extension source and path; a change requires renewed consent. The trust record is stored under the global pi agent directory. Subagent work runs concurrently only when the third-party tool supports parallel calls or batch tasks.

## Extending the whitelist

Pi-lens read-only tools are discovered by extension source; write tools remain explicitly blocked.

## Bash command filtering

A command must match a read-only prefix allowlist (cat/head/grep/find/git status/...) and not hit any destructive pattern (rm/mv/cp/tee/`>` redirection/npm install/git commit/curl -o/find -delete/...). This is a heuristic guard, not a sandbox.

## Workflow injected into the model

1. Explore the actual environment first: resolve discoverable facts (files, entry points, interfaces, tests) by reading and searching, not by asking the user. Check available third-party subagent modes or templates and prefer a read-only option.
2. Confirm intent through dialogue: goal, success criteria, scope, constraints, preferences. Only ask what cannot be inferred from the repo; preference questions offer 2-4 mutually exclusive options with a recommended default (via `ask_question` when installed, otherwise numbered text options).
3. Refine the design until decision-complete (approach, modules, interfaces, edge cases, test strategy, acceptance criteria).
4. Output the final plan once, wrapped in `<proposed_plan>` ... `</proposed_plan>` tags (each tag on its own line, Markdown inside). Plan revisions are always emitted as a complete new plan.

For substantial planning work, the model inspects the current tool catalog for Todo capabilities and requests consent on first use. It tracks separate research areas and synthesis when approved, and continues without Todo when unavailable or denied.

When a turn ends with a complete `proposed_plan` block while plan mode is on, a dialog asks whether to execute the plan:

- "是，实施此计划" - exits plan mode (tools restored) and sends the execution prompt automatically.
- The execution prompt references the existing approved plan without repeating it and suggests using available Todo, subagent, and verification tools when useful.
- "否，告诉 PI 应该如何做的不同" - stays in plan mode; the user replies with corrections and the model emits a full new plan.

The dialog only appears in TUI mode, is skipped when messages are already queued, and never fires after plan mode is off.

## Tests

```bash
npm test   # from packages/plan-mode
```
