import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AvailableTool } from "./policy.ts";

export type ExtensionTrustScope = "readonly" | "all";

interface TrustFile {
	version: 2;
	readonlyExtensions: string[];
	allExtensions: string[];
}

export function extensionTrustKey(tool: AvailableTool): string {
	const source = tool.sourceInfo;
	return source ? `${source.source}\n${source.path}` : tool.name;
}

export function createTrustStore(filePath: string) {
	let pendingWrite: Promise<void> = Promise.resolve();

	async function load(): Promise<TrustFile> {
		try {
			const value: unknown = JSON.parse(await readFile(filePath, "utf8"));
			if (typeof value !== "object" || value === null || (value as TrustFile).version !== 2) {
				return { version: 2, readonlyExtensions: [], allExtensions: [] };
			}
			const candidate = value as Partial<TrustFile>;
			if (!Array.isArray(candidate.readonlyExtensions) || !Array.isArray(candidate.allExtensions)) {
				return { version: 2, readonlyExtensions: [], allExtensions: [] };
			}
			return {
				version: 2,
				readonlyExtensions: candidate.readonlyExtensions.filter((item): item is string => typeof item === "string"),
				allExtensions: candidate.allExtensions.filter((item): item is string => typeof item === "string"),
			};
		} catch {
			return { version: 2, readonlyExtensions: [], allExtensions: [] };
		}
	}

	async function update(extension: string, scope: ExtensionTrustScope): Promise<void> {
		const write = pendingWrite.then(async () => {
			const stored = await load();
			const field = scope === "all" ? "allExtensions" : "readonlyExtensions";
			if (stored[field].includes(extension)) return;
			const next: TrustFile = { ...stored, [field]: [...stored[field], extension] };
			const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
			await mkdir(dirname(filePath), { recursive: true });
			try {
				await writeFile(tempPath, JSON.stringify(next, null, 2), { mode: 0o600 });
				await rename(tempPath, filePath);
			} finally {
				await rm(tempPath, { force: true });
			}
		});
		pendingWrite = write.catch(() => {});
		await write;
	}

	return {
		async getScope(tool: AvailableTool): Promise<ExtensionTrustScope | undefined> {
			await pendingWrite;
			const stored = await load();
			const extension = extensionTrustKey(tool);
			if (stored.allExtensions.includes(extension)) return "all";
			if (stored.readonlyExtensions.includes(extension)) return "readonly";
			return undefined;
		},
		async trustExtension(tool: AvailableTool, scope: ExtensionTrustScope): Promise<void> {
			await update(extensionTrustKey(tool), scope);
		},
	};
}
