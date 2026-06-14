import { expect } from "chai"
import { describe, it } from "mocha"
import { ContextSanitizer } from "../ContextSanitizer"
import { TaskSpecManager } from "../TaskSpecManager"

describe("TaskSpecManager and ContextSanitizer", () => {
	it("builds worker prompts from sanitized task context only", () => {
		const manager = new TaskSpecManager()
		const taskSpec = manager.ensureTaskSpecFromDraft(
			{
				goal: "Fix the login form",
				mode: "debugging",
				files: ["src/login.ts"],
				constraints: ["Do not change backend"],
				acceptanceCriteria: ["Login test passes"],
			},
			"m1",
		)
		manager.applyPatch({ kind: "reject_direction", text: "Do not rewrite the UI", sourceMessageId: "m2", createdAt: 2 })
		manager.applyPatch({ kind: "add_constraint", text: "Keep existing API shape", sourceMessageId: "m3", createdAt: 3 })

		const prompt = new ContextSanitizer().toWorkerPrompt(manager.getTaskSpec() ?? taskSpec)

		expect(prompt).to.contain("Fix the login form")
		expect(prompt).to.contain("src/login.ts")
		expect(prompt).to.contain("Do not change backend")
		expect(prompt).to.contain("Do not rewrite the UI")
		expect(prompt).to.contain("Pending Revisions")
		expect(prompt).not.to.contain("にゃ")
		expect(prompt).not.to.contain("ボス")
	})

	it("deduplicates repeated patches", () => {
		const manager = new TaskSpecManager()
		manager.ensureTaskSpec("Fix login", "m1")
		manager.applyPatch({ kind: "add_constraint", text: "Do not change backend", sourceMessageId: "m2", createdAt: 2 })
		manager.applyPatch({ kind: "add_constraint", text: "Do not change backend", sourceMessageId: "m3", createdAt: 3 })

		expect(manager.getTaskSpec()?.constraints).to.deep.equal(["Do not change backend"])
		expect(manager.getTaskSpec()?.pendingPatches.filter((patch) => patch.text === "Do not change backend")).to.have.length(1)
	})

	it("emits a PLAN ONLY worker prompt that forbids file changes", () => {
		const manager = new TaskSpecManager()
		const spec = manager.startFreshTask({ goal: "Plan a refactor", mode: "coding", executionMode: "plan_only" }, "m1")
		const prompt = new ContextSanitizer().toWorkerPrompt(spec)

		expect(prompt).to.contain("PLAN ONLY")
		expect(prompt).to.contain("ファイルの編集・新規作成・書き込み系コマンドの実行は一切しないでください")
		expect(prompt).to.contain("attempt_completion")
	})

	it("emits a PLAN THEN EXECUTE worker prompt that plans then implements", () => {
		const manager = new TaskSpecManager()
		const spec = manager.startFreshTask({ goal: "Build a feature", mode: "coding", executionMode: "plan_then_execute" }, "m1")
		const prompt = new ContextSanitizer().toWorkerPrompt(spec)

		expect(prompt).to.contain("PLAN THEN EXECUTE")
		expect(prompt).to.contain("確認を待たずにそのまま実装")
	})

	it("defaults to EXECUTE mode when executionMode is unset", () => {
		const manager = new TaskSpecManager()
		const spec = manager.startFreshTask({ goal: "Just do it", mode: "coding" }, "m1")
		const prompt = new ContextSanitizer().toWorkerPrompt(spec)

		expect(spec.executionMode).to.equal("execute_directly")
		expect(prompt).to.contain("Execution Mode: EXECUTE")
	})

	it("emits a SURVEY PLAN worker prompt that asks one question at a time and never edits files", () => {
		const manager = new TaskSpecManager()
		const spec = manager.startFreshTask({ goal: "Build a whole app", mode: "coding", executionMode: "survey_plan" }, "m1")
		const prompt = new ContextSanitizer().toWorkerPrompt(spec)

		expect(prompt).to.contain("SURVEY PLAN")
		// 一次只问一题:必须用 ask_followup_question 单问，且禁止 plan_mode_respond 列举。
		expect(prompt).to.contain("ask_followup_question")
		expect(prompt).to.contain("ちょうど 1 問")
		expect(prompt).to.contain("plan_mode_respond")
		// 只读不写,与 plan_only 一致。
		expect(prompt).to.contain("ファイルの編集・新規作成・書き込み系コマンドの実行は一切しないでください")
		// 先做理解度自评 + 最后 attempt_completion 出报告。
		expect(prompt).to.contain("理解度の自己評価")
		expect(prompt).to.contain("attempt_completion")
	})
})
