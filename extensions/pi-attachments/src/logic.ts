/**
 * Pi attachments extension - pure logic.
 *
 * Zero pi imports so this module is testable with plain `node --test`.
 */

/** One queued attachment waiting to be attached to the next user message. */
export interface Attachment {
	kind: "image" | "file";
	/** Absolute path (for clipboard screenshots this is the temp file we wrote). */
	path: string;
	/** Base64 payload, only set for image attachments. */
	base64?: string;
	/** MIME type, only set for image attachments. */
	mimeType?: string;
}

/** Result of transforming a prompt for submission. */
export interface TransformResult {
	text: string;
	images: { type: "image"; mimeType: string; data: string }[];
}

/** Image extensions recognized by the fallback path scanner. */
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);

/** Threshold above which images are sent as file paths instead of base64.
 * Measured on the base64 payload length (= 4/3 of the raw file size), so a
 * ~3MB raw image already degrades. */
export const MAX_IMAGE_BASE64_BYTES = 4 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Magic-number MIME detection
// ---------------------------------------------------------------------------

function startsWithAscii(buffer: Uint8Array, offset: number, ascii: string): boolean {
	for (let i = 0; i < ascii.length; i++) {
		if (buffer[offset + i] !== ascii.charCodeAt(i)) return false;
	}
	return true;
}

function startsWith(buffer: Uint8Array, bytes: number[]): boolean {
	if (buffer.length < bytes.length) return false;
	return bytes.every((b, i) => buffer[i] === b);
}

/** Detect a supported image MIME type from file magic bytes, or null. */
export function detectImageMimeType(buffer: Uint8Array): string | null {
	if (startsWith(buffer, [0xff, 0xd8, 0xff])) return "image/jpeg";
	if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
	if (startsWithAscii(buffer, 0, "GIF8")) return "image/gif";
	if (startsWithAscii(buffer, 0, "RIFF") && startsWithAscii(buffer, 8, "WEBP")) return "image/webp";
	if (startsWith(buffer, [0x42, 0x4d])) return "image/bmp";
	return null;
}

export function hasImageExtension(path: string): boolean {
	const lastDot = path.lastIndexOf(".");
	const lastSep = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	if (lastDot === -1 || lastDot < lastSep) return false;
	return IMAGE_EXTENSIONS.has(path.slice(lastDot).toLowerCase());
}

// ---------------------------------------------------------------------------
// Path token extraction from prompt text
// ---------------------------------------------------------------------------

/** Split prompt text into whitespace-separated tokens, preserving offsets. */
export function tokenizeText(text: string): { token: string; start: number; end: number }[] {
	const result: { token: string; start: number; end: number }[] = [];
	const re = /\S+/g;
	for (const match of text.matchAll(re)) {
		const start = match.index ?? 0;
		result.push({ token: match[0], start, end: start + match[0].length });
	}
	return result;
}

/**
 * Find whitespace-delimited tokens in `text` that look like image paths
 * (image extension + file exists). Returns tokens with document-char offsets
 * plus line-relative offsets, so removal can stay line-scoped.
 *
 * `fileExists` is injected for testability.
 */
export function findImagePathTokens(
	text: string,
	fileExists: (path: string) => boolean = () => false,
): { path: string; start: number; end: number; lineIndex: number; lineStart: number }[] {
	const result: { path: string; start: number; end: number; lineIndex: number; lineStart: number }[] = [];
	for (const { token, start, end } of tokenizeText(text)) {
		// Strip surrounding quotes (some terminals wrap dropped paths).
		const stripped = token.replace(/^["']|["']$/g, "");
		if (!hasImageExtension(stripped)) continue;
		if (!fileExists(stripped)) continue;
		result.push({ path: stripped, start, end, ...lineOffsetFor(text, start) });
	}
	return result;
}

function lineOffsetFor(text: string, charOffset: number): { lineIndex: number; lineStart: number } {
	let lineIndex = 0;
	let lineStart = 0;
	for (let i = 0; i < charOffset; i++) {
		if (text.charCodeAt(i) === 10) {
			lineIndex++;
			lineStart = i + 1;
		}
	}
	return { lineIndex, lineStart };
}

/**
 * Remove [start, end) ranges from text. Only lines that actually lost a range
 * get their whitespace collapsed; untouched lines keep their exact formatting
 * (code indentation, tables). Offsets are line-relative: start/end are indexes
 * into the line's own content.
 */
export function removeRangesFromLines(
	text: string,
	ranges: { lineIndex: number; start: number; end: number }[],
): string {
	if (ranges.length === 0) return text;
	const lines = text.split("\n");
	const byLine = new Map<number, { start: number; end: number }[]>();
	for (const { lineIndex, start, end } of ranges) {
		const list = byLine.get(lineIndex) ?? [];
		list.push({ start, end });
		byLine.set(lineIndex, list);
	}
	for (const [lineIndex, lineRanges] of byLine) {
		const line = lines[lineIndex];
		if (line === undefined) continue;
		let out = "";
		let pos = 0;
		for (const range of [...lineRanges].sort((a, b) => a.start - b.start)) {
			out += line.slice(pos, range.start);
			pos = range.end;
		}
		out += line.slice(pos);
		lines[lineIndex] = out.replace(/[ \t]+$/g, "").replace(/[ \t]{2,}/g, " ");
	}
	return lines.join("\n").trim();
}

// ---------------------------------------------------------------------------
// Bracketed paste parsing (drag & drop / terminal paste)
// ---------------------------------------------------------------------------

/**
 * Parse the content of a bracketed paste into existing file paths plus
 * leftover text. Tries the whole trimmed string first (paths with spaces),
 * then splits on whitespace. Returns null when nothing looks like a file.
 */
export function parsePastePaths(
	content: string,
	fileExists: (path: string) => boolean = () => false,
): { paths: string[]; rest: string } | null {
	const trimmed = content.trim();
	if (!trimmed) return null;

	// Whole string as one path (handles spaces in filenames and terminal quoting).
	const unquoted = trimmed.replace(/^["']|["']$/g, "");
	if (fileExists(unquoted)) {
		return { paths: [unquoted], rest: "" };
	}

	// Token-wise: consecutive path tokens are collected, others go to rest.
	const tokens = tokenizeText(trimmed);
	const paths: string[] = [];
	const restTokens: string[] = [];
	for (const { token } of tokens) {
		const stripped = token.replace(/^["']|["']$/g, "");
		if (fileExists(stripped)) {
			paths.push(stripped);
		} else {
			restTokens.push(token);
		}
	}
	if (paths.length === 0) return null;
	return { paths, rest: restTokens.join(" ") };
}

// ---------------------------------------------------------------------------
// Clipboard URI list (Linux file copies)
// ---------------------------------------------------------------------------

/** Parse a text/uri-list payload into local file paths. */
export function parseUriList(payload: string): string[] {
	const result: string[] = [];
	for (const line of payload.split(/\r?\n/)) {
		const uri = line.trim();
		if (!uri || uri.startsWith("#")) continue;
		if (!uri.startsWith("file://")) continue;
		try {
			const p = decodeURIComponent(new URL(uri).pathname);
			// Windows-over-WSL URIs like file:///C:/foo look like /C:/foo - strip leading slash.
			const normalized = /^\/[A-Za-z]:\//.test(p) ? p.slice(1) : p;
			if (normalized) result.push(normalized);
		} catch {
			// Malformed URI - skip.
		}
	}
	return result;
}

// ---------------------------------------------------------------------------
// Submission transform
// ---------------------------------------------------------------------------

export interface ModelCapabilities {
	/** Whether the current model accepts image input. */
	vision: boolean;
}

/**
 * Build the submission payload from queued attachments plus a fallback scan
 * of the prompt text.
 *
 * Rules:
 * - image attachments on vision models, up to MAX_IMAGE_BASE64_BYTES -> base64 ImageContent
 * - non-vision models, oversized images, unreadable files -> absolute path appended to text
 * - file attachments -> absolute path appended to text
 * - existing image-path tokens in the text are lifted into attachments with the same rules
 *
 * Returns the cleaned text, the image blocks to attach, and human-readable
 * fallback notes (for notify).
 */
export function buildSubmission(
	text: string,
	attachments: Attachment[],
	model: ModelCapabilities,
	deps: {
		fileExists: (path: string) => boolean;
		readFileBase64: (path: string) => { base64: string; mimeType: string } | null;
		makeAbsolute: (path: string) => string;
	},
): { result: TransformResult; fallbackNotes: string[] } {
	const images: TransformResult["images"] = [];
	const pathLines: string[] = [];
	const fallbackNotes: string[] = [];
	const handledPaths = new Set<string>();

	const addPathFallback = (path: string, reason: string) => {
		const absolute = deps.makeAbsolute(path);
		if (!pathLines.includes(absolute)) pathLines.push(absolute);
		fallbackNotes.push(reason);
	};

	const addImageOrFallback = (att: Attachment) => {
		if (handledPaths.has(att.path)) return;
		handledPaths.add(att.path);
		if (!model.vision) {
			addPathFallback(att.path, "Model does not support images; attached as file path");
			return;
		}
		const loaded = deps.readFileBase64(att.path);
		if (!loaded) {
			// BMP or undetectable formats are not sent inline (providers reject them).
			addPathFallback(att.path, "Image format not supported inline; attached as file path");
			return;
		}
		if (loaded.base64.length > MAX_IMAGE_BASE64_BYTES) {
			addPathFallback(att.path, "Image exceeds 4MB; attached as file path (agent can read it)");
			return;
		}
		images.push({ type: "image", mimeType: loaded.mimeType, data: loaded.base64 });
	};

	// Queued image attachments first.
	for (const att of attachments) {
		if (att.kind === "image") {
			addImageOrFallback(att);
		} else {
			addPathFallback(att.path, "");
		}
	}

	// Fallback scan: image path tokens already in the text (deduped by path).
	const tokens = findImagePathTokens(text, deps.fileExists);
	const lineRanges = tokens.map((t) => ({
		lineIndex: t.lineIndex,
		start: t.start - t.lineStart,
		end: t.end - t.lineStart,
	}));
	for (const token of tokens) {
		addImageOrFallback({ kind: "image", path: token.path });
	}

	let cleaned = removeRangesFromLines(text, lineRanges);

	// Append fallback paths that are not already mentioned in the remaining text.
	const appended: string[] = [];
	for (const line of pathLines) {
		if (!cleaned.includes(line)) appended.push(line);
	}
	if (appended.length > 0) {
		cleaned = `${cleaned}${cleaned ? "\n" : ""}[attached files]\n${appended.join("\n")}`;
	}

	return { result: { text: cleaned, images }, fallbackNotes: [...new Set(fallbackNotes.filter(Boolean))] };
}
