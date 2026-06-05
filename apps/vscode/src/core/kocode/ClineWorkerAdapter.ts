import type { ClineMessage as ProtoClineMessage } from "@shared/proto/cline/ui"
import type { TaskSpec, TaskSpecPatch, WorkerControlRequest } from "@shared/kocode"
import { deepSeekModels } from "@shared/api"
import { convertProtoToClineMessage } from "@shared/proto-conversions/cline-message"
import { registerPartialMessageCallback } from "@/core/controller/ui/subscribeToPartialMessage"
import { Controller } from "@/core/controller"
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
	"tool",
	"command",
	"completion_result",
	"followup",
	"plan_mode_respond",
	"mistake_limit_reached",
	"auto_approval_max_req_reached",
	"resume_task",
	"resume_completed_task",
	"api_req_failed",
])

function fromProtoMessage(message: ProtoClineMessage): ClineMessage {
	return convertProtoToClineMessage(message)
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
	}
}

export class ClineWorkerAdapter {
	private activeTaskId?: string
	private unsubscribePartial?: () => void
	private readonly sanitizer = new ContextSanitizer()
	private readonly pendingInjections: TaskSpecPatch[] = []
	private currentTaskSpec?: TaskSpec
	// Bookkeeping so we can tell apart "task is paused at resume_task" vs "task is paused mid-tool".
	private lastPendingAsk?: { ask: string; ts: number }

	constructor(
		private readonly controller: Controller,
		private readonly bus: WorkerEventBus,
	) {
		this.unsubscribePartial = registerPartialMessageCallback((message) => {
			void this.handlePartialMessage(fromProtoMessage(message))
		})
	}

	isRunning(): boolean {
		return !!this.controller.task && !!this.activeTaskId
	}

	getActiveTaskId(): string | undefined {
		return this.activeTaskId
	}

	async start(taskSpec: TaskSpec): Promise<void> {
		this.currentTaskSpec = taskSpec
		const prompt = this.sanitizer.toWorkerPrompt(taskSpec)
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

		this.activeTaskId = await this.controller.initTask(prompt, undefined, undefined, undefined, KOCODE_WORKER_TASK_SETTINGS)
		KocodeTrace.log("worker_started", { taskId: this.activeTaskId, model: KOCODE_WORKER_MODEL_ID })

		await this.bus.emitDigest({
			taskId: this.activeTaskId,
			status: "running",
			title: "作業中",
			summary: "Cline Worker が裏で作業しているにゃ。",
		})
	}

	async control(request: WorkerControlRequest): Promise<void> {
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
				if (request.action === "cancel") {
					this.pendingInjections.length = 0
					this.lastPendingAsk = undefined
				}
				break
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
					await this.bus.emitDigest({
						taskId: this.controller.task?.taskId ?? this.activeTaskId,
						status: "running",
						title: request.action === "redirect" ? "方向修正中" : "再計画中",
						summary: request.reason,
					})
					this.activeTaskId = this.controller.task?.taskId
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
				}
				break
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
				break
		}
	}

	updateTaskSpec(taskSpec: TaskSpec | undefined): void {
		this.currentTaskSpec = taskSpec
	}

	dispose(): void {
		this.unsubscribePartial?.()
		this.unsubscribePartial = undefined
	}

	private async handlePartialMessage(message: ClineMessage): Promise<void> {
		if (!this.activeTaskId) {
			return
		}

		const label = message.ask ?? message.say ?? message.type
		const isCompletion = isCompletionMessage(message)
		KocodeTrace.log("worker_event", {
			activeTaskId: this.activeTaskId,
			type: message.type,
			label,
			partial: message.partial,
			isCompletion,
		})
		await this.bus.emitWorkerDetail({
			kind: isCompletion ? "completed" : message.type === "ask" ? "ask" : label === "tool" ? "tool" : "message",
			title: label,
			detail: message.text,
			source: "cline",
			ts: message.ts,
		})
		await this.bus.emitDigest(this.sanitizer.toDigestFromMessage(message, this.activeTaskId))

		// Track pending ask state so append_context can deliver as soon as the worker is parked.
		if (message.type === "ask" && !message.partial && message.ask) {
			this.lastPendingAsk = { ask: message.ask, ts: message.ts ?? Date.now() }
			await this.tryFlushInjectionsToPendingAsk()
		}

		if (isCompletion) {
			this.activeTaskId = undefined
			this.lastPendingAsk = undefined
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
		// Wait briefly for that ask to appear, then unblock it with the redirection text.
		const task = this.controller.task
		if (!task) {
			return false
		}
		const start = Date.now()
		const TIMEOUT_MS = 5_000
		while (Date.now() - start < TIMEOUT_MS) {
			const ask = this.lastPendingAsk?.ask
			if (ask === "resume_task" || ask === "resume_completed_task") {
				await task.handleWebviewAskResponse("messageResponse", text)
				this.lastPendingAsk = undefined
				return true
			}
			await new Promise((resolve) => setTimeout(resolve, 100))
		}
		KocodeTrace.warn("worker_redirect_no_resume_ask", { textLength: text.length })
		return false
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
}
