import type {
	KocodeChatMessage,
	KocodeEvent,
	KocodeSendResult,
	KocodeSessionState,
	KocodeUserMessage,
	TaskSpecPatch,
	WorkerControlRequest,
} from "@shared/kocode"
import { Controller } from "@/core/controller"
import { ClineWorkerAdapter } from "./ClineWorkerAdapter"
import { FlashAgentSession } from "./FlashAgentSession"
import { TaskSpecManager } from "./TaskSpecManager"
import { WorkerEventBus, type KocodeEventListener } from "./WorkerEventBus"

export class KocodeOrchestrator {
	private readonly bus = new WorkerEventBus()
	private readonly flash = new FlashAgentSession()
	private readonly taskSpecManager = new TaskSpecManager()
	private readonly worker: ClineWorkerAdapter
	private readonly messages: KocodeChatMessage[] = []

	constructor(controller: Controller) {
		this.worker = new ClineWorkerAdapter(controller, this.bus)
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
		this.messages.push(userMessage)
		await this.bus.emit({ type: "user_message", message: userMessage })

		const intent = this.flash.classify(
			request.text,
			userMessage.id,
			this.bus.getDigest(),
			this.worker.isRunning() || !!this.taskSpecManager.getTaskSpec(),
		)

		switch (intent.type) {
			case "social_chat":
			case "status_question":
				await this.sayFlash(intent.reply)
				return { accepted: true, messageId: userMessage.id, taskSpec: this.taskSpecManager.getTaskSpec() }

			case "worker_control":
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
				await this.sayFlash(intent.reply)
				return { accepted: true, messageId: userMessage.id, taskSpec: this.taskSpecManager.getTaskSpec() }

			case "task_revision":
				await this.applyPatch(intent.patch)
				await this.worker.control({ action: "append_context", reason: intent.patch.text, taskSpecPatch: intent.patch })
				await this.sayFlash(this.flash.revisionQueuedMessage())
				return { accepted: true, messageId: userMessage.id, taskSpec: this.taskSpecManager.getTaskSpec() }

			case "complex_task": {
				const taskSpec = this.taskSpecManager.ensureTaskSpec(request.text, userMessage.id, request.files ?? [])
				await this.emitTaskSpec(taskSpec)
				await this.sayFlash(this.flash.workerStartedMessage())

				if (!this.worker.isRunning()) {
					this.taskSpecManager.markActive()
					await this.emitTaskSpec(this.taskSpecManager.getTaskSpec())
					void this.worker.start(this.taskSpecManager.getTaskSpec()!).catch(async (error) => {
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

				return { accepted: true, messageId: userMessage.id, taskSpec, workerStarted: false }
			}
		}
	}

	async workerControl(request: WorkerControlRequest): Promise<void> {
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
	}

	dispose(): void {
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

	private async sayFlash(text: string): Promise<void> {
		const message = this.flash.toMessage(text)
		this.messages.push(message)
		await this.bus.emit({ type: "flash_message", message })
	}

	private async applyPatch(patch: TaskSpecPatch): Promise<void> {
		const taskSpec = this.taskSpecManager.applyPatch(patch)
		await this.emitTaskSpec(taskSpec)
	}

	private async emitTaskSpec(taskSpec: ReturnType<TaskSpecManager["getTaskSpec"]>): Promise<void> {
		if (taskSpec) {
			await this.bus.emit({ type: "task_spec_updated", taskSpec } satisfies KocodeEvent)
		}
	}
}
