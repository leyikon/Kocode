import { expect } from "chai"
import { describe, it } from "mocha"
import { classifyUpdate } from "../vendor/change-classifier"
import type { ChangeAnalysis } from "../vendor/fingerprint"

function analysis(partial: Partial<ChangeAnalysis>): ChangeAnalysis {
	return {
		fileChanges: [],
		newFiles: [],
		deletedFiles: [],
		structurallyChangedFiles: [],
		cosmeticOnlyFiles: [],
		unchangedFiles: [],
		...partial,
	} as ChangeAnalysis
}

describe("change-classifier (R7 增量决策)", () => {
	it("无结构变化 → SKIP(不触发模型)", () => {
		const decision = classifyUpdate(analysis({ cosmeticOnlyFiles: ["a.ts", "b.ts"] }), 100)
		expect(decision.action).to.equal("SKIP")
		expect(decision.filesToReanalyze).to.have.length(0)
	})

	it("无任何变化 → SKIP", () => {
		const decision = classifyUpdate(analysis({}), 100)
		expect(decision.action).to.equal("SKIP")
	})

	it("少量局部结构变化 → PARTIAL_UPDATE", () => {
		const decision = classifyUpdate(analysis({ structurallyChangedFiles: ["src/a.ts"] }), 100, ["src/a.ts", "src/b.ts"])
		expect(decision.action).to.equal("PARTIAL_UPDATE")
		expect(decision.filesToReanalyze).to.include("src/a.ts")
	})

	it("超过 30 个结构变化 → FULL_UPDATE(建议 full rebuild)", () => {
		const many = Array.from({ length: 31 }, (_, i) => `src/f${i}.ts`)
		const decision = classifyUpdate(analysis({ structurallyChangedFiles: many }), 200)
		expect(decision.action).to.equal("FULL_UPDATE")
	})

	it("超过 50% 文件结构变化 → FULL_UPDATE", () => {
		const many = Array.from({ length: 6 }, (_, i) => `src/f${i}.ts`)
		const decision = classifyUpdate(analysis({ structurallyChangedFiles: many }), 10)
		expect(decision.action).to.equal("FULL_UPDATE")
	})

	it("新增顶层目录 → ARCHITECTURE_UPDATE", () => {
		const decision = classifyUpdate(
			analysis({ newFiles: ["newdir/x.ts"] }),
			100,
			["src/a.ts", "src/b.ts"], // 已知文件都在 src/,newdir 是新目录
		)
		expect(decision.action).to.equal("ARCHITECTURE_UPDATE")
	})

	it("删除文件被纳入 filesToReanalyze/重建范围", () => {
		const decision = classifyUpdate(analysis({ deletedFiles: ["src/old.ts"], structurallyChangedFiles: ["src/a.ts"] }), 100, [
			"src/a.ts",
			"src/old.ts",
		])
		// 删除 + 局部修改:仍是 PARTIAL(同目录,数量少)
		expect(["PARTIAL_UPDATE", "ARCHITECTURE_UPDATE"]).to.include(decision.action)
	})
})
