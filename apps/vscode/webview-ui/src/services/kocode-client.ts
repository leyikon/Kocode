import type { EmptyRequest } from "@shared/proto/cline/common"
import type { KocodeEvent, KocodeSendResult, KocodeSessionState, KocodeUserMessage, WorkerControlRequest } from "@shared/kocode"
import { ProtoBusClient, type Callbacks } from "./grpc-client-base"

const encodeIdentity = <T>(value: T): unknown => value
const decodeKocodeSendResult = (value: { [key: string]: any }) => value as KocodeSendResult
const decodeEmpty = (value: { [key: string]: any }) => value as Record<string, never>
const decodeKocodeSessionState = (value: { [key: string]: any }) => value as KocodeSessionState
const decodeKocodeEvent = (value: { [key: string]: any }) => value as KocodeEvent

export class KocodeServiceClient extends ProtoBusClient {
	static override serviceName = "cline.KocodeService"

	static async sendUserMessage(request: KocodeUserMessage): Promise<KocodeSendResult> {
		return this.makeUnaryRequest("sendUserMessage", request, encodeIdentity, decodeKocodeSendResult)
	}

	static async workerControl(request: WorkerControlRequest): Promise<Record<string, never>> {
		return this.makeUnaryRequest("workerControl", request, encodeIdentity, decodeEmpty)
	}

	static async getKocodeSession(request: EmptyRequest): Promise<KocodeSessionState> {
		return this.makeUnaryRequest("getKocodeSession", request, encodeIdentity, decodeKocodeSessionState)
	}

	static async openWorkbench(request: EmptyRequest): Promise<Record<string, never>> {
		return this.makeUnaryRequest("openWorkbench", request, encodeIdentity, decodeEmpty)
	}

	static subscribeToKocodeEvents(request: EmptyRequest, callbacks: Callbacks<KocodeEvent>): () => void {
		return this.makeStreamingRequest("subscribeToKocodeEvents", request, encodeIdentity, decodeKocodeEvent, callbacks)
	}
}
