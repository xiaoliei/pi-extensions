/**
 * Parse <proposed_plan>...</proposed_plan> blocks from assistant text.
 * Pure functions, no pi imports — directly unit-testable.
 */

// Opening/closing tags must each be on their own line (surrounding whitespace tolerated).
const OPEN_RE = /^[ \t]*<proposed_plan>[ \t]*$/;
const CLOSE_RE = /^[ \t]*<\/proposed_plan>[ \t]*$/;

/** Returns the content of the last complete block, or undefined when no complete block exists. */
export function extractProposedPlan(text: string): string | undefined {
	const lines = text.split(/\r?\n/);
	let content: string[] | undefined;
	for (let i = 0; i < lines.length; i++) {
		if (OPEN_RE.test(lines[i])) {
			const close = lines.slice(i + 1).findIndex((l) => CLOSE_RE.test(l));
			if (close === -1) continue; // unclosed block: ignore
			content = lines.slice(i + 1, i + 1 + close);
			i += close + 1;
		}
	}
	return content?.join("\n");
}
