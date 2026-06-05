import { expect } from "chai"
import * as fs from "fs/promises"
import { afterEach, beforeEach, describe, it } from "mocha"
import * as os from "os"
import * as path from "path"
import { KnowledgeStore } from "../KnowledgeStore"
import type { GraphEdge, GraphNode, KnowledgeGraph } from "../vendor/types"

function node(id: string, filePath?: string): GraphNode {
	return { id, type: "file", name: id, filePath, summary: "", tags: [], complexity: "simple" }
}

function edge(source: string, target: string): GraphEdge {
	return { source, target, type: "imports", direction: "forward", weight: 0.7 }
}

function makeGraph(nodes: GraphNode[], edges: GraphEdge[]): KnowledgeGraph {
	return {
		version: "1.0.0",
		project: { name: "t", languages: [], frameworks: [], description: "", analyzedAt: "", gitCommitHash: "abc" },
		nodes,
		edges,
		layers: [],
		tour: [],
	}
}

describe("KnowledgeStore", () => {
	let tmpDir: string
	let store: KnowledgeStore

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kocode-kg-"))
		store = new KnowledgeStore(tmpDir)
	})

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true })
	})

	it("缺失图谱时 readGraph 返回 null(触发降级)", async () => {
		const graph = await store.readGraph()
		expect(graph).to.equal(null)
	})

	it("写入后再读取语义等价(round-trip)", async () => {
		const graph = makeGraph([node("file:a.ts", "a.ts"), node("file:b.ts", "b.ts")], [edge("file:a.ts", "file:b.ts")])
		await store.writeGraph(graph)
		const read = await store.readGraph()
		expect(read).to.not.equal(null)
		expect(read?.nodes.map((n) => n.id).sort()).to.deep.equal(["file:a.ts", "file:b.ts"])
		expect(read?.edges).to.have.length(1)
	})

	it("写盘前移除指向不存在节点的 dangling edge(R4.4)", async () => {
		const graph = makeGraph([node("file:a.ts", "a.ts")], [edge("file:a.ts", "file:ghost.ts")])
		const saved = await store.writeGraph(graph)
		// 指向不存在节点 file:ghost.ts 的边应被 sanitize 移除。
		expect(saved.edges).to.have.length(0)
	})

	it("损坏的 JSON 视为缺失,返回 null 而非抛出(R4.5)", async () => {
		await fs.mkdir(store.dir, { recursive: true })
		await fs.writeFile(store.graphPath, "{ this is not valid json", "utf8")
		const read = await store.readGraph()
		expect(read).to.equal(null)
	})

	it("meta 可写入并读回", async () => {
		await store.writeMeta({
			lastAnalyzedAt: "now",
			gitCommitHash: "abc",
			version: "1.0.0",
			analyzedFiles: 3,
			generatedTiers: ["structure", "semantic"],
			status: "ok",
		})
		const meta = await store.readMeta()
		expect(meta?.gitCommitHash).to.equal("abc")
		expect(meta?.generatedTiers).to.deep.equal(["structure", "semantic"])
	})
})
