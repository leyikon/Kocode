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
	"计划",
	"規劃",
	"规划",
	"方案",
	"怎么做",
	"如何做",
	"先别改",
	"不要改",
	"先不要",
	"先看",
	"plan",
	"approach",
	"how would",
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
const REPLAN_HINTS = ["やり直", "再計画", "replan", "重做", "再来", "重新计划", "重新规划"]
const ROLLBACK_HINTS = [
	"完全不行",
	"全部不对",
	"全都不对",
	"推倒重来",
	"推翻重来",
	"回滚",
	"回退",
	"撤回",
	"恢复到",
	"rollback",
	"roll back",
	"戻して",
	"巻き戻",
]
const STATUS_HINTS = ["どこまで", "進んでる", "状況", "進捗", "status", "progress", "怎么样了", "进度"]
const SOCIAL_HINTS = ["ありがとう", "かわいい", "いいね", "thanks", "thank", "好きにゃ", "嬉しい", "你好", "谢谢", "可爱"]
const PLANNING_TASK_HINTS = [
	"计划",
	"規劃",
	"规划",
	"方案",
	"怎么做",
	"如何做",
	"先别改",
	"不要改",
	"先不要",
	"先看",
	"計画",
	"plan",
	"approach",
	"how would",
]
const EXPLANATION_HINTS = ["解释", "講", "讲", "教我", "説明", "説明して", "explain"]
// 「実装せず計画だけ」を明示する強いシグナル。命中したら plan_only。
const PLAN_ONLY_HINTS = [
	"先别改",
	"别改",
	"不要改",
	"先不要改",
	"不要实现",
	"先不要",
	"只给方案",
	"只要计划",
	"計画だけ",
	"まだ実装しない",
	"実装しないで",
	"触らないで",
	"don't change",
	"do not change",
	"plan only",
	"just the plan",
]

function parseRollbackSteps(text: string): number | undefined {
	const digit = text.match(/(?:回滚|回退|撤回|恢复到|rollback|roll back|戻|巻き戻)[^\d一二三]*([123一二三])/i)?.[1]
	if (!digit) {
		return undefined
	}
	if (digit === "一") {
		return 1
	}
	if (digit === "二") {
		return 2
	}
	if (digit === "三") {
		return 3
	}
	return Number(digit)
}

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

	if (matches(ROLLBACK_HINTS)) {
		if (!input.hasActiveTask) {
			return {
				type: "status_question",
				reply: "今は回滚できる進行中の作業が見つからないにゃ。",
			}
		}
		const patch: TaskSpecPatch = {
			kind: "request_rollback",
			text,
			sourceMessageId: input.messageId,
			createdAt: Date.now(),
		}
		return {
			type: "worker_control",
			control: {
				action: "rollback_request",
				reason: text,
				taskSpecPatch: patch,
				rollback: { steps: parseRollbackSteps(text), restoreType: "taskAndWorkspace" },
			},
			reply: "大きく戻す可能性があるにゃ。実行前に確認するね。",
		}
	}
	if (matches(CANCEL_HINTS)) {
		// 控制指令仅在有进行中任务时才成立；否则像「取消订阅功能」这类其实是任务描述，
		// 不应被误判为 worker 控制（#6）。无任务时落到下方的任务/社交分支。
		if (input.hasActiveTask) {
			return {
				type: "worker_control",
				control: { action: "cancel", reason: text },
				reply: "了解にゃ、いったん止めるね。",
			}
		}
	}
	if (matches(PAUSE_HINTS)) {
		if (input.hasActiveTask) {
			return {
				type: "worker_control",
				control: { action: "pause", reason: text },
				reply: "わかったにゃ、ちょっと止めて待つね。",
			}
		}
	}
	if (matches(REDIRECT_HINTS)) {
		if (input.hasActiveTask) {
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
	}
	if (matches(REPLAN_HINTS)) {
		if (input.hasActiveTask) {
			return {
				type: "worker_control",
				control: { action: "replan", reason: text },
				reply: "もう一度ちゃんと組み立て直すにゃ。",
			}
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
	if (!hasVerb && matches(EXPLANATION_HINTS)) {
		return {
			type: "explanation_request",
			reply: "ここは Flash 側で短く説明するにゃ。",
			decision: {
				intent: "explanation_request",
				reply: "ここは Flash 側で短く説明するにゃ。",
				task: {
					goal: text,
					mode: null,
					executionMode: null,
					files: [],
					constraints: [],
					acceptanceCriteria: [],
				},
				patch: { kind: null, text: null },
				workerControl: { action: null, reason: null },
				memoryUpdate: { projectMemory: null, socialMemory: null },
			},
		}
	}

	if (hasVerb) {
		const planOnly = matches(PLAN_ONLY_HINTS)
		const planningOnly = matches(PLANNING_TASK_HINTS)
		// 言行一致:计划信号 → plan_then_execute;明确"先别改/只给方案" → plan_only。
		const executionMode: FlashModelDecision["task"]["executionMode"] = planOnly
			? "plan_only"
			: planningOnly
				? "plan_then_execute"
				: "execute_directly"
		const planReply = planOnly
			? "わかったにゃ、まずは作り方だけ整理してくるね。コードはまだ触らないにゃ。"
			: planningOnly
				? "まずは作り方を整理してから進めるにゃ。"
				: input.hasActiveTask
					? "了解にゃ、その分も続けて進めるね。"
					: "了解にゃ、すぐ取りかかるね。"
		const decision: FlashModelDecision = {
			intent: input.hasActiveTask ? "extend_task" : "new_task",
			reply: planReply,
			task: {
				goal: text,
				mode: null,
				executionMode,
				files: [],
				constraints: [],
				acceptanceCriteria: planOnly ? ["計画だけを出す", "ユーザーが追加で依頼するまでコード変更しない"] : [],
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
