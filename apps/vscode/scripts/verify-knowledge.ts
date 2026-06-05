// 独立验证脚本(绕过 mocha,直接用 ts-node CJS 跑)。
// 验证:KnowledgeStore 的 round-trip + dangling edge 移除、GraphRetriever 上限与排序、
// change-classifier 决策。仅用于本机快速校验,不进 CI。
import * as assert from "node:assert"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { GraphRetriever, MAX_NODES } from "../src/core/knowledge/GraphRetriever"
import { KnowledgeStore } from "../src/core/knowledge/KnowledgeStore"
import { classifyUpdate } from "../src/core/knowledge/vendor/change-classifier"
import type { ChangeAnalysis } from "../src/core/knowledge/vendor/fingerprint"
import type { GraphEdge, GraphNode, KnowledgeGraph } from "../src/core/knowledge/vendor/types"
import type { TaskSpec } from "../src/shared/kocode"

function node(id: string, filePath?: string, summary = ""): GraphNode {
	return { id, type: "file", name: id, filePath, summary, tags: [], complexity: "simple" }
}
function edge(s: string, t: string): GraphEdge {
	return { source: s, target: t, type: "imports", direction: "forward", weight: 0.7 }
}
function graph(nodes: GraphNode[], edges: GraphEdge[] = []): KnowledgeGraph {
	return {
		version: "1.0.0",
		project: { name: "t", languages: [], frameworks: [], description: "", analyzedAt: "", gitCommitHash: "abc" },
		nodes,
		edges,
		layers: [],
		tour: [],
	}
}
function taskSpec(p: Partial<TaskSpec>): TaskSpec {
	return {
		id: "t",
		goal: "",
		mode: "coding",
		status: "active",
		files: [],
		constraints: [],
		acceptedDecisions: [],
		rejectedDirections: [],
		pendingPatches: [],
		acceptanceCriteria: [],
		...p,
	}
}
function changeAnalysis(p: Partial<ChangeAnalysis>): ChangeAnalysis {
	return {
		fileChanges: [],
		newFiles: [],
		deletedFiles: [],
		structurallyChangedFiles: [],
		cosmeticOnlyFiles: [],
		unchangedFiles: [],
		...p,
	} as ChangeAnalysis
}

async function main() {
	let passed = 0

	// 1. KnowledgeStore round-trip + dangling edge 移除
	const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kg-verify-"))
	try {
		const store = new KnowledgeStore(tmp)
		assert.strictEqual(await store.readGraph(), null, "缺失图谱应返回 null")
		passed++

		const saved = await store.writeGraph(graph([node("file:a.ts", "a.ts"), node("file:b.ts", "b.ts")], [edge("file:a.ts", "file:b.ts")]))
		assert.strictEqual(saved.edges.length, 1, "有效边应保留")
		const read = await store.readGraph()
		assert.ok(read && read.nodes.length === 2, "round-trip 节点数应为 2")
		passed++

		const sanitized = await store.writeGraph(graph([node("file:a.ts", "a.ts")], [edge("file:a.ts", "file:ghost.ts")]))
		assert.strictEqual(sanitized.edges.length, 0, "dangling edge 应被移除")
		passed++

		await store.dir // touch
		await fs.writeFile(store.graphPath, "{ broken json", "utf8")
		assert.strictEqual(await store.readGraph(), null, "损坏 JSON 应返回 null")
		passed++
	} finally {
		await fs.rm(tmp, { recursive: true, force: true })
	}

	// 2. GraphRetriever 上限 + 精确命中
	{
		const nodes = Array.from({ length: 40 }, (_, i) => node(`file:f${i}.ts`, `f${i}.ts`, "auth handler"))
		const retriever = new GraphRetriever(graph(nodes))
		const result = retriever.retrieve(taskSpec({ goal: "auth handler" }))
		assert.ok(result.nodes.length <= MAX_NODES, "节点数应 ≤ MAX_NODES")
		passed++

		const g2 = graph([node("file:src/auth/login.ts", "src/auth/login.ts"), node("file:src/x.ts", "src/x.ts")])
		const r2 = new GraphRetriever(g2).retrieve(taskSpec({ files: ["src/auth/login.ts"] }))
		assert.strictEqual(r2.nodes[0]?.id, "file:src/auth/login.ts", "精确文件命中应排首位")
		passed++
	}

	// 3. change-classifier 决策
	{
		assert.strictEqual(classifyUpdate(changeAnalysis({ cosmeticOnlyFiles: ["a.ts"] }), 100).action, "SKIP", "cosmetic → SKIP")
		passed++
		assert.strictEqual(
			classifyUpdate(changeAnalysis({ structurallyChangedFiles: Array.from({ length: 31 }, (_, i) => `f${i}.ts`) }), 200).action,
			"FULL_UPDATE",
			">30 结构变化 → FULL_UPDATE",
		)
		passed++
		assert.strictEqual(
			classifyUpdate(changeAnalysis({ structurallyChangedFiles: ["src/a.ts"] }), 100, ["src/a.ts", "src/b.ts"]).action,
			"PARTIAL_UPDATE",
			"局部结构变化 → PARTIAL_UPDATE",
		)
		passed++
	}

	console.log(`✔ 全部验证通过 (${passed} 项)`)
}

main().catch((e) => {
	console.error("✘ 验证失败:", e)
	process.exit(1)
})
