import type { ClineMessage as ProtoClineMessage } from "@shared/proto/cline/ui"
import type { TaskSpec, WorkerControlRequest } from "@shared/kocode"
import { registerPartialMessageCallback } from "@/core/controller/ui/subscribeToPartialMessage"
import { Controller } from "@/core/controller"
import type { ClineMessage } from "@/shared/ExtensionMessage"
import { ContextSanitizer } from "./ContextSanitizer"
import { WorkerEventBus } from "./WorkerEventBus"

function fromProtoMessage(message: ProtoClineMessage): ClineMessage {
	return message as unknown as ClineMessage
}

export class ClineWorkerAdapter {
	private activeTaskId?: string
	private unsubscribePartial?: () => void
	private readonly sanitizer = new ContextSanitizer()

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
		const prompt = this.sanitizer.toWorkerPrompt(taskSpec)
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

		this.activeTaskId = await this.controller.initTask(prompt)

		await this.bus.emitDigest({
			taskId: this.activeTaskId,
			status: "running",
			title: "作業中",
			summary: "Cline Worker が裏で作業しているにゃ。",
		})
	}

	async control(request: WorkerControlRequest): Promise<void> {
		switch (request.action) {
			case "pause":
			case "cancel":
			case "redirect":
			case "replan":
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
				break
			case "append_context":
				await this.bus.emitWorkerDetail({
					kind: "status",
					title: "Context queued",
					detail: request.reason,
					source: "flash",
				})
				break
		}
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
		await this.bus.emitWorkerDetail({
			kind: message.type === "ask" ? "ask" : label === "tool" ? "tool" : "message",
			title: label,
			detail: message.text,
			source: "cline",
			ts: message.ts,
		})
		await this.bus.emitDigest(this.sanitizer.toDigestFromMessage(message, this.activeTaskId))
	}
}
