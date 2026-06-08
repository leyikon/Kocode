import type {
	KocodeEvent,
	KocodeOpenWorkbenchRequest,
	KocodeSendResult,
	KocodeSessionState,
	KocodeUserMessage,
	WorkerControlRequest,
} from "@shared/kocode"
import type { EmptyRequest } from "@shared/proto/cline/common"
import { type Callbacks, ProtoBusClient } from "./grpc-client-base"

const encodeIdentity = <T>(value: T): unknown => value
const decodeKocodeSendResult = (value: unknown) => value as KocodeSendResult
const decodeEmpty = (value: unknown) => value as Record<string, never>
const decodeKocodeSessionState = (value: unknown) => value as KocodeSessionState
const decodeKocodeEvent = (value: unknown) => value as KocodeEvent

export class KocodeServiceClient extends ProtoBusClient {
	static override serviceName = "cline.KocodeService"

	static async sendUserMessage(request: KocodeUserMessage): Promise<KocodeSendResult> {
		return KocodeServiceClient.makeUnaryRequest("sendUserMessage", request, encodeIdentity, decodeKocodeSendResult)
	}

	static async workerControl(request: WorkerControlRequest): Promise<Record<string, never>> {
		return KocodeServiceClient.makeUnaryRequest("workerControl", request, encodeIdentity, decodeEmpty)
	}

	static async getKocodeSession(request: EmptyRequest): Promise<KocodeSessionState> {
		return KocodeServiceClient.makeUnaryRequest("getKocodeSession", request, encodeIdentity, decodeKocodeSessionState)
	}

	static async openWorkbench(request: EmptyRequest | KocodeOpenWorkbenchRequest): Promise<Record<string, never>> {
		return KocodeServiceClient.makeUnaryRequest("openWorkbench", request, encodeIdentity, decodeEmpty)
	}

	static subscribeToKocodeEvents(request: EmptyRequest, callbacks: Callbacks<KocodeEvent>): () => void {
		return KocodeServiceClient.makeStreamingRequest(
			"subscribeToKocodeEvents",
			request,
			encodeIdentity,
			decodeKocodeEvent,
			callbacks,
		)
	}
}
