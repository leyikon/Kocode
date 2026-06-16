import { convertClineMessageToProto } from "@shared/proto-conversions/cline-message"
import { expect } from "chai"
import { describe, it } from "mocha"
import { sendPartialMessageEvent } from "@/core/controller/ui/subscribeToPartialMessage"
import { FlashAgentSession } from "../FlashAgentSession"
import type { FlashModelDecision } from "../FlashModelClient"
import { InMemoryKocodeMemoryStore } from "../KocodeMemoryStore"
import { InMemoryKocodeMemoStore } from "../KocodeMemoStore"
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

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
	const startedAt = Date.now()
	while (!predicate()) {
		if (Date.now() - startedAt > timeoutMs) {
			return
		}
		await new Promise((resolve) => setTimeout(resolve, 10))
	}
}

class QueueFlashModelClient {
	private readonly decisions: FlashModelDecision[]
	private readonly workerUpdates: string[]

	constructor(decisions: FlashModelDecision[], workerUpdates: string[] = []) {
		this.decisions = decisions
		this.workerUpdates = workerUpdates
	}

	async decide(): Promise<FlashModelDecision> {
		const next = this.decisions.shift()
		if (!next) {
			throw new Error("No mock decision queued")
		}
		return next
	}

	async composeWorkerUpdate(): Promise<{
		shouldNotify: boolean
		reply: string
		memoryUpdate: { projectMemory: null; socialMemory: null }
	}> {
		const reply = this.workerUpdates.shift()
		return {
			shouldNotify: !!reply,
			reply: reply ?? "",
			memoryUpdate: { projectMemory: null, socialMemory: null },
		}
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
			ensureWorkspaceManager: async () => undefined,
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

	it("keeps explanation requests on the flash lane without starting a worker", async () => {
		let initCount = 0
		const controller = {
			task: undefined,
			initTask: async () => {
				initCount += 1
				return `task-${initCount}`
			},
			cancelTask: async () => undefined,
			getWorkspaceManager: () => undefined,
			ensureWorkspaceManager: async () => undefined,
		} as any
		const flash = new FlashAgentSession(
			new QueueFlashModelClient([
				decision({
					intent: "explanation_request",
					reply: "ここは Flash 側で短く説明するにゃ。",
					task: {
						goal: "Explain task scheduling",
						mode: "learning",
						files: [],
						constraints: [],
						acceptanceCriteria: [],
					},
				}),
			]),
			new InMemoryKocodeMemoryStore(),
		)
		const orchestrator = new KocodeOrchestrator(controller, flash)

		const result = await orchestrator.sendUserMessage({ text: "タスク調度って何か説明して" })

		expect(result.workerStarted).to.equal(undefined)
		expect(initCount).to.equal(0)
		expect(orchestrator.getSession().messages.at(-1)?.text).to.equal("ここは Flash 側で短く説明するにゃ。")
		orchestrator.dispose()
	})

	it("starts a worker for planning requests because planning needs the worker lane", async () => {
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
			ensureWorkspaceManager: async () => undefined,
		} as any
		const flash = new FlashAgentSession(
			new QueueFlashModelClient([
				decision({
					intent: "new_task",
					reply: "Worker に計画から整理してもらうにゃ。",
					task: {
						goal: "先に実装計画だけ作る",
						mode: "coding",
						files: [],
						constraints: [],
						acceptanceCriteria: ["計画だけを出す", "ユーザーが追加で依頼するまでコード変更しない"],
					},
				}),
			]),
			new InMemoryKocodeMemoryStore(),
		)
		const orchestrator = new KocodeOrchestrator(controller, flash)

		const result = await orchestrator.sendUserMessage({ text: "先に計画だけ教えて、まだ実装しないで" })
		await new Promise((resolve) => setTimeout(resolve, 0))

		expect(result.workerStarted).to.equal(true)
		expect(initCount).to.equal(1)
		expect(orchestrator.getSession().taskSpec?.acceptanceCriteria).to.include("計画だけを出す")
		orchestrator.dispose()
	})

	it("creates a persisted completion memo and attaches a memo file ref to the Flash message", async () => {
		let initCount = 0
		const completionMarkdown = "# Final Report\n\nThis is the full long completion report."
		const controller = {
			task: undefined,
			initTask: async () => {
				initCount += 1
				controller.task = { taskId: `task-${initCount}` }
				return `task-${initCount}`
			},
			cancelTask: async () => undefined,
			getWorkspaceManager: () => undefined,
			ensureWorkspaceManager: async () => undefined,
		} as any
		const memoStore = new InMemoryKocodeMemoStore()
		const flash = new FlashAgentSession(
			new QueueFlashModelClient(
				[
					decision({
						intent: "new_task",
						reply: "作業を始めるにゃ。",
						task: { goal: "Build reports", mode: "coding", files: [], constraints: [], acceptanceCriteria: [] },
					}),
				],
				["できたよ。下のレポートを見てね。"],
			),
			new InMemoryKocodeMemoryStore(),
		)
		const orchestrator = new KocodeOrchestrator(controller, flash, memoStore)

		await orchestrator.sendUserMessage({ text: "レポート機能を作って" })
		await waitFor(() => orchestrator.getSession().workerDigest.status === "running")
		await sendPartialMessageEvent(
			convertClineMessageToProto({
				type: "say",
				say: "completion_result",
				text: completionMarkdown,
				partial: false,
				ts: 100,
			} as any),
		)
		await waitFor(() => orchestrator.getSession().memos.length === 1)
		await waitFor(() => orchestrator.getSession().messages.some((message) => !!message.memoRefs?.length))

		const session = orchestrator.getSession()
		expect(session.memos).to.have.length(1)
		expect(session.memos[0].kind).to.equal("completion_report")
		expect(session.memos[0].title).to.equal("Final Report")
		expect(session.memos[0].markdown).to.equal(completionMarkdown)
		const flashMessage = session.messages.at(-1)
		expect(flashMessage?.text).to.equal("できたよ。下のレポートを見てね。")
		expect(flashMessage?.text).not.to.contain("full long completion report")
		expect(flashMessage?.memoRefs?.[0]?.id).to.equal(session.memos[0].id)
		const memoId = session.memos[0].id
		orchestrator.dispose()

		const restored = new KocodeOrchestrator(
			controller,
			new FlashAgentSession(new QueueFlashModelClient([]), new InMemoryKocodeMemoryStore()),
			memoStore,
		)
		await restored.ensureReady()
		expect(restored.getSession().memos[0].id).to.equal(memoId)
		await restored.selectWorkbench({ memoId })
		expect(restored.getSession().selectedMemoId).to.equal(memoId)
		restored.dispose()
	})

	it("classifies plan_only completion output as a plan report memo", async () => {
		const controller = {
			task: undefined,
			initTask: async () => {
				controller.task = { taskId: "task-plan" }
				return "task-plan"
			},
			cancelTask: async () => undefined,
			getWorkspaceManager: () => undefined,
			ensureWorkspaceManager: async () => undefined,
		} as any
		const flash = new FlashAgentSession(
			new QueueFlashModelClient(
				[
					decision({
						intent: "new_task",
						reply: "作り方を整理するにゃ。",
						task: {
							goal: "Plan the work",
							mode: "coding",
							executionMode: "plan_only",
							files: [],
							constraints: [],
							acceptanceCriteria: [],
						},
					}),
				],
				["計画をまとめたよ。"],
			),
			new InMemoryKocodeMemoryStore(),
		)
		const orchestrator = new KocodeOrchestrator(controller, flash, new InMemoryKocodeMemoStore())

		await orchestrator.sendUserMessage({ text: "計画だけ出して" })
		await waitFor(() => orchestrator.getSession().workerDigest.status === "running")
		await sendPartialMessageEvent(
			convertClineMessageToProto({
				type: "say",
				say: "completion_result",
				text: "# Implementation Plan\n\nDo not edit files yet.",
				partial: false,
				ts: 200,
			} as any),
		)
		await waitFor(() => orchestrator.getSession().memos.length === 1)
		await waitFor(() => orchestrator.getSession().messages.some((message) => !!message.memoRefs?.length))

		const session = orchestrator.getSession()
		expect(session.memos).to.have.length(1)
		expect(session.memos[0].kind).to.equal("plan_report")
		expect(session.messages.at(-1)?.memoRefs?.[0]?.kind).to.equal("plan_report")
		orchestrator.dispose()
	})

	it("requires user confirmation before restoring a rollback checkpoint", async () => {
		let initCount = 0
		let restoreCall: { messageTs: number; restoreType: string; offset?: number } | undefined
		const taskMock = {
			taskId: "task-rollback",
			taskState: { isInitialized: true },
			messageStateHandler: {
				getClineMessages: () => [
					{ type: "say", say: "checkpoint_created", ts: 100, lastCheckpointHash: "hash-1" },
					{ type: "say", say: "checkpoint_created", ts: 200, lastCheckpointHash: "hash-2" },
				],
			},
			checkpointManager: {
				restoreCheckpoint: async (messageTs: number, restoreType: string, offset?: number) => {
					restoreCall = { messageTs, restoreType, offset }
				},
			},
		}
		const controller = {
			task: undefined,
			initTask: async () => {
				initCount += 1
				controller.task = taskMock
				return "task-rollback"
			},
			cancelTask: async () => undefined,
			getWorkspaceManager: () => undefined,
			ensureWorkspaceManager: async () => undefined,
		} as any
		const flash = new FlashAgentSession(
			new QueueFlashModelClient([
				decision({
					intent: "new_task",
					reply: "作業を始めるにゃ。",
					task: {
						goal: "Change the settings UI",
						mode: "coding",
						files: [],
						constraints: [],
						acceptanceCriteria: [],
					},
				}),
				decision({
					intent: "worker_control",
					reply: "確認してから戻すにゃ。",
					patch: { kind: "request_rollback", text: "完全不行，回滚 2 步" },
					workerControl: {
						action: "rollback_request",
						reason: "完全不行，回滚 2 步",
						rollback: { steps: 2, restoreType: "taskAndWorkspace" },
					},
				}),
			]),
			new InMemoryKocodeMemoryStore(),
		)
		const orchestrator = new KocodeOrchestrator(controller, flash)

		await orchestrator.sendUserMessage({ text: "帮我改设置 UI" })
		await new Promise((resolve) => setTimeout(resolve, 0))
		await orchestrator.sendUserMessage({ text: "完全不行，回滚 2 步" })

		expect(initCount).to.equal(1)
		expect(restoreCall).to.equal(undefined)
		expect(orchestrator.getSession().pendingRollback?.steps).to.equal(2)

		await orchestrator.sendUserMessage({ text: "确认回滚" })

		expect(restoreCall).to.deep.equal({ messageTs: 100, restoreType: "taskAndWorkspace", offset: 0 })
		expect(orchestrator.getSession().pendingRollback).to.equal(undefined)
		expect(orchestrator.getSession().taskSpec?.status).to.equal("paused")
		orchestrator.dispose()
	})

	it("asks for confirmation before discarding a running task on new_task (#4)", async () => {
		let initCount = 0
		let cancelCount = 0
		const controller = {
			task: undefined,
			initTask: async () => {
				initCount += 1
				controller.task = {}
				return `task-${initCount}`
			},
			cancelTask: async () => {
				cancelCount += 1
				controller.task = undefined
			},
			getWorkspaceManager: () => undefined,
			ensureWorkspaceManager: async () => undefined,
		} as any
		const flash = new FlashAgentSession(
			new QueueFlashModelClient([
				decision({
					intent: "new_task",
					reply: "作業を始めるにゃ。",
					task: { goal: "First task", mode: "coding", files: [], constraints: [], acceptanceCriteria: [] },
				}),
				decision({
					intent: "new_task",
					reply: "新しいのを始めるにゃ。",
					task: { goal: "Second task", mode: "coding", files: [], constraints: [], acceptanceCriteria: [] },
				}),
			]),
			new InMemoryKocodeMemoryStore(),
		)
		const orchestrator = new KocodeOrchestrator(controller, flash)

		await orchestrator.sendUserMessage({ text: "做第一个任务" })
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(initCount).to.equal(1)

		// Second new_task while worker is running: must NOT cancel yet, must ask for confirmation.
		const second = await orchestrator.sendUserMessage({ text: "做另一个完全不同的任务" })
		expect(second.workerStarted).to.equal(undefined)
		expect(cancelCount).to.equal(0)
		expect(initCount).to.equal(1)

		// User declines: keep the current task, no cancel, no new worker.
		await orchestrator.sendUserMessage({ text: "いいえ" })
		expect(cancelCount).to.equal(0)
		expect(initCount).to.equal(1)

		orchestrator.dispose()
	})

	it("confirms the queued task switch and starts the new task (#4)", async () => {
		let initCount = 0
		let cancelCount = 0
		const controller = {
			task: undefined,
			initTask: async () => {
				initCount += 1
				controller.task = {}
				return `task-${initCount}`
			},
			cancelTask: async () => {
				cancelCount += 1
				controller.task = undefined
			},
			getWorkspaceManager: () => undefined,
			ensureWorkspaceManager: async () => undefined,
		} as any
		const flash = new FlashAgentSession(
			new QueueFlashModelClient([
				decision({
					intent: "new_task",
					reply: "作業を始めるにゃ。",
					task: { goal: "First task", mode: "coding", files: [], constraints: [], acceptanceCriteria: [] },
				}),
				decision({
					intent: "new_task",
					reply: "新しいのを始めるにゃ。",
					task: { goal: "Second task", mode: "coding", files: [], constraints: [], acceptanceCriteria: [] },
				}),
			]),
			new InMemoryKocodeMemoryStore(),
		)
		const orchestrator = new KocodeOrchestrator(controller, flash)

		await orchestrator.sendUserMessage({ text: "做第一个任务" })
		await new Promise((resolve) => setTimeout(resolve, 0))
		await orchestrator.sendUserMessage({ text: "做另一个完全不同的任务" })

		// User confirms the switch: current task cancelled, new worker started.
		await orchestrator.sendUserMessage({ text: "はい" })
		await new Promise((resolve) => setTimeout(resolve, 0))

		expect(cancelCount).to.equal(1)
		expect(initCount).to.equal(2)
		expect(orchestrator.getSession().taskSpec?.goal).to.equal("Second task")
		orchestrator.dispose()
	})

	it("marks the task failed when the worker fails to start (#3)", async () => {
		const controller = {
			task: undefined,
			initTask: async () => {
				throw new Error("init boom")
			},
			cancelTask: async () => undefined,
			getWorkspaceManager: () => undefined,
			ensureWorkspaceManager: async () => undefined,
		} as any
		const flash = new FlashAgentSession(
			new QueueFlashModelClient([
				decision({
					intent: "new_task",
					reply: "作業を始めるにゃ。",
					task: { goal: "Boom task", mode: "coding", files: [], constraints: [], acceptanceCriteria: [] },
				}),
			]),
			new InMemoryKocodeMemoryStore(),
		)
		const orchestrator = new KocodeOrchestrator(controller, flash)

		await orchestrator.sendUserMessage({ text: "做一个会启动失败的任务" })
		// Allow the fire-and-forget worker.start().catch() to settle.
		await new Promise((resolve) => setTimeout(resolve, 10))

		expect(orchestrator.getSession().taskSpec?.status).to.equal("failed")
		expect(orchestrator.getSession().workerDigest.status).to.equal("failed")
		orchestrator.dispose()
	})
})
