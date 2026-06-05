import * as path from "path"
import { Logger } from "@/shared/services/Logger"
import {
    loadConfig,
    loadFingerprints,
    loadGraph,
    loadMeta,
    saveConfig,
    saveFingerprints,
    saveGraph,
    saveMeta,
} from "./vendor/persistence/index"
import type { FingerprintStore } from "./vendor/fingerprint"
import type { AnalysisMeta, KnowledgeGraph, ProjectConfig } from "./vendor/types"

/**
 * 图谱落盘层(R4)。完全对齐上游 persistence 设计:文件拆分 + 路径脱敏 + 校验。
 *
 * 目录结构(工作区根下 .understand-anything/):
 *   knowledge-graph.json   完整图谱(nodes/edges/layers/tour)
 *   meta.json              仅 AnalysisMeta(小:几百字节)+ Kocode 扩展字段
 *   fingerprints.json      指纹库(单独存,避免 meta 膨胀)
 *   config.json            { autoUpdate, outputLanguage }
 *
 * 关键保证(均由 vendor persistence 提供):
 * - saveGraph 写盘前 sanitiseFilePaths(把绝对路径转相对/仅文件名,避免泄露目录结构)。
 * - loadGraph 默认 validateGraph(移除 dangling edge、校验引用);校验失败抛错,
 *   本层捕获后视为"图谱缺失"返回 null(R4.5),触发降级而非中断扩展。
 * - fingerprints 单独文件,不进 meta.json(解决 meta 膨胀)。
 */

export const KNOWLEDGE_DIR = ".understand-anything"

export type KnowledgeTier = "structure" | "semantic" | "deep"

/**
 * Kocode 扩展的元数据。在上游 AnalysisMeta 基础上增加生成层级与状态,
 * 这些字段随 meta.json 一并落盘(指纹不在此,单独 fingerprints.json)。
 */
export interface KnowledgeMeta extends AnalysisMeta {
	/** 已生成到哪些层级(R3:深度层可缺省)。 */
	generatedTiers: KnowledgeTier[]
	/** 最近一次生成状态。 */
	status: "ok" | "partial" | "failed"
}

export class KnowledgeStore {
	constructor(private readonly workspaceRoot: string) {}

	get dir(): string {
		return path.join(this.workspaceRoot, KNOWLEDGE_DIR)
	}

	get graphPath(): string {
		return path.join(this.dir, "knowledge-graph.json")
	}

	get metaPath(): string {
		return path.join(this.dir, "meta.json")
	}

	/** 读取图谱;缺失或校验失败返回 null(R4.5:触发降级而非中断)。 */
	async readGraph(): Promise<KnowledgeGraph | null> {
		try {
			// validate:true(默认)会移除 dangling edge 并校验引用;失败抛错,这里降级为 null。
			return loadGraph(this.workspaceRoot)
		} catch (error) {
			Logger.warn(`[KnowledgeStore] 读取/校验图谱失败,视为缺失: ${String(error)}`)
			return null
		}
	}

	async readMeta(): Promise<KnowledgeMeta | null> {
		const meta = loadMeta(this.workspaceRoot) as KnowledgeMeta | null
		return meta
	}

	async readFingerprints(): Promise<FingerprintStore | null> {
		return loadFingerprints(this.workspaceRoot)
	}

	async readConfig(): Promise<ProjectConfig> {
		return loadConfig(this.workspaceRoot)
	}

	/**
	 * 写入图谱:vendor saveGraph 内部先 sanitiseFilePaths(脱敏)再写盘。
	 * 注意:上游 saveGraph 不做 validateGraph 清理(清理在 loadGraph 时),
	 * 但为满足 R4.4「写盘前移除 dangling edge」,我们在写前显式校验一次并写入清理后的图谱。
	 */
	async writeGraph(graph: KnowledgeGraph): Promise<KnowledgeGraph> {
		// R4.4:写盘前移除 dangling edge / 校验 layer/tour 引用。
		const cleaned = await this.cleanGraph(graph)
		saveGraph(this.workspaceRoot, cleaned)
		return cleaned
	}

	async writeMeta(meta: KnowledgeMeta): Promise<void> {
		saveMeta(this.workspaceRoot, meta)
	}

	async writeFingerprints(store: FingerprintStore): Promise<void> {
		saveFingerprints(this.workspaceRoot, store)
	}

	async writeConfig(config: ProjectConfig): Promise<void> {
		saveConfig(this.workspaceRoot, config)
	}

	async exists(): Promise<boolean> {
		return (await this.readGraph()) !== null
	}

	/**
	 * 用 validateGraph 清理图谱(移除 dangling edge、过滤 layer/tour 无效引用)。
	 * 校验致命失败时退回原图谱(避免丢数据),由 saveGraph 的脱敏兜底。
	 */
	private async cleanGraph(graph: KnowledgeGraph): Promise<KnowledgeGraph> {
		const { validateGraph } = await import("./vendor/schema")
		const result = validateGraph(graph)
		if (result.success && result.data) {
			return result.data as unknown as KnowledgeGraph
		}
		Logger.warn(`[KnowledgeStore] 图谱校验未通过,按原样写入(已脱敏): ${result.fatal ?? "unknown"}`)
		return graph
	}
}
