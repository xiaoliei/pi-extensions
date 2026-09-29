import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	type Attachment,
	buildSubmission,
	detectImageMimeType,
	findImagePathTokens,
	hasImageExtension,
	parsePastePaths,
	parseUriList,
	removeRangesFromLines,
	tokenizeText,
} from "../src/logic.ts";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const GIF = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const BMP = Uint8Array.from([0x42, 0x4d, 0x00, 0x00]);
const WEBP = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
const TEXT = Uint8Array.from([0x68, 0x69]);

test("detectImageMimeType: magic numbers", () => {
	assert.equal(detectImageMimeType(PNG), "image/png");
	assert.equal(detectImageMimeType(JPEG), "image/jpeg");
	assert.equal(detectImageMimeType(GIF), "image/gif");
	assert.equal(detectImageMimeType(BMP), "image/bmp");
	assert.equal(detectImageMimeType(WEBP), "image/webp");
	assert.equal(detectImageMimeType(TEXT), null);
	assert.equal(detectImageMimeType(new Uint8Array(0)), null);
});

test("hasImageExtension: case-insensitive, rejects non-image and bare dots", () => {
	assert.equal(hasImageExtension("a.PNG"), true);
	assert.equal(hasImageExtension("dir.x/b.jpeg"), true);
	assert.equal(hasImageExtension("a.txt"), false);
	assert.equal(hasImageExtension("noext"), false);
	assert.equal(hasImageExtension("dir.d/file"), false);
});

test("tokenizeText: offsets survive multiple spaces", () => {
	const tokens = tokenizeText("look at   a.png now");
	assert.deepEqual(
		tokens.map((t) => t.token),
		["look", "at", "a.png", "now"],
	);
	const aPng = tokens[2];
	assert.ok(aPng);
	assert.equal("look at   a.png now".slice(aPng.start, aPng.end), "a.png");
});

test("findImagePathTokens: strips quotes, requires existence", () => {
	const paths = new Set(["/tmp/a.png"]);
	const exists = (p: string) => paths.has(p);
	const tokens = findImagePathTokens('see "/tmp/a.png" and /tmp/b.png', exists);
	assert.equal(tokens.length, 1);
	assert.equal(tokens[0]?.path, "/tmp/a.png");
});

test("removeRangesFromLines: removes tokens, collapses only affected lines", () => {
	assert.equal(removeRangesFromLines("look at /tmp/a.png now", [{ lineIndex: 0, start: 8, end: 18 }]), "look at now");
	assert.equal(
		removeRangesFromLines("/tmp/a.png /tmp/b.png", [
			{ lineIndex: 0, start: 0, end: 10 },
			{ lineIndex: 0, start: 11, end: 21 },
		]),
		"",
	);
	assert.equal(removeRangesFromLines("no ranges here", []), "no ranges here");
	// Untouched lines keep their formatting (tables, indentation).
	const multi = "| a | b |\nlook /tmp/a.png here\n    indented code";
	assert.equal(
		removeRangesFromLines(multi, [{ lineIndex: 1, start: 5, end: 15 }]),
		"| a | b |\nlook here\n    indented code",
	);
});

test("parsePastePaths: whole-string path with spaces wins", () => {
	const paths = new Set(["/home/u/my image.png"]);
	const exists = (p: string) => paths.has(p);
	const parsed = parsePastePaths('"/home/u/my image.png"', exists);
	assert.deepEqual(parsed?.paths, ["/home/u/my image.png"]);
	assert.equal(parsed?.rest, "");
});

test("parsePastePaths: token split with leftover text", () => {
	const paths = new Set(["/tmp/a.png"]);
	const exists = (p: string) => paths.has(p);
	const parsed = parsePastePaths("/tmp/a.png explain this", exists);
	assert.deepEqual(parsed?.paths, ["/tmp/a.png"]);
	assert.equal(parsed?.rest, "explain this");
});

test("parsePastePaths: no files returns null", () => {
	assert.equal(
		parsePastePaths("just some text", () => false),
		null,
	);
	assert.equal(
		parsePastePaths("   ", () => false),
		null,
	);
});

test("parseUriList: file URIs, comments, decode", () => {
	const payload = "# comment\nfile:///home/u/a%20b.png\nhttps://example.com/x\nfile:///C:/Users/u/c.png";
	assert.deepEqual(parseUriList(payload), ["/home/u/a b.png", "C:/Users/u/c.png"]);
	assert.deepEqual(parseUriList("not-a-uri"), []);
});

// ---------------------------------------------------------------------------
// buildSubmission
// ---------------------------------------------------------------------------

function makeDeps(files: Map<string, Uint8Array>) {
	return {
		fileExists: (p: string) => files.has(p),
		readFileBase64: (p: string) => {
			const bytes = files.get(p);
			if (!bytes) return null;
			const mime = detectImageMimeType(bytes);
			if (!mime || mime === "image/bmp") return null;
			return { base64: Buffer.from(bytes).toString("base64"), mimeType: mime };
		},
		makeAbsolute: (p: string) => (p.startsWith("/") ? p : `/abs/${p}`),
	};
}

test("buildSubmission: vision model turns image attachment into ImageContent", () => {
	const att: Attachment = { kind: "image", path: "/tmp/a.png" };
	const { result, fallbackNotes } = buildSubmission(
		"describe this",
		[att],
		{ vision: true },
		makeDeps(new Map([["/tmp/a.png", PNG]])),
	);
	assert.equal(result.text, "describe this");
	assert.equal(result.images.length, 1);
	assert.equal(result.images[0]?.mimeType, "image/png");
	assert.deepEqual(fallbackNotes, []);
});

test("buildSubmission: non-vision model degrades to file path", () => {
	const att: Attachment = { kind: "image", path: "/tmp/a.png" };
	const { result, fallbackNotes } = buildSubmission(
		"describe this",
		[att],
		{ vision: false },
		makeDeps(new Map([["/tmp/a.png", PNG]])),
	);
	assert.equal(result.images.length, 0);
	assert.ok(result.text.includes("/tmp/a.png"));
	assert.ok(result.text.includes("[attached files]"));
	assert.equal(fallbackNotes.length, 1);
});

test("buildSubmission: file attachment appends path on any model", () => {
	const att: Attachment = { kind: "file", path: "/tmp/notes.txt" };
	const { result } = buildSubmission("summarize", [att], { vision: true }, makeDeps(new Map()));
	assert.equal(result.images.length, 0);
	assert.ok(result.text.includes("/tmp/notes.txt"));
});

test("buildSubmission: oversized image degrades to path", () => {
	const bigPng = new Uint8Array(4 * 1024 * 1024 + 2);
	bigPng.set(PNG.slice(0, 8), 0);
	const att: Attachment = { kind: "image", path: "/tmp/big.png" };
	const { result, fallbackNotes } = buildSubmission(
		"look",
		[att],
		{ vision: true },
		makeDeps(new Map([["/tmp/big.png", bigPng]])),
	);
	assert.equal(result.images.length, 0);
	assert.ok(result.text.includes("/tmp/big.png"));
	assert.ok(fallbackNotes.some((n) => n.includes("4MB")));
});

test("buildSubmission: unreadable image degrades to path", () => {
	const att: Attachment = { kind: "image", path: "/tmp/gone.png" };
	const { result, fallbackNotes } = buildSubmission("look", [att], { vision: true }, makeDeps(new Map()));
	assert.equal(result.images.length, 0);
	assert.ok(result.text.includes("/tmp/gone.png"));
	assert.ok(fallbackNotes.some((n) => n.includes("not supported inline")));
});

test("buildSubmission: duplicate path token is attached once", () => {
	const { result } = buildSubmission(
		"check /tmp/a.png and /tmp/a.png",
		[],
		{ vision: true },
		makeDeps(new Map([["/tmp/a.png", PNG]])),
	);
	assert.equal(result.images.length, 1);
	assert.equal(result.text, "check and");
});

test("buildSubmission: lifts image path tokens out of text", () => {
	const { result } = buildSubmission(
		"check /tmp/inline.png please",
		[],
		{ vision: true },
		makeDeps(new Map([["/tmp/inline.png", PNG]])),
	);
	assert.equal(result.text, "check please");
	assert.equal(result.images.length, 1);
});

test("buildSubmission: text path token on non-vision stays in text as path", () => {
	const { result } = buildSubmission(
		"check /tmp/inline.png please",
		[],
		{ vision: false },
		makeDeps(new Map([["/tmp/inline.png", PNG]])),
	);
	assert.equal(result.images.length, 0);
	// Token removed from original position, path preserved via [attached files].
	assert.ok(!result.text.includes("check /tmp/inline.png please"));
	assert.ok(result.text.includes("/tmp/inline.png"));
});

test("buildSubmission: dedupes appended paths already in text", () => {
	const att: Attachment = { kind: "file", path: "/tmp/notes.txt" };
	const { result } = buildSubmission("read /tmp/notes.txt", [att], { vision: true }, makeDeps(new Map()));
	const occurrences = result.text.split("/tmp/notes.txt").length - 1;
	assert.equal(occurrences, 1);
});

test("buildSubmission: no attachments and no tokens returns text unchanged", () => {
	const { result, fallbackNotes } = buildSubmission("plain prompt", [], { vision: true }, makeDeps(new Map()));
	assert.equal(result.text, "plain prompt");
	assert.equal(result.images.length, 0);
	assert.deepEqual(fallbackNotes, []);
});

// ---------------------------------------------------------------------------
// Integration shape: real temp files on disk
// ---------------------------------------------------------------------------

test("classifyPath-style flow with real files on disk", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-att-test-"));
	try {
		const pngPath = join(dir, "shot.png");
		writeFileSync(pngPath, PNG);
		const txtPath = join(dir, "note.txt");
		writeFileSync(txtPath, "hello");

		assert.ok(hasImageExtension(pngPath));
		const tokens = findImagePathTokens(`look at ${pngPath}`, (p) => p === pngPath);
		assert.equal(tokens.length, 1);
		assert.equal(tokens[0]?.path, pngPath);
		assert.equal(txtPath.endsWith(".txt"), true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
