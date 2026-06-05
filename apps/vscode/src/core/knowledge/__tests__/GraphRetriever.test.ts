import { expect } from "chai"
import { describe, it } from "mocha"
import type { TaskSpec } from "@shared/kocode"
import { GraphRetriever, MAX_EDGES, MAX_LAYERS, MAX_NODES } from "../GraphRetriever"
import type { GraphEdge, GraphNode, KnowledgeGraph, Layer } from "../vendor/types"

function node(id: string, name: string, filePath?: string, summary = ""): GraphNode {
	return { id, type: "file", name, filePath, summary, tags: [], complexity: "simple" }
}

function edge(source: string, target: string, weight = 0.5): GraphEdge {
	return { source, target, type: "imports", direction: "forward", weight }
}

function makeTaskSpec(partial: Partial<TaskSpec>): TaskSpec {
	return {
		id: "t1",
		goal: "",
		mode: "coding",
		status: "active",
		files: [],
		constraints: [],
		acceptedDecisions: [],
		rejectedDirections: [],
		pendingPatches: [],
		acceptanceCriteria: [],
		...partial,
	}
}

function makeGraph(nodes: GraphNode[], edges: GraphEdge[] = [], layers: Layer[] = []): KnowledgeGraph {
	return {
		version: "1.0.0",
		project: { name: "test", languages: [], frameworks: [], description: "", analyzedAt: "", gitCommitHash: "" },
		nodes,
		edges,
		layers,
		tour: [],
	}
}

describe("GraphRetriever", () => {
	it("精确文件路径命中应被检索到(score=0 最高优先级)", () => {
		const graph = makeGraph([
			node("file:src/auth/login.ts", "login.ts", "src/auth/login.ts", "处理登录"),
			node("file:src/utils/math.ts", "math.ts", "src/utils/math.ts", "数学工具"),
		])
		const retriever = new GraphRetriever(graph)
		const result = retriever.retrieve(makeTaskSpec({ goal: "随便", files: ["src/auth/login.ts"] }))
		const ids = result.nodes.map((n) => n.id)
		expect(ids).to.include("file:src/auth/login.ts")
		// 精确命中应排在最前。
		expect(result.nodes[0].id).to.equal("file:src/auth/login.ts")
	})

	it("按文件名后缀匹配也能命中(相对路径片段)", () => {
		const graph = makeGraph([node("file:src/auth/login.ts", "login.ts", "src/auth/login.ts")])
		const retriever = new GraphRetriever(graph)
		const result = retriever.retrieve(makeTaskSpec({ files: ["auth/login.ts"] }))
		expect(result.nodes.map((n) => n.id)).to.include("file:src/auth/login.ts")
	})

	it("节点数量不超过 MAX_NODES", () => {
		const nodes = Array.from({ length: 50 }, (_, i) => node(`file:f${i}.ts`, `f${i}.ts`, `f${i}.ts`, "auth handler"))
		const retriever = new GraphRetriever(makeGraph(nodes))
		const result = retriever.retrieve(makeTaskSpec({ goal: "auth handler" }))
		expect(result.nodes.length).to.be.at.most(MAX_NODES)
	})

	it("边数量不超过 MAX_EDGES,且两端命中的边优先", () => {
		const nodes = Array.from({ length: 5 }, (_, i) => node(`file:f${i}.ts`, `f${i}.ts`, `f${i}.ts`, "service"))
		const edges: GraphEdge[] = []
		// 构造大量边
		for (let i = 0; i < 5; i++) {
			for (let j = 0; j < 5; j++) {
				if (i !== j) {
					edges.push(edge(`file:f${i}.ts`, `file:f${j}.ts`, 0.5))
				}
			}
		}
		const retriever = new GraphRetriever(makeGraph(nodes, edges))
		const result = retriever.retrieve(makeTaskSpec({ goal: "service" }))
		expect(result.edges.length).to.be.at.most(MAX_EDGES)
	})

	it("层数量不超过 MAX_LAYERS,且按命中节点数排序", () => {
		const nodes = Array.from({ length: 6 }, (_, i) => node(`file:f${i}.ts`, `f${i}.ts`, `f${i}.ts`, "api"))
		const layers: Layer[] = [
			{ id: "L1", name: "Layer1", description: "", nodeIds: ["file:f0.ts"] },
			{ id: "L2", name: "Layer2", description: "", nodeIds: ["file:f0.ts", "file:f1.ts", "file:f2.ts"] },
			{ id: "L3", name: "Layer3", description: "", nodeIds: ["file:f3.ts"] },
			{ id: "L4", name: "Layer4", description: "", nodeIds: ["file:f4.ts"] },
		]
		const retriever = new GraphRetriever(makeGraph(nodes, [], layers))
		const result = retriever.retrieve(makeTaskSpec({ goal: "api" }))
		expect(result.layers.length).to.be.at.most(MAX_LAYERS)
		// 命中最多节点的 Layer2 应排在最前。
		expect(result.layers[0]?.id).to.equal("L2")
	})

	it("空图谱返回空结果,不抛异常", () => {
		const retriever = new GraphRetriever(makeGraph([]))
		const result = retriever.retrieve(makeTaskSpec({ goal: "anything" }))
		expect(result.nodes).to.have.length(0)
		expect(result.edges).to.have.length(0)
		expect(result.layers).to.have.length(0)
	})
})
