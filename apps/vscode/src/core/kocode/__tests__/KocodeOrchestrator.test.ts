import { expect } from "chai"
import { describe, it } from "mocha"
import { FlashAgentSession } from "../FlashAgentSession"
import type { FlashModelDecision } from "../FlashModelClient"
import { InMemoryKocodeMemoryStore } from "../KocodeMemoryStore"
import { KocodeOrchestrator } from "../KocodeOrchestrator"

const decision = (overrides: Partial<FlashModelDecision>): FlashModelDecision => ({
	intent: "social_chat",
	reply: "聞いてるにゃ、ボス。",
	task: { goal: null, mode: null, files: [], constraints: [], acceptanceCriteria: [] },
	patch: { kind: null, text: null },
	workerControl: { action: null, reason: null },
	memoryUpdate: { projectMemory: null, socialMemory: null },
	...overrides,
})

class QueueFlashModelClient {
	private readonly decisions: FlashModelDecision[]

	constructor(decisions: FlashModelDecision[]) {
		this.decisions = decisions
	}

	async decide(): Promise<FlashModelDecision> {
		const next = this.decisions.shift()
		if (!next) {
			throw new Error("No mock decision queued")
		}
		return next
	}
}

describe("KocodeOrchestrator", () => {
	it("starts worker for complex tasks and keeps social chat on the flash lane", async () => {
		let initCount = 0
		const controller = {
			task: undefined,
			initTask: async () => {
				initCount += 1
				controller.task = {}
				return `task-${initCount}`
			},
			cancelTask: async () => undefined,
			getWorkspaceManager: () => undefined,
		} as any
		const flash = new FlashAgentSession(
			new QueueFlashModelClient([
				decision({
					intent: "new_task",
					reply: "作業を始めるにゃ。",
					task: {
						goal: "Create a login page",
						mode: "coding",
						files: [],
						constraints: [],
						acceptanceCriteria: ["Login page exists"],
					},
				}),
				decision({ intent: "social_chat", reply: "聞いてるにゃ、ボス。" }),
			]),
			new InMemoryKocodeMemoryStore(),
		)
		const orchestrator = new KocodeOrchestrator(controller, flash)

		await orchestrator.sendUserMessage({ text: "帮我写一个登录页面" })
		await orchestrator.sendUserMessage({ text: "你好呀" })

		expect(initCount).to.equal(1)
		expect(orchestrator.getSession().messages.at(-1)?.text).to.equal("聞いてるにゃ、ボス。")
		orchestrator.dispose()
	})
})
