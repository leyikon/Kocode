import { createHash } from "crypto"
import { promises as fs } from "fs"
import * as path from "path"
import { z } from "zod"
import { HostProvider } from "@/hosts/host-provider"
import { Logger } from "@/shared/services/Logger"

/**
 * Structured Kocode memory replaces the prior pair of free-form strings (projectMemory / socialMemory)
 * so we can patch individual facts instead of overwriting the whole blob, and so we can survive
 * across Kocode sessions in the same workspace.
 */
export const KocodeMemorySchema = z.object({
	version: z.literal(1).default(1),
	updatedAt: z.number().default(0),
	// Free-form sentence-level summary (legacy projectMemory). Useful for prompt context.
	projectSummary: z.string().default(""),
	// Short Flash-side conversational memory (legacy socialMemory).
	socialSummary: z.string().default(""),
	// Glossary entries the user has been taught — Flash should reuse the same wording.
	glossary: z
		.array(
			z.object({
				term: z.string(),
				explanation: z.string(),
				addedAt: z.number(),
			}),
		)
		.default([]),
	// Directions the user explicitly rejected (across all tasks). Worker should never re-attempt these.
	rejectedDirections: z
		.array(
			z.object({
				text: z.string(),
				addedAt: z.number(),
			}),
		)
		.default([]),
	// Decisions the user accepted across the project (e.g. "use Tailwind", "JS not TS").
	acceptedDecisions: z
		.array(
			z.object({
				text: z.string(),
				addedAt: z.number(),
			}),
		)
		.default([]),
	// Open questions Flash wants to revisit later.
	openQuestions: z
		.array(
			z.object({
				text: z.string(),
				addedAt: z.number(),
			}),
		)
		.default([]),
	// Coarse skill profile so Flash and Worker can adjust explanation depth.
	skillProfile: z
		.object({
			level: z.enum(["beginner", "intermediate", "advanced"]).default("beginner"),
			notes: z.array(z.string()).default([]),
		})
		.default({ level: "beginner", notes: [] }),
})

export type KocodeMemory = z.infer<typeof KocodeMemorySchema>

const DEFAULT_PROJECT_SUMMARY =
	"Kocode は、初めて vibe coding する人のための、やさしく人間味のある VS Code AI coding companion。Flash は会話と文脈整理、Worker は実作業を担当する。"

export function createDefaultMemory(): KocodeMemory {
	return KocodeMemorySchema.parse({
		updatedAt: Date.now(),
		projectSummary: DEFAULT_PROJECT_SUMMARY,
	})
}

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

export interface KocodeMemoryPersistence {
	load(): Promise<KocodeMemory>
	save(memory: KocodeMemory): Promise<void>
}

export class FileKocodeMemoryStore implements KocodeMemoryPersistence {
	constructor(private readonly cwd: string | undefined) {}

	private async storagePath(): Promise<string> {
		const root = HostProvider.get().globalStorageFsPath
		const dir = path.resolve(root, "kocode", "memory", workspaceKey(this.cwd))
		await ensureDir(dir)
		return path.join(dir, "memory.json")
	}

	async load(): Promise<KocodeMemory> {
		try {
			const file = await this.storagePath()
			const text = await fs.readFile(file, "utf8")
			const json = JSON.parse(text)
			return KocodeMemorySchema.parse(json)
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
				Logger.warn(`[Kocode] failed to load memory, falling back to default: ${error instanceof Error ? error.message : String(error)}`)
			}
			return createDefaultMemory()
		}
	}

	async save(memory: KocodeMemory): Promise<void> {
		try {
			const file = await this.storagePath()
			await atomicWrite(file, JSON.stringify(memory, null, 2))
		} catch (error) {
			Logger.warn(`[Kocode] failed to persist memory: ${error instanceof Error ? error.message : String(error)}`)
		}
	}
}

/**
 * In-memory persistence used by tests so they don't touch the filesystem.
 */
export class InMemoryKocodeMemoryStore implements KocodeMemoryPersistence {
	private current: KocodeMemory = createDefaultMemory()

	async load(): Promise<KocodeMemory> {
		return this.current
	}

	async save(memory: KocodeMemory): Promise<void> {
		this.current = memory
	}
}

/**
 * Mutation helpers — keep memory updates idempotent and bounded so the prompt context
 * stays small even after long sessions.
 */
const MAX_LIST_ENTRIES = 25

function pushUnique<T extends { text: string }>(items: T[], item: T): T[] {
	const filtered = items.filter((existing) => existing.text !== item.text)
	const next = [...filtered, item]
	return next.length > MAX_LIST_ENTRIES ? next.slice(-MAX_LIST_ENTRIES) : next
}

function pushUniqueGlossary(items: KocodeMemory["glossary"], term: string, explanation: string): KocodeMemory["glossary"] {
	const filtered = items.filter((existing) => existing.term !== term)
	const next = [...filtered, { term, explanation, addedAt: Date.now() }]
	return next.length > MAX_LIST_ENTRIES ? next.slice(-MAX_LIST_ENTRIES) : next
}

export const KocodeMemoryMutators = {
	setProjectSummary(memory: KocodeMemory, summary: string): KocodeMemory {
		return { ...memory, projectSummary: summary, updatedAt: Date.now() }
	},
	setSocialSummary(memory: KocodeMemory, summary: string): KocodeMemory {
		return { ...memory, socialSummary: summary, updatedAt: Date.now() }
	},
	addGlossary(memory: KocodeMemory, term: string, explanation: string): KocodeMemory {
		return { ...memory, glossary: pushUniqueGlossary(memory.glossary, term, explanation), updatedAt: Date.now() }
	},
	rejectDirection(memory: KocodeMemory, text: string): KocodeMemory {
		return { ...memory, rejectedDirections: pushUnique(memory.rejectedDirections, { text, addedAt: Date.now() }), updatedAt: Date.now() }
	},
	acceptDecision(memory: KocodeMemory, text: string): KocodeMemory {
		return { ...memory, acceptedDecisions: pushUnique(memory.acceptedDecisions, { text, addedAt: Date.now() }), updatedAt: Date.now() }
	},
	addOpenQuestion(memory: KocodeMemory, text: string): KocodeMemory {
		return { ...memory, openQuestions: pushUnique(memory.openQuestions, { text, addedAt: Date.now() }), updatedAt: Date.now() }
	},
	resolveOpenQuestion(memory: KocodeMemory, text: string): KocodeMemory {
		return {
			...memory,
			openQuestions: memory.openQuestions.filter((entry) => entry.text !== text),
			updatedAt: Date.now(),
		}
	},
	setSkillLevel(memory: KocodeMemory, level: KocodeMemory["skillProfile"]["level"]): KocodeMemory {
		return { ...memory, skillProfile: { ...memory.skillProfile, level }, updatedAt: Date.now() }
	},
}

/**
 * Compact textual representation suitable for inclusion in the Flash runtime context.
 * Truncates list-shaped fields to keep prompt size bounded.
 */
export function memoryToPromptText(memory: KocodeMemory): string {
	const lines: string[] = []
	if (memory.projectSummary) {
		lines.push(`summary: ${memory.projectSummary}`)
	}
	lines.push(`skill_level: ${memory.skillProfile.level}`)
	if (memory.glossary.length > 0) {
		lines.push("glossary:")
		for (const entry of memory.glossary.slice(-8)) {
			lines.push(`  - ${entry.term}: ${entry.explanation}`)
		}
	}
	if (memory.acceptedDecisions.length > 0) {
		lines.push("accepted_decisions:")
		for (const entry of memory.acceptedDecisions.slice(-6)) {
			lines.push(`  - ${entry.text}`)
		}
	}
	if (memory.rejectedDirections.length > 0) {
		lines.push("rejected_directions:")
		for (const entry of memory.rejectedDirections.slice(-6)) {
			lines.push(`  - ${entry.text}`)
		}
	}
	if (memory.openQuestions.length > 0) {
		lines.push("open_questions:")
		for (const entry of memory.openQuestions.slice(-4)) {
			lines.push(`  - ${entry.text}`)
		}
	}
	return lines.join("\n")
}
