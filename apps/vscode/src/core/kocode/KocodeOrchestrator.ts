import type {
	KocodeChatMessage,
	KocodeEvent,
	KocodeSendResult,
	KocodeSessionState,
	KocodeUserMessage,
	TaskSpecPatch,
	WorkerDigest,
	WorkerControlRequest,
	WorkerEvent,
} from "@shared/kocode"
import { Controller } from "@/core/controller"
import { ClineWorkerAdapter } from "./ClineWorkerAdapter"
import { FlashAgentSession } from "./FlashAgentSession"
import { FileKocodeMemoryStore } from "./KocodeMemoryStore"
import type { FlashWorkerUpdateReason } from "./FlashModelClient"
import { KocodeTrace } from "./KocodeTrace"
import { TaskSpecManager } from "./TaskSpecManager"
import { WorkerEventBus, type KocodeEventListener } from "./WorkerEventBus"

const WORKER_NOTICE_COOLDOWN_MS = 8_000
// Coalesce bursts of worker events into a single Flash translation.
const PROGRESS_DEBOUNCE_MS = 1_500
const TERMINAL_WORKER_STATUSES = new Set<WorkerDigest["status"]>(["completed", "failed", "paused", "cancelled"])

export class KocodeOrchestrator {
	private readonly bus = new WorkerEventBus()
	private readonly flash: FlashAgentSession
	private readonly taskSpecManager = new TaskSpecManager()
	private readonly worker: ClineWorkerAdapter
	private readonly messages: KocodeChatMessage[] = []
	private readonly unsubscribeWorkerMonitor: () => void
	private workerUpdateInFlight = false
	private pendingCriticalWorkerUpdate?: FlashWorkerUpdateReason
	private lastFlashWorkerNoticeAt = 0
	private lastProgressDigestKey = ""
	private readonly notifiedTerminalWorkerKeys = new Set<string>()
	private progressDebounceTimer?: ReturnType<typeof setTimeout>
	private disposed = false

	constructor(controller: Controller, flash?: FlashAgentSession) {
		const cwd = controller.getWorkspaceManager()?.getPrimaryRoot()?.path
		this.flash = flash ?? new FlashAgentSession(undefined, new FileKocodeMemoryStore(cwd))
		this.worker = new ClineWorkerAdapter(controller, this.bus)
		this.unsubscribeWorkerMonitor = this.bus.subscribe((event) => {
			void this.handleWorkerEventForFlash(event)
		})
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
		}
	}

	async sendUserMessage(request: KocodeUserMessage): Promise<KocodeSendResult> {
		const userMessage = this.toUserMessage(request)
		KocodeTrace.log("user_message", {
			messageId: userMessage.id,
			text: request.text,
			files: request.files?.length ?? 0,
			images: request.images?.length ?? 0,
		})
		this.messages.push(userMessage)
		await this.bus.emit({ type: "user_message", message: userMessage })
		if (this.pendingCriticalWorkerUpdate) {
			const reason = this.pendingCriticalWorkerUpdate
			this.pendingCriticalWorkerUpdate = undefined
			void this.scheduleWorkerUpdate(reason, { critical: true, force: true })
		}

		const taskSpec = this.taskSpecManager.getTaskSpec()
		const intent = await this.flash.classify(
			request.text,
			userMessage.id,
			this.bus.getDigest(),
			this.worker.isRunning() || !!taskSpec,
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
				await this.worker.control(intent.control)
				if (intent.control.action === "pause") {
					await this.emitTaskSpec(this.taskSpecManager.markPaused())
				}
				if (intent.control.action === "cancel") {
					await this.emitTaskSpec(this.taskSpecManager.markCancelled())
				}
				if (intent.control.action === "redirect" || intent.control.action === "replan") {
					// Worker now resumes from history with the redirection text injected; only restart
					// if no resume path was available (worker had no history yet).
					if (!this.worker.isRunning()) {
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
				await this.worker.control({ action: "append_context", reason: intent.patch.text, taskSpecPatch: intent.patch })
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
					await this.worker.control({ action: "append_context", reason: intent.patch.text, taskSpecPatch: intent.patch })
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
				// If a worker is running on a different task, archive it before starting fresh.
				if (this.worker.isRunning()) {
					await this.worker.control({ action: "cancel", reason: "ユーザーが新しいタスクを開始するため、現在の作業を保存にゃ。" })
					this.taskSpecManager.markCompleted()
				}
				const taskSpec = this.taskSpecManager.startFreshTask(
					{
						goal: intent.decision.task.goal ?? request.text,
						mode: intent.decision.task.mode,
						files: [...(intent.decision.task.files ?? []), ...(request.files ?? [])],
						constraints: intent.decision.task.constraints,
						acceptanceCriteria: intent.decision.task.acceptanceCriteria,
					},
					userMessage.id,
				)
				await this.emitTaskSpec(taskSpec)
				await this.sayFlash(this.flash.workerStartedMessage(intent.decision), { workerNotice: true })

				KocodeTrace.log("orchestrator_action", {
					messageId: userMessage.id,
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
				}
				void this.worker.start(activeSpec!).catch(async (error) => {
					await this.bus.emitWorkerDetail({
						kind: "error",
						title: "Worker start failed",
						detail: error instanceof Error ? error.message : String(error),
						source: "kocode",
					})
					await this.bus.emitDigest({
						status: "failed",
						title: "起動失敗",
						summary: "Worker を起動できなかったにゃ。",
					})
				})
				return { accepted: true, messageId: userMessage.id, taskSpec, workerStarted: true }
			}
		}
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
		await this.worker.control(request)
		if (request.action === "pause") {
			await this.emitTaskSpec(this.taskSpecManager.markPaused())
		}
		if (request.action === "cancel") {
			await this.emitTaskSpec(this.taskSpecManager.markCancelled())
		}
		if (request.action === "redirect" || request.action === "replan") {
			await this.restartWorkerIfTaskExists()
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
			await this.bus.emitWorkerDetail({
				kind: "error",
				title: "Worker restart failed",
				detail: error instanceof Error ? error.message : String(error),
				source: "kocode",
			})
			await this.bus.emitDigest({
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
				this.pendingCriticalWorkerUpdate = reason
			}
			KocodeTrace.log("worker_update_skipped", { reason, key, cause: "in_flight", pendingCriticalWorkerUpdate: this.pendingCriticalWorkerUpdate })
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
			const reply = await this.flash.composeWorkerUpdate(reason, digest, this.taskSpecManager.getTaskSpec(), this.bus.getWorkerEvents().slice(-8))
			if (reply) {
				await this.sayFlash(reply, { workerNotice: true })
				if (terminal) {
					this.notifiedTerminalWorkerKeys.add(key)
				}
			} else if (options.critical) {
				this.pendingCriticalWorkerUpdate = reason
				KocodeTrace.log("worker_update_pending", { reason, key, cause: "empty_critical_reply" })
			}
		} catch (error) {
			KocodeTrace.error("worker_update_failed", error, {
				reason,
				key,
				workerStatus: digest.status,
			})
			if (options.critical) {
				this.pendingCriticalWorkerUpdate = reason
			}
		} finally {
			this.workerUpdateInFlight = false
			// If a critical update was queued while one was in flight, run it now.
			if (this.pendingCriticalWorkerUpdate && !this.disposed) {
				const next = this.pendingCriticalWorkerUpdate
				this.pendingCriticalWorkerUpdate = undefined
				void this.scheduleWorkerUpdate(next, { critical: true, force: true })
			}
		}
	}

	private workerUpdateKey(reason: FlashWorkerUpdateReason, digest: WorkerDigest): string {
		return [reason, digest.taskId ?? "no-task", digest.status, digest.lastEventAt].join(":")
	}

	private progressDigestKey(digest: WorkerDigest): string {
		return [digest.taskId ?? "no-task", digest.status, digest.title, digest.summary].join(":")
	}
}
