import { deepSeekModels } from "@shared/api"
import type { TaskSpec, TaskSpecPatch, WorkerControlRequest, WorkerRollbackRequest } from "@shared/kocode"
import type { ClineMessage as ProtoClineMessage } from "@shared/proto/cline/ui"
import { convertProtoToClineMessage } from "@shared/proto-conversions/cline-message"
import { Controller } from "@/core/controller"
import { checkpointRestore } from "@/core/controller/checkpoints/checkpointRestore"
import { registerPartialMessageCallback } from "@/core/controller/ui/subscribeToPartialMessage"
import type { ClineMessage } from "@/shared/ExtensionMessage"
import type { Settings } from "@/shared/storage/state-keys"
import { ContextSanitizer } from "./ContextSanitizer"
import { KocodeTrace } from "./KocodeTrace"
import { WorkerEventBus } from "./WorkerEventBus"

const KOCODE_WORKER_MODEL_ID = "deepseek-v4-pro"
const KOCODE_WORKER_TASK_SETTINGS: Partial<Settings> = {
	planModeApiProvider: "cline",
	actModeApiProvider: "cline",
	planModeClineModelId: KOCODE_WORKER_MODEL_ID,
	actModeClineModelId: KOCODE_WORKER_MODEL_ID,
	planModeClineModelInfo: deepSeekModels[KOCODE_WORKER_MODEL_ID],
	actModeClineModelInfo: deepSeekModels[KOCODE_WORKER_MODEL_ID],
}

// Asks where injecting a fresh user message via messageResponse is unsafe / has special semantics.
// command_output is a streaming UI ask used by the terminal stream; resume_task / resume_completed_task
// are exactly where we want to inject a redirect, so they're handled separately.
const SAFE_FOR_INJECTION_ASKS = new Set<string>([
	"followup",
	"plan_mode_respond",
	"resume_task",
	"resume_completed_task",
	"api_req_failed",
])

// Worker（Cline）が「許可待ち」で停止する ask 種別。これらは Flash Agent が自動で許可/拒否を判断する。
// followup / plan_mode_respond などの「自由入力待ち」は対象外（注入ロジック側で扱う）。
const APPROVAL_ASKS = new Set<string>([
	"tool",
	"command",
	"use_mcp_server",
	"browser_action_launch",
	"use_subagents",
	"api_req_failed",
	"mistake_limit_reached",
])

const MAX_ROLLBACK_STEPS = 3

// Worker が承認待ちになった時に Flash Agent へ判断を委ねるコールバック。
// true=許可（yesButtonClicked）、false=拒否（noButtonClicked）。
export type WorkerApprovalResolver = (request: { askType: string; askText: string }) => Promise<boolean>

// survey_plan モードで Worker が ask_followup_question を出した時に呼ばれる。
// 通常の followup（worker_detail）イベントは発行せず、こちらに振り分ける。
export type SurveyQuestionHandler = (question: { ts: number; question: string; options: string[] }) => Promise<void> | void

type WorkerLifecycle = "idle" | "starting" | "running" | "paused"

export interface WorkerControlResult {
	handled: boolean
	workerRunning: boolean
	needsFreshStart: boolean
}

export interface WorkerRollbackPreview {
	available: boolean
	steps: number
	checkpointCount: number
	targetMessageTs?: number
}

export interface WorkerRollbackResult extends WorkerRollbackPreview {
	restored: boolean
	reason?: string
}

function fromProtoMessage(message: ProtoClineMessage): ClineMessage {
	return convertProtoToClineMessage(message)
}

// Cline が JSON.stringify した followup ask の detail（{ question, options, selected? }）を解析する。
// question 空・selected 済み・parse 失敗は「有効な未回答の質問ではない」として null を返す。
function parseFollowupDetail(detail: string | undefined): { question: string; options: string[] } | null {
	if (!detail) {
		return null
	}
	try {
		const parsed = JSON.parse(detail) as { question?: unknown; options?: unknown; selected?: unknown }
		const question = typeof parsed.question === "string" ? parsed.question.trim() : ""
		if (!question) {
			return null
		}
		if (typeof parsed.selected === "string" && parsed.selected.length > 0) {
			return null
		}
		const options = Array.isArray(parsed.options)
			? parsed.options.filter((option): option is string => typeof option === "string" && option.trim().length > 0)
			: []
		return { question, options }
	} catch {
		return null
	}
}

function isCompletionMessage(message: ClineMessage): boolean {
	return !message.partial && (message.say === "completion_result" || message.ask === "completion_result")
}

function patchToInjectionLine(patch: TaskSpecPatch): string {
	switch (patch.kind) {
		case "replace_goal":
			return `[Kocode Update — replace goal] ${patch.text}`
		case "add_constraint":
			return `[Kocode Update — additional requirement] ${patch.text}`
		case "remove_constraint":
			return `[Kocode Update — drop constraint] ${patch.text}`
		case "add_file_scope":
			return `[Kocode Update — also touch] ${patch.text}`
		case "reject_direction":
			return `[Kocode Update — user rejected direction] ${patch.text}`
		case "request_pause":
			return `[Kocode Update — user requested pause] ${patch.text}`
		case "request_cancel":
			return `[Kocode Update — user requested cancel] ${patch.text}`
		case "request_replan":
			return `[Kocode Update — user requested replan] ${patch.text}`
		case "request_rollback":
			return `[Kocode Update — user requested rollback] ${patch.text}`
	}
}

function clampRollbackSteps(steps?: number): number {
	const normalized = Number.isFinite(steps) ? Math.trunc(steps ?? 1) : 1
	return Math.max(1, Math.min(MAX_ROLLBACK_STEPS, normalized))
}

export class ClineWorkerAdapter {
	private activeTaskId?: string
	private lifecycle: WorkerLifecycle = "idle"
	private unsubscribePartial?: () => void
	private readonly sanitizer = new ContextSanitizer()
	private readonly pendingInjections: TaskSpecPatch[] = []
	private currentTaskSpec?: TaskSpec
	// Bookkeeping so we can tell apart "task is paused at resume_task" vs "task is paused mid-tool".
	private lastPendingAsk?: { ask: string; ts: number }
	// 事件驱动等待 resume ask：避免用 100ms 忙轮询阻塞控制链路（#5）。
	private resumeAskWaiter?: { resolve: () => void }
	// Worker 承認待ちを Flash Agent に委ねるリゾルバ（Orchestrator が注入）。
	private approvalResolver?: WorkerApprovalResolver
	// survey_plan モードの followup を Orchestrator へ振り分けるハンドラ（Orchestrator が注入）。
	private surveyQuestionHandler?: SurveyQuestionHandler
	// 同一 ask（ts 単位）を二重に自動応答しないためのガード。
	private autoApprovedAskTs = new Set<number>()
	// 自動応答が進行中の ask。完了通知などと競合しないよう記録する。
	private approvalInFlightTs?: number

	constructor(
		private readonly controller: Controller,
		private readonly bus: WorkerEventBus,
	) {
		this.unsubscribePartial = registerPartialMessageCallback((message) => {
			void this.handlePartialMessage(fromProtoMessage(message))
		})
	}

	/** Orchestrator が Flash Agent ベースの承認判断を注入する。 */
	setApprovalResolver(resolver: WorkerApprovalResolver | undefined): void {
		this.approvalResolver = resolver
	}

	/** Orchestrator が survey_plan の followup 振り分けハンドラを注入する。 */
	setSurveyQuestionHandler(handler: SurveyQuestionHandler | undefined): void {
		this.surveyQuestionHandler = handler
	}

	/** 現在の TaskSpec が survey_plan モードか。 */
	private isSurveyPlanMode(): boolean {
		return this.currentTaskSpec?.executionMode === "survey_plan"
	}

	isRunning(): boolean {
		return this.lifecycle === "starting" || (this.lifecycle === "running" && (!!this.controller.task || !!this.activeTaskId))
	}

	getActiveTaskId(): string | undefined {
		return this.activeTaskId
	}

	async start(taskSpec: TaskSpec): Promise<void> {
		if (this.lifecycle === "starting" || this.lifecycle === "running") {
			this.currentTaskSpec = taskSpec
			KocodeTrace.log("worker_start_skipped", {
				taskId: taskSpec.id,
				lifecycle: this.lifecycle,
				activeTaskId: this.activeTaskId,
			})
			return
		}
		this.lifecycle = "starting"
		this.currentTaskSpec = taskSpec
		const workspaceRoot =
			this.controller.getWorkspaceManager()?.getPrimaryRoot()?.path ??
			(await this.controller.ensureWorkspaceManager())?.getPrimaryRoot()?.path
		const prompt = await this.sanitizer.toWorkerPromptWithKnowledge(taskSpec, workspaceRoot)
		KocodeTrace.log("worker_start", {
			taskId: taskSpec.id,
			goal: taskSpec.goal,
			mode: taskSpec.mode,
			model: KOCODE_WORKER_MODEL_ID,
			promptLength: prompt.length,
		})
		await this.bus.emitDigest({
			taskId: this.activeTaskId,
			status: "starting",
			title: "作業開始",
			summary: "Worker を起動しているにゃ。",
		})
		await this.bus.emitWorkerDetail({
			kind: "started",
			title: "Worker started",
			detail: taskSpec.goal,
			source: "kocode",
		})

		try {
			this.activeTaskId = await this.controller.initTask(
				prompt,
				undefined,
				undefined,
				undefined,
				KOCODE_WORKER_TASK_SETTINGS,
			)
		} catch (error) {
			this.lifecycle = "idle"
			throw error
		}
		this.lifecycle = "running"
		KocodeTrace.log("worker_started", { taskId: this.activeTaskId, model: KOCODE_WORKER_MODEL_ID })

		await this.bus.emitDigest({
			taskId: this.activeTaskId,
			status: "running",
			title: "作業中",
			summary: "Cline Worker が裏で作業しているにゃ。",
		})
	}

	async control(request: WorkerControlRequest): Promise<WorkerControlResult> {
		KocodeTrace.log("worker_control", {
			action: request.action,
			reason: request.reason,
			activeTaskId: this.activeTaskId,
			patchKind: request.taskSpecPatch?.kind,
		})
		switch (request.action) {
			case "pause":
			case "cancel":
				await this.controller.cancelTask()
				await this.bus.emitWorkerDetail({
					kind: request.action === "cancel" ? "cancelled" : "status",
					title: `Worker ${request.action}`,
					detail: request.reason,
					source: "flash",
				})
				await this.bus.emitDigest({
					taskId: this.activeTaskId,
					status: request.action === "cancel" ? "cancelled" : "paused",
					title: request.action === "cancel" ? "キャンセル済み" : "一時停止",
					summary: request.reason,
				})
				this.activeTaskId = undefined
				this.lifecycle = request.action === "cancel" ? "idle" : "paused"
				if (request.action === "cancel") {
					this.pendingInjections.length = 0
					this.lastPendingAsk = undefined
				}
				return { handled: true, workerRunning: false, needsFreshStart: false }
			case "redirect":
			case "replan": {
				// Soft "redirect": cancel the active stream so Cline reinits the task and surfaces a
				// resume_task ask. We then answer that ask with the redirection text instead of starting
				// a fresh task — that preserves checkpoints, history, and conversation context.
				const redirectionText = this.composeRedirectionText(request)
				await this.controller.cancelTask()
				await this.bus.emitWorkerDetail({
					kind: "status",
					title: `Worker ${request.action}`,
					detail: request.reason,
					source: "flash",
				})
				const injected = await this.injectIntoResumeAsk(redirectionText)
				if (injected) {
					const taskId = this.controller.task?.taskId ?? this.activeTaskId
					await this.bus.emitDigest({
						taskId,
						status: "running",
						title: request.action === "redirect" ? "方向修正中" : "再計画中",
						summary: request.reason,
					})
					this.activeTaskId = taskId
					this.lifecycle = "running"
				} else {
					// Fallback: no resume ask appeared (no history yet) — leave it paused so the
					// orchestrator can decide to start fresh.
					await this.bus.emitDigest({
						taskId: this.activeTaskId,
						status: "paused",
						title: "再計画中",
						summary: request.reason,
					})
					this.activeTaskId = undefined
					this.lifecycle = "paused"
				}
				return { handled: injected, workerRunning: injected, needsFreshStart: !injected }
			}
			case "append_context":
				if (request.taskSpecPatch) {
					this.pendingInjections.push(request.taskSpecPatch)
				}
				await this.bus.emitWorkerDetail({
					kind: "status",
					title: "Context queued",
					detail: request.reason,
					source: "flash",
				})
				// Best-effort: if the worker is parked on an injectable ask right now, deliver immediately.
				await this.tryFlushInjectionsToPendingAsk()
				return { handled: true, workerRunning: this.isRunning(), needsFreshStart: false }
			case "rollback_request":
				return { handled: false, workerRunning: this.isRunning(), needsFreshStart: false }
			case "rollback_confirmed": {
				const result = await this.rollbackToCheckpoint(request.rollback)
				return { handled: result.restored, workerRunning: false, needsFreshStart: false }
			}
		}
	}

	getRollbackPreview(rollback?: WorkerRollbackRequest): WorkerRollbackPreview {
		const steps = clampRollbackSteps(rollback?.steps)
		const checkpointMessages = this.getCheckpointMessages()
		const target = checkpointMessages.at(-steps)
		return {
			available: !!target,
			steps,
			checkpointCount: checkpointMessages.length,
			targetMessageTs: target?.ts,
		}
	}

	async rollbackToCheckpoint(rollback?: WorkerRollbackRequest): Promise<WorkerRollbackResult> {
		const preview = this.getRollbackPreview(rollback)
		if (!preview.available || !preview.targetMessageTs) {
			await this.bus.emitWorkerDetail({
				kind: "error",
				title: "Rollback unavailable",
				detail: "No recent Cline checkpoint is available for this worker task.",
				source: "kocode",
			})
			return { ...preview, restored: false, reason: "no_checkpoint" }
		}

		const restoreType = rollback?.restoreType ?? "taskAndWorkspace"
		// 在清空 activeTaskId 之前先捕获，确保回滚相关 digest 仍带 taskId（#7）。
		const rollbackTaskId = this.activeTaskId
		try {
			await checkpointRestore(this.controller, {
				metadata: undefined,
				number: preview.targetMessageTs,
				restoreType,
				offset: 0,
			})
			this.pendingInjections.length = 0
			this.lastPendingAsk = undefined
			this.activeTaskId = undefined
			this.lifecycle = "paused"
			await this.bus.emitWorkerDetail({
				kind: "status",
				title: "Rollback restored",
				detail: `Restored ${restoreType} to checkpoint ${preview.steps} step(s) back.`,
				source: "kocode",
			})
			await this.bus.emitDigest({
				taskId: rollbackTaskId,
				status: "paused",
				title: "回滚完成",
				summary: `已回滚到最近第 ${preview.steps} 个 Cline checkpoint。`,
			})
			return { ...preview, restored: true }
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error)
			KocodeTrace.error("worker_rollback_failed", error, {
				steps: preview.steps,
				restoreType,
				targetMessageTs: preview.targetMessageTs,
			})
			await this.bus.emitWorkerDetail({
				kind: "error",
				title: "Rollback failed",
				detail: reason,
				source: "kocode",
			})
			await this.bus.emitDigest({
				taskId: rollbackTaskId,
				status: "failed",
				title: "回滚失败",
				summary: reason,
			})
			return { ...preview, restored: false, reason }
		}
	}

	updateTaskSpec(taskSpec: TaskSpec | undefined): void {
		this.currentTaskSpec = taskSpec
	}

	dispose(): void {
		this.unsubscribePartial?.()
		this.unsubscribePartial = undefined
		// 解除任何挂起的 resume ask 等待，避免 dispose 后 Promise 永久悬挂（#5）。
		if (this.resumeAskWaiter) {
			this.resumeAskWaiter.resolve()
			this.resumeAskWaiter = undefined
		}
	}

	private async handlePartialMessage(message: ClineMessage): Promise<void> {
		if (!this.activeTaskId) {
			return
		}

		const label = message.ask ?? message.say ?? message.type
		const isCompletion = isCompletionMessage(message)

		// survey_plan モード: Worker の followup ask は通常の worker_detail を出さず、
		// survey 専用イベントへ振り分ける（B1: アダプタ側で分流）。
		// partial の途中は壊れた JSON になりうるので、完成した non-partial だけを扱う。
		if (
			message.type === "ask" &&
			!message.partial &&
			message.ask === "followup" &&
			this.isSurveyPlanMode() &&
			this.surveyQuestionHandler
		) {
			const parsed = parseFollowupDetail(message.text)
			if (parsed) {
				// pWaitFor 待機中の ask を Orchestrator が answerFollowup で進められるよう、
				// pending ask として記録しておく（通常フローと同じ）。
				this.lastPendingAsk = { ask: message.ask, ts: message.ts ?? Date.now() }
				await this.tryFlushInjectionsToPendingAsk()
				try {
					await this.surveyQuestionHandler({
						ts: message.ts ?? Date.now(),
						question: parsed.question,
						options: parsed.options,
					})
				} catch (error) {
					KocodeTrace.error("worker_survey_question_failed", error, { ts: message.ts })
				}
				return
			}
			// parse 失敗時は通常フローへフォールバック（壊れた質問を握り潰さない）。
		}

		// この ask が Flash Agent の自動承認対象か。対象なら「人手待ち（waiting）」ではなく
		// 「Flash が処理中（running）」として扱い、ユーザーへの確認待ち通知を出さない。
		const isAutoApprovableAsk =
			message.type === "ask" &&
			!message.partial &&
			!!message.ask &&
			!!this.approvalResolver &&
			APPROVAL_ASKS.has(message.ask)
		KocodeTrace.log("worker_event", {
			activeTaskId: this.activeTaskId,
			type: message.type,
			label,
			partial: message.partial,
			isCompletion,
			isAutoApprovableAsk,
		})
		await this.bus.emitWorkerDetail({
			kind: isCompletion
				? "completed"
				: isAutoApprovableAsk
					? "status"
					: message.type === "ask"
						? "ask"
						: label === "tool"
							? "tool"
							: "message",
			title: label,
			detail: message.text,
			source: "cline",
			ts: message.ts,
		})
		// 自動承認対象は waiting ではなく running 扱いの digest にして、確認待ち通知を抑止する。
		const digest = this.sanitizer.toDigestFromMessage(message, this.activeTaskId)
		await this.bus.emitDigest(isAutoApprovableAsk ? { ...digest, status: "running" } : digest)

		// Track pending ask state so append_context can deliver as soon as the worker is parked.
		if (message.type === "ask" && !message.partial && message.ask) {
			this.lastPendingAsk = { ask: message.ask, ts: message.ts ?? Date.now() }
			// 唤醒 redirect/replan 的事件驱动等待（#5）。
			if (this.resumeAskWaiter && this.isResumeAsk(message.ask)) {
				this.resumeAskWaiter.resolve()
			}
			await this.tryFlushInjectionsToPendingAsk()
			// Worker が承認待ちで止まった ask は、Flash Agent に判断を委ねて自動応答する。
			await this.maybeAutoApprove(message)
		}

		if (isCompletion) {
			this.activeTaskId = undefined
			this.lastPendingAsk = undefined
			this.lifecycle = "idle"
		}
	}

	/**
	 * 承認待ち ask を Flash Agent の判断で自動的に許可/拒否する。
	 * リゾルバ未設定や resume 系 ask の時は何もしない（人手フローや注入ロジックに委ねる）。
	 */
	private async maybeAutoApprove(message: ClineMessage): Promise<void> {
		const askType = message.ask
		if (!askType || !this.approvalResolver || !APPROVAL_ASKS.has(askType)) {
			return
		}
		const ts = message.ts ?? Date.now()
		// 二重応答ガード：同じ ask に対して複数回応答しない。
		if (this.autoApprovedAskTs.has(ts) || this.approvalInFlightTs === ts) {
			return
		}
		this.approvalInFlightTs = ts
		try {
			const approved = await this.approvalResolver({ askType, askText: message.text ?? "" })
			// 判断中に ask が解消・タスクが切り替わっていないか再確認。
			if (this.lastPendingAsk?.ts !== ts || !this.controller.task) {
				KocodeTrace.log("worker_auto_approval_stale", { askType, ts })
				return
			}
			const response = approved ? "yesButtonClicked" : "noButtonClicked"
			await this.controller.task.handleWebviewAskResponse(response)
			this.autoApprovedAskTs.add(ts)
			// 集合の無界増長を防ぐ（直近 200 件だけ保持）。
			if (this.autoApprovedAskTs.size > 200) {
				const oldest = this.autoApprovedAskTs.values().next().value
				if (oldest !== undefined) {
					this.autoApprovedAskTs.delete(oldest)
				}
			}
			if (this.lastPendingAsk?.ts === ts) {
				this.lastPendingAsk = undefined
			}
			await this.bus.emitWorkerDetail({
				kind: "status",
				title: approved ? "Flash auto-approved" : "Flash auto-rejected",
				detail: `${askType}: ${approved ? "許可" : "拒否"}`,
				source: "flash",
			})
			KocodeTrace.log("worker_auto_approval", { askType, ts, approved })
		} catch (error) {
			KocodeTrace.error("worker_auto_approval_failed", error, { askType, ts })
		} finally {
			if (this.approvalInFlightTs === ts) {
				this.approvalInFlightTs = undefined
			}
		}
	}

	private composeRedirectionText(request: WorkerControlRequest): string {
		const lines: string[] = []
		lines.push("[Kocode] User changed direction. Continue from the existing task state with the updates below.")
		if (request.reason) {
			lines.push("", `Reason: ${request.reason}`)
		}
		if (request.taskSpecPatch) {
			lines.push("", patchToInjectionLine(request.taskSpecPatch))
		}
		// Drain any append_context patches that piled up while the worker was busy.
		if (this.pendingInjections.length > 0) {
			lines.push("", "Pending updates:")
			for (const patch of this.pendingInjections.splice(0, this.pendingInjections.length)) {
				lines.push(patchToInjectionLine(patch))
			}
		}
		if (this.currentTaskSpec) {
			lines.push("", `Current goal: ${this.currentTaskSpec.goal}`)
		}
		return lines.join("\n")
	}

	private async injectIntoResumeAsk(text: string): Promise<boolean> {
		// After cancelTask reinits the task with the historyItem, the new Task instance is
		// driven by resumeTaskFromHistory which awaits a resume_task / resume_completed_task ask.
		// Wait (event-driven) for that ask to appear, then unblock it with the redirection text.
		const task = this.controller.task
		if (!task) {
			return false
		}
		// 如果取消后 ask 已经先到了，直接处理，避免错过早到的事件。
		if (this.isResumeAsk(this.lastPendingAsk?.ask)) {
			await task.handleWebviewAskResponse("messageResponse", text)
			this.lastPendingAsk = undefined
			return true
		}
		const appeared = await this.waitForResumeAsk(5_000)
		if (!appeared) {
			KocodeTrace.warn("worker_redirect_no_resume_ask", { textLength: text.length })
			return false
		}
		await task.handleWebviewAskResponse("messageResponse", text)
		this.lastPendingAsk = undefined
		return true
	}

	private isResumeAsk(ask?: string): boolean {
		return ask === "resume_task" || ask === "resume_completed_task"
	}

	private waitForResumeAsk(timeoutMs: number): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => {
				if (this.resumeAskWaiter) {
					this.resumeAskWaiter = undefined
				}
				resolve(false)
			}, timeoutMs)
			this.resumeAskWaiter = {
				resolve: () => {
					clearTimeout(timer)
					this.resumeAskWaiter = undefined
					resolve(true)
				},
			}
		})
	}

	private getCheckpointMessages(): ClineMessage[] {
		const messages = this.controller.task?.messageStateHandler?.getClineMessages?.() ?? []
		return messages.filter((message): message is ClineMessage & { ts: number } => {
			return (
				typeof message.ts === "number" &&
				typeof message.lastCheckpointHash === "string" &&
				message.lastCheckpointHash.length > 0
			)
		})
	}

	private async tryFlushInjectionsToPendingAsk(): Promise<void> {
		if (this.pendingInjections.length === 0) {
			return
		}
		const ask = this.lastPendingAsk?.ask
		if (!ask || !SAFE_FOR_INJECTION_ASKS.has(ask)) {
			return
		}
		const task = this.controller.task
		if (!task) {
			return
		}
		const text = this.pendingInjections
			.splice(0, this.pendingInjections.length)
			.map((patch) => patchToInjectionLine(patch))
			.join("\n")
		try {
			await task.handleWebviewAskResponse("messageResponse", text)
			this.lastPendingAsk = undefined
			KocodeTrace.log("worker_inject_success", { ask, textLength: text.length })
		} catch (error) {
			KocodeTrace.error("worker_inject_failed", error, { ask })
		}
	}

	/** Worker が followup（ask_followup_question）で停止して、ユーザーの回答を待っているか。 */
	isAwaitingFollowup(): boolean {
		return this.lastPendingAsk?.ask === "followup"
	}

	/**
	 * アンケートカードの回答を、Worker(Cline)自身の ask 応答機構へ直接戻す。
	 * Flash の再分類を通さず、followup で pWaitFor 待機している ask に messageResponse として注入する。
	 * これにより一問一答が正しく次の質問へ進む。
	 */
	async answerFollowup(text: string): Promise<boolean> {
		const task = this.controller.task
		if (!task) {
			KocodeTrace.warn("worker_followup_answer_no_task", { textLength: text.length })
			return false
		}
		if (this.lastPendingAsk?.ask !== "followup") {
			KocodeTrace.warn("worker_followup_answer_no_pending", {
				pendingAsk: this.lastPendingAsk?.ask,
				textLength: text.length,
			})
			return false
		}
		try {
			await task.handleWebviewAskResponse("messageResponse", text)
			this.lastPendingAsk = undefined
			KocodeTrace.log("worker_followup_answer_success", { textLength: text.length })
			return true
		} catch (error) {
			KocodeTrace.error("worker_followup_answer_failed", error, { textLength: text.length })
			return false
		}
	}
}
