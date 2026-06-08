import type {
	KocodeEvent,
	KocodeOpenWorkbenchRequest,
	KocodeSendResult,
	KocodeSessionState,
	KocodeUserMessage,
	WorkerControlRequest,
} from "@shared/kocode"
import { Empty, EmptyRequest } from "@shared/proto/cline/common"
import { Controller } from "@/core/controller"
import { getRequestRegistry, type StreamingResponseHandler } from "@/core/controller/grpc-handler"
import { WebviewProvider } from "@/core/webview"
import { KocodeOrchestrator } from "./KocodeOrchestrator"

const orchestrators = new WeakMap<Controller, KocodeOrchestrator>()

function getOrchestrator(controller: Controller): KocodeOrchestrator {
	let orchestrator = orchestrators.get(controller)
	if (!orchestrator) {
		orchestrator = new KocodeOrchestrator(controller)
		orchestrators.set(controller, orchestrator)
	}
	return orchestrator
}

export async function sendUserMessage(controller: Controller, request: KocodeUserMessage): Promise<KocodeSendResult> {
	return getOrchestrator(controller).sendUserMessage(request)
}

export async function workerControl(controller: Controller, request: WorkerControlRequest): Promise<Empty> {
	await getOrchestrator(controller).workerControl(request)
	return Empty.create()
}

export async function getKocodeSession(controller: Controller, _request: EmptyRequest): Promise<KocodeSessionState> {
	const orchestrator = getOrchestrator(controller)
	await orchestrator.ensureReady()
	return orchestrator.getSession()
}

export async function openWorkbench(controller: Controller, request: KocodeOpenWorkbenchRequest): Promise<Empty> {
	await getOrchestrator(controller).selectMemo(request.memoId)
	const provider = WebviewProvider.getInstance() as WebviewProvider & {
		openKocodeWorkbenchPanel?: () => Promise<void>
	}
	await provider.openKocodeWorkbenchPanel?.()
	return Empty.create()
}

export async function subscribeToKocodeEvents(
	controller: Controller,
	_request: EmptyRequest,
	responseStream: StreamingResponseHandler<KocodeEvent>,
	requestId?: string,
): Promise<void> {
	const orchestrator = getOrchestrator(controller)
	const unsubscribe = orchestrator.subscribe(async (event) => {
		await responseStream(event, false)
	})

	if (requestId) {
		getRequestRegistry().registerRequest(requestId, unsubscribe, { type: "kocode_events_subscription" }, responseStream)
	}

	await orchestrator.ensureReady()
	const session = orchestrator.getSession()
	await responseStream(
		{
			type: "worker_status",
			digest: session.workerDigest,
		},
		false,
	)
}

export const kocodeServiceHandlers = {
	sendUserMessage,
	workerControl,
	subscribeToKocodeEvents,
	getKocodeSession,
	openWorkbench,
}
