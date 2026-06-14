import type { KocodeCharacterId, KocodeChatMessage, KocodeEvent, KocodeMemoRef, KocodeSurveyQuestion } from "@shared/kocode"
import { BooleanRequest, EmptyRequest } from "@shared/proto/cline/common"
import {
	BookOpenIcon,
	CheckIcon,
	ChevronLeftIcon,
	ClipboardListIcon,
	FileTextIcon,
	MenuIcon,
	PlusIcon,
	SendIcon,
	SettingsIcon,
} from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { useMount } from "react-use"
import { Virtuoso } from "react-virtuoso"
import himeAvatar from "@/assets/kocode/hime-avatar.png"
import kokoAvatar from "@/assets/kocode/koko-avatar.png"
import manaAvatar from "@/assets/kocode/mana-avatar.png"
import {
	CHAT_CONSTANTS,
	ChatLayout,
	InputSection,
	useChatState,
	useMessageHandlers,
	useScrollBehavior,
} from "@/components/chat/chat-view"
import { MarkdownRow } from "@/components/chat/MarkdownRow"
import { normalizeApiConfiguration } from "@/components/settings/utils/providerUtils"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { FileServiceClient, UiServiceClient } from "@/services/grpc-client"
import { KocodeServiceClient } from "@/services/kocode-client"
import "./KocodeChatView.css"

interface KocodeChatViewProps {
	isHidden: boolean
}

const MAX_ATTACHMENTS = CHAT_CONSTANTS.MAX_IMAGES_AND_FILES_PER_MESSAGE

type KocodeCharacter = {
	id: KocodeCharacterId
	name: string
	label: string
	status: string
	tag: string
	avatar: string
	themeClass: string
	welcome: string
	placeholder: string
}

const KOCODE_CHARACTERS: KocodeCharacter[] = [
	{
		id: "koko",
		name: "ここちゃん",
		label: "デフォルト",
		status: "やさしく一緒に進めるにゃ",
		tag: "オンライン",
		avatar: kokoAvatar,
		themeClass: "theme-koko",
		welcome: "ボス、今日は何を作るにゃ？",
		placeholder: "ここちゃんにメッセージを送る...",
	},
	{
		id: "hime",
		name: "ひめ様",
		label: "プリンセス",
		status: "べ、別に助けたいわけじゃないわよ",
		tag: "オンライン",
		avatar: himeAvatar,
		themeClass: "theme-hime",
		welcome: "まったく、仕方ないわね。何を作るの？",
		placeholder: "ひめ様にメッセージを送る...",
	},
	{
		id: "mana",
		name: "まな先輩",
		label: "先輩",
		status: "落ち着いて整理しましょう",
		tag: "オンライン",
		avatar: manaAvatar,
		themeClass: "theme-mana",
		welcome: "大丈夫です。一緒に順番に整理しましょう。",
		placeholder: "まな先輩にメッセージを送る...",
	},
]

const getKocodeCharacter = (characterId?: KocodeCharacterId) =>
	KOCODE_CHARACTERS.find((character) => character.id === characterId) ?? KOCODE_CHARACTERS[0]

const formatTime = (timestamp: number) =>
	new Date(timestamp).toLocaleTimeString("ja-JP", {
		hour: "2-digit",
		minute: "2-digit",
	})

const KocodeHeader = ({
	character,
	isContactsView,
	onBackToChat,
	onOpenContacts,
	onOpenSettings,
	onOpenWorkbench,
}: {
	character: KocodeCharacter
	isContactsView: boolean
	onBackToChat: () => void
	onOpenContacts: () => void
	onOpenSettings: () => void
	onOpenWorkbench: () => void
}) => (
	<header className="kocode-topbar">
		<button
			aria-label={isContactsView ? "チャットに戻る" : "キャラクターを選ぶ"}
			className="kocode-icon-button"
			onClick={isContactsView ? onBackToChat : onOpenContacts}
			type="button">
			{isContactsView ? <ChevronLeftIcon size={19} /> : <MenuIcon size={19} />}
		</button>
		<div className="kocode-logo">
			<span aria-hidden>♡</span>
			<div>
				<strong>{isContactsView ? "キャラクター" : "Kocode / ココーデ"}</strong>
				{!isContactsView && (
					<small>
						{character.name}・{character.tag}
					</small>
				)}
			</div>
		</div>
		<button aria-label="作業メモを開く" className="kocode-icon-button" onClick={onOpenWorkbench} type="button">
			<BookOpenIcon size={18} />
		</button>
		<button aria-label="設定" className="kocode-icon-button" onClick={onOpenSettings} type="button">
			<SettingsIcon size={18} />
		</button>
	</header>
)

const KocodeStatusCard = ({ character }: { character: KocodeCharacter }) => (
	<section className="kocode-status-card">
		<img alt="" aria-hidden className="kocode-status-avatar" draggable={false} src={character.avatar} />
		<div className="kocode-status-copy">
			<strong>{character.name}</strong>
			<span>{character.status}</span>
		</div>
		<i aria-hidden />
	</section>
)

const Avatar = ({ character }: { character: KocodeCharacter }) => (
	<img alt="" aria-hidden className="kocode-avatar" draggable={false} src={character.avatar} />
)

const AssistantBubble = ({
	children,
	timestamp,
	character,
}: {
	children: React.ReactNode
	timestamp?: number
	character: KocodeCharacter
}) => (
	<div className="kocode-row kocode-row-assistant">
		<Avatar character={character} />
		<div className="kocode-bubble-wrap">
			<div className="kocode-bubble kocode-assistant-bubble">{children}</div>
			{timestamp !== undefined && <time>{formatTime(timestamp)}</time>}
		</div>
	</div>
)

const UserBubble = ({ children, timestamp }: { children: React.ReactNode; timestamp?: number }) => (
	<div className="kocode-row kocode-row-user">
		<div className="kocode-bubble-wrap">
			<div className="kocode-bubble kocode-user-bubble">{children}</div>
			{timestamp !== undefined && (
				<div className="kocode-sent">
					<time>{formatTime(timestamp)}</time>
					<span>✓</span>
				</div>
			)}
		</div>
	</div>
)

const memoKindLabel = (kind: KocodeMemoRef["kind"]) => (kind === "plan_report" ? "計画" : "完了")

const MemoFileCard = ({ memo, onOpen }: { memo: KocodeMemoRef; onOpen: (memoId: string) => void }) => (
	<button className="kocode-memo-file-card" onClick={() => onOpen(memo.id)} type="button">
		<span className="kocode-memo-file-icon">
			<FileTextIcon size={17} />
		</span>
		<span className="kocode-memo-file-main">
			<strong>{memo.title}</strong>
			<small>{memoKindLabel(memo.kind)}レポート</small>
		</span>
	</button>
)

// survey_plan モードの「アンケートを開く」ジャンプカード。
// 一問一答は独立パネル（作業メモの「アンケート」ページ）で行うので、
// チャット側は質問の総数と最新の質問プレビューだけ見せて、パネルへ誘導する。
const KocodeSurveyJumpCard = ({
	character,
	question,
	answeredCount,
	onOpen,
}: {
	character: KocodeCharacter
	question: KocodeSurveyQuestion
	answeredCount: number
	onOpen: () => void
}) => (
	<div className="kocode-row kocode-row-assistant">
		<Avatar character={character} />
		<div className="kocode-bubble-wrap">
			<button className="kocode-survey-jump-card" onClick={onOpen} type="button">
				<span className="kocode-survey-jump-icon">
					<ClipboardListIcon size={18} />
				</span>
				<span className="kocode-survey-jump-main">
					<strong>アンケートで一緒に整理するにゃ</strong>
					<span className="kocode-survey-jump-preview">{question.question}</span>
					<small>{answeredCount > 0 ? `${answeredCount}問 回答済み · タップで続ける` : "タップして回答する"}</small>
				</span>
			</button>
		</div>
	</div>
)

// アンケート用 followup の状態。Worker(Cline)が ask_followup_question で止まっている時の
// 「いま聞かれている 1 問」を表す。question 全文 + 選択肢を持つ。
type ActiveFollowup = {
	ts: number
	question: string
	options: string[]
}

// worker_detail(kind=ask, title=followup)の detail は Cline が JSON.stringify した
// { question, options, selected? } 文字列。partial の途中は壊れた JSON になりうるので、
// parse 失敗・question 空は無視して直前の完全な 1 問を保持する。
const parseFollowupDetail = (detail: string | undefined, ts: number): ActiveFollowup | null => {
	if (!detail) {
		return null
	}
	try {
		const parsed = JSON.parse(detail) as { question?: unknown; options?: unknown; selected?: unknown }
		const question = typeof parsed.question === "string" ? parsed.question.trim() : ""
		if (!question) {
			return null
		}
		// ユーザーが既に選択済み(selected あり)なら、その 1 問はもう答え終わっているので出さない。
		if (typeof parsed.selected === "string" && parsed.selected.length > 0) {
			return null
		}
		const options = Array.isArray(parsed.options)
			? parsed.options.filter((option): option is string => typeof option === "string" && option.trim().length > 0)
			: []
		return { ts, question, options }
	} catch {
		return null
	}
}

// 一問一答のアンケートカード。question を全文表示し、options をボタンにする。
// 「モデルがまれに複数問をまとめて出した」場合も、question を原文のまま出すだけで壊れない。
// 自由入力は下のメッセージ入力欄が兜底になるので、ここでは選択肢ボタンのみ提供する。
const KocodeSurveyCard = ({
	followup,
	character,
	onSelectOption,
}: {
	followup: ActiveFollowup
	character: KocodeCharacter
	onSelectOption: (option: string) => void
}) => (
	<div className="kocode-row kocode-row-assistant">
		<Avatar character={character} />
		<div className="kocode-bubble-wrap">
			<div className="kocode-bubble kocode-assistant-bubble kocode-survey-card">
				<div className="kocode-survey-question">
					<MarkdownRow markdown={followup.question} />
				</div>
				{followup.options.length > 0 && (
					<div className="kocode-survey-options">
						{followup.options.map((option) => (
							<button
								className="kocode-survey-option"
								key={option}
								onClick={() => onSelectOption(option)}
								type="button">
								{option}
							</button>
						))}
					</div>
				)}
				<small className="kocode-survey-hint">下の入力欄から、自分の言葉で答えてもいいにゃ。</small>
			</div>
		</div>
	</div>
)

const KocodeTypingBubble = ({ character, timestamp }: { character: KocodeCharacter; timestamp: number }) => (
	<div aria-label={`${character.name}が入力中`} className="kocode-row kocode-row-assistant kocode-typing-row">
		<Avatar character={character} />
		<div className="kocode-bubble-wrap">
			<div className="kocode-bubble kocode-assistant-bubble kocode-typing-bubble">
				<span />
				<span />
				<span />
			</div>
			<time>{formatTime(timestamp)}</time>
		</div>
	</div>
)

const KocodeEmptyChat = ({
	character,
	showWaitingBubble,
	waitingCharacter,
	waitingSince,
}: {
	character: KocodeCharacter
	showWaitingBubble: boolean
	waitingCharacter: KocodeCharacter
	waitingSince: number
}) => (
	<div className="kocode-empty-chat">
		<div className="kocode-day-divider">今日</div>
		<AssistantBubble character={character}>{character.welcome}</AssistantBubble>
		{showWaitingBubble && <KocodeTypingBubble character={waitingCharacter} timestamp={waitingSince} />}
	</div>
)

const KocodeChatMessageItem = ({
	fallbackCharacter,
	message,
	onOpenMemo,
}: {
	fallbackCharacter: KocodeCharacter
	message: KocodeChatMessage
	onOpenMemo: (memoId: string) => void
}) => {
	if (message.author === "user") {
		return <UserBubble timestamp={message.ts}>{message.text}</UserBubble>
	}

	const messageCharacter = message.characterId ? getKocodeCharacter(message.characterId) : fallbackCharacter

	return (
		<AssistantBubble character={messageCharacter} timestamp={message.ts}>
			<MarkdownRow markdown={message.text} />
			{message.memoRefs && message.memoRefs.length > 0 && (
				<div className="kocode-memo-file-list">
					{message.memoRefs.map((memo) => (
						<MemoFileCard key={memo.id} memo={memo} onOpen={onOpenMemo} />
					))}
				</div>
			)}
		</AssistantBubble>
	)
}

const KocodeContactsView = ({
	characters,
	selectedCharacter,
	onSelectCharacter,
}: {
	characters: KocodeCharacter[]
	selectedCharacter: KocodeCharacter
	onSelectCharacter: (character: KocodeCharacter) => void
}) => (
	<section className="kocode-contacts">
		<div className="kocode-contact-section-title">応対スタイル</div>
		<div className="kocode-contact-list">
			{characters.map((character) => {
				const selected = character.id === selectedCharacter.id
				return (
					<button
						className={`kocode-contact-card ${character.themeClass}${selected ? " is-selected" : ""}`}
						key={character.id}
						onClick={() => onSelectCharacter(character)}
						type="button">
						<img alt="" aria-hidden className="kocode-contact-avatar" draggable={false} src={character.avatar} />
						<div className="kocode-contact-main">
							<div className="kocode-contact-name-row">
								<strong>{character.name}</strong>
								<span>{character.label}</span>
							</div>
							<p>{character.status}</p>
						</div>
						{selected && (
							<div className="kocode-contact-check">
								<CheckIcon size={14} />
							</div>
						)}
					</button>
				)
			})}
		</div>
		<div className="kocode-contact-note">次のメッセージから、このキャラクターで返事するにゃ。</div>
	</section>
)

const KocodeChatView = ({ isHidden }: KocodeChatViewProps) => {
	const { apiConfiguration, clineMessages: messages, mode, navigateToSettings } = useExtensionState()
	const [kocodeMessages, setKocodeMessages] = useState<KocodeChatMessage[]>([])
	const [selectedCharacterId, setSelectedCharacterId] = useState<KocodeCharacterId>("koko")
	const [screen, setScreen] = useState<"chat" | "contacts">("chat")
	const [isAwaitingKocode, setIsAwaitingKocode] = useState(false)
	const [isWorkerWaiting, setIsWorkerWaiting] = useState(false)
	const [waitingCharacterId, setWaitingCharacterId] = useState<KocodeCharacterId>("koko")
	const [waitingSince, setWaitingSince] = useState(Date.now())
	// アンケートで「いま聞かれている 1 問」。followup ask が来たらセットし、
	// 回答送信 / 別状態への遷移でクリアする。
	const [activeFollowup, setActiveFollowup] = useState<ActiveFollowup | null>(null)
	// survey_plan モードの状態。survey_question が来たら最新の質問を保持し、
	// チャットには「アンケートを開く」ジャンプカードだけ出す（一問一答はパネル側）。
	const [surveyQuestion, setSurveyQuestion] = useState<KocodeSurveyQuestion | null>(null)
	const [surveyAnsweredCount, setSurveyAnsweredCount] = useState(0)
	const selectedCharacter = useMemo(
		() => KOCODE_CHARACTERS.find((character) => character.id === selectedCharacterId) ?? KOCODE_CHARACTERS[0],
		[selectedCharacterId],
	)
	const waitingCharacter = useMemo(() => getKocodeCharacter(waitingCharacterId), [waitingCharacterId])
	const showWaitingBubble = screen === "chat" && (isAwaitingKocode || isWorkerWaiting)

	const chatState = useChatState(messages)
	const setChatInputValue = chatState.setInputValue
	const messageHandlers = useMessageHandlers(messages, chatState)
	const scrollBehavior = useScrollBehavior(messages, [], [], chatState.expandedRows, chatState.setExpandedRows)
	const { selectedModelInfo } = useMemo(() => normalizeApiConfiguration(apiConfiguration, mode), [apiConfiguration, mode])

	const selectFilesAndImages = useCallback(async () => {
		const response = await FileServiceClient.selectFiles(BooleanRequest.create({ value: selectedModelInfo.supportsImages }))
		const availableSlots = MAX_ATTACHMENTS - chatState.selectedImages.length - chatState.selectedFiles.length
		if (!response || availableSlots <= 0) {
			return
		}
		const imagesToAdd = response.values1.slice(0, availableSlots)
		const filesToAdd = response.values2.slice(0, availableSlots - imagesToAdd.length)
		chatState.setSelectedImages((previous) => [...previous, ...imagesToAdd])
		chatState.setSelectedFiles((previous) => [...previous, ...filesToAdd])
	}, [chatState, selectedModelInfo.supportsImages])

	const handleKocodeSendMessage = useCallback(
		async (text: string, images: string[], files: string[]) => {
			const messageToSend = text.trim()
			if (!messageToSend && images.length === 0 && files.length === 0) {
				return
			}

			setIsAwaitingKocode(true)
			setWaitingCharacterId(selectedCharacter.id)
			setWaitingSince(Date.now())
			// followup（アンケート）待ちのときは、入力欄の自由回答も Worker の ask へ直接戻す。
			// inline followup（activeFollowup）と survey_plan（surveyQuestion）の両方が対象。
			const hadActiveFollowup = activeFollowup !== null || surveyQuestion !== null

			if (hadActiveFollowup) {
				if (images.length > 0 || files.length > 0) {
					setIsAwaitingKocode(false)
					return
				}
				// 回答を送ったら、いま出ているアンケートカードは片付ける(次の 1 問が来たら再表示)。
				setActiveFollowup(null)
				setSurveyQuestion(null)
				try {
					await KocodeServiceClient.answerWorkerAsk({
						text: messageToSend,
						characterId: selectedCharacter.id,
					})
				} catch (error) {
					setIsAwaitingKocode(false)
					console.error(error)
					return
				}
				chatState.setInputValue("")
				chatState.setActiveQuote(null)
				chatState.setSelectedImages([])
				chatState.setSelectedFiles([])
				chatState.setSendingDisabled(false)
				chatState.setEnableButtons(true)
				return
			}

			try {
				await KocodeServiceClient.sendUserMessage({
					text: messageToSend,
					characterId: selectedCharacter.id,
					images,
					files,
				})
			} catch (error) {
				setIsAwaitingKocode(false)
				console.error(error)
				return
			}

			chatState.setInputValue("")
			chatState.setActiveQuote(null)
			chatState.setSelectedImages([])
			chatState.setSelectedFiles([])
			chatState.setSendingDisabled(false)
			chatState.setEnableButtons(true)
		},
		[chatState, selectedCharacter.id, activeFollowup, surveyQuestion],
	)

	const kocodeMessageHandlers = useMemo(
		() => ({
			...messageHandlers,
			handleSendMessage: handleKocodeSendMessage,
		}),
		[handleKocodeSendMessage, messageHandlers],
	)

	const openMemo = useCallback((memoId: string) => {
		void KocodeServiceClient.openWorkbench({ memoId })
	}, [])

	// アンケートのジャンプカードをタップ: 独立パネル（作業メモ）を開いて一問一答へ誘導する。
	const openSurvey = useCallback(() => {
		void KocodeServiceClient.openWorkbench(EmptyRequest.create({}))
	}, [])

	// アンケートの選択肢をタップ: その選択肢を Worker 自身の followup ask へ直接戻す。
	// Flash の再分類を通さず、answerWorkerAsk で一問一答を次の質問へ進める。
	const handleSelectSurveyOption = useCallback(
		(option: string) => {
			setActiveFollowup(null)
			setIsWorkerWaiting(true)
			setWaitingSince(Date.now())
			void KocodeServiceClient.answerWorkerAsk({ text: option, characterId: selectedCharacter.id }).catch(console.error)
		},
		[selectedCharacter.id],
	)

	useEffect(() => {
		KocodeServiceClient.getKocodeSession(EmptyRequest.create({}))
			.then((session) => {
				setKocodeMessages(session.messages)
				const shouldWait =
					session.workerDigest.status === "starting" ||
					session.workerDigest.status === "running" ||
					session.workerDigest.status === "waiting"
				setIsWorkerWaiting(shouldWait)
				if (shouldWait) {
					setWaitingSince(Date.now())
				}
				// 進行中の survey があれば、ジャンプカードの初期状態を復元する。
				if (session.survey && session.survey.status === "active") {
					setSurveyAnsweredCount(session.survey.entries.length)
					setSurveyQuestion(session.survey.current ?? null)
				}
			})
			.catch(console.error)

		const cleanup = KocodeServiceClient.subscribeToKocodeEvents(EmptyRequest.create({}), {
			onResponse: (event: KocodeEvent) => {
				if (event.type === "user_message" || event.type === "flash_message") {
					setKocodeMessages((previous) => {
						if (previous.some((message) => message.id === event.message.id)) {
							return previous
						}
						return [...previous, event.message]
					})
					if (event.type === "flash_message") {
						setIsAwaitingKocode(false)
						setWaitingCharacterId(event.message.characterId ?? selectedCharacterId)
					}
				}
				if (event.type === "worker_status") {
					const shouldWait =
						event.digest.status === "starting" ||
						event.digest.status === "running" ||
						event.digest.status === "waiting"
					setIsWorkerWaiting((wasWaiting) => {
						if (shouldWait && !wasWaiting) {
							setWaitingSince(Date.now())
						}
						if (!shouldWait && wasWaiting) {
							setWaitingSince(Date.now())
						}
						return shouldWait
					})
					// 終了系の状態に入ったら、出しっぱなしのアンケートカードを片付ける。
					if (
						event.digest.status === "completed" ||
						event.digest.status === "failed" ||
						event.digest.status === "cancelled"
					) {
						setActiveFollowup(null)
						setSurveyQuestion(null)
					}
				}
				// アンケートの 1 問: Worker(Cline)が ask_followup_question で止まった時だけカードを出す。
				if (event.type === "worker_detail") {
					if (event.event.kind === "ask" && event.event.title === "followup") {
						const followup = parseFollowupDetail(event.event.detail, event.event.ts)
						if (followup) {
							setActiveFollowup(followup)
						}
					} else if (event.event.kind === "completed" || event.event.kind === "cancelled") {
						setActiveFollowup(null)
					}
				}
				// survey_plan モード: 一問一答は独立パネルで行い、チャットにはジャンプカードだけ出す。
				if (event.type === "survey_question") {
					setSurveyQuestion(event.question)
				}
				if (event.type === "survey_updated") {
					setSurveyAnsweredCount(event.survey.entries.length)
					if (event.survey.status !== "active") {
						setSurveyQuestion(null)
					} else {
						setSurveyQuestion(event.survey.current ?? null)
					}
				}
			},
			onError: console.error,
			onComplete: () => undefined,
		})

		return cleanup
	}, [])

	useEffect(() => {
		const cleanup = UiServiceClient.subscribeToShowWebview(
			{},
			{
				onResponse: (event) => {
					if (!isHidden && !event.preserveEditorFocus) {
						chatState.textAreaRef.current?.focus()
					}
				},
				onError: console.error,
				onComplete: () => undefined,
			},
		)
		return cleanup
	}, [chatState.textAreaRef, isHidden])

	useEffect(() => {
		const cleanup = UiServiceClient.subscribeToAddToInput(
			{},
			{
				onResponse: (event) => {
					if (event.value) {
						setChatInputValue((previous) => (previous ? `${previous}\n${event.value}\n` : `${event.value}\n`))
					}
				},
				onError: console.error,
				onComplete: () => undefined,
			},
		)
		return cleanup
	}, [setChatInputValue])

	useMount(() => chatState.textAreaRef.current?.focus())

	const attachmentsDisabled = chatState.selectedImages.length + chatState.selectedFiles.length >= MAX_ATTACHMENTS
	const isAnsweringQuestion = activeFollowup !== null || surveyQuestion !== null
	const shouldDisableAttachments = attachmentsDisabled || isAnsweringQuestion

	return (
		<ChatLayout isHidden={isHidden}>
			<main className={`kocode-view ${selectedCharacter.themeClass}`}>
				<KocodeHeader
					character={selectedCharacter}
					isContactsView={screen === "contacts"}
					onBackToChat={() => setScreen("chat")}
					onOpenContacts={() => setScreen("contacts")}
					onOpenSettings={() => navigateToSettings()}
					onOpenWorkbench={() => void KocodeServiceClient.openWorkbench(EmptyRequest.create({}))}
				/>
				{screen === "contacts" ? (
					<KocodeContactsView
						characters={KOCODE_CHARACTERS}
						onSelectCharacter={(character) => {
							setSelectedCharacterId(character.id)
							setScreen("chat")
						}}
						selectedCharacter={selectedCharacter}
					/>
				) : (
					<>
						<KocodeStatusCard character={selectedCharacter} />
						<section className="kocode-conversation">
							{kocodeMessages.length > 0 ? (
								<Virtuoso
									atBottomStateChange={scrollBehavior.setIsAtBottom}
									className="kocode-thread scrollable"
									components={{
										Footer: () => (
											<>
												{activeFollowup && (
													<KocodeSurveyCard
														character={selectedCharacter}
														followup={activeFollowup}
														onSelectOption={handleSelectSurveyOption}
													/>
												)}
												{surveyQuestion && (
													<KocodeSurveyJumpCard
														answeredCount={surveyAnsweredCount}
														character={selectedCharacter}
														onOpen={openSurvey}
														question={surveyQuestion}
													/>
												)}
												{showWaitingBubble && (
													<KocodeTypingBubble character={waitingCharacter} timestamp={waitingSince} />
												)}
											</>
										),
									}}
									data={kocodeMessages}
									initialTopMostItemIndex={kocodeMessages.length - 1}
									itemContent={(_, item) => (
										<KocodeChatMessageItem
											fallbackCharacter={selectedCharacter}
											message={item}
											onOpenMemo={openMemo}
										/>
									)}
									key="kocode-thread"
									ref={scrollBehavior.virtuosoRef}
								/>
							) : (
								<KocodeEmptyChat
									character={selectedCharacter}
									showWaitingBubble={showWaitingBubble}
									waitingCharacter={waitingCharacter}
									waitingSince={waitingSince}
								/>
							)}
						</section>
					</>
				)}
			</main>
			{screen === "chat" && (
				<footer className={`kocode-input-dock ${selectedCharacter.themeClass}`}>
					<div className="kocode-compose-row">
						<button
							aria-label="ファイルや画像を追加"
							className="kocode-compose-action"
							disabled={shouldDisableAttachments}
							onClick={() => void selectFilesAndImages()}
							type="button">
							<PlusIcon size={19} />
						</button>
						<div className="kocode-composer">
							<InputSection
								chatState={chatState}
								messageHandlers={kocodeMessageHandlers}
								placeholderText={selectedCharacter.placeholder}
								scrollBehavior={scrollBehavior}
								selectFilesAndImages={selectFilesAndImages}
								shouldDisableFilesAndImages={shouldDisableAttachments}
								variant="kocode"
							/>
						</div>
						<button
							aria-label="送信"
							className="kocode-compose-action kocode-send-ornament"
							onClick={() =>
								void handleKocodeSendMessage(
									chatState.inputValue,
									chatState.selectedImages,
									chatState.selectedFiles,
								)
							}
							type="button">
							<SendIcon size={18} />
						</button>
					</div>
					<div className="kocode-footer-copy">♡ Kocode はあなたのコーディングを応援するにゃ！</div>
				</footer>
			)}
		</ChatLayout>
	)
}

export default KocodeChatView
