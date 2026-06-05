import type { TaskSpec, TaskSpecPatch, WorkerDigest } from "@shared/kocode"
import type { FlashIntent } from "./FlashAgentSession"
import type { FlashModelDecision } from "./FlashModelClient"

const TASK_VERBS = [
	"实现",
	"修改",
	"修复",
	"调试",
	"报错",
	"代码",
	"文件",
	"生成",
	"做",
	"写",
	"加",
	"删除",
	"add",
	"fix",
	"debug",
	"implement",
	"create",
	"update",
	"build",
	"refactor",
	"作って",
	"修正",
	"作成",
	"コード",
	"エラー",
	"バグ",
]

const PAUSE_HINTS = ["止めて", "ストップ", "stop", "wait", "待って", "暂停", "停一下"]
const CANCEL_HINTS = ["キャンセル", "もうやめて", "やめ", "abort", "cancel", "取消"]
const REDIRECT_HINTS = ["違う", "そうじゃない", "方向が違う", "じゃなくて", "wrong", "redirect", "不对", "不是这样"]
const REPLAN_HINTS = ["やり直", "計画", "replan", "重做", "再来"]
const STATUS_HINTS = ["どこまで", "進んでる", "状況", "進捗", "status", "progress", "怎么样了", "进度"]
const SOCIAL_HINTS = ["ありがとう", "かわいい", "いいね", "thanks", "thank", "好きにゃ", "嬉しい", "你好", "谢谢", "可爱"]

export interface HeuristicClassifyInput {
	text: string
	messageId: string
	hasActiveTask: boolean
	taskSpec?: TaskSpec
	workerStatus: WorkerDigest["status"]
}

export function fallbackClassify(input: HeuristicClassifyInput): FlashIntent {
	const text = input.text.trim()
	if (!text) {
		return { type: "social_chat", reply: "聞いてるにゃ、ボス。もう少し具体的に教えてもらえる？" }
	}

	const lower = text.toLowerCase()
	const hasVerb = TASK_VERBS.some((kw) => lower.includes(kw.toLowerCase()))
	const matches = (hints: string[]): boolean => hints.some((kw) => lower.includes(kw.toLowerCase()))

	if (matches(CANCEL_HINTS)) {
		return {
			type: "worker_control",
			control: { action: "cancel", reason: text },
			reply: "了解にゃ、いったん止めるね。",
		}
	}
	if (matches(PAUSE_HINTS)) {
		return {
			type: "worker_control",
			control: { action: "pause", reason: text },
			reply: "わかったにゃ、ちょっと止めて待つね。",
		}
	}
	if (matches(REDIRECT_HINTS)) {
		const patch: TaskSpecPatch = {
			kind: "reject_direction",
			text,
			sourceMessageId: input.messageId,
			createdAt: Date.now(),
		}
		return {
			type: "worker_control",
			control: { action: "redirect", reason: text, taskSpecPatch: patch },
			reply: "方向、メモしたにゃ。すぐ立て直すね。",
		}
	}
	if (matches(REPLAN_HINTS)) {
		return {
			type: "worker_control",
			control: { action: "replan", reason: text },
			reply: "もう一度ちゃんと組み立て直すにゃ。",
		}
	}
	if (matches(STATUS_HINTS)) {
		return {
			type: "status_question",
			reply: input.hasActiveTask
				? `今は「${input.taskSpec?.goal ?? "作業中"}」を進めてる途中にゃ。`
				: "今はとくに作業してないよ、ボス。新しいお願い、教えてね。",
		}
	}
	if (!hasVerb && matches(SOCIAL_HINTS)) {
		return { type: "social_chat", reply: "うんうん、ちゃんと聞いてるにゃ、ボス。" }
	}

	if (hasVerb) {
		const decision: FlashModelDecision = {
			intent: input.hasActiveTask ? "extend_task" : "new_task",
			reply: input.hasActiveTask
				? "了解にゃ、いまの作業に追加でメモしたよ。"
				: "了解にゃ。まずは小さく整理して、裏で作業を始めるね。",
			task: {
				goal: text,
				mode: null,
				files: [],
				constraints: [],
				acceptanceCriteria: [],
			},
			patch: {
				kind: input.hasActiveTask ? "add_constraint" : null,
				text: input.hasActiveTask ? text : null,
			},
			workerControl: { action: null, reason: null },
			memoryUpdate: { projectMemory: null, socialMemory: null },
		}
		if (input.hasActiveTask) {
			const patch: TaskSpecPatch = {
				kind: "add_constraint",
				text,
				sourceMessageId: input.messageId,
				createdAt: Date.now(),
			}
			return { type: "extend_task", decision, patch, reply: decision.reply }
		}
		return { type: "new_task", decision }
	}

	// Default: treat as social chat with a gentle clarifying nudge so we never drop input.
	return {
		type: "social_chat",
		reply: "うん、聞こえてるにゃ。もう少しだけ具体的に教えてくれる？",
	}
}
