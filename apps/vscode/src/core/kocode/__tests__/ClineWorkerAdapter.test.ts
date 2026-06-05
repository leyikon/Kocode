import { expect } from "chai"
import { describe, it } from "mocha"
import { sendPartialMessageEvent } from "@/core/controller/ui/subscribeToPartialMessage"
import { convertClineMessageToProto } from "@shared/proto-conversions/cline-message"
import { ClineWorkerAdapter } from "../ClineWorkerAdapter"
import { WorkerEventBus } from "../WorkerEventBus"

const taskSpec = {
	id: "task-1",
	goal: "Fix login",
	mode: "debugging" as const,
	status: "active" as const,
	files: [],
	constraints: [],
	acceptedDecisions: [],
	rejectedDirections: [],
	pendingPatches: [],
	acceptanceCriteria: [],
}

describe("ClineWorkerAdapter", () => {
	it("starts Cline with a sanitized prompt", async () => {
		const bus = new WorkerEventBus()
		const controller = {
			task: undefined,
			initTask: async (prompt: string, _images?: string[], _files?: string[], _historyItem?: unknown, taskSettings?: Record<string, unknown>) => {
				expect(prompt).to.contain("Fix login")
				expect(taskSettings?.actModeApiProvider).to.equal("cline")
				expect(taskSettings?.actModeClineModelId).to.equal("deepseek-v4-pro")
				expect(taskSettings?.planModeClineModelId).to.equal("deepseek-v4-pro")
				controller.task = {}
				return "task-1"
			},
			cancelTask: async () => undefined,
		} as any
		const worker = new ClineWorkerAdapter(controller, bus)

		await worker.start(taskSpec)

		expect(worker.isRunning()).to.equal(true)
		worker.dispose()
	})

	it("marks completion_result as completed and clears active task", async () => {
		const bus = new WorkerEventBus()
		const controller = {
			task: {},
			initTask: async () => "task-1",
			cancelTask: async () => undefined,
		} as any
		const worker = new ClineWorkerAdapter(controller, bus)
		await worker.start(taskSpec)

		await sendPartialMessageEvent(convertClineMessageToProto({
			type: "say",
			say: "completion_result",
			text: "Done",
			partial: false,
			ts: 10,
		} as any))
		await new Promise((resolve) => setTimeout(resolve, 0))

		expect(bus.getDigest().status).to.equal("completed")
		expect(worker.isRunning()).to.equal(false)
		expect(bus.getWorkerEvents().at(-1)?.kind).to.equal("completed")
		worker.dispose()
	})

	it("queues append_context patches and flushes them when an injectable ask appears", async () => {
		const bus = new WorkerEventBus()
		const askResponses: Array<{ type: string; text?: string }> = []
		const taskMock = {
			handleWebviewAskResponse: async (type: string, text?: string) => {
				askResponses.push({ type, text })
			},
		}
		const controller = {
			task: taskMock,
			initTask: async () => "task-1",
			cancelTask: async () => undefined,
		} as any
		const worker = new ClineWorkerAdapter(controller, bus)
		await worker.start(taskSpec)

		await worker.control({
			action: "append_context",
			reason: "Add dark mode toggle",
			taskSpecPatch: {
				kind: "add_constraint",
				text: "Add dark mode toggle",
				sourceMessageId: "m1",
				createdAt: 1,
			},
		})

		// Worker is mid-tool-execution: no pending ask yet, so injection waits.
		expect(askResponses.length).to.equal(0)

		await sendPartialMessageEvent(
			convertClineMessageToProto({
				type: "ask",
				ask: "tool",
				text: "approve write_to_file?",
				partial: false,
				ts: 20,
			} as any),
		)
		await new Promise((resolve) => setTimeout(resolve, 0))

		expect(askResponses.length).to.equal(1)
		expect(askResponses[0].type).to.equal("messageResponse")
		expect(askResponses[0].text ?? "").to.contain("Add dark mode toggle")
		worker.dispose()
	})

	it("does not inject into command_output asks (streaming UI)", async () => {
		const bus = new WorkerEventBus()
		const askResponses: Array<{ type: string; text?: string }> = []
		const taskMock = {
			handleWebviewAskResponse: async (type: string, text?: string) => {
				askResponses.push({ type, text })
			},
		}
		const controller = {
			task: taskMock,
			initTask: async () => "task-1",
			cancelTask: async () => undefined,
		} as any
		const worker = new ClineWorkerAdapter(controller, bus)
		await worker.start(taskSpec)

		await worker.control({
			action: "append_context",
			reason: "Tweak",
			taskSpecPatch: { kind: "add_constraint", text: "Tweak", sourceMessageId: "m2", createdAt: 1 },
		})

		await sendPartialMessageEvent(
			convertClineMessageToProto({
				type: "ask",
				ask: "command_output",
				text: "ls output...",
				partial: false,
				ts: 30,
			} as any),
		)
		await new Promise((resolve) => setTimeout(resolve, 0))

		expect(askResponses.length).to.equal(0)
		worker.dispose()
	})

	it("redirect cancels the worker and answers the resume_task ask with the redirection text", async () => {
		const bus = new WorkerEventBus()
		const askResponses: Array<{ type: string; text?: string }> = []
		let cancelCalled = false
		const taskMock = {
			taskId: "task-redirect",
			handleWebviewAskResponse: async (type: string, text?: string) => {
				askResponses.push({ type, text })
			},
		}
		const controller = {
			task: taskMock,
			initTask: async () => "task-redirect",
			cancelTask: async () => {
				cancelCalled = true
				// Simulate Cline reinit-on-cancel: surface a resume_task ask shortly after.
				setTimeout(() => {
					void sendPartialMessageEvent(
						convertClineMessageToProto({
							type: "ask",
							ask: "resume_task",
							text: "",
							partial: false,
							ts: 40,
						} as any),
					)
				}, 20)
			},
		} as any
		const worker = new ClineWorkerAdapter(controller, bus)
		await worker.start(taskSpec)

		await worker.control({
			action: "redirect",
			reason: "Use Tailwind, not vanilla CSS",
			taskSpecPatch: {
				kind: "reject_direction",
				text: "vanilla CSS",
				sourceMessageId: "m3",
				createdAt: 1,
			},
		})

		expect(cancelCalled).to.equal(true)
		expect(askResponses.length).to.equal(1)
		expect(askResponses[0].type).to.equal("messageResponse")
		expect(askResponses[0].text ?? "").to.contain("Use Tailwind")
		expect(askResponses[0].text ?? "").to.contain("vanilla CSS")
		worker.dispose()
	})
})
