import type { KocodeCharacterId, KocodeChatMessage, KocodeEvent, KocodeMemoRef } from "@shared/kocode"
import { BooleanRequest, EmptyRequest } from "@shared/proto/cline/common"
import {
	BookOpenIcon,
	CheckIcon,
	ChevronLeftIcon,
	FileTextIcon,
	MenuIcon,
	PlusIcon,
	SearchIcon,
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
			aria-label={isContactsView ? "チャットに戻る" : "連絡先を開く"}
			className="kocode-icon-button"
			onClick={isContactsView ? onBackToChat : onOpenContacts}
			type="button">
			{isContactsView ? <ChevronLeftIcon size={19} /> : <MenuIcon size={19} />}
		</button>
		<div className="kocode-logo">
			<span aria-hidden>♡</span>
			<div>
				<strong>{isContactsView ? "連絡先" : "Kocode / ココーデ"}</strong>
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
		<div className="kocode-contact-search">
			<SearchIcon size={15} />
			<span>キャラクターを探す</span>
		</div>
		<div className="kocode-contact-section-title">Kocode Friends</div>
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
		<div className="kocode-contact-note">左上のボタンで、いつでもチャットに戻れるにゃ。</div>
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
		[chatState, selectedCharacter.id],
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
										Footer: () =>
											showWaitingBubble ? (
												<KocodeTypingBubble character={waitingCharacter} timestamp={waitingSince} />
											) : null,
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
							disabled={attachmentsDisabled}
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
								shouldDisableFilesAndImages={attachmentsDisabled}
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
