// 端到端验证(仅结构层,不调模型):在真实代码目录上跑 analyze,检查新的落盘结构。
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { KnowledgeService } from "../src/core/knowledge/KnowledgeService"

async function main() {
	// 用扩展自身的 src/core/knowledge 作为被分析目标(真实 TS 代码)。
	const root = path.resolve(__dirname, "..")
	const service = new KnowledgeService(root, path.join(root, "dist"))

	// semantic:false → 不调便宜模型,纯 Tier0 结构 + detectLayers + 落盘。
	const result = await service.analyze({ semantic: false })

	const uaDir = path.join(root, ".understand-anything")
	const files = await fs.readdir(uaDir)
	console.log("== .understand-anything 文件 ==")
	for (const f of files.sort()) {
		const stat = await fs.stat(path.join(uaDir, f))
		console.log(`  ${f}: ${(stat.size / 1024).toFixed(1)} KB`)
	}

	const meta = JSON.parse(await fs.readFile(path.join(uaDir, "meta.json"), "utf8"))
	console.log("== meta.json 内容 ==")
	console.log(JSON.stringify(meta, null, 2))
	console.log("== meta 是否含 fingerprints(应为 false)==", "fingerprints" in meta)

	console.log("== 图谱统计 ==")
	console.log("  nodes:", result.graph.nodes.length)
	console.log("  edges:", result.graph.edges.length)
	console.log("  layers:", result.graph.layers.length, "→", result.graph.layers.map((l) => `${l.name}(${l.nodeIds.length})`).join(", "))

	// 路径脱敏检查:不应出现绝对路径 / 用户名。
	const leaked = result.graph.nodes.filter((n) => n.filePath && (n.filePath.startsWith("/") || n.filePath.includes("/Users/")))
	console.log("== 路径脱敏:泄露绝对路径的节点数(应为 0)==", leaked.length)
}

main().catch((e) => {
	console.error("✘ e2e 验证失败:", e)
	process.exit(1)
})
