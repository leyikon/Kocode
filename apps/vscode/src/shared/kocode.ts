export type KocodeContextLayer = "social" | "task" | "revision" | "worker_memory" | "worker_digest"
export type KocodeCharacterId = "koko" | "hime" | "mana"

export type KocodeTaskMode = "coding" | "debugging" | "learning" | "slide_preview" | "quiz"
export type KocodeTaskStatus = "draft" | "active" | "paused" | "completed" | "cancelled" | "failed"

// 执行意图:决定 Worker 是只产计划、先计划再实现、还是直接实现。
// 用于保证 Flash「说法」与系统「动作」一致(言行一致)。
export type KocodeExecutionMode = "plan_only" | "plan_then_execute" | "execute_directly"

export type TaskSpecPatchKind =
	| "replace_goal"
	| "add_constraint"
	| "remove_constraint"
	| "add_file_scope"
	| "reject_direction"
	| "request_pause"
	| "request_cancel"
	| "request_replan"
	| "request_rollback"

export interface TaskSpecPatch {
	kind: TaskSpecPatchKind
	text: string
	sourceMessageId: string
	createdAt: number
}

export interface TaskSpec {
	id: string
	goal: string
	mode: KocodeTaskMode
	status: KocodeTaskStatus
	// 执行意图。缺省视为 execute_directly(向后兼容旧 TaskSpec)。
	executionMode?: KocodeExecutionMode
	files: string[]
	constraints: string[]
	acceptedDecisions: string[]
	rejectedDirections: string[]
	pendingPatches: TaskSpecPatch[]
	acceptanceCriteria: string[]
}

export type WorkerRollbackRestoreType = "workspace" | "taskAndWorkspace"

export interface WorkerRollbackRequest {
	steps?: number
	restoreType?: WorkerRollbackRestoreType
	confirmationId?: string
}

export interface PendingRollbackConfirmation {
	id: string
	steps: number
	restoreType: WorkerRollbackRestoreType
	reason: string
	sourceMessageId: string
	createdAt: number
}

export type WorkerControlAction =
	| "pause"
	| "cancel"
	| "redirect"
	| "append_context"
	| "replan"
	| "rollback_request"
	| "rollback_confirmed"

export interface WorkerControlRequest {
	action: WorkerControlAction
	reason: string
	taskSpecPatch?: TaskSpecPatch
	rollback?: WorkerRollbackRequest
}

export type KocodeMessageAuthor = "user" | "flash"

export interface KocodeChatMessage {
	id: string
	author: KocodeMessageAuthor
	text: string
	ts: number
	characterId?: KocodeCharacterId
	images?: string[]
	files?: string[]
}

export interface WorkerDigest {
	taskId?: string
	status: "idle" | "starting" | "running" | "waiting" | "paused" | "cancelled" | "completed" | "failed"
	title: string
	summary: string
	lastEventAt: number
}

export interface WorkerEvent {
	id: string
	ts: number
	kind: "started" | "message" | "ask" | "tool" | "status" | "cancelled" | "completed" | "error"
	title: string
	detail?: string
	source?: string
}

export interface SlidePreviewPage {
	title: string
	body: string
}

export interface PracticeQuestion {
	question: string
	hint?: string
	answer?: string
	explanation?: string
}

export type LearningArtifact =
	| { type: "code_explanation"; title: string; markdown: string }
	| { type: "runnable_example"; title: string; files: string[]; markdown: string }
	| { type: "mermaid_map"; title: string; mermaid: string }
	| { type: "slide_preview"; title: string; slides: SlidePreviewPage[] }
	| { type: "practice_quiz"; title: string; questions: PracticeQuestion[] }

export type KocodeEvent =
	| { type: "flash_message"; message: KocodeChatMessage }
	| { type: "user_message"; message: KocodeChatMessage }
	| { type: "worker_status"; digest: WorkerDigest }
	| { type: "worker_detail"; event: WorkerEvent }
	| { type: "task_spec_updated"; taskSpec: TaskSpec }
	| { type: "artifact_ready"; artifact: LearningArtifact }

export interface KocodeUserMessage {
	text: string
	characterId?: KocodeCharacterId
	images?: string[]
	files?: string[]
}

export interface KocodeSendResult {
	accepted: boolean
	messageId: string
	taskSpec?: TaskSpec
	workerStarted?: boolean
}

export interface KocodeSessionState {
	messages: KocodeChatMessage[]
	taskSpec?: TaskSpec
	workerDigest: WorkerDigest
	workerEvents: WorkerEvent[]
	pendingRollback?: PendingRollbackConfirmation
}
