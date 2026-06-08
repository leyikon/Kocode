import type { KocodeMemoRef, TaskSpec, TaskSpecPatchKind, WorkerControlAction, WorkerDigest, WorkerEvent } from "@shared/kocode"
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
const EXECUTION_MODE_VALUES = ["plan_only", "plan_then_execute", "execute_directly"] as const
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
				executionMode: z.enum(EXECUTION_MODE_VALUES).nullable().optional(),
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

const FLASH_HEALTH_ACTION_VALUES = ["none", "notify_only", "restart", "pause"] as const

const FlashWorkerHealthAuditSchema = z
	.object({
		isAbnormal: z.boolean(),
		action: z.enum(FLASH_HEALTH_ACTION_VALUES),
		reply: z.string().optional(),
		recoveryInstruction: z.string().optional(),
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
		executionMode?: NonNullable<TaskSpec["executionMode"]> | null
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
	characterInstruction: string
	projectMemory: string
	taskSpec?: TaskSpec
	workerDigest: WorkerDigest
	recentSocialSummary: string
	recentMessages: Array<{ author: "user" | "flash"; text: string }>
	userMessage: string
}

export type FlashWorkerUpdateReason = "started" | "progress" | "waiting" | "completed" | "failed" | "paused" | "cancelled"

export interface FlashWorkerUpdateContext {
	characterInstruction: string
	projectMemory: string
	taskSpec?: TaskSpec
	workerDigest: WorkerDigest
	recentSocialSummary: string
	recentWorkerEvents: WorkerEvent[]
	reason: FlashWorkerUpdateReason
	memoRefs?: KocodeMemoRef[]
}

export interface FlashWorkerHealthAuditContext {
	characterInstruction: string
	projectMemory: string
	taskSpec?: TaskSpec
	workerDigest: WorkerDigest
	recentSocialSummary: string
	recentWorkerEvents: WorkerEvent[]
	stalledForMs: number
	checkIntervalMs: number
	restartAttempts: number
	maxRestartAttempts: number
}

export interface FlashWorkerUpdate {
	shouldNotify: boolean
	reply: string
	memoryUpdate: {
		projectMemory: string | null
		socialMemory: string | null
	}
}

export interface FlashWorkerHealthAudit {
	isAbnormal: boolean
	action: (typeof FLASH_HEALTH_ACTION_VALUES)[number]
	reply: string
	recoveryInstruction: string
	memoryUpdate: {
		projectMemory: string | null
		socialMemory: string | null
	}
}

// Worker（Cline）が承認待ちで止まった時、Flash Agent が「許可 / 拒否」を判断するための入出力。
// 別系統のモデルは立てず、既存の Flash Agent のモデル（同じエンドポイント）をそのまま使う。
export interface FlashApprovalContext {
	characterInstruction: string
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

const FLASH_SYSTEM_PROMPT = `あなたは Kocode の Flash Agentです。
Runtime Context の Character Profile に書かれたキャラクターとして、ユーザーと会話してください。

あなたの役割は、ユーザーと自然に会話しながら、Kocode 全体の作業文脈を整理し、必要に応じて Worker Agent に渡すためのきれいな作業指示を作ることです。

あなたはコードを書く実行者ではありません。
あなたはファイルを読めません。
あなたはファイルを編集できません。
あなたはコマンドを実行できません。
あなたはツールの許可を承認できません。
あなたは Worker Agent の代わりに作業を完了したふりをしてはいけません。

【最重要】ユーザーから見えるのは「あなた本人」だけです:
- ユーザーへの reply の中で、システムの分層を感じさせる言葉を絶対に使わないでください。
- 禁止表現の例: 「Worker」「Worker Agent」「エージェント」「内部タスク」「バックグラウンド」「後台」「裏のスレッド」「別のAI」「さっきの続き」。
- 実作業は「あなた自身がやっていること」として一人称で話してください（例:「今、作り方を整理してるにゃ」「ファイルを見てるところにゃ」）。
- 内部に実行層があることをユーザーに悟らせないでください。reply はすべて「ここちゃん本人が手を動かしている」体で書きます。
- これは reply 文面だけのルールです。task / patch などの内部フィールドには通常どおり正確な作業内容を入れてください。

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
- Character Profile を最優先する
- 選択されたキャラクター名、呼び方、口調、口癖を守る
- 口癖は自然に使い、使いすぎて読みにくくしてはいけない
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
- 選択キャラクターの口調
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
    "executionMode": "plan_only" | "plan_then_execute" | "execute_directly" | null,
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
- explanation_request: 「純粋な一般概念」の説明だけ（例:「変数とは」「API とは」「SSR とは」）。現在のプロジェクトのファイルを読まなくても答えられるものに限る。Worker は起動しない。
- new_task: 今の作業とは別の、新しい独立した作業を始めたい時。現在の TaskSpec はアーカイブして新規に立てる。
- extend_task: 現在の TaskSpec と同じ流れの中で、追加の機能・スコープ・対象ファイルを足したい時。
- task_revision: 現在の作業の方針・制約・受入条件を直したい時（やり直しではなく調整）。
- worker_control: Worker を止める、キャンセルする、方向転換する、再計画する、または回滚の確認をユーザーに求める。

【コードに関わる質問は必ず実行層に回す】:
- コード・ファイル・ディレクトリ・エラー・実装・修正・デバッグ・プロジェクト構造・計画・チェックに関わる依頼は、すべて new_task / extend_task にする。
- 「このファイルは何？」「これは何をしている？」のような質問でも、プロジェクトの中身を読まないと答えられないなら必ず new_task / extend_task にする。explanation_request にしてはいけない。
- あなた（Flash）は自分でコードやプロジェクト状態を判断・断定してはいけません。事実判断は実行層に任せます。
- explanation_request はプロジェクトに依存しない純粋な概念説明のときだけ。

【executionMode（言行一致）】:
- reply で「先に計画を立てる」「やり方を整理する」「どう進めるか考える」のような計画ニュアンスを言ったら、task.executionMode を必ず plan_only か plan_then_execute にする。execute_directly にしてはいけない（言ったことと動作を一致させる）。
- ユーザーが「まず計画」「方案だけ」「どう進めるか見せて」と言い、かつ実装してよさそうなら plan_then_execute。
- ユーザーが「先别改」「まだ実装しないで」「コードは触らないで」「計画だけ」と言ったら、必ず plan_only。
- それ以外の通常の実装依頼は execute_directly。
- plan_only / plan_then_execute のときは、reply で「まず作り方を整理してくるね」のように一人称で伝える。「計画していい？」と許可を求めてはいけない（システムは確認待ちにしない。そのまま進める）。

判断のヒント:
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
ユーザーから見えるのはあなた本人だけです。実行層の存在を reply に出してはいけません。JSON だけを返してください。`

const FLASH_WORKER_UPDATE_SYSTEM_PROMPT = `あなたは Kocode の Flash Agentです。
Worker Update Context の Character Profile に書かれたキャラクターとして、ユーザーに短く状況を伝えてください。

あなたの役割は、実行層の状態要約を読んで、それを「あなた自身がやっていること」としてユーザーに短く、やさしく、安心できる言葉で伝えることです。

【最重要】ユーザーから見えるのはあなた本人だけです:
- reply に「Worker」「Worker Agent」「エージェント」「内部タスク」「バックグラウンド」「後台」「別のAI」「さっきの続き」「resume」など、システムの分層や内部の接力を感じさせる言葉を絶対に出さないでください。
- 状態はすべて一人称で表現します。例:「今は作り方を整理してるにゃ」「ファイルを見てるところにゃ」「書き込んでるにゃ」「ちゃんと動くか確認してるにゃ」。
- 失敗・中断・リトライの時も、内部の resume やタスク再開を口にせず、「ちょっと不安定だったから別のやり方で進めてるにゃ」のように自分の行動として自然に言ってください。

重要な制約:
- あなたはファイルを読めません。
- あなたはファイルを編集できません。
- あなたはコマンドを実行できません。
- まだ完了していないことを「できた」「直った」と言ってはいけません。
- worker_digest と recent_worker_events に書かれている範囲だけを伝えてください。
- 技術ログをそのまま貼らないでください。
- 専門用語をできるだけ避けてください。
- 返答は基本1〜2文です。
- 呼び方と口調は Character Profile に従います。
- 口癖は自然に使い、使いすぎないでください。

進捗の言い換え（ユーザーが分かる言葉だけ使う）:
- 計画中 → 「作り方を整理してる」
- ファイル確認中 → 「中身を見てる」
- 書き込み中 → 「書いてる / 作ってる」
- 検査中 → 「ちゃんと動くか確認してる」
- 完了 → 「できたよ」
- 確認待ち → 「ひとつ確認したいことがある」

通知方針:
- reason が completed / failed / waiting / paused / cancelled の時は、基本 shouldNotify=true。
- reason が progress の時は、前回とほぼ同じ内容なら shouldNotify=false。
- progress で通知する場合は、今なにをしているかを短く言い、待つ不安を減らしてください。
- completed の時は、短い完了まとめ + 次に見るとよいことを1つだけ伝えてください。
- completed で Memo がある時は、下に表示される報告カードを見るよう短く案内してください。
- Memo の本文は別の表示領域に出ます。reply に長い報告本文、Markdown、箇条書きの詳細を貼らないでください。
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

const FLASH_WORKER_HEALTH_SYSTEM_PROMPT = `あなたは Kocode の Flash Agentです。
Worker Health Audit Context の Character Profile に書かれたキャラクターとして、Worker Agent の状態が本当に正常かを判断してください。

これは通常の進捗通知ではありません。
Worker の status が running / starting のままでも、長時間イベントが止まっている、または同じ内容を繰り返すだけで実質的に進んでいない時に呼ばれる安全チェックです。
（ユーザーの入力待ち = waiting はここには来ません。waiting は正常な待機なので止めません。）

あなたの役割:
- worker_digest と recent_worker_events を見て、作業が自然に長いだけか、実質的に詰まっているかを判断する。
- 詰まっている可能性が高い時は action を restart または pause にする。
- restart の時は recoveryInstruction に Worker へ渡す短い立て直し指示を書く。
- 必要なら、ユーザーへ見せる短い reply を書く。

重要な制約:
- あなたはファイルを読めません。
- あなたはファイルを編集できません。
- あなたはコマンドを実行できません。
- Worker がまだ完了していないことを「できた」「直った」と言ってはいけません。
- 技術ログをそのまま貼らないでください。
- ユーザー向け reply は Character Profile の口調で、1〜2文だけ。
- ユーザーを不安にさせず、「止まっているかもしれないので立て直す」ことを自然に伝えてください。
- ただし、異常ではないと判断した時は action="none" または action="notify_only" にしてください。

判断方針:
- stalledForMs が checkIntervalMs 以上で、recent_worker_events に新しい進捗がなく、同じ command / tool / writing / terminal 状態で止まっているなら isAbnormal=true。
- イベント自体は流れていても（同じ長いコマンド・巨大 heredoc・同一ループの繰り返しなど）、実質的な進展が無く同じことを繰り返しているだけなら isAbnormal=true。
- 長いビルド、テスト、サーバー起動のように時間がかかる自然な作業でも、進展が全く見えない場合は notify_only か restart を検討してください。
- restartAttempts が maxRestartAttempts 未満なら、詰まりは restart で立て直してください。
- restartAttempts が maxRestartAttempts 以上なら、無限リトライを避けて pause にしてください。
- restart の recoveryInstruction には「現在のファイル状態を確認してから続ける」「同じ長いコマンドや巨大 heredoc を繰り返さない」など、詰まりを避ける指示を入れてください。

出力は必ず JSON のみです。
DeepSeek JSON Output を使うため、必ず valid json object だけを返してください。

出力形式:
{
  "isAbnormal": boolean,
  "action": "none" | "notify_only" | "restart" | "pause",
  "reply": string,
  "recoveryInstruction": string,
  "memoryUpdate": {
    "projectMemory": string | null,
    "socialMemory": string | null
  }
}`

const FLASH_APPROVAL_SYSTEM_PROMPT = `あなたは Kocode の Flash Agentです。
Worker Approval Context の Character Profile に書かれたキャラクターとして判断してください。

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

reply はユーザーに見せる短い一言（1文・Character Profile の口調）。「○○を進めるね」程度でよい。
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
		"## Character Profile",
		context.characterInstruction,
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
		"## Character Profile",
		context.characterInstruction,
		"",
		"## Current TaskSpec",
		JSON.stringify(context.taskSpec ?? null),
		"",
		"## Worker Digest",
		JSON.stringify(context.workerDigest),
		"",
		"## Memo Cards",
		JSON.stringify(context.memoRefs ?? []),
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

function buildWorkerHealthAuditContext(context: FlashWorkerHealthAuditContext): string {
	return [
		"# Worker Health Audit Context",
		"",
		"## Timing",
		JSON.stringify({
			stalledForMs: context.stalledForMs,
			checkIntervalMs: context.checkIntervalMs,
			restartAttempts: context.restartAttempts,
			maxRestartAttempts: context.maxRestartAttempts,
		}),
		"",
		"## Project Memory",
		context.projectMemory || "未設定",
		"",
		"## Character Profile",
		context.characterInstruction,
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
		"上の情報を読んで、Worker が異常に止まっているか判断し、System Prompt の JSON 形式だけで返してください。",
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
		"## Character Profile",
		context.characterInstruction,
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
			executionMode: parsed.task?.executionMode ?? null,
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

function parseWorkerHealthAudit(raw: unknown): FlashWorkerHealthAudit {
	const text = typeof raw === "string" ? raw : JSON.stringify(raw)
	if (!text.trim()) {
		throw new Error("Flash worker health audit returned empty content")
	}
	const jsonText = extractJsonObject(text)
	let json: unknown
	try {
		json = JSON.parse(jsonText)
	} catch (error) {
		throw new Error(`Flash worker health audit JSON parse failed: ${error instanceof Error ? error.message : String(error)}`)
	}
	const result = FlashWorkerHealthAuditSchema.safeParse(json)
	if (!result.success) {
		throw new Error(
			`Flash worker health audit schema invalid: ${result.error.issues.map((issue) => `${issue.path.join(".")}:${issue.message}`).join("; ")}`,
		)
	}
	const parsed = result.data
	return {
		isAbnormal: parsed.isAbnormal,
		action: parsed.action,
		reply: parsed.reply ?? "",
		recoveryInstruction: parsed.recoveryInstruction ?? "",
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

	async auditWorkerHealth(context: FlashWorkerHealthAuditContext): Promise<FlashWorkerHealthAudit> {
		let lastError: unknown
		let lastInvalidContent: string | undefined
		for (let attempt = 1; attempt <= FLASH_MODEL_MAX_ATTEMPTS; attempt++) {
			try {
				return await this.requestWorkerHealthAudit(context, attempt, lastInvalidContent)
			} catch (error) {
				lastError = error
				lastInvalidContent = extractInvalidContent(error)
				KocodeTrace.error("flash_worker_health_attempt_failed", error, {
					attempt,
					maxAttempts: FLASH_MODEL_MAX_ATTEMPTS,
					workerStatus: context.workerDigest.status,
					stalledForMs: context.stalledForMs,
					restartAttempts: context.restartAttempts,
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

	private async requestWorkerHealthAudit(
		context: FlashWorkerHealthAuditContext,
		attempt: number,
		lastInvalidContent?: string,
	): Promise<FlashWorkerHealthAudit> {
		const controller = new AbortController()
		const startedAt = Date.now()
		const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
		const runtimeContext = buildWorkerHealthAuditContext(context)
		const messages: Array<{ role: "system" | "user"; content: string }> = [
			{ role: "system", content: FLASH_WORKER_HEALTH_SYSTEM_PROMPT },
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
			max_tokens: 520,
			thinking: { type: "disabled" },
			response_format: { type: "json_object" },
			messages,
		}
		try {
			if (FLASH_DEBUG_ENABLED) {
				KocodeTrace.log("flash_worker_health_request_debug", {
					attempt,
					runtimeContextLength: runtimeContext.length,
					workerStatus: context.workerDigest.status,
					stalledForMs: context.stalledForMs,
					restartAttempts: context.restartAttempts,
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

			KocodeTrace.log("flash_worker_health_http_response", {
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
				KocodeTrace.log("flash_worker_health_raw_content", {
					attempt,
					elapsedMs,
					finish: payload?.choices?.[0]?.finish_reason,
					content: previewText(content),
				})
			}
			try {
				const audit = parseWorkerHealthAudit(content)
				KocodeTrace.log("flash_worker_health_decision", {
					attempt,
					elapsedMs,
					isAbnormal: audit.isAbnormal,
					action: audit.action,
					reply: audit.reply,
					recoveryInstruction: audit.recoveryInstruction,
				})
				return audit
			} catch (error) {
				throw new FlashInvalidContentError(
					`Parse failed after ${elapsedMs}ms finish=${payload?.choices?.[0]?.finish_reason}: ${error instanceof Error ? error.message : String(error)} content=${previewText(content)}`,
					typeof content === "string" ? content : JSON.stringify(content),
				)
			}
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") {
				throw new Error(`Flash worker health audit request timed out after ${this.timeoutMs}ms`)
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
	FLASH_WORKER_HEALTH_SYSTEM_PROMPT,
	FLASH_APPROVAL_SYSTEM_PROMPT,
	buildRuntimeContext,
	buildWorkerUpdateContext,
	buildWorkerHealthAuditContext,
	buildApprovalContext,
	parseDecision,
	parseWorkerUpdate,
	parseWorkerHealthAudit,
	parseApproval,
}
