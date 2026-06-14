import type { KocodeMemoDocument } from "@shared/kocode"
import { createHash } from "crypto"
import { promises as fs } from "fs"
import * as path from "path"
import { z } from "zod"
import { HostProvider } from "@/hosts/host-provider"
import { Logger } from "@/shared/services/Logger"

const MAX_MEMO_DOCUMENTS = 100

const KocodeMemoDocumentSchema = z.object({
	id: z.string(),
	taskId: z.string(),
	kind: z.enum(["plan_report", "completion_report", "survey_record"]),
	title: z.string(),
	markdown: z.string(),
	createdAt: z.number(),
	sourceMessageId: z.string().optional(),
	taskGoal: z.string().optional(),
})

const KocodeMemoFileSchema = z.object({
	version: z.literal(1).default(1),
	updatedAt: z.number().default(0),
	memos: z.array(KocodeMemoDocumentSchema).default([]),
})

function workspaceKey(cwd: string | undefined): string {
	const seed = cwd?.trim() || "global"
	return createHash("sha256").update(seed).digest("hex").slice(0, 24)
}

async function ensureDir(dirPath: string): Promise<void> {
	await fs.mkdir(dirPath, { recursive: true })
}

async function atomicWrite(filePath: string, data: string): Promise<void> {
	const tmpPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`
	try {
		await fs.writeFile(tmpPath, data, "utf8")
		await fs.rename(tmpPath, filePath)
	} catch (error) {
		fs.unlink(tmpPath).catch(() => {})
		throw error
	}
}

export interface KocodeMemoPersistence {
	load(): Promise<KocodeMemoDocument[]>
	save(memos: KocodeMemoDocument[]): Promise<void>
}

export function trimMemoList(memos: KocodeMemoDocument[]): KocodeMemoDocument[] {
	return [...memos].sort((a, b) => a.createdAt - b.createdAt).slice(-MAX_MEMO_DOCUMENTS)
}

export class FileKocodeMemoStore implements KocodeMemoPersistence {
	constructor(private readonly cwd: string | undefined) {}

	private async storagePath(): Promise<string> {
		const root = HostProvider.get().globalStorageFsPath
		const dir = path.resolve(root, "kocode", "memos", workspaceKey(this.cwd))
		await ensureDir(dir)
		return path.join(dir, "memos.json")
	}

	async load(): Promise<KocodeMemoDocument[]> {
		try {
			const file = await this.storagePath()
			const text = await fs.readFile(file, "utf8")
			const json = JSON.parse(text)
			const parsed = KocodeMemoFileSchema.parse(json)
			return trimMemoList(parsed.memos)
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
				Logger.warn(
					`[Kocode] failed to load memos, falling back to empty list: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
			return []
		}
	}

	async save(memos: KocodeMemoDocument[]): Promise<void> {
		try {
			const file = await this.storagePath()
			const data = {
				version: 1,
				updatedAt: Date.now(),
				memos: trimMemoList(memos),
			}
			await atomicWrite(file, JSON.stringify(data, null, 2))
		} catch (error) {
			Logger.warn(`[Kocode] failed to persist memos: ${error instanceof Error ? error.message : String(error)}`)
		}
	}
}

export class InMemoryKocodeMemoStore implements KocodeMemoPersistence {
	private current: KocodeMemoDocument[] = []

	async load(): Promise<KocodeMemoDocument[]> {
		return [...this.current]
	}

	async save(memos: KocodeMemoDocument[]): Promise<void> {
		this.current = trimMemoList(memos)
	}
}
