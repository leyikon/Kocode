import { expect } from "chai"
import { describe, it } from "mocha"
import { FlashAgentSession } from "../FlashAgentSession"
import type { FlashModelDecision } from "../FlashModelClient"
import { InMemoryKocodeMemoryStore } from "../KocodeMemoryStore"

const digest = {
	status: "idle" as const,
	title: "待機中",
	summary: "待っているにゃ。",
	lastEventAt: 1,
}

const decision = (overrides: Partial<FlashModelDecision>): FlashModelDecision => ({
	intent: "social_chat",
	reply: "聞いてるにゃ、ボス。",
	task: { goal: null, mode: null, files: [], constraints: [], acceptanceCriteria: [] },
	patch: { kind: null, text: null },
	workerControl: { action: null, reason: null },
	memoryUpdate: { projectMemory: null, socialMemory: null },
	...overrides,
})

class MockFlashModelClient {
	private readonly result: FlashModelDecision | Error

	constructor(result: FlashModelDecision | Error) {
		this.result = result
	}

	async decide(): Promise<FlashModelDecision> {
		if (this.result instanceof Error) {
			throw this.result
		}
		return this.result
	}
}

describe("FlashAgentSession", () => {
	it("returns social chat decisions without creating worker intent", async () => {
		const flash = new FlashAgentSession(
			new MockFlashModelClient(decision({ intent: "social_chat" })),
			new InMemoryKocodeMemoryStore(),
		)

		const intent = await flash.classify("你好", "m1", digest, false)

		expect(intent.type).to.equal("social_chat")
	})

	it("returns new_task decisions from the model", async () => {
		const flash = new FlashAgentSession(
			new MockFlashModelClient(
				decision({
					intent: "new_task",
					reply: "まかせてにゃ、ボス。",
					task: {
						goal: "Fix the failing login test",
						mode: "debugging",
						files: ["src/login.ts"],
						constraints: ["Do not change backend"],
						acceptanceCriteria: ["Tests pass"],
					},
				}),
			),
			new InMemoryKocodeMemoryStore(),
		)

		const intent = await flash.classify("帮我修复登录测试", "m1", digest, false)

		expect(intent.type).to.equal("new_task")
		if (intent.type === "new_task") {
			expect(intent.decision.task.goal).to.equal("Fix the failing login test")
			expect(intent.decision.task.constraints).to.deep.equal(["Do not change backend"])
		}
	})

	it("falls back to local heuristics when the flash model fails", async () => {
		const flash = new FlashAgentSession(new MockFlashModelClient(new Error("bad json")), new InMemoryKocodeMemoryStore())

		const intent = await flash.classify("帮我修复这个报错", "m1", digest, false)

		// "修复" + "报错" are task verbs and there's no active task, so fallback should
		// produce a new_task intent rather than swallow the user message as flash_error.
		expect(intent.type).to.equal("new_task")
	})

	it("falls back to social_chat for chit-chat when the flash model fails", async () => {
		const flash = new FlashAgentSession(new MockFlashModelClient(new Error("bad json")), new InMemoryKocodeMemoryStore())

		const intent = await flash.classify("你好呀ここちゃん", "m1", digest, false)

		expect(intent.type).to.equal("social_chat")
	})

	it("falls back to worker_control(cancel) when the user asks to stop", async () => {
		const flash = new FlashAgentSession(new MockFlashModelClient(new Error("network down")), new InMemoryKocodeMemoryStore())

		const intent = await flash.classify("もうやめて、キャンセル", "m1", { ...digest, status: "running" }, true)

		expect(intent.type).to.equal("worker_control")
		if (intent.type === "worker_control") {
			expect(intent.control.action).to.equal("cancel")
		}
	})
})
