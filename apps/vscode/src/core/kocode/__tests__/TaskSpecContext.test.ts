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
})
