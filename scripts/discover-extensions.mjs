#!/usr/bin/env node
/**
 * Discover pi extensions under extensions/.
 *
 * An extension is any first-level subdirectory of extensions/ containing a
 * valid package.json with a non-empty "name". Used by CI to build the test
 * matrix and to validate release tags, so new extensions are picked up by
 * dropping a folder into extensions/ - no workflow changes.
 *
 * Usage:
 *   node scripts/discover-extensions.mjs --json          print JSON array of extension dir names
 *   node scripts/discover-extensions.mjs --check <name>  exit 0 if <name> is a discovered extension, else 1
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "extensions");

export function discoverExtensions() {
	const found = [];
	if (!existsSync(ROOT)) return found;
	for (const entry of readdirSync(ROOT, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		if (!entry.isDirectory()) continue;
		const pkgPath = join(ROOT, entry.name, "package.json");
		if (!existsSync(pkgPath)) continue;
		try {
			const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
			if (typeof pkg?.name === "string" && pkg.name.trim() !== "") {
				found.push(entry.name);
			}
		} catch {
			// broken JSON: not a valid extension, skip
		}
	}
	return found;
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("discover-extensions.mjs")) {
	const args = process.argv.slice(2);
	if (args[0] === "--json") {
		console.log(JSON.stringify(discoverExtensions()));
	} else if (args[0] === "--check") {
		const name = args[1];
		if (!name) {
			console.error("Usage: discover-extensions.mjs --check <name>");
			process.exit(2);
		}
		if (discoverExtensions().includes(name)) {
			console.log(name);
		} else {
			console.error(`Unknown extension "${name}". Available: ${discoverExtensions().join(", ") || "(none)"}`);
			process.exit(1);
		}
	} else {
		console.error("Usage: discover-extensions.mjs --json | --check <name>");
		process.exit(2);
	}
}
