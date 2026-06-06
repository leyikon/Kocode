import type { KocodeChatMessage, TaskSpec, TaskSpecPatch, WorkerControlRequest, WorkerDigest, WorkerEvent } from "@shared/kocode"
import {
    FlashModelClient,
    type FlashApprovalContext,
    type FlashApprovalDecision,
    type FlashModelDecision,
    type FlashWorkerUpdateReason
} from "./FlashModelClient"
import { fallbackClassify } from "./HeuristicClassifier"
import {
    createDefaultMemory,
    FileKocodeMemoryStore,
    type KocodeMemory,
    KocodeMemoryMutators,
    type KocodeMemoryPersistence,
    memoryToPromptText,
} from "./KocodeMemoryStore"
import { KocodeTrace } from "./KocodeTrace"

type FlashDecisionClient = Pick<FlashModelClient, "decide"> &
	Partial<Pick<FlashModelClient, "composeWorkerUpdate" | "decideApproval">>

export type FlashIntent =
	| { type: "social_chat"; reply: string }
	| { type: "status_question"; reply: string }
	| { type: "explanation_request"; reply: string; decision: FlashModelDecision }
	| { type: "new_task"; decision: FlashModelDecision }
	| { type: "extend_task"; decision: FlashModelDecision; patch: TaskSpecPatch; reply: string }
	| { type: "task_revision"; patch: TaskSpecPatch; reply: string }
	| { type: "worker_control"; control: WorkerControlRequest; reply: string }
	| { type: "flash_error"; reply: string }

export class FlashAgentSession {
	private memory: KocodeMemory = createDefaultMemory()
	private memoryReady: Promise<void>

	constructor(
		private readonly modelClient: FlashDecisionClient = new FlashModelClient(),
		private readonly memoryStore: KocodeMemoryPersistence = new FileKocodeMemoryStore(undefined),
	) {
		this.memoryReady = this.memoryStore
			.load()
			.then((loaded) => {
				this.memory = loaded
			})
			.catch((error) => {
				KocodeTrace.error("kocode_memory_load_failed", error)
			})
	}

	async classify(
		text: string,
		messageId: string,
		workerDigest: WorkerDigest,
		hasActiveTask: boolean,
		taskSpec?: TaskSpec,
		recentMessages: Array<{ author: "user" | "flash"; text: string }> = [],
	): Promise<FlashIntent> {
		await this.memoryReady
		KocodeTrace.log("flash_classify_start", {
			messageId,
			hasActiveTask,
			workerStatus: workerDigest.status,
			taskStatus: taskSpec?.status,
			taskGoal: taskSpec?.goal,
			recentMessages: recentMessages.length,
			text,
		})
		try {
			const decision = await this.modelClient.decide({
				projectMemory: memoryToPromptText(this.memory) || this.memory.projectSummary,
				taskSpec,
				workerDigest,
				recentSocialSummary: this.memory.socialSummary,
				recentMessages,
				userMessage: text,
			})
			await this.applyMemoryUpdate(decision)
			const intent = this.toIntent(decision, text, messageId, hasActiveTask)
			KocodeTrace.log("flash_intent", {
				messageId,
				modelIntent: decision.intent,
				finalIntent: intent.type,
				patchKind: "patch" in intent ? intent.patch.kind : undefined,
				workerAction: intent.type === "worker_control" ? intent.control.action : undefined,
				reply: "reply" in intent ? intent.reply : undefined,
			})
			return intent
		} catch (error) {
			KocodeTrace.error("flash_classify_failed", error, { messageId, text })
			// Local deterministic fallback so the user message is never silently dropped.
			const fallback = fallbackClassify({
				text,
				messageId,
				hasActiveTask,
				taskSpec,
				workerStatus: workerDigest.status,
			})
			KocodeTrace.log("flash_intent_fallback", {
				messageId,
				finalIntent: fallback.type,
			})
			return fallback
		}
	}

	workerStartedMessage(decision?: FlashModelDecision): string {
		return decision?.reply || "まかせてにゃ、ボス。まずは小さく整理して、裏で作業を始めるにゃ。"
	}

	/** Reply-string variant for callers that already extracted the model reply. */
	workerStartedMessageFromReply(reply?: string): string {
		return reply?.trim() || "まかせてにゃ、ボス。まずは小さく整理して、裏で作業を始めるにゃ。"
	}

	revisionQueuedMessage(reply?: string): string {
		return reply || "追加の希望、ちゃんとメモしたにゃ。次の整理タイミングで反映するにゃ。"
	}

	async composeWorkerUpdate(
		reason: FlashWorkerUpdateReason,
		workerDigest: WorkerDigest,
		taskSpec?: TaskSpec,
		recentWorkerEvents: WorkerEvent[] = [],
	): Promise<string | undefined> {
		await this.memoryReady
		if (!this.modelClient.composeWorkerUpdate) {
			return undefined
		}
		KocodeTrace.log("flash_worker_update_start", {
			reason,
			workerStatus: workerDigest.status,
			workerTitle: workerDigest.title,
			taskStatus: taskSpec?.status,
			taskGoal: taskSpec?.goal,
			recentWorkerEvents: recentWorkerEvents.length,
		})
		const update = await this.modelClient.composeWorkerUpdate({
			projectMemory: memoryToPromptText(this.memory) || this.memory.projectSummary,
			taskSpec,
			workerDigest,
			recentSocialSummary: this.memory.socialSummary,
			recentWorkerEvents,
			reason,
		})
		if (update.memoryUpdate.projectMemory) {
			this.memory = KocodeMemoryMutators.setProjectSummary(this.memory, update.memoryUpdate.projectMemory)
			void this.persistMemory()
		}
		if (update.memoryUpdate.socialMemory) {
			this.memory = KocodeMemoryMutators.setSocialSummary(this.memory, update.memoryUpdate.socialMemory)
			void this.persistMemory()
		}
		KocodeTrace.log("flash_worker_update_result", {
			reason,
			shouldNotify: update.shouldNotify,
			reply: update.reply,
		})
		return update.shouldNotify && update.reply.trim() ? update.reply.trim() : undefined
	}

	/**
	 * Worker（Cline）が承認待ちで止まった時、Flash Agent として許可/拒否を判断する。
	 * 別系統のモデルは立てず、Flash Agent のモデル（同一エンドポイント）と記憶をそのまま使う。
	 * モデルが使えない／失敗した場合は、作業を前に進める安全側として approve=true にフォールバックする。
	 */
	async decideWorkerApproval(
		askType: string,
		askText: string,
		workerDigest: WorkerDigest,
		taskSpec?: TaskSpec,
		recentWorkerEvents: WorkerEvent[] = [],
	): Promise<FlashApprovalDecision> {
		await this.memoryReady
		const fallback: FlashApprovalDecision = {
			approve: true,
			reply: "そのまま進めるにゃ、ボス。",
			reason: "flash_approval_unavailable_fallback_allow",
		}
		if (!this.modelClient.decideApproval) {
			return fallback
		}
		KocodeTrace.log("flash_approval_start", {
			askType,
			workerStatus: workerDigest.status,
			taskStatus: taskSpec?.status,
			taskGoal: taskSpec?.goal,
			recentWorkerEvents: recentWorkerEvents.length,
		})
		try {
			const context: FlashApprovalContext = {
				projectMemory: memoryToPromptText(this.memory) || this.memory.projectSummary,
				taskSpec,
				workerDigest,
				recentSocialSummary: this.memory.socialSummary,
				recentWorkerEvents,
				askType,
				askText,
			}
			const decision = await this.modelClient.decideApproval(context)
			KocodeTrace.log("flash_approval_result", {
				askType,
				approve: decision.approve,
				reason: decision.reason,
				reply: decision.reply,
			})
			return decision
		} catch (error) {
			KocodeTrace.error("flash_approval_failed", error, { askType })
			// モデルが落ちても Worker を無限に止めない：前に進める方向でフォールバック。
			return fallback
		}
	}

	getMemorySnapshot(): KocodeMemory {
		return this.memory
	}

	rememberRejectedDirection(text: string): void {
		this.memory = KocodeMemoryMutators.rejectDirection(this.memory, text)
		void this.persistMemory()
	}

	rememberAcceptedDecision(text: string): void {
		this.memory = KocodeMemoryMutators.acceptDecision(this.memory, text)
		void this.persistMemory()
	}

	private async persistMemory(): Promise<void> {
		try {
			await this.memoryStore.save(this.memory)
		} catch (error) {
			KocodeTrace.error("kocode_memory_save_failed", error)
		}
	}

	toMessage(text: string): KocodeChatMessage {
		return {
			id: `flash-${Date.now()}-${Math.random().toString(36).slice(2)}`,
			author: "flash",
			text,
			ts: Date.now(),
		}
	}

	private toIntent(decision: FlashModelDecision, originalText: string, messageId: string, hasActiveTask: boolean): FlashIntent {
		switch (decision.intent) {
			case "social_chat":
				return { type: "social_chat", reply: decision.reply }
			case "status_question":
				return { type: "status_question", reply: decision.reply }
			case "explanation_request":
				return { type: "explanation_request", reply: decision.reply, decision }
			case "new_task":
				return { type: "new_task", decision }
			case "extend_task": {
				// Extend = same flow, additional scope. Use add_constraint or add_file_scope as the patch.
				const patchKind = decision.patch.kind ?? "add_constraint"
				const patchText = decision.patch.text ?? decision.task.goal ?? originalText
				const patch: TaskSpecPatch = {
					kind: patchKind,
					text: patchText,
					sourceMessageId: messageId,
					createdAt: Date.now(),
				}
				return { type: "extend_task", decision, patch, reply: decision.reply }
			}
			case "task_revision":
				return {
					type: "task_revision",
					patch: {
						kind: decision.patch.kind ?? "add_constraint",
						text: decision.patch.text ?? originalText,
						sourceMessageId: messageId,
						createdAt: Date.now(),
					},
					reply: decision.reply,
				}
			case "worker_control": {
				const action = decision.workerControl.action ?? (hasActiveTask ? "append_context" : "replan")
				const patchKind =
					decision.patch.kind ??
					(action === "redirect" ? "reject_direction" : action === "rollback_request" ? "request_rollback" : undefined)
				const patch: TaskSpecPatch | undefined = patchKind
					? {
							kind: patchKind,
							text: decision.patch.text ?? decision.workerControl.reason ?? originalText,
							sourceMessageId: messageId,
							createdAt: Date.now(),
						}
					: undefined
				return {
					type: "worker_control",
					control: {
						action,
						reason: decision.workerControl.reason ?? originalText,
						taskSpecPatch: patch,
						rollback: decision.workerControl.rollback
							? {
									steps: decision.workerControl.rollback.steps ?? undefined,
									restoreType: decision.workerControl.rollback.restoreType ?? undefined,
								}
							: undefined,
					},
					reply: decision.reply,
				}
			}
		}
	}

	private async applyMemoryUpdate(decision: FlashModelDecision): Promise<void> {
		let changed = false
		if (decision.memoryUpdate.projectMemory) {
			this.memory = KocodeMemoryMutators.setProjectSummary(this.memory, decision.memoryUpdate.projectMemory)
			changed = true
		}
		if (decision.memoryUpdate.socialMemory) {
			this.memory = KocodeMemoryMutators.setSocialSummary(this.memory, decision.memoryUpdate.socialMemory)
			changed = true
		}
		// Mirror reject_direction patches into long-term memory so future tasks remember what was rejected.
		if (decision.intent === "worker_control" && decision.patch.kind === "reject_direction" && decision.patch.text) {
			this.memory = KocodeMemoryMutators.rejectDirection(this.memory, decision.patch.text)
			changed = true
		}
		if (changed) {
			await this.persistMemory()
		}
	}
}
