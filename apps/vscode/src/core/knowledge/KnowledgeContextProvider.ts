import type { TaskSpec } from "@shared/kocode"
import { getLatestGitCommitHash } from "@utils/git"
import { Logger } from "@/shared/services/Logger"
import { GraphRetriever, type RetrievedContext } from "./GraphRetriever"
import { KnowledgeStore } from "./KnowledgeStore"
import type { GraphNode, KnowledgeGraph } from "./vendor/types"

/**
 * Worker 上下文注入提供者(R5/R6)。
 *
 * 职责:
 * - 读取工作区图谱并判断 freshness(gitCommitHash vs HEAD)。
 * - 图谱有效且新鲜:检索相关片段,生成"权威结构 + 参考语义"注入块(R5.3)。
 * - 图谱缺失/stale:降级为 Skeleton(目录骨架 + 生成/刷新提示),不注入语义(R6.2/R6.3)。
 * - 任何异常都不抛出,返回空串或骨架,保证不阻塞 Worker 启动(R6.4)。
 *
 * 注入文本以单一 Markdown 块返回,由 ContextSanitizer 追加到 toWorkerPrompt 结果中。
 */

const SKELETON_MAX_ENTRIES = 60

export class KnowledgeContextProvider {
	private readonly store: KnowledgeStore

	constructor(private readonly workspaceRoot: string) {
		this.store = new KnowledgeStore(workspaceRoot)
	}

	/** 生成注入到 Worker prompt 的知识图谱上下文块。无可注入内容时返回空串。 */
	async buildInjection(taskSpec: TaskSpec): Promise<string> {
		try {
			const graph = await this.store.readGraph()
			if (!graph) {
				return this.skeletonBlock("missing")
			}

			const stale = await this.isStale(graph)
			if (stale) {
				// R6.3:stale 时只给骨架 + 刷新提示,不注入可能过时的语义。
				return this.skeletonBlock("stale", graph)
			}

			const retriever = new GraphRetriever(graph)
			const context = retriever.retrieve(taskSpec)
			if (context.nodes.length === 0) {
				// 检索不到相关节点:给精简骨架,帮助 Worker 建立全局观。
				return this.skeletonBlock("fresh", graph)
			}
			return this.contextBlock(context, graph)
		} catch (error) {
			Logger.warn(`[KnowledgeContextProvider] 构建注入失败,跳过注入: ${String(error)}`)
			return ""
		}
	}

	private async isStale(graph: KnowledgeGraph): Promise<boolean> {
		const head = await getLatestGitCommitHash(this.workspaceRoot)
		const recorded = graph.project?.gitCommitHash
		// 非 git 仓库或无记录:无法判定新鲜度,保守视为可用(仅用结构,不强制 stale)。
		if (!head || !recorded) {
			return false
		}
		return head !== recorded
	}

	/** 有效图谱:权威结构 + 参考语义(R5.2/R5.3/R5.5)。 */
	private contextBlock(context: RetrievedContext, graph: KnowledgeGraph): string {
		const lines: string[] = []
		lines.push("## Project Knowledge Graph (Kocode)")
		lines.push(
			"以下是项目知识图谱检索到的相关上下文,用于减少自行探索。**结构事实为权威信息**(tree-sitter 提取),**语义摘要仅供参考**(便宜模型生成,可能不精确)。",
		)
		lines.push("")

		// 权威结构:节点与文件路径。
		lines.push("### Relevant Files & Symbols (权威 / authoritative)")
		for (const node of context.nodes) {
			const loc = node.filePath ? ` — ${node.filePath}${this.lineSuffix(node)}` : ""
			lines.push(`- [${node.type}] ${node.name}${loc}`)
			if (node.summary) {
				lines.push(`  - 摘要(参考): ${this.truncate(node.summary, 160)}`)
			}
		}
		lines.push("")

		// 关系(权威结构)。
		if (context.edges.length > 0) {
			lines.push("### Relationships (权威 / authoritative)")
			for (const edge of context.edges) {
				lines.push(`- ${this.shortId(edge.source)} --${edge.type}--> ${this.shortId(edge.target)}`)
			}
			lines.push("")
		}

		// 架构层(参考)。
		if (context.layers.length > 0) {
			lines.push("### Architectural Layers (参考 / reference)")
			for (const layer of context.layers) {
				lines.push(`- ${layer.name}: ${this.truncate(layer.description, 120)}`)
			}
			lines.push("")
		}

		lines.push(
			`> 图谱共 ${graph.nodes.length} 个节点 / ${graph.edges.length} 条关系。如需更多结构信息,优先查图谱而非全量读代码。`,
		)
		return lines.join("\n")
	}

	/** 降级骨架:目录结构 + 生成/刷新提示(R6.2/R6.3)。 */
	private skeletonBlock(reason: "missing" | "stale" | "fresh", graph?: KnowledgeGraph): string {
		const lines: string[] = []
		lines.push("## Project Knowledge Graph (Kocode)")
		if (reason === "missing") {
			lines.push("项目知识图谱尚未生成。可运行命令 `kocode.knowledge.analyze` 生成,以便后续减少代码探索。")
		} else if (reason === "stale") {
			lines.push("项目知识图谱已过时(与当前 git HEAD 不一致)。以下仅提供目录骨架;语义摘要已省略以避免误导。可运行 `kocode.knowledge.refresh` 刷新。")
		} else {
			lines.push("未检索到与当前任务直接相关的图谱节点。以下提供项目目录骨架供参考。")
		}

		const dirs = graph ? this.directorySkeleton(graph.nodes) : []
		if (dirs.length > 0) {
			lines.push("")
			lines.push("### Directory Skeleton")
			for (const dir of dirs) {
				lines.push(`- ${dir}`)
			}
		}
		return lines.join("\n")
	}

	/** 从节点 filePath 聚合出目录骨架(去重、限量)。 */
	private directorySkeleton(nodes: GraphNode[]): string[] {
		const dirs = new Set<string>()
		for (const node of nodes) {
			if (!node.filePath) {
				continue
			}
			const segments = node.filePath.split("/")
			// 取前两层目录,形成骨架。
			if (segments.length >= 2) {
				dirs.add(segments.slice(0, Math.min(2, segments.length - 1)).join("/") + "/")
			}
		}
		return [...dirs].sort().slice(0, SKELETON_MAX_ENTRIES)
	}

	private lineSuffix(node: GraphNode): string {
		if (node.lineRange && node.lineRange.length === 2) {
			return `:${node.lineRange[0]}-${node.lineRange[1]}`
		}
		return ""
	}

	private shortId(id: string): string {
		// 节点 id 形如 "file:src/a.ts" / "function:src/a.ts:foo";展示末段更易读。
		const parts = id.split(":")
		if (parts.length >= 2) {
			return parts.slice(1).join(":")
		}
		return id
	}

	private truncate(text: string, max: number): string {
		const compact = text.replace(/\s+/g, " ").trim()
		return compact.length > max ? `${compact.slice(0, max)}...` : compact
	}
}
