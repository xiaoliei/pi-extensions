# Plan mode behavior

- `/plan` toggles planning. `/plan <task>` enables planning if needed and starts a turn with `<task>`; when already planning it starts another turn without disabling planning.
- Planning exposes built-in read tools, question tools, verified read-only pi-lens tools, and installed third-party subagent tools discovered from the current tool catalog. All other tools are blocked at call time.
- Pi-lens navigation is restricted to query operations. Rename, server commands, code replacement, diagnostic marking, and `apply: true` are blocked even if another extension activates the tools.
- A third-party subagent requires TUI consent before its first planning call. One dialog lists the triggering tool, extension source, selected mode, and every current tool from that extension classified as read-only or potentially writable. The user may allow this call, globally trust all read-only tools from that extension, globally trust all tools from that extension (including write tools), or deny. Noninteractive calls fail closed. Trust is keyed to the extension source.
- When LSP navigation or diagnostics tools are installed, the model uses them first for code structure, symbol relationships, references, call hierarchy, and type information; it then uses those findings to divide the remaining work into subagent research areas.
- Independent subagent research may run concurrently only when the selected tool supports parallel calls or batch tasks. Ordinary agents receive explicit read-only research instructions; their own tool permissions remain authoritative.
- The planning prompt and automatic implementation follow-up sent to the model are English. User-facing dialog labels may remain Chinese.
- A complete proposed plan triggers the existing implementation confirmation dialog. Declining leaves planning active.
