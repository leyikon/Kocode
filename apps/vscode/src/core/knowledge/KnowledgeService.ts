import { listFiles } from "@services/glob/list-files"
import { getLatestGitCommitHash } from "@utils/git"
import * as fs from "fs/promises"
import * as path from "path"
import { Logger } from "@/shared/services/Logger"
import { KocodeSemanticAnalyzer, KocodeSemanticCancelledError } from "./backends/KocodeSemanticAnalyzer"
import { TreeSitterBackend } from "./backends/TreeSitterBackend"
import { type KnowledgeMeta, KnowledgeStore, type KnowledgeTier } from "./KnowledgeStore"
import { GraphBuilder } from "./vendor/analyzer/graph-builder"
import { detectLayers } from "./vendor/analyzer/layer-detector"
import { classifyUpdate } from "./vendor/change-classifier"
import { analyzeChanges, buildFingerprintStore } from "./vendor/fingerprint"
import { createIgnoreFilter, type IgnoreFilter } from "./vendor/ignore-filter"
import { LanguageRegistry } from "./vendor/languages/language-registry"
import { PluginRegistry } from "./vendor/plugins/registry"
import { getChangedFiles, mergeGraphUpdate } from "./vendor/staleness"
import type { KnowledgeGraph } from "./vendor/types"

/** 单次分析的层级配置(R1/R2/R3:分层可独立开关)。 */
export interface AnalyzeOptions {
	/** 是否生成 Tier 1 语义层(Kocode 模型)。默认 true。 */
	semantic?: boolean
	/** 是否生成 Tier 2 深度层(tour/domain)。默认 false(R3:按需,默认不全量)。 */
	deep?: boolean
	/** 取消信号(R8.2)。 */
	signal?: AbortSignal
	/** 进度回调(R8.1:UI 显示进度)。 */
	onProgress?: (progress: AnalyzeProgress) => void
}

export interface AnalyzeProgress {
	phase: "scan" | "structure" | "semantic" | "build" | "persist" | "done"
	/** 已处理文件数 / 总文件数(语义阶段)。 */
	current?: number
	total?: number
	message: string
}

export interface AnalyzeResult {
	graph: KnowledgeGraph
	meta: KnowledgeMeta
	tokenUsage: { promptTokens: number; completionTokens: number; totalTokens: number; requests: number }
	cancelled: boolean
}

export interface IncrementalOptions {
	/** 是否对受影响文件生成语义。默认 true。 */
	semantic?: boolean
	signal?: AbortSignal
	onProgress?: (progress: AnalyzeProgress) => void
}

export type IncrementalAction =
	| "SKIP" // 无变更或仅 cosmetic
	| "PARTIAL_UPDATE"
	| "ARCHITECTURE_UPDATE"
	| "FULL_RECOMMENDED" // 大规模结构变化,建议用户 full rebuild
	| "FULL_REBUILT" // 无图谱时已自动全量重建

export interface IncrementalResult {
	action: IncrementalAction
	reason: string
	result?: AnalyzeResult
}

// 与 TreeSitterBackend 支持的扩展名保持一致(用于 scanner 判定"可结构提取")。
const STRUCTURE_EXTENSIONS = new Set([
	".js",
	".jsx",
	".mjs",
	".cjs",
	".ts",
	".tsx",
	".py",
	".rs",
	".go",
	".cpp",
	".hpp",
	".cc",
	".c",
	".h",
	".cs",
	".rb",
	".java",
	".php",
	".swift",
	".kt",
])

const MAX_FILE_BYTES = 512 * 1024 // 单文件超过 512KB 跳过语义分析(仍建结构节点)
const SEMANTIC_CONCURRENCY = 5 // 与上游一致:最多 5 并发文件分析

/**
 * 项目知识图谱核心编排服务(R1-R4, R8)。
 *
 * 全量分析流程:scan → Tier0 结构(tree-sitter)→ Tier1 语义(Kocode 模型)→ GraphBuilder → 落盘。
 * 复用 vendor 的纯算法(GraphBuilder/registry/fingerprint/ignore-filter),
 * Tier0/Tier1 通过 Kocode 后端适配器(TreeSitterBackend / KocodeSemanticAnalyzer)接入。
 */
export class KnowledgeService {
	private readonly store: KnowledgeStore
	private readonly treeSitter: TreeSitterBackend
	private readonly languageRegistry = LanguageRegistry.createDefault()
	private readonly pluginRegistry: PluginRegistry

	/**
	 * @param workspaceRoot 工作区根路径
	 * @param wasmDir 可选 wasm 目录;默认走 TreeSitterBackend 的 __dirname(打包后即 dist/)。
	 *   测试/脚本环境需显式传入 dist/。
	 */
	constructor(
		private readonly workspaceRoot: string,
		wasmDir?: string,
	) {
		this.store = new KnowledgeStore(workspaceRoot)
		this.treeSitter = new TreeSitterBackend(wasmDir)
		this.pluginRegistry = new PluginRegistry(this.languageRegistry)
		this.pluginRegistry.register(this.treeSitter)
	}

	getStore(): KnowledgeStore {
		return this.store
	}

	/** 全量分析(对应 kocode.knowledge.analyze)。 */
	async analyze(options: AnalyzeOptions = {}): Promise<AnalyzeResult> {
		const { semantic = true, deep = false, signal, onProgress } = options
		const semanticAnalyzer = new KocodeSemanticAnalyzer()
		let cancelled = false

		const emit = (progress: AnalyzeProgress) => onProgress?.(progress)

		// ---- 1. 扫描文件 ----
		emit({ phase: "scan", message: "扫描工作区文件" })
		const ignoreFilter = createIgnoreFilter(this.workspaceRoot)
		const files = await this.scanFiles(ignoreFilter)
		Logger.log(`[KnowledgeService] 扫描到 ${files.length} 个文件`)

		const gitHash = (await getLatestGitCommitHash(this.workspaceRoot)) ?? ""
		const projectName = path.basename(this.workspaceRoot)
		const builder = new GraphBuilder(projectName, gitHash, this.languageRegistry)

		// ---- 2. Tier 0 结构提取(预热 wasm 语法后并行解析)----
		emit({ phase: "structure", message: "提取代码结构(tree-sitter)" })
		await this.treeSitter.prewarm(files.map((f) => f.absPath))

		const projectContext = `项目名: ${projectName}`
		const structuralByFile = new Map<string, { analysis: ReturnType<TreeSitterBackend["analyzeFile"]>; content: string }>()

		for (const file of files) {
			this.throwIfAborted(signal)
			let content: string
			try {
				content = await fs.readFile(file.absPath, "utf8")
			} catch {
				continue
			}
			if (file.canStructure) {
				const analysis = this.treeSitter.analyzeFile(file.absPath, content)
				structuralByFile.set(file.relPath, { analysis, content })
			} else {
				// R1.4:不支持结构提取的文件仍建文件级节点。
				builder.addFile(file.relPath, { summary: "", tags: [], complexity: "moderate" })
			}
		}

		// ---- 3. Tier 1 语义层(Kocode 模型,可并发、可取消)----
		const totalSemantic = structuralByFile.size
		if (semantic) {
			emit({ phase: "semantic", current: 0, total: totalSemantic, message: "生成语义摘要(Kocode 模型)" })
			try {
				await this.runSemanticBatch(
					[...structuralByFile.entries()],
					semanticAnalyzer,
					projectContext,
					signal,
					(n) => {
						emit({ phase: "semantic", current: n, total: totalSemantic, message: "生成语义摘要(Kocode 模型)" })
					},
					builder,
				)
			} catch (error) {
				if (error instanceof KocodeSemanticCancelledError) {
					cancelled = true
					Logger.log("[KnowledgeService] 语义分析被取消,保留已生成部分")
				} else {
					throw error
				}
			}
		} else {
			// 仅结构层:不带语义 meta 直接建节点。
			for (const [relPath, { analysis }] of structuralByFile) {
				builder.addFileWithAnalysis(relPath, analysis, {
					summary: "",
					tags: [],
					complexity: "moderate",
					summaries: {},
					fileSummary: "",
				})
			}
		}

		// ---- 4. 构建 + import 边 + 架构层(免费启发式)----
		emit({ phase: "build", message: "构建图谱" })
		this.addImportEdges(files, structuralByFile, builder)
		const graph = builder.build()
		// detectLayers 是纯启发式(按目录名归层),零模型成本,补齐 layers(R2.3)。
		graph.layers = detectLayers(graph)

		// ---- 5. 落盘(对齐上游:图谱/meta/fingerprints 分文件)----
		emit({ phase: "persist", message: "写入图谱" })
		const fingerprintStore = this.safeBuildFingerprints(files, gitHash)
		const generatedTiers: KnowledgeTier[] = ["structure"]
		if (semantic) {
			generatedTiers.push("semantic")
		}
		if (deep) {
			generatedTiers.push("deep")
		}
		const savedGraph = await this.store.writeGraph(graph)
		// 指纹单独落盘,不进 meta.json(避免 meta 膨胀)。
		if (fingerprintStore) {
			await this.store.writeFingerprints(fingerprintStore)
		}
		const meta: KnowledgeMeta = {
			lastAnalyzedAt: new Date().toISOString(),
			gitCommitHash: gitHash,
			version: graph.version,
			analyzedFiles: files.length,
			generatedTiers,
			status: cancelled ? "partial" : "ok",
		}
		await this.store.writeMeta(meta)

		emit({ phase: "done", message: "分析完成" })
		const usage = semanticAnalyzer.getUsage()
		return {
			graph: savedGraph,
			meta,
			tokenUsage: {
				promptTokens: usage.promptTokens,
				completionTokens: usage.completionTokens,
				totalTokens: usage.totalTokens,
				requests: usage.requests,
			},
			cancelled,
		}
	}

	// ---- 增量更新(R7) ----

	/**
	 * git commit 后的增量更新(对应 kocode.knowledge.refresh / git hook)。
	 *
	 * 流程:
	 * 1. 无图谱/无指纹 → 退化为全量分析。
	 * 2. 用 staleness.getChangedFiles 取 lastCommit..HEAD 变更文件。
	 * 3. 用 fingerprint.analyzeChanges 计算变更级别。
	 * 4. 用 classifyUpdate 决策:SKIP / PARTIAL / ARCHITECTURE / FULL。
	 *    - SKIP(仅 cosmetic):只更新 meta,不触发任何模型调用(R7.3)。
	 *    - FULL:返回提示建议 full rebuild,不静默执行(R7.7)。
	 *    - PARTIAL/ARCHITECTURE:对受影响文件重算结构(+ 可选语义),mergeGraphUpdate 替换节点(R7.4-7.6)。
	 */
	async incrementalUpdate(options: IncrementalOptions = {}): Promise<IncrementalResult> {
		const { semantic = true, signal, onProgress } = options
		const emit = (p: AnalyzeProgress) => onProgress?.(p)

		const existingGraph = await this.store.readGraph()
		const meta = await this.store.readMeta()
		const existingFingerprints = await this.store.readFingerprints()
		if (!existingGraph || !existingFingerprints) {
			emit({ phase: "scan", message: "无可用图谱,执行全量分析" })
			const full = await this.analyze({ semantic, signal, onProgress })
			return { action: "FULL_REBUILT", reason: "无已有图谱或指纹,已全量重建", result: full }
		}

		const head = (await getLatestGitCommitHash(this.workspaceRoot)) ?? ""
		const lastHash = meta?.gitCommitHash ?? existingFingerprints.gitCommitHash
		const changedFiles = lastHash ? getChangedFiles(this.workspaceRoot, lastHash) : []
		if (changedFiles.length === 0) {
			return { action: "SKIP", reason: "无文件变更" }
		}

		// 仅保留可结构提取的变更文件参与指纹比较。
		const ignoreFilter = createIgnoreFilter(this.workspaceRoot)
		const relevantChanged = changedFiles
			.map((f) => f.split("\\").join("/"))
			.filter((rel) => !ignoreFilter.isIgnored(rel) && STRUCTURE_EXTENSIONS.has(path.extname(rel).toLowerCase()))

		await this.treeSitter.prewarm(relevantChanged.map((rel) => path.join(this.workspaceRoot, rel)))

		const analysis = analyzeChanges(this.workspaceRoot, relevantChanged, existingFingerprints, this.pluginRegistry)
		const decision = classifyUpdate(analysis, existingGraph.nodes.length, Object.keys(existingFingerprints.files))

		if (decision.action === "SKIP") {
			// R7.3:cosmetic-only,只更新 meta 的 commit hash,不触发模型。
			await this.store.writeMeta({
				lastAnalyzedAt: new Date().toISOString(),
				gitCommitHash: head,
				version: existingGraph.version,
				analyzedFiles: meta?.analyzedFiles ?? existingGraph.nodes.length,
				generatedTiers: meta?.generatedTiers ?? ["structure"],
				status: meta?.status ?? "ok",
			})
			return { action: "SKIP", reason: decision.reason }
		}

		if (decision.action === "FULL_UPDATE") {
			// R7.7:大规模结构变化不静默增量,提示用户运行 full rebuild。
			return { action: "FULL_RECOMMENDED", reason: decision.reason }
		}

		// PARTIAL_UPDATE / ARCHITECTURE_UPDATE:重算受影响文件并合并。
		emit({ phase: "structure", message: `增量更新 ${decision.filesToReanalyze.length} 个文件` })
		const semanticAnalyzer = new KocodeSemanticAnalyzer()
		const builder = new GraphBuilder(path.basename(this.workspaceRoot), head, this.languageRegistry)
		const projectContext = `项目名: ${path.basename(this.workspaceRoot)}`
		let cancelled = false

		try {
			for (const rel of decision.filesToReanalyze) {
				this.throwIfAborted(signal)
				const abs = path.join(this.workspaceRoot, rel)
				let content: string
				try {
					content = await fs.readFile(abs, "utf8")
				} catch {
					continue // 文件可能已删除,由 mergeGraphUpdate 通过 changedFilePaths 移除其旧节点
				}
				const structural = this.treeSitter.analyzeFile(abs, content)
				let sem: Awaited<ReturnType<KocodeSemanticAnalyzer["analyzeFile"]>> = null
				if (semantic && content.length <= MAX_FILE_BYTES) {
					sem = await semanticAnalyzer.analyzeFile(rel, content, { projectContext, signal })
				}
				builder.addFileWithAnalysis(rel, structural, {
					summary: sem?.fileSummary ?? "",
					tags: sem?.tags ?? [],
					complexity: sem?.complexity ?? "moderate",
					summaries: { ...(sem?.functionSummaries ?? {}), ...(sem?.classSummaries ?? {}) },
					fileSummary: sem?.fileSummary ?? "",
				})
			}
		} catch (error) {
			if (error instanceof KocodeSemanticCancelledError) {
				cancelled = true
			} else {
				throw error
			}
		}

		const partial = builder.build()
		// 受影响文件 = 重算文件 + 删除文件(都需从旧图谱中移除其节点)。
		const affectedFiles = [...new Set([...decision.filesToReanalyze, ...analysis.deletedFiles])]
		const merged = mergeGraphUpdate(existingGraph, affectedFiles, partial.nodes, partial.edges, head)
		// 合并后重算架构层(免费启发式),保持 layers 与节点一致。
		merged.layers = detectLayers(merged)

		emit({ phase: "persist", message: "写入增量图谱" })
		const savedGraph = await this.store.writeGraph(merged)

		// 重算指纹(全量重建指纹库以保持一致),单独落盘。
		const allFiles = await this.scanFiles(ignoreFilter)
		const fingerprintStore = this.safeBuildFingerprints(allFiles, head)
		if (fingerprintStore) {
			await this.store.writeFingerprints(fingerprintStore)
		}
		await this.store.writeMeta({
			lastAnalyzedAt: new Date().toISOString(),
			gitCommitHash: head,
			version: savedGraph.version,
			analyzedFiles: allFiles.length,
			generatedTiers: meta?.generatedTiers ?? (semantic ? ["structure", "semantic"] : ["structure"]),
			status: cancelled ? "partial" : "ok",
		})

		emit({ phase: "done", message: "增量更新完成" })
		const usage = semanticAnalyzer.getUsage()
		return {
			action: decision.action === "ARCHITECTURE_UPDATE" ? "ARCHITECTURE_UPDATE" : "PARTIAL_UPDATE",
			reason: decision.reason,
			result: {
				graph: savedGraph,
				meta: {
					lastAnalyzedAt: new Date().toISOString(),
					gitCommitHash: head,
					version: savedGraph.version,
					analyzedFiles: allFiles.length,
					generatedTiers: meta?.generatedTiers ?? (semantic ? ["structure", "semantic"] : ["structure"]),
					status: cancelled ? "partial" : "ok",
				},
				tokenUsage: {
					promptTokens: usage.promptTokens,
					completionTokens: usage.completionTokens,
					totalTokens: usage.totalTokens,
					requests: usage.requests,
				},
				cancelled,
			},
		}
	}

	// ---- 内部辅助 ----

	private throwIfAborted(signal?: AbortSignal): void {
		if (signal?.aborted) {
			throw new KocodeSemanticCancelledError()
		}
	}

	private async scanFiles(ignoreFilter: IgnoreFilter): Promise<ScannedFile[]> {
		// listFiles 递归列出工作区文件(已内置 node_modules 等忽略)。
		const [absPaths] = await listFiles(this.workspaceRoot, true, 5_000)
		const result: ScannedFile[] = []
		for (const absPath of absPaths) {
			if (absPath.endsWith("/") || absPath.endsWith("\\")) {
				continue // 目录项
			}
			const relPath = path.relative(this.workspaceRoot, absPath).split(path.sep).join("/")
			if (!relPath || relPath.startsWith("..")) {
				continue
			}
			if (ignoreFilter.isIgnored(relPath)) {
				continue
			}
			const ext = path.extname(absPath).toLowerCase()
			result.push({ absPath, relPath, canStructure: STRUCTURE_EXTENSIONS.has(ext) })
		}
		return result
	}

	/** 并发执行语义分析,带取消与进度(R8.1/R8.2)。 */
	private async runSemanticBatch(
		entries: Array<[string, { analysis: ReturnType<TreeSitterBackend["analyzeFile"]>; content: string }]>,
		analyzer: KocodeSemanticAnalyzer,
		projectContext: string,
		signal: AbortSignal | undefined,
		onProcessed: (count: number) => void,
		builder: GraphBuilder,
	): Promise<void> {
		let index = 0
		let done = 0

		const worker = async (): Promise<void> => {
			while (index < entries.length) {
				const current = index++
				this.throwIfAborted(signal)
				const [relPath, { analysis, content }] = entries[current]

				let semantic: Awaited<ReturnType<KocodeSemanticAnalyzer["analyzeFile"]>> = null
				if (content.length <= MAX_FILE_BYTES) {
					semantic = await analyzer.analyzeFile(relPath, content, { projectContext, signal })
				}

				// R2.5:语义失败保留结构信息,语义字段置空。
				builder.addFileWithAnalysis(relPath, analysis, {
					summary: semantic?.fileSummary ?? "",
					tags: semantic?.tags ?? [],
					complexity: semantic?.complexity ?? "moderate",
					summaries: { ...(semantic?.functionSummaries ?? {}), ...(semantic?.classSummaries ?? {}) },
					fileSummary: semantic?.fileSummary ?? "",
				})

				done += 1
				onProcessed(done)
			}
		}

		const workerCount = Math.min(SEMANTIC_CONCURRENCY, Math.max(1, entries.length))
		await Promise.all(Array.from({ length: workerCount }, () => worker()))
	}

	/** 由 tree-sitter 的 import 解析在文件间建 import 边。 */
	private addImportEdges(
		files: ScannedFile[],
		structuralByFile: Map<string, { analysis: ReturnType<TreeSitterBackend["analyzeFile"]>; content: string }>,
		builder: GraphBuilder,
	): void {
		const relByAbsNoExt = new Map<string, string>()
		for (const file of files) {
			const absNoExt = file.absPath.replace(/\.[^./\\]+$/, "")
			relByAbsNoExt.set(absNoExt, file.relPath)
		}
		for (const [relPath, { content }] of structuralByFile) {
			const absPath = path.join(this.workspaceRoot, relPath)
			const imports = this.treeSitter.resolveImports(absPath, content)
			for (const imp of imports) {
				if (!imp.resolvedPath.startsWith("/") && !/^[A-Za-z]:\\/.test(imp.resolvedPath)) {
					continue // 仅处理可解析到工作区内的相对导入
				}
				const targetNoExt = imp.resolvedPath.replace(/\.[^./\\]+$/, "")
				const targetRel = relByAbsNoExt.get(targetNoExt) ?? relByAbsNoExt.get(imp.resolvedPath)
				if (targetRel && targetRel !== relPath) {
					builder.addImportEdge(relPath, targetRel)
				}
			}
		}
	}

	private safeBuildFingerprints(files: ScannedFile[], gitHash: string) {
		try {
			const structureFiles = files.filter((f) => f.canStructure).map((f) => f.relPath)
			return buildFingerprintStore(this.workspaceRoot, structureFiles, this.pluginRegistry, gitHash)
		} catch (error) {
			Logger.warn(`[KnowledgeService] 构建指纹失败(不影响图谱): ${String(error)}`)
			return undefined
		}
	}
}

interface ScannedFile {
	absPath: string
	relPath: string
	canStructure: boolean
}
