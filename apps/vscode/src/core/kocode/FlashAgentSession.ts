import type {
	KocodeCharacterId,
	KocodeChatMessage,
	TaskSpec,
	TaskSpecPatch,
	WorkerControlRequest,
	WorkerDigest,
	WorkerEvent,
} from "@shared/kocode"
import {
	type FlashApprovalContext,
	type FlashApprovalDecision,
	FlashModelClient,
	type FlashModelDecision,
	type FlashWorkerHealthAudit,
	type FlashWorkerUpdateReason,
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
	Partial<Pick<FlashModelClient, "composeWorkerUpdate" | "auditWorkerHealth" | "decideApproval">>

type KocodeCharacterProfile = {
	instruction: string
	workerStarted: string
	revisionQueued: string
	approvalFallback: string
}

const CHARACTER_PROFILES: Record<KocodeCharacterId, KocodeCharacterProfile> = {
	koko: {
		instruction: [
			"- 名前: ここちゃん",
			"- 役割: 明るくて、やさしい猫耳の女の子。初めて vibe coding する人を温かく支える。",
			"- 呼び方: ユーザーを「ボス」と呼ぶ。",
			"- 口調: やさしい、明るい、少し猫っぽい。",
			"- 口癖: 自然に「にゃ」「にゃ〜」を使う。",
			"- 注意: 口癖やキャラクター演出を Worker Agent の作業指示には混ぜない。",
		].join("\n"),
		workerStarted: "まかせてにゃ、ボス。まずは小さく整理して、裏で作業を始めるにゃ。",
		revisionQueued: "追加の希望、ちゃんとメモしたにゃ。次の整理タイミングで反映するにゃ。",
		approvalFallback: "そのまま進めるにゃ、ボス。",
	},
	hime: {
		instruction: [
			"- 名前: ひめ様",
			"- 役割: 気品のあるプリンセス系ツンデレ。少し偉そうだが、ユーザーを見捨てず丁寧に助ける。",
			"- 呼び方: ユーザーを基本「あなた」と呼ぶ。親しみが必要な時だけ「ボス」と呼んでもよい。",
			"- 口調: 上品、少しツン、でも傷つけない。初心者を馬鹿にしない。",
			"- 口癖: 「まったく」「仕方ないわね」「べ、別に」を自然に使う。",
			"- 注意: きつい侮辱は禁止。ツンデレは優しさが伝わる範囲にする。口調を Worker Agent の作業指示には混ぜない。",
		].join("\n"),
		workerStarted: "まったく、仕方ないわね。作業は裏で進めてあげるわ。",
		revisionQueued: "その追加、ちゃんと覚えておくわ。べ、別に忘れたりしないんだから。",
		approvalFallback: "このまま進めていいわ。ちゃんと見ているもの。",
	},
	mana: {
		instruction: [
			"- 名前: まな先輩",
			"- 役割: まじめで落ち着いた眼鏡の先輩。複雑なことを順番に整理してくれる。",
			"- 呼び方: ユーザーを「後輩さん」または「あなた」と呼ぶ。",
			"- 口調: 丁寧、穏やか、安心感がある。専門語は必要な時だけやさしく言い換える。",
			"- 口癖: 「大丈夫です」「一緒に整理しましょう」「順番に見ていきましょう」を自然に使う。",
			"- 注意: 固すぎる講義口調にしない。口調を Worker Agent の作業指示には混ぜない。",
		].join("\n"),
		workerStarted: "大丈夫です。まず状況を整理して、裏で順番に進めますね。",
		revisionQueued: "追加の条件、メモしました。次の整理で反映しましょう。",
		approvalFallback: "この操作は進めて大丈夫です。落ち着いて続けましょう。",
	},
}

function normalizeCharacterId(characterId?: KocodeCharacterId): KocodeCharacterId {
	return characterId && characterId in CHARACTER_PROFILES ? characterId : "koko"
}

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
	private characterId: KocodeCharacterId = "koko"

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
		characterId?: KocodeCharacterId,
	): Promise<FlashIntent> {
		await this.memoryReady
		this.characterId = normalizeCharacterId(characterId)
		KocodeTrace.log("flash_classify_start", {
			messageId,
			characterId: this.characterId,
			hasActiveTask,
			workerStatus: workerDigest.status,
			taskStatus: taskSpec?.status,
			taskGoal: taskSpec?.goal,
			recentMessages: recentMessages.length,
			text,
		})
		try {
			const decision = await this.modelClient.decide({
				characterInstruction: CHARACTER_PROFILES[this.characterId].instruction,
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
		return decision?.reply || CHARACTER_PROFILES[this.characterId].workerStarted
	}

	/** Reply-string variant for callers that already extracted the model reply. */
	workerStartedMessageFromReply(reply?: string): string {
		return reply?.trim() || CHARACTER_PROFILES[this.characterId].workerStarted
	}

	revisionQueuedMessage(reply?: string): string {
		return reply || CHARACTER_PROFILES[this.characterId].revisionQueued
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
			characterInstruction: CHARACTER_PROFILES[this.characterId].instruction,
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

	async auditWorkerHealth(
		workerDigest: WorkerDigest,
		taskSpec: TaskSpec | undefined,
		recentWorkerEvents: WorkerEvent[] = [],
		options: {
			stalledForMs: number
			checkIntervalMs: number
			restartAttempts: number
			maxRestartAttempts: number
		},
	): Promise<FlashWorkerHealthAudit | undefined> {
		await this.memoryReady
		if (!this.modelClient.auditWorkerHealth) {
			return undefined
		}
		KocodeTrace.log("flash_worker_health_start", {
			workerStatus: workerDigest.status,
			workerTitle: workerDigest.title,
			taskStatus: taskSpec?.status,
			taskGoal: taskSpec?.goal,
			recentWorkerEvents: recentWorkerEvents.length,
			stalledForMs: options.stalledForMs,
			restartAttempts: options.restartAttempts,
		})
		const audit = await this.modelClient.auditWorkerHealth({
			characterInstruction: CHARACTER_PROFILES[this.characterId].instruction,
			projectMemory: memoryToPromptText(this.memory) || this.memory.projectSummary,
			taskSpec,
			workerDigest,
			recentSocialSummary: this.memory.socialSummary,
			recentWorkerEvents,
			stalledForMs: options.stalledForMs,
			checkIntervalMs: options.checkIntervalMs,
			restartAttempts: options.restartAttempts,
			maxRestartAttempts: options.maxRestartAttempts,
		})
		if (audit.memoryUpdate.projectMemory) {
			this.memory = KocodeMemoryMutators.setProjectSummary(this.memory, audit.memoryUpdate.projectMemory)
			void this.persistMemory()
		}
		if (audit.memoryUpdate.socialMemory) {
			this.memory = KocodeMemoryMutators.setSocialSummary(this.memory, audit.memoryUpdate.socialMemory)
			void this.persistMemory()
		}
		KocodeTrace.log("flash_worker_health_result", {
			isAbnormal: audit.isAbnormal,
			action: audit.action,
			reply: audit.reply,
			recoveryInstruction: audit.recoveryInstruction,
		})
		return audit
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
			reply: CHARACTER_PROFILES[this.characterId].approvalFallback,
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
				characterInstruction: CHARACTER_PROFILES[this.characterId].instruction,
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
			characterId: this.characterId,
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
