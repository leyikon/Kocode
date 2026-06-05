import type { TaskSpec } from "@shared/kocode"
import { SearchEngine } from "./vendor/search"
import type { GraphEdge, GraphNode, KnowledgeGraph, Layer } from "./vendor/types"

/**
 * 图谱检索器(R5)。按 TaskSpec 检索与当前任务最相关的节点/边/层,
 * 供 ContextSanitizer 注入 Worker 上下文。
 *
 * 注入上限(R5.4):节点 ≤ 10、关系 ≤ 20、层 ≤ 3。
 */

export const MAX_NODES = 10
export const MAX_EDGES = 20
export const MAX_LAYERS = 3

export interface RetrievedContext {
	nodes: GraphNode[]
	edges: GraphEdge[]
	layers: Layer[]
}

export class GraphRetriever {
	private readonly search: SearchEngine
	private readonly nodeById: Map<string, GraphNode>

	constructor(private readonly graph: KnowledgeGraph) {
		this.search = new SearchEngine(graph.nodes)
		this.nodeById = new Map(graph.nodes.map((n) => [n.id, n]))
	}

	/**
	 * 依据 TaskSpec 检索相关上下文。
	 * 查询词来源:goal + files + constraints + acceptanceCriteria,文件路径优先。
	 */
	retrieve(taskSpec: TaskSpec): RetrievedContext {
		const scored = new Map<string, number>() // nodeId -> 最佳(最小)score

		const record = (nodeId: string, score: number) => {
			const prev = scored.get(nodeId)
			if (prev === undefined || score < prev) {
				scored.set(nodeId, score)
			}
		}

		// 1. 显式 files:精确路径命中优先级最高(score=0)。
		for (const file of taskSpec.files) {
			const normalized = file.split("\\").join("/")
			for (const node of this.graph.nodes) {
				if (node.filePath && (node.filePath === normalized || node.filePath.endsWith(normalized))) {
					record(node.id, 0)
				}
			}
		}

		// 2. 语义/模糊检索:goal 与各约束。
		const queries = [taskSpec.goal, ...taskSpec.constraints, ...taskSpec.acceptanceCriteria].filter(
			(q) => typeof q === "string" && q.trim().length > 0,
		)
		for (const query of queries) {
			for (const result of this.search.search(query, { limit: MAX_NODES * 2 })) {
				record(result.nodeId, result.score)
			}
		}

		// 3. 排序取前 N(R5.6:按相关度排序,最相关优先)。
		const rankedIds = [...scored.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id)
		const selectedNodes: GraphNode[] = []
		for (const id of rankedIds) {
			const node = this.nodeById.get(id)
			if (node) {
				selectedNodes.push(node)
			}
			if (selectedNodes.length >= MAX_NODES) {
				break
			}
		}

		const selectedNodeIds = new Set(selectedNodes.map((n) => n.id))

		// 4. 关联边:两端都在选中节点集合内的边优先;其次保留一端命中的边。
		const edges = this.selectEdges(selectedNodeIds)

		// 5. 关联层:包含选中节点的层。
		const layers = this.selectLayers(selectedNodeIds)

		return { nodes: selectedNodes, edges, layers }
	}

	private selectEdges(selectedNodeIds: Set<string>): GraphEdge[] {
		const bothEnds: GraphEdge[] = []
		const oneEnd: GraphEdge[] = []
		for (const edge of this.graph.edges) {
			const hasSource = selectedNodeIds.has(edge.source)
			const hasTarget = selectedNodeIds.has(edge.target)
			if (hasSource && hasTarget) {
				bothEnds.push(edge)
			} else if (hasSource || hasTarget) {
				oneEnd.push(edge)
			}
		}
		// 按权重降序,优先两端命中的关系。
		bothEnds.sort((a, b) => b.weight - a.weight)
		oneEnd.sort((a, b) => b.weight - a.weight)
		return [...bothEnds, ...oneEnd].slice(0, MAX_EDGES)
	}

	private selectLayers(selectedNodeIds: Set<string>): Layer[] {
		const scored = this.graph.layers
			.map((layer) => ({
				layer,
				hits: layer.nodeIds.filter((id) => selectedNodeIds.has(id)).length,
			}))
			.filter((entry) => entry.hits > 0)
			.sort((a, b) => b.hits - a.hits)
		return scored.slice(0, MAX_LAYERS).map((entry) => entry.layer)
	}
}
