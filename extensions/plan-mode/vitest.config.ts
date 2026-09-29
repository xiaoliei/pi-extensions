import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Alias host modules to the published upstream packages installed as
// devDependencies - same modules pi's loader injects at runtime.
const resolveEntry = (name: string) =>
	fileURLToPath(new URL(`./node_modules/${name}/dist/index.js`, import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
		silent: "passed-only",
	},
	resolve: {
		alias: [
			{ find: /^@mariozechner\/pi-coding-agent$/, replacement: resolveEntry("@earendil-works/pi-coding-agent") },
			{ find: /^@mariozechner\/pi-tui$/, replacement: resolveEntry("@earendil-works/pi-tui") },
		],
	},
});
