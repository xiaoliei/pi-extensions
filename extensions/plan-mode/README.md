# Plan Mode Extension Package

Read-only planning workflow: `/plan` enters plan mode, blocks all write operations, and guides the model through environment exploration, intent confirmation, and design refinement. The model outputs a formal plan in a `<proposed_plan>` Markdown block; afterwards a dialog asks whether to execute it - confirming exits plan mode and starts implementation automatically.

Compatible with both original pi (`@earendil-works`) and the customized fork (`@xiaoliyo`) - imports use the `@mariozechner` scope that both extension loaders alias to their host modules.

## Commands

- `/plan` - toggle plan mode
- `--plan` - start in plan mode
- `Ctrl+Alt+P` - toggle plan mode

## What is allowed in plan mode

- Read-only built-in tools: `read`, `grep`, `find`, `ls`, `bash` (read-only command allowlist)
- Question tools: `ask_question` (from `@xiaoliyo/pi-ask-question`), `question`, `questionnaire`
- `subagent`: only the `explore` agent, single-task mode (read-only exploration), plus `agent="list"` discovery

Everything else is hidden via `setActiveTools` and hard-blocked in `tool_call` (including write-capable tools registered by other extensions).

## Extending the whitelist

Append read-only tool names to `EXTRA_READONLY_TOOLS` in `src/policy.ts` (e.g. a future `todo` tool), then reload.

## Bash command filtering

A command must match a read-only prefix allowlist (cat/head/grep/find/git status/...) and not hit any destructive pattern (rm/mv/cp/tee/`>` redirection/npm install/git commit/curl -o/find -delete/...). This is a heuristic guard, not a sandbox.

## Workflow injected into the model

1. Explore the actual environment first: resolve discoverable facts (files, entry points, interfaces, tests) by reading and searching, not by asking the user.
2. Confirm intent through dialogue: goal, success criteria, scope, constraints, preferences. Only ask what cannot be inferred from the repo; preference questions offer 2-4 mutually exclusive options with a recommended default (via `ask_question` when installed, otherwise numbered text options).
3. Refine the design until decision-complete (approach, modules, interfaces, edge cases, test strategy, acceptance criteria).
4. Output the final plan once, wrapped in `<proposed_plan>` ... `</proposed_plan>` tags (each tag on its own line, Markdown inside). Plan revisions are always emitted as a complete new plan.

When a turn ends with a complete `proposed_plan` block while plan mode is on, a dialog asks whether to execute the plan:

- "是，实施此计划" - exits plan mode (tools restored) and sends the execution prompt automatically.
- "否，告诉 PI 应该如何做的不同" - stays in plan mode; the user replies with corrections and the model emits a full new plan.

The dialog only appears in TUI mode, is skipped when messages are already queued, and never fires after plan mode is off.

## Tests

```bash
npm test   # from packages/plan-mode
```
