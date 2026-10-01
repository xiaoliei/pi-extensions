/**
 * Pi attachments extension.
 *
 * Unified attachment tray for the pi coding agent:
 * - Ctrl+V pastes clipboard images (screenshots) or copied files into the tray
 * - Drag & drop / terminal paste of image files goes into the tray
 * - Thumbnails render above the editor (kitty/iTerm graphics, text fallback)
 * - /attachments lists and removes queued attachments
 * - On submit, images become base64 ImageContent for vision models; on
 *   non-vision models they degrade to file paths appended to the prompt
 *
 * Compatible with both pi namespaces: imports use the @mariozechner scope
 * that both extension loaders alias to their host modules.
 */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { Container, Image, Text, type TUI } from "@mariozechner/pi-tui";
import { isKeyRelease, matchesKey, type KeyId } from "@mariozechner/pi-tui";
import { type Attachment, buildSubmission, detectImageMimeType, parsePastePaths, parseUriList } from "./logic.ts";

const WIDGET_ID = "attachments";
const THUMBNAIL_CELLS = 14; // ~7 rows tall; interactive-mode caps widgets at 10 lines
const BRACKETED_PASTE_START = "\x1b[200~";
// Paste shortcuts matched with pi-tui's matchesKey so every terminal encoding is
// covered (legacy \x16, kitty CSI u with/without event-type suffix, modifyOtherKeys).
// Windows: Alt+V is the core default (Ctrl+V is taken by Windows Terminal);
// other platforms: Ctrl+V. Note Windows Terminal intercepts Ctrl+V itself and
// only forwards text pastes, so image-only clipboards need Alt+V there.
const PASTE_SHORTCUTS: KeyId[] =
	process.platform === "win32" ? ["alt+v", "ctrl+v"] : ["ctrl+v"];

type QueueState = {
	attachments: Attachment[];
	/** UI captured from the latest TUI context; undefined in RPC/json/print modes. */
	ui?: ExtensionContext["ui"];
	/** Unsubscribe for the terminal input listener; re-registered per session. */
	unsubInput?: () => void;
};

// One state per extension runtime; cleared on session_start.
const state: QueueState = { attachments: [] };

function runCommand(command: string, args: string[], timeoutMs: number): { ok: boolean; stdout: Buffer } {
	const result = spawnSync(command, args, { timeout: timeoutMs, maxBuffer: 50 * 1024 * 1024, encoding: "buffer" });
	if (result.error || result.status !== 0) return { ok: false, stdout: Buffer.alloc(0) };
	return { ok: true, stdout: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout) };
}

/** Windows / WSL: PowerShell reads the image from the Windows clipboard to a temp PNG. */
function readClipboardImageViaPowerShell(): { path: string } | null {
	const tmpFile = join(tmpdir(), `pi-clip-${randomUUID()}.png`);
	try {
		const winPathResult = runCommand("wslpath", ["-w", tmpFile], 1000);
		const winPath = winPathResult.ok ? winPathResult.stdout.toString("utf-8").trim() : tmpFile;
		const psQuoted = winPath.replaceAll("'", "''");
		const psScript = [
			"Add-Type -AssemblyName System.Windows.Forms",
			"Add-Type -AssemblyName System.Drawing",
			`$path = '${psQuoted}'`,
			"$img = [System.Windows.Forms.Clipboard]::GetImage()",
			"if ($img) { $img.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); Write-Output 'ok' } else { Write-Output 'empty' }",
		].join("; ");
		const result = runCommand("powershell.exe", ["-NoProfile", "-Command", psScript], 5000);
		if (!result.ok || result.stdout.toString("utf-8").trim() !== "ok") return null;
		if (!existsSync(tmpFile)) return null;
		return { path: tmpFile };
	} catch {
		return null;
	}
}

/** Windows / WSL: files copied in Explorer land in FileDropList. */
function readClipboardFilesViaPowerShell(): string[] {
	const psScript =
		"$files = Get-Clipboard -Format FileDropList; if ($files) { $files | ForEach-Object { Write-Output $_ } }";
	const result = runCommand("powershell.exe", ["-NoProfile", "-Command", psScript], 3000);
	if (!result.ok) return [];
	return result.stdout
		.toString("utf-8")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
}

function readClipboardImageLinux(): { path: string } | null {
	// Wayland first.
	const list = runCommand("wl-paste", ["--list-types"], 1000);
	if (list.ok) {
		const types = list.stdout
			.toString("utf-8")
			.split(/\r?\n/)
			.map((t) => t.trim())
			.filter(Boolean);
		const mime = types.find((t) => t.startsWith("image/"));
		if (mime) {
			const data = runCommand("wl-paste", ["--type", mime, "--no-newline"], 3000);
			if (data.ok && data.stdout.length > 0) return writeTempImage(data.stdout, mime);
		}
	}
	// X11 fallback.
	for (const mime of ["image/png", "image/jpeg"]) {
		const data = runCommand("xclip", ["-selection", "clipboard", "-t", mime, "-o"], 3000);
		if (data.ok && data.stdout.length > 0) return writeTempImage(data.stdout, mime);
	}
	return null;
}

function readClipboardFilesLinux(): string[] {
	for (const args of [
		["wl-paste", "--type", "text/uri-list", "--no-newline"],
		["xclip", "-selection", "clipboard", "-t", "text/uri-list", "-o"],
	]) {
		const result = runCommand(args[0], args.slice(1), 2000);
		if (result.ok) {
			const paths = parseUriList(result.stdout.toString("utf-8"));
			if (paths.length > 0) return paths;
		}
	}
	return [];
}

function readClipboardImageMac(): { path: string } | null {
	const tmpFile = join(tmpdir(), `pi-clip-${randomUUID()}.png`);
	const script =
		`set pngData to (the clipboard as «class PNGf»)\n` +
		`set outFile to open for access POSIX file "${tmpFile}" with write permission\n` +
		`set eof outFile to 0\nwrite pngData to outFile\nclose access outFile`;
	const result = runCommand("osascript", ["-e", script], 3000);
	if (!result.ok || !existsSync(tmpFile)) return null;
	return { path: tmpFile };
}

function readClipboardFilesMac(): string[] {
	const script =
		'try\nset out to ""\nrepeat with f in (the clipboard as «class furl» list)\nset out to out & (POSIX path of f) & linefeed\nend repeat\nreturn out\non error\nreturn ""\nend try';
	const result = runCommand("osascript", ["-e", script], 3000);
	if (!result.ok) return [];
	return result.stdout
		.toString("utf-8")
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean);
}

// ponytail: no BMP->PNG transcoding without photon; non-PNG clipboard formats fall back to file path.
function writeTempImage(bytes: Buffer, mimeType: string): { path: string } | null {
	const [, subtype] = mimeType.split("/");
	const ext = mimeType === "image/jpeg" ? "jpg" : (subtype?.replace("jpeg", "jpg") ?? "png");
	const tmpFile = join(tmpdir(), `pi-clip-${randomUUID()}.${ext}`);
	try {
		writeFileSync(tmpFile, bytes);
		return { path: tmpFile };
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Attachment intake
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Attachment intake
// ---------------------------------------------------------------------------

function isWsl(): boolean {
	return process.platform === "linux" && Boolean(process.env.WSL_DISTRO_NAME || process.env.WSLENV);
}

function readClipboardImage(): { path: string } | null {
	if (process.platform === "win32" || isWsl()) return readClipboardImageViaPowerShell();
	if (process.platform === "darwin") return readClipboardImageMac();
	if (process.platform === "linux") return readClipboardImageLinux();
	return null;
}

function readClipboardFiles(): string[] {
	if (process.platform === "win32" || isWsl()) return readClipboardFilesViaPowerShell();
	if (process.platform === "darwin") return readClipboardFilesMac();
	if (process.platform === "linux") return readClipboardFilesLinux();
	return [];
}

function readClipboardText(): string | null {
	if (process.platform === "win32" || isWsl()) {
		const result = runCommand("powershell.exe", ["-NoProfile", "-Command", "Get-Clipboard"], 2000);
		if (!result.ok) return null;
		const text = result.stdout.toString("utf-8").replace(/\r?\n$/, "");
		return text.length > 0 ? text : null;
	}
	if (process.platform === "darwin") {
		const result = runCommand("pbpaste", [], 2000);
		if (!result.ok) return null;
		const text = result.stdout.toString("utf-8").replace(/\r?\n$/, "");
		return text.length > 0 ? text : null;
	}
	// Linux: wl-paste, falling back to xclip.
	const wayland = runCommand("wl-paste", ["--no-newline"], 2000);
	if (wayland.ok) {
		const text = wayland.stdout.toString("utf-8");
		return text.length > 0 ? text : null;
	}
	const x11 = runCommand("xclip", ["-selection", "clipboard", "-o"], 2000);
	if (!x11.ok) return null;
	const text = x11.stdout.toString("utf-8");
	return text.length > 0 ? text : null;
}

// Files only: directories must not be swallowed as attachments.
function fileExists(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

function makeAbsolute(path: string): string {
	return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

/** Sniff the image magic number from the first bytes without reading the whole file. */
function detectImageMimeTypeAtPath(path: string): string | null {
	let fd: number;
	try {
		fd = openSync(path, "r");
	} catch {
		return null;
	}
	try {
		const header = Buffer.alloc(16);
		const bytesRead = readSync(fd, header, 0, 16, 0);
		return detectImageMimeType(header.subarray(0, bytesRead));
	} catch {
		return null;
	} finally {
		closeSync(fd);
	}
}

function classifyPath(path: string): Attachment | null {
	// ponytail: base64 payload is re-read from disk at submit time; only kind+mime are needed here.
	const mimeType = detectImageMimeTypeAtPath(path);
	if (mimeType && mimeType !== "image/bmp") {
		return { kind: "image", path, mimeType };
	}
	return { kind: "file", path };
}

/** Add paths as attachments, returning how many were added. Skips duplicates. */
function addPaths(paths: string[]): number {
	let added = 0;
	for (const path of paths) {
		if (state.attachments.some((a) => a.path === path)) continue;
		const att = classifyPath(path);
		if (att) {
			state.attachments.push(att);
			added++;
		}
	}
	return added;
}

// ---------------------------------------------------------------------------
// Widget rendering
// ---------------------------------------------------------------------------

function renderWidget(): void {
	const ui = state.ui;
	if (!ui) return;
	if (state.attachments.length === 0) {
		ui.setWidget(WIDGET_ID, undefined);
		return;
	}
	ui.setWidget(WIDGET_ID, (_tui: TUI, theme: Theme) => {
		// Vertical stack only: image escape sequences must not be horizontally
		// composited, and interactive-mode caps widgets at MAX_WIDGET_LINES (10).
		const container = new Container();
		const label = state.attachments
			.map((att, i) => `[${i + 1}] ${basename(att.path)}${att.kind === "image" ? "" : " (file)"}`)
			.join("  ");
		container.addChild(new Text(theme.fg("muted", `attachments: ${label}`), 0, 0));
		const firstImage = state.attachments.find((a) => a.kind === "image" && a.base64 && a.mimeType);
		if (firstImage?.base64 && firstImage.mimeType) {
			container.addChild(
				new Image(
					firstImage.base64,
					firstImage.mimeType,
					{ fallbackColor: (t: string) => theme.fg("muted", t) },
					{ maxWidthCells: THUMBNAIL_CELLS, filename: basename(firstImage.path) },
				),
			);
			const more = state.attachments.filter((a) => a !== firstImage && a.kind === "image").length;
			if (more > 0) {
				container.addChild(new Text(theme.fg("muted", `(+${more} more images)`), 0, 0));
			}
		}
		return container;
	});
}

// ---------------------------------------------------------------------------
// Input interception helpers
// ---------------------------------------------------------------------------

/** Handle a bracketed-paste payload (drag & drop / terminal paste). */
function handleBracketedPaste(ctx: ExtensionContext, content: string): boolean {
	const parsed = parsePastePaths(content, fileExists);
	if (!parsed) return false;

	// Every existing path goes to the tray (image or file); leftover text goes to the editor.
	addPaths(parsed.paths);
	if (parsed.rest) ctx.ui.pasteToEditor(parsed.rest);
	return true;
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

export default function attachmentsExtension(pi: ExtensionAPI): void {
	// Per-session reset + raw terminal input registration (Ctrl+V / bracketed paste).
	pi.on("session_start", (_event, ctx) => {
		state.attachments = [];
		state.ui = ctx.hasUI && ctx.mode === "tui" ? ctx.ui : undefined;

		// Re-register the input listener per session; unsubscribe the old one
		// so session switches don't stack duplicate handlers.
		state.unsubInput?.();
		state.unsubInput = undefined;
		if (!ctx.hasUI || ctx.mode !== "tui") {
			renderWidget();
			return;
		}
		state.unsubInput = ctx.ui.onTerminalInput((data: string) => {
			// Bracketed paste: drag & drop or terminal-level paste.
			if (data.includes(BRACKETED_PASTE_START)) {
				const content = data.replaceAll(BRACKETED_PASTE_START, "").replaceAll("\x1b[201~", "");
				if (handleBracketedPaste(ctx, content)) {
					renderWidget();
					return { consume: true };
				}
				return undefined;
			}

			// Paste key: image > file list > text path > let through.
			// Kitty event-report mode also sends key releases; ignore those.
			if (isKeyRelease(data)) return undefined;
			const isPasteKey = PASTE_SHORTCUTS.some((id) => matchesKey(data, id));
			if (isPasteKey) {
				const image = readClipboardImage();
				if (image && addPaths([image.path]) > 0) {
					renderWidget();
					return { consume: true };
				}
				if (image) {
					renderWidget();
					return { consume: true }; // clipboard image already queued
				}
				const files = readClipboardFiles();
				if (files.length > 0) {
					const existing = files.filter(fileExists);
					if (existing.length > 0) {
						addPaths(existing);
						renderWidget();
						return { consume: true };
					}
				}
				// Text that happens to be existing file path(s): take over to avoid
				// the core's own clipboard probe (an extra PowerShell spawn on Windows).
				const text = readClipboardText();
				const textPaths = text ? parsePastePaths(text, fileExists) : null;
				if (textPaths) {
					addPaths(textPaths.paths);
					if (textPaths.rest) ctx.ui.pasteToEditor(textPaths.rest);
					renderWidget();
					return { consume: true };
				}
				// Plain text: paste it ourselves for the same reason.
				if (text) {
					ctx.ui.pasteToEditor(text);
					return { consume: true };
				}
				return undefined; // clipboard unreadable: let the core try
			}

			return undefined;
		});
	});

	// Submission: turn attachments into ImageContent / path text per model capability.
	pi.on("input", (event, ctx) => {
		const hasQueued = state.attachments.length > 0;
		const vision = ctx.model?.input?.includes("image") ?? false;

		const readFileBase64 = (path: string): { base64: string; mimeType: string } | null => {
			try {
				const buffer = readFileSync(path);
				const mimeType = detectImageMimeType(buffer);
				if (!mimeType || mimeType === "image/bmp") return null;
				return { base64: buffer.toString("base64"), mimeType };
			} catch {
				return null;
			}
		};

		const { result, fallbackNotes } = buildSubmission(
			event.text,
			state.attachments,
			{ vision },
			{ fileExists, readFileBase64, makeAbsolute },
		);

		const changed = hasQueued || result.images.length > 0 || result.text !== event.text;
		if (!changed) return { action: "continue" };

		for (const note of fallbackNotes) {
			ctx.ui.notify(note, "warning");
		}

		state.attachments = [];
		renderWidget();

		return {
			action: "transform",
			text: result.text,
			images: result.images.length > 0 ? result.images : undefined,
		};
	});

	// /attachments: inspect and remove queued attachments.
	pi.registerCommand("attachments", {
		description: "View and remove queued attachments",
		handler: async (_args, ctx) => {
			if (state.attachments.length === 0) {
				ctx.ui.notify("No attachments queued", "info");
				return;
			}
			// Loop until the user picks Done or cancels.
			for (;;) {
				const options = [
					...state.attachments.map((att, i) => `[${i + 1}] ${basename(att.path)} (${att.kind})`),
					"Done",
				];
				const selection = await ctx.ui.select("Attachments", options);
				if (selection === undefined || selection === "Done") return;
				const index = options.indexOf(selection);
				if (index >= 0 && index < state.attachments.length) {
					state.attachments.splice(index, 1);
					renderWidget();
				}
			}
		},
	});
}
