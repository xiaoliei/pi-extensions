# Plan mode behavior

- `/plan` toggles planning. `/plan <task>` enables planning if needed and starts a turn with `<task>`; when already planning it starts another turn without disabling planning.
- Planning exposes built-in read tools, question tools, verified read-only pi-lens tools, and installed third-party subagent tools discovered from the current tool catalog. All other tools are blocked at call time.
- Pi-lens navigation is restricted to query operations. Rename, server commands, code replacement, diagnostic marking, and `apply: true` are blocked even if another extension activates the tools.
- A third-party subagent requires TUI consent before its first planning call. The dialog identifies the tool, extension source, selected mode, and possible write access. The user may allow this call, trust that tool and source globally, or deny. Noninteractive calls fail closed. Trust is invalid when the source changes.
- Independent subagent research may run concurrently only when the selected tool supports parallel calls or batch tasks. Ordinary agents receive explicit read-only research instructions; their own tool permissions remain authoritative.
- The planning prompt and automatic implementation follow-up sent to the model are English. User-facing dialog labels may remain Chinese.
- A complete proposed plan triggers the existing implementation confirmation dialog. Declining leaves planning active.
