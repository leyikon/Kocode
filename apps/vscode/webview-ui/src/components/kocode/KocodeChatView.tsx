import type { KocodeChatMessage, KocodeEvent } from "@shared/kocode"
import { BooleanRequest, EmptyRequest } from "@shared/proto/cline/common"
import { BookOpenIcon, MenuIcon, PlusIcon, SendIcon, SettingsIcon } from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { useMount } from "react-use"
import { Virtuoso } from "react-virtuoso"
import kokoAvatar from "@/assets/kocode/koko-avatar.png"
import kokoBanner from "@/assets/kocode/koko-banner.png"
import {
	ActionButtons,
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
	onOpenLegacy: () => void
}

const MAX_ATTACHMENTS = CHAT_CONSTANTS.MAX_IMAGES_AND_FILES_PER_MESSAGE

const formatTime = (timestamp: number) =>
	new Date(timestamp).toLocaleTimeString("ja-JP", {
		hour: "2-digit",
		minute: "2-digit",
	})

const KocodeHeader = ({
	onOpenLegacy,
	onOpenSettings,
	onOpenWorkbench,
}: {
	onOpenLegacy: () => void
	onOpenSettings: () => void
	onOpenWorkbench: () => void
}) => (
	<header className="kocode-topbar">
		<button aria-label="以前の画面を開く" className="kocode-icon-button" onClick={onOpenLegacy} type="button">
			<MenuIcon size={21} />
		</button>
		<div className="kocode-logo">
			<span aria-hidden>♡</span>
			<strong>Kocode / ココーデ</strong>
		</div>
		<button aria-label="作業メモを開く" className="kocode-icon-button" onClick={onOpenWorkbench} type="button">
			<BookOpenIcon size={20} />
		</button>
		<button aria-label="設定" className="kocode-icon-button" onClick={onOpenSettings} type="button">
			<SettingsIcon size={20} />
		</button>
	</header>
)

const KocodeHero = () => (
	<section className="kocode-hero">
		<img alt="ここちゃん" className="kocode-hero-art" src={kokoBanner} />
		<div className="kocode-hero-copy">
			<h1>
				ここちゃん<span>♡</span>
			</h1>
			<p>
				なんでも気軽に
				<br />
				聞いてにゃ！
			</p>
		</div>
	</section>
)

const Avatar = () => <img alt="" aria-hidden className="kocode-avatar" draggable={false} src={kokoAvatar} />

const AssistantBubble = ({ children, timestamp }: { children: React.ReactNode; timestamp?: number }) => (
	<div className="kocode-row kocode-row-assistant">
		<Avatar />
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

const KocodeEmptyChat = () => (
	<div className="kocode-empty-chat">
		<div className="kocode-day-divider">今日</div>
		<AssistantBubble>
			ボス、まずは小さく
			<br />
			作ってみるにゃ。
		</AssistantBubble>
		<UserBubble>うまく動かないよ〜</UserBubble>
		<AssistantBubble>
			このエラー、こわくないにゃ。
			<br />
			原因を一緒に見つけるにゃ〜
		</AssistantBubble>
	</div>
)

const KocodeChatMessageItem = ({ message }: { message: KocodeChatMessage }) => {
	if (message.author === "user") {
		return <UserBubble timestamp={message.ts}>{message.text}</UserBubble>
	}

	return (
		<AssistantBubble timestamp={message.ts}>
			<MarkdownRow markdown={message.text} />
		</AssistantBubble>
	)
}

const KocodeChatView = ({ isHidden, onOpenLegacy }: KocodeChatViewProps) => {
	const { apiConfiguration, clineMessages: messages, mode, navigateToSettings } = useExtensionState()
	const [kocodeMessages, setKocodeMessages] = useState<KocodeChatMessage[]>([])
	const task = useMemo(() => messages.at(0), [messages])

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

			await KocodeServiceClient.sendUserMessage({
				text: messageToSend,
				images,
				files,
			})

			chatState.setInputValue("")
			chatState.setActiveQuote(null)
			chatState.setSelectedImages([])
			chatState.setSelectedFiles([])
			chatState.setSendingDisabled(false)
			chatState.setEnableButtons(true)
		},
		[chatState],
	)

	const kocodeMessageHandlers = useMemo(
		() => ({
			...messageHandlers,
			handleSendMessage: handleKocodeSendMessage,
		}),
		[handleKocodeSendMessage, messageHandlers],
	)

	useEffect(() => {
		KocodeServiceClient.getKocodeSession(EmptyRequest.create({}))
			.then((session) => {
				setKocodeMessages(session.messages)
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
			<main className="kocode-view">
				<KocodeHeader
					onOpenLegacy={onOpenLegacy}
					onOpenSettings={() => navigateToSettings()}
					onOpenWorkbench={() => void KocodeServiceClient.openWorkbench(EmptyRequest.create({}))}
				/>
				<KocodeHero />
				<section className="kocode-conversation">
					{kocodeMessages.length > 0 ? (
						<Virtuoso
							atBottomStateChange={scrollBehavior.setIsAtBottom}
							className="kocode-thread scrollable"
							data={kocodeMessages}
							initialTopMostItemIndex={kocodeMessages.length - 1}
							itemContent={(_, item) => <KocodeChatMessageItem message={item} />}
							key="kocode-thread"
							ref={scrollBehavior.virtuosoRef}
						/>
					) : (
						<KocodeEmptyChat />
					)}
				</section>
			</main>
			<footer className="kocode-input-dock">
				<ActionButtons
					chatState={chatState}
					messageHandlers={messageHandlers}
					messages={messages}
					mode={mode}
					scrollBehavior={scrollBehavior}
					task={task}
				/>
				<div className="kocode-compose-row">
					<button
						aria-label="ファイルや画像を追加"
						className="kocode-compose-action"
						disabled={attachmentsDisabled}
						onClick={() => void selectFilesAndImages()}
						type="button">
						<PlusIcon size={22} />
					</button>
					<div className="kocode-composer">
						<InputSection
							chatState={chatState}
							messageHandlers={kocodeMessageHandlers}
							placeholderText="ここちゃんにメッセージを送る..."
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
							void handleKocodeSendMessage(chatState.inputValue, chatState.selectedImages, chatState.selectedFiles)
						}
						type="button">
						<SendIcon size={21} />
					</button>
				</div>
				<div className="kocode-footer-copy">♡ Kocode はあなたのコーディングを応援するにゃ！</div>
			</footer>
		</ChatLayout>
	)
}

export default KocodeChatView
