import type {
    KocodeChatMessage,
    KocodeEvent,
    KocodeSendResult,
    KocodeSessionState,
    KocodeUserMessage,
    PendingRollbackConfirmation,
    TaskSpecPatch,
    WorkerControlRequest,
    WorkerDigest,
    WorkerEvent,
    WorkerRollbackRestoreType,
} from "@shared/kocode"
import { Controller } from "@/core/controller"
import { ClineWorkerAdapter } from "./ClineWorkerAdapter"
import { FlashAgentSession } from "./FlashAgentSession"
import type { FlashWorkerUpdateReason } from "./FlashModelClient"
import { FileKocodeMemoryStore } from "./KocodeMemoryStore"
import { KocodeTrace } from "./KocodeTrace"
import { type TaskSpecDraft, TaskSpecManager } from "./TaskSpecManager"
import { type KocodeEventListener, WorkerEventBus } from "./WorkerEventBus"

const WORKER_NOTICE_COOLDOWN_MS = 8_000
// Coalesce bursts of worker events into a single Flash translation.
const PROGRESS_DEBOUNCE_MS = 1_500
const MAX_CRITICAL_WORKER_UPDATE_RETRIES = 2
const MAX_ROLLBACK_STEPS = 3
// 终态去重键的硬上限，防止超长会话下集合无界增长（#8）。
const MAX_TERMINAL_DEDUP_KEYS = 64

// 在 Worker 正在运行时收到 new_task，需要先向用户确认再丢弃当前任务（#4）。
interface PendingTaskSwitch {
	id: string
	draft: TaskSpecDraft
	reply: string
	sourceMessageId: string
	createdAt: number
}

function clampRollbackSteps(steps?: number): number {
	const normalized = Number.isFinite(steps) ? Math.trunc(steps ?? 1) : 1
	return Math.max(1, Math.min(MAX_ROLLBACK_STEPS, normalized))
}

function extractRollbackSteps(text: string): number | undefined {
	const value = text.match(/(?:回滚|回退|撤回|恢复到|rollback|roll back|戻|巻き戻)[^\d一二三]*([123一二三])/i)?.[1]
	if (!value) {
		return undefined
	}
	if (value === "一") {
		return 1
	}
	if (value === "二") {
		return 2
	}
	if (value === "三") {
		return 3
	}
	return Number(value)
}

function isRollbackConfirmation(text: string): boolean {
	const lower = text.trim().toLowerCase()
	return /确认|確定|是的|可以|执行|回滚吧|开始回滚|confirm|yes|ok|はい|お願い/.test(lower)
}

function isRollbackCancellation(text: string): boolean {
	const lower = text.trim().toLowerCase()
	return /取消|不要|先不|别回滚|不用回滚|不回滚|cancel|no|やめ|待って/.test(lower)
}

// 任务切换确认复用与回滚一致的肯定/否定判断词表。
function isConfirmation(text: string): boolean {
	return isRollbackConfirmation(text)
}

function isCancellation(text: string): boolean {
	return isRollbackCancellation(text)
}

export class KocodeOrchestrator {
	private readonly bus = new WorkerEventBus()
	private readonly flash: FlashAgentSession
	private readonly taskSpecManager = new TaskSpecManager()
	private readonly worker: ClineWorkerAdapter
	private readonly messages: KocodeChatMessage[] = []
	private readonly unsubscribeWorkerMonitor: () => void
	private workerUpdateInFlight = false
	// 关键通知改为去重队列，确保 waiting 不会被后到的 completed/failed 覆盖丢失（#2）。
	private readonly pendingCriticalQueue: FlashWorkerUpdateReason[] = []
	private readonly criticalWorkerUpdateRetries = new Map<string, number>()
	private lastFlashWorkerNoticeAt = 0
	private lastProgressDigestKey = ""
	private readonly notifiedTerminalWorkerKeys = new Set<string>()
	private progressDebounceTimer?: ReturnType<typeof setTimeout>
	private pendingRollback?: PendingRollbackConfirmation
	private pendingTaskSwitch?: PendingTaskSwitch
	// 串行化用户消息处理，避免并发 sendUserMessage 交错改写 TaskSpec 状态（#1 并发场景）。
	private sendChain: Promise<unknown> = Promise.resolve()
	private disposed = false

	constructor(controller: Controller, flash?: FlashAgentSession) {
		const cwd = controller.getWorkspaceManager()?.getPrimaryRoot()?.path
		this.flash = flash ?? new FlashAgentSession(undefined, new FileKocodeMemoryStore(cwd))
		this.worker = new ClineWorkerAdapter(controller, this.bus)
		// Worker が承認待ちで止まったら、Flash Agent に許可/拒否を判断させて自動応答する。
		this.worker.setApprovalResolver((request) => this.resolveWorkerApproval(request))
		this.unsubscribeWorkerMonitor = this.bus.subscribe((event) => {
			void this.handleWorkerEventForFlash(event)
		})
	}

	/**
	 * Worker（Cline）の承認待ちを Flash Agent に判断させる。
	 * 同じ Flash Agent（モデル・記憶）を使い、別系統は立てない。判断後はユーザーへ一言伝える。
	 */
	private async resolveWorkerApproval(request: { askType: string; askText: string }): Promise<boolean> {
		const decision = await this.flash.decideWorkerApproval(
			request.askType,
			request.askText,
			this.bus.getDigest(),
			this.taskSpecManager.getTaskSpec(),
			this.bus.getWorkerEvents().slice(-8),
		)
		KocodeTrace.log("orchestrator_worker_approval", {
			askType: request.askType,
			approve: decision.approve,
			reason: decision.reason,
		})
		const reply = decision.reply?.trim()
		if (reply) {
			await this.sayFlash(reply, { workerNotice: true })
		}
		return decision.approve
	}

	subscribe(listener: KocodeEventListener): () => void {
		return this.bus.subscribe(listener)
	}

	getSession(): KocodeSessionState {
		return {
			messages: [...this.messages],
			taskSpec: this.taskSpecManager.getTaskSpec(),
			workerDigest: this.bus.getDigest(),
			workerEvents: this.bus.getWorkerEvents(),
			pendingRollback: this.pendingRollback,
		}
	}

	async sendUserMessage(request: KocodeUserMessage): Promise<KocodeSendResult> {
		// 串行化处理：把每条消息排到前一条之后，避免并发改写 TaskSpec / Worker 状态（#1）。
		const run = this.sendChain.then(
			() => this.processUserMessage(request),
			() => this.processUserMessage(request),
		)
		this.sendChain = run.catch(() => undefined)
		return run
	}

	private async processUserMessage(request: KocodeUserMessage): Promise<KocodeSendResult> {
		const userMessage = this.toUserMessage(request)
		KocodeTrace.log("user_message", {
			messageId: userMessage.id,
			text: request.text,
			files: request.files?.length ?? 0,
			images: request.images?.length ?? 0,
		})
		this.messages.push(userMessage)
		await this.bus.emit({ type: "user_message", message: userMessage })
		if (this.pendingCriticalQueue.length > 0) {
			// 用户回来了：把排队的关键通知按顺序补发出去（#2）。
			const next = this.pendingCriticalQueue.shift()
			if (next) {
				void this.scheduleWorkerUpdate(next, { critical: true })
			}
		}
		// 优先处理待确认的任务切换：用户在被询问"是否丢弃当前任务"后回复（#4）。
		if (this.pendingTaskSwitch && (await this.handlePendingTaskSwitchReply(request.text))) {
			return { accepted: true, messageId: userMessage.id, taskSpec: this.taskSpecManager.getTaskSpec() }
		}
		if (this.pendingRollback && (await this.handlePendingRollbackReply(request.text))) {
			return { accepted: true, messageId: userMessage.id, taskSpec: this.taskSpecManager.getTaskSpec() }
		}

		const taskSpec = this.taskSpecManager.getTaskSpec()
		const hasActiveTask = this.worker.isRunning() || taskSpec?.status === "active" || taskSpec?.status === "paused"
		const intent = await this.flash.classify(
			request.text,
			userMessage.id,
			this.bus.getDigest(),
			hasActiveTask,
			taskSpec,
			this.messages.map((message) => ({ author: message.author, text: message.text })),
		)

		KocodeTrace.log("orchestrator_intent", {
			messageId: userMessage.id,
			intent: intent.type,
			workerRunning: this.worker.isRunning(),
			taskStatus: this.taskSpecManager.getTaskSpec()?.status,
			taskGoal: this.taskSpecManager.getTaskSpec()?.goal,
		})

		switch (intent.type) {
			case "flash_error":
			case "social_chat":
			case "status_question":
			case "explanation_request":
				KocodeTrace.log("orchestrator_action", { messageId: userMessage.id, action: "say_flash", intent: intent.type })
				await this.sayFlash(intent.reply)
				return { accepted: true, messageId: userMessage.id, taskSpec: this.taskSpecManager.getTaskSpec() }

			case "worker_control":
				KocodeTrace.log("orchestrator_action", {
					messageId: userMessage.id,
					action: "worker_control",
					workerAction: intent.control.action,
					reason: intent.control.reason,
					patchKind: intent.control.taskSpecPatch?.kind,
				})
				if (intent.control.taskSpecPatch) {
					await this.applyPatch(intent.control.taskSpecPatch)
				}
				if (intent.control.action === "rollback_request") {
					await this.requestRollbackConfirmation(intent.control, userMessage.id, intent.reply)
					return { accepted: true, messageId: userMessage.id, taskSpec: this.taskSpecManager.getTaskSpec() }
				}
				if (intent.control.action === "rollback_confirmed") {
					await this.confirmPendingRollback(intent.control.rollback?.confirmationId)
					return { accepted: true, messageId: userMessage.id, taskSpec: this.taskSpecManager.getTaskSpec() }
				}
				const controlResult = await this.worker.control(intent.control)
				if (intent.control.action === "pause") {
					await this.emitTaskSpec(this.taskSpecManager.markPaused())
				}
				if (intent.control.action === "cancel") {
					await this.emitTaskSpec(this.taskSpecManager.markCancelled())
				}
				if (intent.control.action === "redirect" || intent.control.action === "replan") {
					// Worker now resumes from history with the redirection text injected; only restart
					// if no resume path was available (worker had no history yet).
					if (controlResult.needsFreshStart || !this.worker.isRunning()) {
						await this.restartWorkerIfTaskExists()
					} else {
						await this.emitTaskSpec(this.taskSpecManager.markActive())
					}
				}
				await this.sayFlash(intent.reply)
				return { accepted: true, messageId: userMessage.id, taskSpec: this.taskSpecManager.getTaskSpec() }

			case "task_revision":
				KocodeTrace.log("orchestrator_action", {
					messageId: userMessage.id,
					action: "task_revision",
					patchKind: intent.patch.kind,
					patchText: intent.patch.text,
				})
				await this.applyPatch(intent.patch)
				if (this.worker.isRunning()) {
					await this.worker.control({
						action: "append_context",
						reason: intent.patch.text,
						taskSpecPatch: intent.patch,
					})
				} else {
					await this.restartWorkerIfTaskExists()
				}
				await this.sayFlash(this.flash.revisionQueuedMessage(intent.reply))
				return { accepted: true, messageId: userMessage.id, taskSpec: this.taskSpecManager.getTaskSpec() }

			case "extend_task":
				KocodeTrace.log("orchestrator_action", {
					messageId: userMessage.id,
					action: "extend_task",
					patchKind: intent.patch.kind,
					patchText: intent.patch.text,
					workerRunning: this.worker.isRunning(),
				})
				await this.applyPatch(intent.patch)
				if (this.worker.isRunning()) {
					await this.worker.control({
						action: "append_context",
						reason: intent.patch.text,
						taskSpecPatch: intent.patch,
					})
				} else {
					// Worker isn't running but we have a TaskSpec — restart with the extended scope.
					await this.restartWorkerIfTaskExists()
				}
				await this.sayFlash(intent.reply)
				return { accepted: true, messageId: userMessage.id, taskSpec: this.taskSpecManager.getTaskSpec() }

			case "new_task": {
				KocodeTrace.log("orchestrator_action", {
					messageId: userMessage.id,
					action: "new_task",
					goal: intent.decision.task.goal,
					mode: intent.decision.task.mode,
					workerRunning: this.worker.isRunning(),
				})
				const draft: TaskSpecDraft = {
					goal: intent.decision.task.goal ?? request.text,
					mode: intent.decision.task.mode,
					files: [...(intent.decision.task.files ?? []), ...(request.files ?? [])],
					constraints: intent.decision.task.constraints,
					acceptanceCriteria: intent.decision.task.acceptanceCriteria,
				}
				// Worker 还在跑：不要静默丢弃当前任务，先向用户确认（#4）。
				if (this.worker.isRunning()) {
					const confirmationId = `task-switch-${Date.now()}-${Math.random().toString(36).slice(2)}`
					this.pendingTaskSwitch = {
						id: confirmationId,
						draft,
						reply: intent.decision.reply,
						sourceMessageId: userMessage.id,
						createdAt: Date.now(),
					}
					const currentGoal = this.taskSpecManager.getTaskSpec()?.goal ?? "今の作業"
					await this.sayFlash(
						`今は「${currentGoal}」を進めてる途中にゃ。新しいお願いを始めると、今の作業は止めて保存することになるにゃ。切り替えていい？「はい」で切り替え、「いいえ」で今のを続けるにゃ。`,
					)
					return { accepted: true, messageId: userMessage.id, taskSpec: this.taskSpecManager.getTaskSpec() }
				}
				const taskSpec = await this.startFreshTaskAndWorker(draft, userMessage.id, intent.decision.reply)
				return { accepted: true, messageId: userMessage.id, taskSpec, workerStarted: true }
			}
		}
	}

	/**
	 * Archives any current task, creates a fresh TaskSpec, and starts the Worker.
	 * Worker 启动失败时会把 TaskSpec 状态同步标回 failed，避免状态机与实际分叉（#3）。
	 */
	private async startFreshTaskAndWorker(
		draft: TaskSpecDraft,
		sourceMessageId: string,
		reply: string,
	): Promise<ReturnType<TaskSpecManager["getTaskSpec"]>> {
		if (this.worker.isRunning()) {
			await this.worker.control({
				action: "cancel",
				reason: "ユーザーが新しいタスクを開始するため、現在の作業を保存にゃ。",
			})
			await this.emitTaskSpec(this.taskSpecManager.markCancelled())
		}
		const taskSpec = this.taskSpecManager.startFreshTask(draft, sourceMessageId)
		await this.emitTaskSpec(taskSpec)
		await this.sayFlash(this.flash.workerStartedMessageFromReply(reply), { workerNotice: true })

		KocodeTrace.log("orchestrator_action", {
			messageId: sourceMessageId,
			action: "start_worker",
			taskId: taskSpec.id,
			goal: taskSpec.goal,
			mode: taskSpec.mode,
		})
		this.taskSpecManager.markActive()
		await this.emitTaskSpec(this.taskSpecManager.getTaskSpec())
		const activeSpec = this.taskSpecManager.getTaskSpec()
		if (activeSpec) {
			this.worker.updateTaskSpec(activeSpec)
			void this.worker.start(activeSpec).catch(async (error) => {
				// 启动失败：把任务状态同步标回 failed 并上报，消除"active 但实际 idle"的分叉（#3）。
				await this.emitTaskSpec(this.taskSpecManager.markFailed())
				await this.bus.emitWorkerDetail({
					kind: "error",
					title: "Worker start failed",
					detail: error instanceof Error ? error.message : String(error),
					source: "kocode",
				})
				await this.bus.emitDigest({
					taskId: activeSpec.id,
					status: "failed",
					title: "起動失敗",
					summary: "Worker を起動できなかったにゃ。",
				})
			})
		}
		return this.taskSpecManager.getTaskSpec()
	}

	private async handlePendingTaskSwitchReply(text: string): Promise<boolean> {
		const pending = this.pendingTaskSwitch
		if (!pending) {
			return false
		}
		if (isCancellation(text)) {
			KocodeTrace.log("task_switch_cancelled", { confirmationId: pending.id, text })
			this.pendingTaskSwitch = undefined
			await this.sayFlash("わかったにゃ、今の作業をそのまま続けるね。新しいお願いはいつでもどうぞにゃ。")
			return true
		}
		if (isConfirmation(text)) {
			KocodeTrace.log("task_switch_confirmed", { confirmationId: pending.id })
			this.pendingTaskSwitch = undefined
			await this.startFreshTaskAndWorker(pending.draft, pending.sourceMessageId, pending.reply)
			return true
		}
		await this.sayFlash("今の作業を止めて新しいお願いに切り替える？「はい」で切り替え、「いいえ」で今のを続けるにゃ。")
		return true
	}

	async workerControl(request: WorkerControlRequest): Promise<void> {
		KocodeTrace.log("external_worker_control", {
			action: request.action,
			reason: request.reason,
			patchKind: request.taskSpecPatch?.kind,
		})
		if (request.taskSpecPatch) {
			await this.applyPatch(request.taskSpecPatch)
		}
		if (request.action === "rollback_request") {
			await this.requestRollbackConfirmation(request, `external-${Date.now()}`)
			return
		}
		if (request.action === "rollback_confirmed") {
			await this.confirmPendingRollback(request.rollback?.confirmationId)
			return
		}
		const controlResult = await this.worker.control(request)
		if (request.action === "pause") {
			await this.emitTaskSpec(this.taskSpecManager.markPaused())
		}
		if (request.action === "cancel") {
			await this.emitTaskSpec(this.taskSpecManager.markCancelled())
		}
		if (request.action === "redirect" || request.action === "replan") {
			if (controlResult.needsFreshStart || !this.worker.isRunning()) {
				await this.restartWorkerIfTaskExists()
			} else {
				await this.emitTaskSpec(this.taskSpecManager.markActive())
			}
		}
	}

	dispose(): void {
		this.disposed = true
		if (this.progressDebounceTimer) {
			clearTimeout(this.progressDebounceTimer)
			this.progressDebounceTimer = undefined
		}
		this.unsubscribeWorkerMonitor()
		this.worker.dispose()
	}

	private toUserMessage(request: KocodeUserMessage): KocodeChatMessage {
		return {
			id: `user-${Date.now()}-${Math.random().toString(36).slice(2)}`,
			author: "user",
			text: request.text,
			ts: Date.now(),
			images: request.images,
			files: request.files,
		}
	}

	private async sayFlash(text: string, options: { workerNotice?: boolean } = {}): Promise<void> {
		const message = this.flash.toMessage(text)
		KocodeTrace.log("flash_message", { messageId: message.id, text })
		this.messages.push(message)
		if (options.workerNotice) {
			this.lastFlashWorkerNoticeAt = Date.now()
		}
		await this.bus.emit({ type: "flash_message", message })
	}

	private async applyPatch(patch: TaskSpecPatch): Promise<void> {
		const taskSpec = this.taskSpecManager.applyPatch(patch)
		KocodeTrace.log("task_spec_patch", {
			patchKind: patch.kind,
			patchText: patch.text,
			taskId: taskSpec.id,
			status: taskSpec.status,
			goal: taskSpec.goal,
			mode: taskSpec.mode,
			pendingPatches: taskSpec.pendingPatches.length,
		})
		await this.emitTaskSpec(taskSpec)
	}

	private async requestRollbackConfirmation(
		request: WorkerControlRequest,
		sourceMessageId: string,
		modelReply?: string,
	): Promise<void> {
		const steps = clampRollbackSteps(request.rollback?.steps ?? extractRollbackSteps(request.reason))
		const restoreType: WorkerRollbackRestoreType = request.rollback?.restoreType ?? "taskAndWorkspace"
		const preview = this.worker.getRollbackPreview({ steps, restoreType })
		KocodeTrace.log("rollback_confirmation_requested", {
			sourceMessageId,
			steps,
			restoreType,
			checkpointCount: preview.checkpointCount,
			available: preview.available,
		})

		if (!preview.available) {
			this.pendingRollback = undefined
			await this.sayFlash(
				"现在找不到可用的 Cline checkpoint，所以不会执行回滚。可以先让 Worker 停下，或者手动检查当前改动。",
			)
			return
		}

		const confirmationId = `rollback-${Date.now()}-${Math.random().toString(36).slice(2)}`
		this.pendingRollback = {
			id: confirmationId,
			steps,
			restoreType,
			reason: request.reason,
			sourceMessageId,
			createdAt: Date.now(),
		}
		const intro = modelReply?.trim() ? `${modelReply.trim()}\n\n` : ""
		await this.sayFlash(
			`${intro}我不会直接回滚。将回到当前 Worker 最近第 ${steps} 个 Cline checkpoint（最多 ${MAX_ROLLBACK_STEPS} 步），范围是 ${restoreType}。回复“确认回滚”执行，回复“取消回滚”放弃。`,
		)
	}

	private async handlePendingRollbackReply(text: string): Promise<boolean> {
		if (!this.pendingRollback) {
			return false
		}
		if (isRollbackCancellation(text)) {
			KocodeTrace.log("rollback_confirmation_cancelled", {
				confirmationId: this.pendingRollback.id,
				text,
			})
			this.pendingRollback = undefined
			await this.sayFlash("好的，回滚已取消。当前代码和任务状态不会因为这次确认请求而改变。")
			return true
		}
		if (isRollbackConfirmation(text)) {
			await this.confirmPendingRollback(this.pendingRollback.id)
			return true
		}
		await this.sayFlash("我还没有执行回滚。请回复“确认回滚”继续，或回复“取消回滚”放弃。")
		return true
	}

	private async confirmPendingRollback(confirmationId?: string): Promise<void> {
		const pending = this.pendingRollback
		if (!pending) {
			await this.sayFlash("现在没有等待确认的回滚请求。")
			return
		}
		if (confirmationId && confirmationId !== pending.id) {
			await this.sayFlash("这个回滚确认已经过期或不匹配，所以我没有执行。")
			return
		}
		this.pendingRollback = undefined
		KocodeTrace.log("rollback_confirmed", {
			confirmationId: pending.id,
			steps: pending.steps,
			restoreType: pending.restoreType,
		})
		const result = await this.worker.control({
			action: "rollback_confirmed",
			reason: pending.reason,
			rollback: {
				steps: pending.steps,
				restoreType: pending.restoreType,
				confirmationId: pending.id,
			},
		})
		if (result.handled) {
			await this.emitTaskSpec(this.taskSpecManager.markPaused())
			await this.sayFlash(
				`已回滚到最近第 ${pending.steps} 个 checkpoint。我先停在这里，不会自动继续重做；告诉我新的方向后再重新开始。`,
			)
			return
		}
		await this.sayFlash("回滚没有成功执行，可能是 checkpoint 已不可用或 Cline 当前任务状态不允许恢复。")
	}

	private async emitTaskSpec(taskSpec: ReturnType<TaskSpecManager["getTaskSpec"]>): Promise<void> {
		if (taskSpec) {
			await this.bus.emit({ type: "task_spec_updated", taskSpec } satisfies KocodeEvent)
		}
	}

	private async restartWorkerIfTaskExists(): Promise<void> {
		const taskSpec = this.taskSpecManager.markActive()
		if (!taskSpec) {
			return
		}
		await this.emitTaskSpec(taskSpec)
		this.worker.updateTaskSpec(taskSpec)
		void this.worker.start(taskSpec).catch(async (error) => {
			// 重启失败：与首次启动一致，把状态同步标回 failed（#3）。
			await this.emitTaskSpec(this.taskSpecManager.markFailed())
			await this.bus.emitWorkerDetail({
				kind: "error",
				title: "Worker restart failed",
				detail: error instanceof Error ? error.message : String(error),
				source: "kocode",
			})
			await this.bus.emitDigest({
				taskId: taskSpec.id,
				status: "failed",
				title: "再起動失敗",
				summary: "Worker を再起動できなかったにゃ。",
			})
		})
	}

	private async handleWorkerEventForFlash(event: KocodeEvent): Promise<void> {
		if (event.type !== "worker_status" && event.type !== "worker_detail") {
			return
		}

		try {
			if (event.type === "worker_status") {
				await this.handleWorkerStatusForFlash(event.digest)
				return
			}
			await this.handleWorkerDetailForFlash(event.event)
		} catch (error) {
			KocodeTrace.error("worker_monitor_failed", error, {
				eventType: event.type,
			})
		}
	}

	private async handleWorkerStatusForFlash(digest: WorkerDigest): Promise<void> {
		KocodeTrace.log("worker_monitor_status", {
			taskId: digest.taskId,
			status: digest.status,
			title: digest.title,
			summary: digest.summary,
		})

		switch (digest.status) {
			case "starting":
				await this.scheduleWorkerUpdate("started", { suppressIfRecent: true })
				break
			case "waiting":
				await this.scheduleWorkerUpdate("waiting", { critical: true })
				break
			case "running":
				// Coalesce a burst of running events into one progress notification.
				this.scheduleProgressDebounced()
				break
			case "completed":
				await this.emitTaskSpec(this.taskSpecManager.markCompleted())
				await this.scheduleWorkerUpdate("completed", { critical: true })
				break
			case "failed":
				await this.scheduleWorkerUpdate("failed", { critical: true })
				break
			case "paused":
				await this.scheduleWorkerUpdate("paused", { critical: true })
				break
			case "cancelled":
				await this.scheduleWorkerUpdate("cancelled", { critical: true })
				break
		}
	}

	private async handleWorkerDetailForFlash(event: WorkerEvent): Promise<void> {
		KocodeTrace.log("worker_monitor_detail", {
			eventId: event.id,
			kind: event.kind,
			title: event.title,
			source: event.source,
		})

		switch (event.kind) {
			case "started":
				await this.scheduleWorkerUpdate("started", { suppressIfRecent: true })
				break
			case "ask":
				// User attention required — push a critical update so the user sees it.
				await this.scheduleWorkerUpdate("waiting", { critical: true })
				break
			case "error":
				await this.scheduleWorkerUpdate("failed", { critical: true })
				break
			case "tool":
			case "message":
				// Worker made tangible progress; coalesce into the next debounced progress notice.
				this.scheduleProgressDebounced()
				break
			case "completed":
				await this.scheduleWorkerUpdate("completed", { critical: true })
				break
			case "cancelled":
				await this.scheduleWorkerUpdate("cancelled", { critical: true })
				break
		}
	}

	private scheduleProgressDebounced(): void {
		if (this.disposed) {
			return
		}
		if (this.progressDebounceTimer) {
			return
		}
		this.progressDebounceTimer = setTimeout(() => {
			this.progressDebounceTimer = undefined
			void this.scheduleWorkerUpdate("progress")
		}, PROGRESS_DEBOUNCE_MS)
	}

	private async scheduleWorkerUpdate(
		reason: FlashWorkerUpdateReason,
		options: { critical?: boolean; force?: boolean; suppressIfRecent?: boolean } = {},
	): Promise<void> {
		const digest = this.bus.getDigest()
		const now = Date.now()
		const key = this.workerUpdateKey(reason, digest)
		const terminal = reason === "completed" || reason === "failed" || reason === "paused" || reason === "cancelled"

		if (terminal && this.notifiedTerminalWorkerKeys.has(key)) {
			KocodeTrace.log("worker_update_skipped", { reason, key, cause: "already_notified" })
			return
		}
		if (options.critical && this.hasExceededCriticalUpdateRetries(key)) {
			KocodeTrace.warn("worker_update_skipped", { reason, key, cause: "retry_limit" })
			this.removeQueuedCritical(reason)
			return
		}
		if (options.suppressIfRecent && now - this.lastFlashWorkerNoticeAt < WORKER_NOTICE_COOLDOWN_MS) {
			KocodeTrace.log("worker_update_skipped", { reason, key, cause: "recent_worker_notice" })
			return
		}
		// Non-critical updates (progress) get a tighter cooldown vs the chat flooding floor (8s).
		if (!options.force && !options.critical && now - this.lastFlashWorkerNoticeAt < WORKER_NOTICE_COOLDOWN_MS) {
			KocodeTrace.log("worker_update_skipped", { reason, key, cause: "cooldown" })
			return
		}
		if (reason === "progress") {
			const digestKey = this.progressDigestKey(digest)
			if (!options.force && digestKey === this.lastProgressDigestKey) {
				KocodeTrace.log("worker_update_skipped", { reason, key, cause: "same_digest" })
				return
			}
			this.lastProgressDigestKey = digestKey
		}
		if (this.workerUpdateInFlight) {
			if (options.critical) {
				this.enqueueCritical(reason)
			}
			KocodeTrace.log("worker_update_skipped", {
				reason,
				key,
				cause: "in_flight",
				pendingCriticalQueue: [...this.pendingCriticalQueue],
			})
			return
		}

		this.workerUpdateInFlight = true
		try {
			KocodeTrace.log("worker_update_compose_start", {
				reason,
				key,
				workerStatus: digest.status,
				taskStatus: this.taskSpecManager.getTaskSpec()?.status,
			})
			const reply = await this.flash.composeWorkerUpdate(
				reason,
				digest,
				this.taskSpecManager.getTaskSpec(),
				this.bus.getWorkerEvents().slice(-8),
			)
			if (reply) {
				await this.sayFlash(reply, { workerNotice: true })
				this.criticalWorkerUpdateRetries.delete(key)
				this.removeQueuedCritical(reason)
				if (terminal) {
					this.rememberTerminalKey(key)
				}
			} else if (options.critical) {
				this.deferCriticalWorkerUpdate(reason, key, "empty_critical_reply")
			}
		} catch (error) {
			KocodeTrace.error("worker_update_failed", error, {
				reason,
				key,
				workerStatus: digest.status,
			})
			if (options.critical) {
				this.deferCriticalWorkerUpdate(reason, key, "compose_failed")
			}
		} finally {
			this.workerUpdateInFlight = false
			// 若有关键通知在飞行期间排队，按 FIFO 取下一个继续（#2）。
			if (this.pendingCriticalQueue.length > 0 && !this.disposed) {
				const next = this.pendingCriticalQueue.shift()
				if (next) {
					void this.scheduleWorkerUpdate(next, { critical: true, force: true })
				}
			}
		}
	}

	// 关键通知入队，按 reason 去重并保序（FIFO）。waiting 与 completed/failed 各占一格，
	// 互不覆盖，从而修复 waiting 被后到的终态通知挤掉导致任务静默挂死的问题（#2）。
	private enqueueCritical(reason: FlashWorkerUpdateReason): void {
		if (!this.pendingCriticalQueue.includes(reason)) {
			this.pendingCriticalQueue.push(reason)
		}
	}

	private removeQueuedCritical(reason: FlashWorkerUpdateReason): void {
		const index = this.pendingCriticalQueue.indexOf(reason)
		if (index !== -1) {
			this.pendingCriticalQueue.splice(index, 1)
		}
	}

	// 有界记录终态去重键：超过上限时淘汰最早的一个，避免无界增长（#8）。
	private rememberTerminalKey(key: string): void {
		this.notifiedTerminalWorkerKeys.add(key)
		if (this.notifiedTerminalWorkerKeys.size > MAX_TERMINAL_DEDUP_KEYS) {
			const oldest = this.notifiedTerminalWorkerKeys.values().next().value
			if (oldest !== undefined) {
				this.notifiedTerminalWorkerKeys.delete(oldest)
			}
		}
	}

	private workerUpdateKey(reason: FlashWorkerUpdateReason, digest: WorkerDigest): string {
		return [reason, digest.taskId ?? "no-task", digest.status, digest.lastEventAt].join(":")
	}

	private deferCriticalWorkerUpdate(reason: FlashWorkerUpdateReason, key: string, cause: string): void {
		const attempts = (this.criticalWorkerUpdateRetries.get(key) ?? 0) + 1
		this.criticalWorkerUpdateRetries.set(key, attempts)
		// 有界：防止重试计数 Map 在长会话下无界增长（#8）。
		if (this.criticalWorkerUpdateRetries.size > MAX_TERMINAL_DEDUP_KEYS) {
			const oldest = this.criticalWorkerUpdateRetries.keys().next().value
			if (oldest !== undefined && oldest !== key) {
				this.criticalWorkerUpdateRetries.delete(oldest)
			}
		}
		if (attempts > MAX_CRITICAL_WORKER_UPDATE_RETRIES) {
			this.removeQueuedCritical(reason)
			KocodeTrace.warn("worker_update_retry_limit", { reason, key, cause, attempts })
			return
		}
		this.enqueueCritical(reason)
		KocodeTrace.log("worker_update_pending", { reason, key, cause, attempts })
	}

	private hasExceededCriticalUpdateRetries(key: string): boolean {
		return (this.criticalWorkerUpdateRetries.get(key) ?? 0) > MAX_CRITICAL_WORKER_UPDATE_RETRIES
	}

	private progressDigestKey(digest: WorkerDigest): string {
		return [digest.taskId ?? "no-task", digest.status, digest.title, digest.summary].join(":")
	}
}
