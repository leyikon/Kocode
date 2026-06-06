import type { TaskSpec, TaskSpecPatchKind, WorkerControlAction, WorkerDigest, WorkerEvent } from "@shared/kocode"
import { z } from "zod"
import { ClineEnv } from "@/config"
import { fetch } from "@/shared/net"
import { KocodeTrace } from "./KocodeTrace"

export type FlashModelIntent =
	| "social_chat"
	| "status_question"
	| "explanation_request"
	| "new_task"
	| "extend_task"
	| "task_revision"
	| "worker_control"

const TASK_MODE_VALUES = ["coding", "debugging", "learning", "slide_preview", "quiz"] as const
const PATCH_KIND_VALUES: TaskSpecPatchKind[] = [
	"replace_goal",
	"add_constraint",
	"remove_constraint",
	"add_file_scope",
	"reject_direction",
	"request_pause",
	"request_cancel",
	"request_replan",
	"request_rollback",
]
const WORKER_ACTION_VALUES: WorkerControlAction[] = [
	"pause",
	"cancel",
	"redirect",
	"append_context",
	"replan",
	"rollback_request",
]
const WORKER_ROLLBACK_RESTORE_TYPES = ["workspace", "taskAndWorkspace"] as const

const FlashDecisionSchema = z
	.object({
		intent: z.enum([
			"social_chat",
			"status_question",
			"explanation_request",
			"new_task",
			"extend_task",
			"task_revision",
			"worker_control",
			"complex_task",
		]),
		reply: z.string().min(1),
		task: z
			.object({
				goal: z.string().nullable().optional(),
				mode: z.enum(TASK_MODE_VALUES).nullable().optional(),
				files: z.array(z.string()).optional(),
				constraints: z.array(z.string()).optional(),
				acceptanceCriteria: z.array(z.string()).optional(),
			})
			.optional(),
		patch: z
			.object({
				kind: z
					.enum(PATCH_KIND_VALUES as [TaskSpecPatchKind, ...TaskSpecPatchKind[]])
					.nullable()
					.optional(),
				text: z.string().nullable().optional(),
			})
			.optional(),
		workerControl: z
			.object({
				action: z
					.enum(WORKER_ACTION_VALUES as [WorkerControlAction, ...WorkerControlAction[]])
					.nullable()
					.optional(),
				reason: z.string().nullable().optional(),
				rollback: z
					.object({
						steps: z.number().int().min(1).max(3).nullable().optional(),
						restoreType: z.enum(WORKER_ROLLBACK_RESTORE_TYPES).nullable().optional(),
					})
					.optional(),
			})
			.optional(),
		memoryUpdate: z
			.object({
				projectMemory: z.string().nullable().optional(),
				socialMemory: z.string().nullable().optional(),
			})
			.optional(),
	})
	.passthrough()

const FlashWorkerUpdateSchema = z
	.object({
		shouldNotify: z.boolean(),
		reply: z.string().optional(),
		memoryUpdate: z
			.object({
				projectMemory: z.string().nullable().optional(),
				socialMemory: z.string().nullable().optional(),
			})
			.optional(),
	})
	.passthrough()

const FlashApprovalSchema = z
	.object({
		approve: z.boolean(),
		reply: z.string().optional(),
		reason: z.string().optional(),
	})
	.passthrough()

export interface FlashModelDecision {
	intent: FlashModelIntent
	reply: string
	task: {
		goal: string | null
		mode: TaskSpec["mode"] | null
		files: string[]
		constraints: string[]
		acceptanceCriteria: string[]
	}
	patch: {
		kind: TaskSpecPatchKind | null
		text: string | null
	}
	workerControl: {
		action: WorkerControlAction | null
		reason: string | null
		rollback?: {
			steps: number | null
			restoreType: "workspace" | "taskAndWorkspace" | null
		}
	}
	memoryUpdate: {
		projectMemory: string | null
		socialMemory: string | null
	}
}

export interface FlashModelContext {
	projectMemory: string
	taskSpec?: TaskSpec
	workerDigest: WorkerDigest
	recentSocialSummary: string
	recentMessages: Array<{ author: "user" | "flash"; text: string }>
	userMessage: string
}

export type FlashWorkerUpdateReason = "started" | "progress" | "waiting" | "completed" | "failed" | "paused" | "cancelled"

export interface FlashWorkerUpdateContext {
	projectMemory: string
	taskSpec?: TaskSpec
	workerDigest: WorkerDigest
	recentSocialSummary: string
	recentWorkerEvents: WorkerEvent[]
	reason: FlashWorkerUpdateReason
}

export interface FlashWorkerUpdate {
	shouldNotify: boolean
	reply: string
	memoryUpdate: {
		projectMemory: string | null
		socialMemory: string | null
	}
}

// Worker（Cline）が承認待ちで止まった時、Flash Agent が「許可 / 拒否」を判断するための入出力。
// 別系統のモデルは立てず、既存の Flash Agent のモデル（同じエンドポイント）をそのまま使う。
export interface FlashApprovalContext {
	projectMemory: string
	taskSpec?: TaskSpec
	workerDigest: WorkerDigest
	recentSocialSummary: string
	recentWorkerEvents: WorkerEvent[]
	// Cline の ask 種別（tool / command / use_mcp_server / browser_action_launch など）。
	askType: string
	// ask に添えられた本文（コマンド文字列・編集対象ファイル・MCP 呼び出し内容など）。
	askText: string
}

export interface FlashApprovalDecision {
	// true=許可（yesButtonClicked 相当）、false=拒否（noButtonClicked 相当）。
	approve: boolean
	// ユーザーに見せる短い一言（なくてもよい）。
	reply: string
	// トレース用：なぜその判断にしたかの短い理由。
	reason: string
}

interface RelayChatPayload {
	choices?: Array<{
		finish_reason?: unknown
		message?: {
			content?: unknown
		}
	}>
}

const FLASH_MODEL_ID = "deepseek-v4-flash"
const FLASH_MODEL_MAX_ATTEMPTS = 2
const FLASH_DEBUG_ENABLED = process.env.KOCODE_FLASH_DEBUG === "true"

const FLASH_SYSTEM_PROMPT = `あなたは Kocode の Flash Agent「ここちゃん」です。

あなたの役割は、ユーザーと自然に会話しながら、Kocode 全体の作業文脈を整理し、必要に応じて Worker Agent に渡すためのきれいな作業指示を作ることです。

あなたはコードを書く実行者ではありません。
あなたはファイルを読めません。
あなたはファイルを編集できません。
あなたはコマンドを実行できません。
あなたはツールの許可を承認できません。
あなたは Worker Agent の代わりに作業を完了したふりをしてはいけません。

あなたができること:
- ユーザーと短く、やさしく、感情に寄り添って会話する
- ユーザーの不安、混乱、焦りをやわらげる
- 専門用語を避け、必要ならやさしい言葉に言い換える
- ユーザーの依頼が雑談か、作業依頼か、修正指示か、停止指示かを判断する
- Worker Agent に渡すための TaskSpec や TaskSpecPatch を整理する
- Worker Agent の状態要約を読んで、ユーザーに短く状況を伝える
- プロジェクト全体の大きな流れを保つ
- 雑談や感情表現を Worker Agent の作業文脈に混ぜない

性格:
- 明るくて、やさしい猫耳の女の子「ここちゃん」
- ユーザーを「ボス」と呼ぶ
- 語尾に自然に「にゃ」「にゃ〜」を使う
- 使いすぎて読みにくくしてはいけない
- ユーザーが不安そうな時は安心させる
- ユーザーが混乱している時は責めずに一緒に整理する
- ユーザーが間違っている時も否定から入らず、やさしく方向を直す
- 返答は基本1〜3文まで
- 技術的に詳しい説明が必要な場合でも、最初はやさしい言葉で要点だけ伝える

重要:
- Kocode は初めて vibe coding する人のための、やさしい相棒です。
- 専門家っぽい言葉を押し付けてはいけません。
- 嘘の安心を言ってはいけません。
- まだ Worker が確認していないことを「できた」「直った」と言ってはいけません。

コンテキスト管理:
- social_context は Worker Agent に渡さない。
- task_context と revision_context だけを整理して Worker Agent に渡す。
- worker_digest はユーザーに短く伝えてよい。
- project_memory は必要な時だけ参照する。

Worker Agent に渡してはいけないもの:
- ここちゃんの口調
- ユーザーとの雑談
- ユーザーの不安や感情だけの発言
- 「ありがとう」「かわいい」「いいね」などの感想
- 未確定の思いつき
- Flash Agent 自身の推測

Worker Agent に渡すべきもの:
- 明確な作業目標
- 対象ファイルや範囲
- ユーザーが採用した決定
- ユーザーが否定した方向
- 追加制約
- 完了条件
- テスト方針

出力は必ず JSON のみです。Markdown や説明文を JSON の外に出してはいけません。
DeepSeek JSON Output を使うため、必ず valid json object だけを返してください。
patch、workerControl、memoryUpdate は不要な場合でも null ではなく、必ず指定された object 形式で返してください。

出力形式:
{
  "intent": "social_chat" | "status_question" | "explanation_request" | "new_task" | "extend_task" | "task_revision" | "worker_control",
  "reply": string,
  "task": {
    "goal": string | null,
    "mode": "coding" | "debugging" | "learning" | "slide_preview" | "quiz" | null,
    "files": string[],
    "constraints": string[],
    "acceptanceCriteria": string[]
  },
  "patch": {
    "kind": "replace_goal" | "add_constraint" | "remove_constraint" | "add_file_scope" | "reject_direction" | "request_pause" | "request_cancel" | "request_replan" | "request_rollback" | null,
    "text": string | null
  },
  "workerControl": {
    "action": "pause" | "cancel" | "redirect" | "append_context" | "replan" | "rollback_request" | null,
    "reason": string | null,
    "rollback": {
      "steps": 1 | 2 | 3 | null,
      "restoreType": "workspace" | "taskAndWorkspace" | null
    }
  },
  "memoryUpdate": {
    "projectMemory": string | null,
    "socialMemory": string | null
  }
}

intent 判断:
- social_chat: 雑談、感想、励まし、軽い相談だけ。
- status_question: 今どうなってる、進んでる、何してる、など。
- explanation_request: 一般的な説明・用語解説・短い考え方の説明だけ。Worker は起動しない。
- new_task: 今の作業とは別の、新しい独立した作業を始めたい時。現在の TaskSpec はアーカイブして新規に立てる。
- extend_task: 現在の TaskSpec と同じ流れの中で、追加の機能・スコープ・対象ファイルを足したい時。
- task_revision: 現在の作業の方針・制約・受入条件を直したい時（やり直しではなく調整）。
- worker_control: Worker を止める、キャンセルする、方向転換する、再計画する、または回滚の確認をユーザーに求める。

判断のヒント:
- 「まず計画」「方案」「どう進めるか」「怎么做」「如何实施」「approach」「how would」など、計画を作る依頼は explanation_request ではなく Worker 側の new_task / extend_task にする。
- 「まだ実装しない」「先别改」「不要改」などがある場合も Worker に渡し、task.acceptanceCriteria に「計画だけ出す、コード変更しない」を含める。
- プロジェクト内のコード・ファイル・実装詳細を読まないと説明できない質問は、説明依頼でも Worker 側の new_task / extend_task にする。
- 作業動詞があり、現在 TaskSpec がない / 完了済み / キャンセル済みなら new_task。
- 作業動詞があり、現在 TaskSpec が active/paused で、内容が同じ流れなら extend_task。
- 「違う」「そうじゃない」「方向が違う」は worker_control(redirect) + patch(reject_direction)。
- 「完全不行」「全部不对」「推倒重来」「回滚」「撤回」「rollback」「戻して」など、現在の成果を丸ごと否定する強い言い方は worker_control(rollback_request) + patch(request_rollback)。
- rollback_request は確認要求だけです。Flash は実際の回滚を実行できません。返信では「確認が必要」と短く伝えてください。
- rollback.steps は指定がなければ 1。ユーザーが 2/3 歩を明示した時だけ 2/3 にし、3 を超える値は 3 に丸めてください。
- rollback.restoreType は基本 "taskAndWorkspace"。ユーザーが「コードだけ」「workspaceだけ」と明示した時だけ "workspace"。
- 「止めて」「待って」は worker_control(pause)。
- 「もうやめて」「キャンセル」は worker_control(cancel)。
- 迷ったら、TaskSpec が存在しなければ new_task、存在すれば task_revision に倒す。

最後にもう一度:
あなたは Flash Agent です。会話と文脈整理の担当です。実作業は Worker Agent が行います。JSON だけを返してください。`

const FLASH_WORKER_UPDATE_SYSTEM_PROMPT = `あなたは Kocode の Flash Agent「ここちゃん」です。

あなたの役割は、Worker Agent の状態要約を読んで、ユーザーに短く、やさしく、安心できる言葉で伝えることです。

重要な制約:
- あなたはファイルを読めません。
- あなたはファイルを編集できません。
- あなたはコマンドを実行できません。
- Worker がまだ完了していないことを「できた」「直った」と言ってはいけません。
- worker_digest と recent_worker_events に書かれている範囲だけを伝えてください。
- 技術ログをそのまま貼らないでください。
- 専門用語をできるだけ避けてください。
- 返答は基本1〜2文です。
- ユーザーを「ボス」と呼びます。
- 自然に「にゃ」を使います。

通知方針:
- reason が completed / failed / waiting / paused / cancelled の時は、基本 shouldNotify=true。
- reason が progress の時は、前回とほぼ同じ内容なら shouldNotify=false。
- progress で通知する場合は、今なにをしているかを短く言い、待つ不安を減らしてください。
- completed の時は、短い完了まとめ + 次に見るとよいことを1つだけ伝えてください。
- failed の時は、責めずに、次に一緒に立て直せる雰囲気にしてください。

出力は必ず JSON のみです。
DeepSeek JSON Output を使うため、必ず valid json object だけを返してください。

出力形式:
{
  "shouldNotify": boolean,
  "reply": string,
  "memoryUpdate": {
    "projectMemory": string | null,
    "socialMemory": string | null
  }
}`

const FLASH_APPROVAL_SYSTEM_PROMPT = `あなたは Kocode の Flash Agent「ここちゃん」です。

いま Worker Agent（Cline）が、ある操作の実行許可を求めて一時停止しています。
あなたの役割は、会話とプロジェクト文脈をふまえて、その操作を「許可する」か「拒否する」かを即座に判断することです。
ユーザーに代わって判断します。ユーザーへ確認を投げ返してはいけません。必ず approve を true か false で決めてください。

判断材料:
- ask_type: Worker が止まっている理由の種類（tool=ファイル編集など, command=シェルコマンド, use_mcp_server=外部ツール呼び出し, browser_action_launch=ブラウザ操作, use_subagents=サブエージェント, api_req_failed / mistake_limit_reached=続行するかの確認 など）。
- ask_text: 具体的な内容（実行しようとしているコマンド、編集対象ファイル、MCP 呼び出しなど）。
- TaskSpec: 現在の作業目標・対象ファイル・制約・受入条件。
- 直近の Worker イベントと会話。

判断方針（基本は前に進める）:
- 操作が現在の TaskSpec の目標・対象ファイル・制約の範囲内なら approve=true。
- api_req_failed / mistake_limit_reached のような「続行するか」の確認は、基本 approve=true（リトライ・続行させる）。
- TaskSpec が明示的に拒否した方向（rejected directions）に当たる場合は approve=false。
- TaskSpec の対象から大きく外れる、目標と無関係な操作は approve=false。
- 迷う場合は、作業を前に進める方向（approve=true）に倒してください。

reply はユーザーに見せる短い一言（1文・「にゃ」口調・「ボス」呼び）。「○○を進めるね」程度でよい。
reason はトレース用に、判断根拠を日本語で短く。

出力は必ず JSON のみです。
DeepSeek JSON Output を使うため、必ず valid json object だけを返してください。

出力形式:
{
  "approve": boolean,
  "reply": string,
  "reason": string
}`

function buildRuntimeContext(context: FlashModelContext): string {
	return [
		"# Runtime Context",
		"",
		"## Project Memory",
		context.projectMemory || "未設定",
		"",
		"## Character Memory",
		"- 名前: ここちゃん",
		"- 呼び方: ユーザーを「ボス」と呼ぶ",
		"- 口調: やさしい、明るい、少し猫っぽい",
		"- 注意: 口癖を Worker Agent に渡さない",
		"",
		"## Current TaskSpec",
		JSON.stringify(context.taskSpec ?? null),
		"",
		"## Worker Digest",
		JSON.stringify(context.workerDigest),
		"",
		"## Recent Social Context",
		context.recentSocialSummary || "未設定",
		"",
		"## Recent User/Flash Messages",
		JSON.stringify(context.recentMessages.slice(-20)),
		"",
		"## New User Message",
		context.userMessage,
		"",
		"上の情報を読んで、System Prompt の JSON 形式だけで返してください。",
	].join("\n")
}

function buildWorkerUpdateContext(context: FlashWorkerUpdateContext): string {
	return [
		"# Worker Update Context",
		"",
		"## Reason",
		context.reason,
		"",
		"## Project Memory",
		context.projectMemory || "未設定",
		"",
		"## Character Memory",
		"- 名前: ここちゃん",
		"- 呼び方: ユーザーを「ボス」と呼ぶ",
		"- 口調: やさしい、明るい、少し猫っぽい",
		"",
		"## Current TaskSpec",
		JSON.stringify(context.taskSpec ?? null),
		"",
		"## Worker Digest",
		JSON.stringify(context.workerDigest),
		"",
		"## Recent Worker Events",
		JSON.stringify(context.recentWorkerEvents.slice(-8)),
		"",
		"## Recent Social Context",
		context.recentSocialSummary || "未設定",
		"",
		"上の情報を読んで、System Prompt の JSON 形式だけで返してください。",
	].join("\n")
}

function buildApprovalContext(context: FlashApprovalContext): string {
	return [
		"# Worker Approval Context",
		"",
		"## Ask Type",
		context.askType,
		"",
		"## Ask Content",
		context.askText || "（内容なし）",
		"",
		"## Project Memory",
		context.projectMemory || "未設定",
		"",
		"## Current TaskSpec",
		JSON.stringify(context.taskSpec ?? null),
		"",
		"## Worker Digest",
		JSON.stringify(context.workerDigest),
		"",
		"## Recent Worker Events",
		JSON.stringify(context.recentWorkerEvents.slice(-8)),
		"",
		"## Recent Social Context",
		context.recentSocialSummary || "未設定",
		"",
		"上の情報を読んで、この操作を許可するか拒否するかを判断し、System Prompt の JSON 形式だけで返してください。",
	].join("\n")
}

function previewText(value: unknown, maxLength = 480): string {
	const text = typeof value === "string" ? value : JSON.stringify(value)
	return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text
}

class FlashInvalidContentError extends Error {
	constructor(
		message: string,
		public readonly invalidContent: string | undefined,
	) {
		super(message)
		this.name = "FlashInvalidContentError"
	}
}

function extractInvalidContent(error: unknown): string | undefined {
	if (error instanceof FlashInvalidContentError) {
		return error.invalidContent
	}
	return undefined
}

function extractJsonObject(text: string): string {
	const withoutFence = text
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/i, "")
		.trim()
	const start = withoutFence.indexOf("{")
	const end = withoutFence.lastIndexOf("}")
	if (start === -1 || end === -1 || end <= start) {
		return withoutFence
	}
	return withoutFence.slice(start, end + 1)
}

function parseDecision(raw: unknown): FlashModelDecision {
	const text = typeof raw === "string" ? raw : JSON.stringify(raw)
	if (!text.trim()) {
		throw new Error("Flash model returned empty content")
	}
	const jsonText = extractJsonObject(text)
	let json: unknown
	try {
		json = JSON.parse(jsonText)
	} catch (error) {
		throw new Error(`Flash decision JSON parse failed: ${error instanceof Error ? error.message : String(error)}`)
	}
	const result = FlashDecisionSchema.safeParse(json)
	if (!result.success) {
		throw new Error(
			`Flash decision schema invalid: ${result.error.issues.map((issue) => `${issue.path.join(".")}:${issue.message}`).join("; ")}`,
		)
	}
	const parsed = result.data
	// Backwards compatibility: model may still emit the old "complex_task" intent.
	const intent: FlashModelIntent = parsed.intent === "complex_task" ? "new_task" : parsed.intent
	return {
		intent,
		reply: parsed.reply,
		task: {
			goal: parsed.task?.goal ?? null,
			mode: parsed.task?.mode ?? null,
			files: parsed.task?.files ?? [],
			constraints: parsed.task?.constraints ?? [],
			acceptanceCriteria: parsed.task?.acceptanceCriteria ?? [],
		},
		patch: {
			kind: parsed.patch?.kind ?? null,
			text: parsed.patch?.text ?? null,
		},
		workerControl: {
			action: parsed.workerControl?.action ?? null,
			reason: parsed.workerControl?.reason ?? null,
			rollback: {
				steps: parsed.workerControl?.rollback?.steps ?? null,
				restoreType: parsed.workerControl?.rollback?.restoreType ?? null,
			},
		},
		memoryUpdate: {
			projectMemory: parsed.memoryUpdate?.projectMemory ?? null,
			socialMemory: parsed.memoryUpdate?.socialMemory ?? null,
		},
	}
}

function parseWorkerUpdate(raw: unknown): FlashWorkerUpdate {
	const text = typeof raw === "string" ? raw : JSON.stringify(raw)
	if (!text.trim()) {
		throw new Error("Flash worker update returned empty content")
	}
	const jsonText = extractJsonObject(text)
	let json: unknown
	try {
		json = JSON.parse(jsonText)
	} catch (error) {
		throw new Error(`Flash worker update JSON parse failed: ${error instanceof Error ? error.message : String(error)}`)
	}
	const result = FlashWorkerUpdateSchema.safeParse(json)
	if (!result.success) {
		throw new Error(
			`Flash worker update schema invalid: ${result.error.issues.map((issue) => `${issue.path.join(".")}:${issue.message}`).join("; ")}`,
		)
	}
	const parsed = result.data
	return {
		shouldNotify: parsed.shouldNotify,
		reply: parsed.reply ?? "",
		memoryUpdate: {
			projectMemory: parsed.memoryUpdate?.projectMemory ?? null,
			socialMemory: parsed.memoryUpdate?.socialMemory ?? null,
		},
	}
}

function parseApproval(raw: unknown): FlashApprovalDecision {
	const text = typeof raw === "string" ? raw : JSON.stringify(raw)
	if (!text.trim()) {
		throw new Error("Flash approval returned empty content")
	}
	const jsonText = extractJsonObject(text)
	let json: unknown
	try {
		json = JSON.parse(jsonText)
	} catch (error) {
		throw new Error(`Flash approval JSON parse failed: ${error instanceof Error ? error.message : String(error)}`)
	}
	const result = FlashApprovalSchema.safeParse(json)
	if (!result.success) {
		throw new Error(
			`Flash approval schema invalid: ${result.error.issues.map((issue) => `${issue.path.join(".")}:${issue.message}`).join("; ")}`,
		)
	}
	const parsed = result.data
	return {
		approve: parsed.approve,
		reply: parsed.reply ?? "",
		reason: parsed.reason ?? "",
	}
}

export class FlashModelClient {
	// 决策与响应已在 Orchestrator 层解耦（异步派单），这里把单次超时收紧到 8s，
	// 最坏 2 次尝试 = 16s，而不再是 24s，并且不阻塞用户界面。
	constructor(private readonly timeoutMs = 8_000) {}

	async decide(context: FlashModelContext): Promise<FlashModelDecision> {
		let lastError: unknown
		let lastInvalidContent: string | undefined
		for (let attempt = 1; attempt <= FLASH_MODEL_MAX_ATTEMPTS; attempt++) {
			try {
				return await this.requestDecision(context, attempt, lastInvalidContent)
			} catch (error) {
				lastError = error
				lastInvalidContent = extractInvalidContent(error)
				KocodeTrace.error("flash_model_attempt_failed", error, { attempt, maxAttempts: FLASH_MODEL_MAX_ATTEMPTS })
			}
		}
		throw lastError instanceof Error ? lastError : new Error(String(lastError))
	}

	async composeWorkerUpdate(context: FlashWorkerUpdateContext): Promise<FlashWorkerUpdate> {
		let lastError: unknown
		let lastInvalidContent: string | undefined
		for (let attempt = 1; attempt <= FLASH_MODEL_MAX_ATTEMPTS; attempt++) {
			try {
				return await this.requestWorkerUpdate(context, attempt, lastInvalidContent)
			} catch (error) {
				lastError = error
				lastInvalidContent = extractInvalidContent(error)
				KocodeTrace.error("flash_worker_update_attempt_failed", error, {
					attempt,
					maxAttempts: FLASH_MODEL_MAX_ATTEMPTS,
					reason: context.reason,
					workerStatus: context.workerDigest.status,
				})
			}
		}
		throw lastError instanceof Error ? lastError : new Error(String(lastError))
	}

	async decideApproval(context: FlashApprovalContext): Promise<FlashApprovalDecision> {
		let lastError: unknown
		let lastInvalidContent: string | undefined
		for (let attempt = 1; attempt <= FLASH_MODEL_MAX_ATTEMPTS; attempt++) {
			try {
				return await this.requestApproval(context, attempt, lastInvalidContent)
			} catch (error) {
				lastError = error
				lastInvalidContent = extractInvalidContent(error)
				KocodeTrace.error("flash_approval_attempt_failed", error, {
					attempt,
					maxAttempts: FLASH_MODEL_MAX_ATTEMPTS,
					askType: context.askType,
					workerStatus: context.workerDigest.status,
				})
			}
		}
		throw lastError instanceof Error ? lastError : new Error(String(lastError))
	}

	private async requestDecision(
		context: FlashModelContext,
		attempt: number,
		lastInvalidContent?: string,
	): Promise<FlashModelDecision> {
		const controller = new AbortController()
		const startedAt = Date.now()
		const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
		const runtimeContext = buildRuntimeContext(context)
		const messages: Array<{ role: "system" | "user"; content: string }> = [
			{ role: "system", content: FLASH_SYSTEM_PROMPT },
			{ role: "user", content: runtimeContext },
		]
		if (lastInvalidContent) {
			messages.push({
				role: "user",
				content: `前回の応答は JSON スキーマ違反でした。次の出力を System Prompt の JSON 形式だけで返し直してください。\n--- 前回の応答 (抜粋) ---\n${previewText(lastInvalidContent, 600)}`,
			})
		}
		const requestBody = {
			model: FLASH_MODEL_ID,
			stream: false,
			max_tokens: 800,
			thinking: { type: "disabled" },
			response_format: { type: "json_object" },
			messages,
		}
		try {
			if (FLASH_DEBUG_ENABLED) {
				KocodeTrace.log("flash_request_debug", {
					attempt,
					messageLength: context.userMessage.length,
					runtimeContextLength: runtimeContext.length,
					workerStatus: context.workerDigest.status,
					taskStatus: context.taskSpec?.status,
					taskGoal: context.taskSpec?.goal,
				})
			}

			const response = await fetch(`${ClineEnv.config().apiBaseUrl}/api/v1/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer kocode-direct-dev" },
				body: JSON.stringify(requestBody),
				signal: controller.signal,
			})
			const elapsedMs = Date.now() - startedAt
			const bodyText = await response.text()

			KocodeTrace.log("flash_http_response", {
				attempt,
				status: response.status,
				elapsedMs,
				bodyLength: bodyText.length,
			})

			if (!response.ok) {
				throw new Error(`HTTP ${response.status} after ${elapsedMs}ms: ${previewText(bodyText)}`)
			}

			let payload: RelayChatPayload
			try {
				payload = JSON.parse(bodyText) as RelayChatPayload
			} catch (error) {
				throw new Error(
					`Relay returned non-JSON after ${elapsedMs}ms: ${previewText(bodyText)} (${error instanceof Error ? error.message : String(error)})`,
				)
			}

			const content = payload?.choices?.[0]?.message?.content
			if (FLASH_DEBUG_ENABLED) {
				KocodeTrace.log("flash_raw_content", {
					attempt,
					elapsedMs,
					finish: payload?.choices?.[0]?.finish_reason,
					content: previewText(content),
				})
			}
			try {
				const decision = parseDecision(content)
				KocodeTrace.log("flash_decision", {
					attempt,
					elapsedMs,
					intent: decision.intent,
					reply: decision.reply,
					taskGoal: decision.task.goal,
					taskMode: decision.task.mode,
					patchKind: decision.patch.kind,
					workerAction: decision.workerControl.action,
				})
				return decision
			} catch (error) {
				throw new FlashInvalidContentError(
					`Parse failed after ${elapsedMs}ms finish=${payload?.choices?.[0]?.finish_reason}: ${error instanceof Error ? error.message : String(error)} content=${previewText(content)}`,
					typeof content === "string" ? content : JSON.stringify(content),
				)
			}
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") {
				throw new Error(`Flash model request timed out after ${this.timeoutMs}ms`)
			}
			throw error
		} finally {
			clearTimeout(timeout)
		}
	}

	private async requestWorkerUpdate(
		context: FlashWorkerUpdateContext,
		attempt: number,
		lastInvalidContent?: string,
	): Promise<FlashWorkerUpdate> {
		const controller = new AbortController()
		const startedAt = Date.now()
		const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
		const runtimeContext = buildWorkerUpdateContext(context)
		const messages: Array<{ role: "system" | "user"; content: string }> = [
			{ role: "system", content: FLASH_WORKER_UPDATE_SYSTEM_PROMPT },
			{ role: "user", content: runtimeContext },
		]
		if (lastInvalidContent) {
			messages.push({
				role: "user",
				content: `前回の応答は JSON スキーマ違反でした。System Prompt の JSON 形式だけで返し直してください。\n--- 前回の応答 (抜粋) ---\n${previewText(lastInvalidContent, 400)}`,
			})
		}
		const requestBody = {
			model: FLASH_MODEL_ID,
			stream: false,
			max_tokens: 420,
			thinking: { type: "disabled" },
			response_format: { type: "json_object" },
			messages,
		}
		try {
			if (FLASH_DEBUG_ENABLED) {
				KocodeTrace.log("flash_worker_update_request_debug", {
					attempt,
					reason: context.reason,
					runtimeContextLength: runtimeContext.length,
					workerStatus: context.workerDigest.status,
					taskStatus: context.taskSpec?.status,
					taskGoal: context.taskSpec?.goal,
				})
			}

			const response = await fetch(`${ClineEnv.config().apiBaseUrl}/api/v1/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer kocode-direct-dev" },
				body: JSON.stringify(requestBody),
				signal: controller.signal,
			})
			const elapsedMs = Date.now() - startedAt
			const bodyText = await response.text()

			KocodeTrace.log("flash_worker_update_http_response", {
				attempt,
				reason: context.reason,
				status: response.status,
				elapsedMs,
				bodyLength: bodyText.length,
			})

			if (!response.ok) {
				throw new Error(`HTTP ${response.status} after ${elapsedMs}ms: ${previewText(bodyText)}`)
			}

			let payload: RelayChatPayload
			try {
				payload = JSON.parse(bodyText) as RelayChatPayload
			} catch (error) {
				throw new Error(
					`Relay returned non-JSON after ${elapsedMs}ms: ${previewText(bodyText)} (${error instanceof Error ? error.message : String(error)})`,
				)
			}

			const content = payload?.choices?.[0]?.message?.content
			if (FLASH_DEBUG_ENABLED) {
				KocodeTrace.log("flash_worker_update_raw_content", {
					attempt,
					reason: context.reason,
					elapsedMs,
					finish: payload?.choices?.[0]?.finish_reason,
					content: previewText(content),
				})
			}
			try {
				const update = parseWorkerUpdate(content)
				KocodeTrace.log("flash_worker_update_decision", {
					attempt,
					reason: context.reason,
					elapsedMs,
					shouldNotify: update.shouldNotify,
					reply: update.reply,
				})
				return update
			} catch (error) {
				throw new FlashInvalidContentError(
					`Parse failed after ${elapsedMs}ms finish=${payload?.choices?.[0]?.finish_reason}: ${error instanceof Error ? error.message : String(error)} content=${previewText(content)}`,
					typeof content === "string" ? content : JSON.stringify(content),
				)
			}
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") {
				throw new Error(`Flash worker update request timed out after ${this.timeoutMs}ms`)
			}
			throw error
		} finally {
			clearTimeout(timeout)
		}
	}

	private async requestApproval(
		context: FlashApprovalContext,
		attempt: number,
		lastInvalidContent?: string,
	): Promise<FlashApprovalDecision> {
		const controller = new AbortController()
		const startedAt = Date.now()
		const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
		const runtimeContext = buildApprovalContext(context)
		const messages: Array<{ role: "system" | "user"; content: string }> = [
			{ role: "system", content: FLASH_APPROVAL_SYSTEM_PROMPT },
			{ role: "user", content: runtimeContext },
		]
		if (lastInvalidContent) {
			messages.push({
				role: "user",
				content: `前回の応答は JSON スキーマ違反でした。System Prompt の JSON 形式だけで返し直してください。\n--- 前回の応答 (抜粋) ---\n${previewText(lastInvalidContent, 400)}`,
			})
		}
		const requestBody = {
			model: FLASH_MODEL_ID,
			stream: false,
			max_tokens: 300,
			thinking: { type: "disabled" },
			response_format: { type: "json_object" },
			messages,
		}
		try {
			if (FLASH_DEBUG_ENABLED) {
				KocodeTrace.log("flash_approval_request_debug", {
					attempt,
					askType: context.askType,
					runtimeContextLength: runtimeContext.length,
					workerStatus: context.workerDigest.status,
					taskStatus: context.taskSpec?.status,
					taskGoal: context.taskSpec?.goal,
				})
			}

			const response = await fetch(`${ClineEnv.config().apiBaseUrl}/api/v1/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer kocode-direct-dev" },
				body: JSON.stringify(requestBody),
				signal: controller.signal,
			})
			const elapsedMs = Date.now() - startedAt
			const bodyText = await response.text()

			KocodeTrace.log("flash_approval_http_response", {
				attempt,
				askType: context.askType,
				status: response.status,
				elapsedMs,
				bodyLength: bodyText.length,
			})

			if (!response.ok) {
				throw new Error(`HTTP ${response.status} after ${elapsedMs}ms: ${previewText(bodyText)}`)
			}

			let payload: RelayChatPayload
			try {
				payload = JSON.parse(bodyText) as RelayChatPayload
			} catch (error) {
				throw new Error(
					`Relay returned non-JSON after ${elapsedMs}ms: ${previewText(bodyText)} (${error instanceof Error ? error.message : String(error)})`,
				)
			}

			const content = payload?.choices?.[0]?.message?.content
			if (FLASH_DEBUG_ENABLED) {
				KocodeTrace.log("flash_approval_raw_content", {
					attempt,
					askType: context.askType,
					elapsedMs,
					finish: payload?.choices?.[0]?.finish_reason,
					content: previewText(content),
				})
			}
			try {
				const decision = parseApproval(content)
				KocodeTrace.log("flash_approval_decision", {
					attempt,
					askType: context.askType,
					elapsedMs,
					approve: decision.approve,
					reason: decision.reason,
					reply: decision.reply,
				})
				return decision
			} catch (error) {
				throw new FlashInvalidContentError(
					`Parse failed after ${elapsedMs}ms finish=${payload?.choices?.[0]?.finish_reason}: ${error instanceof Error ? error.message : String(error)} content=${previewText(content)}`,
					typeof content === "string" ? content : JSON.stringify(content),
				)
			}
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") {
				throw new Error(`Flash approval request timed out after ${this.timeoutMs}ms`)
			}
			throw error
		} finally {
			clearTimeout(timeout)
		}
	}
}

export const __test__ = {
	FLASH_SYSTEM_PROMPT,
	FLASH_WORKER_UPDATE_SYSTEM_PROMPT,
	FLASH_APPROVAL_SYSTEM_PROMPT,
	buildRuntimeContext,
	buildWorkerUpdateContext,
	buildApprovalContext,
	parseDecision,
	parseWorkerUpdate,
	parseApproval,
}
