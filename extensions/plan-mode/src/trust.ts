import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AvailableTool } from "./policy.ts";

interface TrustFile {
	version: 1;
	allowed: string[];
}

export function toolTrustKey(tool: AvailableTool): string {
	return JSON.stringify([tool.name, tool.sourceInfo?.source, tool.sourceInfo?.path]);
}

export function createTrustStore(filePath: string) {
	let pendingWrite: Promise<void> = Promise.resolve();

	async function load(): Promise<TrustFile> {
		try {
			const value: unknown = JSON.parse(await readFile(filePath, "utf8"));
			if (
				typeof value !== "object" || value === null ||
				(value as TrustFile).version !== 1 ||
				!Array.isArray((value as TrustFile).allowed) ||
				!(value as TrustFile).allowed.every((item) => typeof item === "string")
			) return { version: 1, allowed: [] };
			return value as TrustFile;
		} catch {
			return { version: 1, allowed: [] };
		}
	}

	return {
		async isTrusted(tool: AvailableTool): Promise<boolean> {
			await pendingWrite;
			return (await load()).allowed.includes(toolTrustKey(tool));
		},
		async trust(tool: AvailableTool): Promise<void> {
			const write = pendingWrite.then(async () => {
				const stored = await load();
				const key = toolTrustKey(tool);
				if (stored.allowed.includes(key)) return;
				const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
				await mkdir(dirname(filePath), { recursive: true });
				try {
					await writeFile(tempPath, JSON.stringify({ version: 1, allowed: [...stored.allowed, key] }, null, 2), { mode: 0o600 });
					await rename(tempPath, filePath);
				} finally {
					await rm(tempPath, { force: true });
				}
			});
			pendingWrite = write.catch(() => {});
			await write;
		},
	};
}
