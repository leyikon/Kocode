import * as disk from "@core/storage/disk"
import axios from "axios"
import { expect } from "chai"
import fs from "fs/promises"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import { ClineEnv, Environment } from "@/config"
import { StateManager } from "@/core/storage/StateManager"
import { getFeatureFlagsService } from "@/services/feature-flags"
import { Logger } from "@/shared/services/Logger"
import { refreshClineModels } from "../refreshClineModels"

describe("refreshClineModels", () => {
	let sandbox: sinon.SinonSandbox

	beforeEach(() => {
		sandbox = sinon.createSandbox()
		sandbox.stub(Logger, "log")
		sandbox.stub(Logger, "error")
		sandbox.stub(getFeatureFlagsService(), "getBooleanFlagEnabled").returns(false)
		sandbox.stub(StateManager, "get").returns({
			getModelsCache: () => undefined,
			setModelsCache: () => undefined,
		} as unknown as StateManager)
	})

	afterEach(() => {
		sandbox.restore()
	})

	it("uses the configured relay model endpoint in self-hosted mode without a rollout flag", async () => {
		sandbox.stub(ClineEnv, "config").returns({
			environment: Environment.selfHosted,
			appBaseUrl: "https://app.kocode.example",
			apiBaseUrl: "https://api.kocode.example",
			mcpBaseUrl: "https://api.kocode.example/v1/mcp",
		})
		sandbox.stub(disk, "ensureCacheDirectoryExists").resolves("/tmp")
		sandbox.stub(fs, "writeFile").resolves()
		const axiosGetStub = sandbox.stub(axios, "get").resolves({
			data: {
				data: [
					{
						id: "deepseek-v4-pro",
						name: "Kocode Pro",
						description: "Private relay model",
						context_length: 1_000_000,
						top_provider: { max_completion_tokens: 384_000, context_length: 1_000_000, is_moderated: false },
						architecture: { modality: ["text"] },
						pricing: { prompt: "0", completion: "0.00000087" },
						supported_parameters: ["reasoning"],
					},
				],
			},
		})

		const models = await refreshClineModels({} as never)

		expect(axiosGetStub.calledOnceWith("https://api.kocode.example/api/v1/ai/cline/models")).to.equal(true)
		expect(models["deepseek-v4-pro"]?.name).to.equal("Kocode Pro")
	})
})
