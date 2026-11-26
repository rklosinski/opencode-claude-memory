// Unpinned memory agents follow the model of the session they work for (mid-session /model too).

import { afterEach, describe, expect, test } from "bun:test"
import { memoryAgentDefaults } from "../../src/agents.js"
import { MEMORY_AGENTS } from "../../src/config.js"
import { sandboxRules } from "../../src/host/v2/agents.js"
import type { ModelRef, V2SessionApi } from "../../src/host/v2/fork.js"
import { V2Host } from "../../src/host/v2/host.js"
import { cleanupTempDirs } from "../helpers/index.js"
import { makeV2Context } from "../helpers/v2ctx.js"

afterEach(() => cleanupTempDirs())

const QWEN: ModelRef = { providerID: "omlx", id: "Qwen3.8-Flash-Next-instrut" }
const GLM: ModelRef = { providerID: "omlx", id: "GLM-5.3-Flash" }
const PIN: ModelRef = { providerID: "omlx", id: "pinned" }

function setup(pinned?: ModelRef, selected?: Record<string, ModelRef>) {
  const mock = makeV2Context({})
  const session = mock.ctx.session as unknown as V2SessionApi
  if (selected) session.get = async ({ sessionID }) => ({ model: selected[sessionID] })
  const defaults = memoryAgentDefaults(MEMORY_AGENTS)
  const generated: Array<ModelRef | undefined> = []
  const host = new V2Host({
    session,
    generateText: async (input) => {
      generated.push(input.model)
      return { text: "" }
    },
    getAgent: async (name) => {
      const agent = mock.agents.get(name)
      return pinned ? { ...agent, model: pinned } : { ...agent, model: undefined }
    },
    sandboxFor: (name) => sandboxRules(defaults[name]?.allowedTools ?? []),
  })
  const forkModel = async (parentSessionID?: string) => {
    const before = mock.calls.length
    await host.runFork({
      agent: MEMORY_AGENTS.extract,
      title: "fork",
      text: "go",
      timeoutMs: 1_000,
      ...(parentSessionID ? { parentSessionID } : {}),
    })
    const create = mock.calls.slice(before).find((call) => call.method === "session.create")
    return (create?.input as { model?: ModelRef } | undefined)?.model
  }
  return { host, generated, forkModel }
}

describe("memory agents follow the session model", () => {
  test("no model seen yet: the host default (no model sent)", async () => {
    const { forkModel } = setup()
    expect(await forkModel("ses_a")).toBeUndefined()
  })

  test("fork and generate use the parent session's latest model, switching with it", async () => {
    const { host, generated, forkModel } = setup()
    host.noteModel("ses_a", QWEN)
    expect(await forkModel("ses_a")).toEqual(QWEN)
    host.noteModel("ses_a", GLM)
    expect(await forkModel("ses_a")).toEqual(GLM)
    await host.generate({
      agent: MEMORY_AGENTS.recall,
      title: "r",
      text: "q",
      parentSessionID: "ses_a",
      timeoutMs: 1_000,
    })
    expect(generated.at(-1)).toEqual(GLM)
  })

  test("an unknown session falls back to the latest model seen anywhere", async () => {
    const { host, forkModel } = setup()
    host.noteModel("ses_a", QWEN)
    host.noteModel("ses_b", GLM)
    expect(await forkModel("ses_a")).toEqual(QWEN)
    expect(await forkModel("ses_new")).toEqual(GLM)
  })

  test("a pinned agent model always wins", async () => {
    const { host, forkModel } = setup(PIN)
    host.noteModel("ses_a", QWEN)
    expect(await forkModel("ses_a")).toEqual(PIN)
  })

  test("the session's selected model (session.get) wins over its last request", async () => {
    const selected: Record<string, ModelRef> = { ses_a: GLM }
    const { host, generated, forkModel } = setup(undefined, selected)
    host.noteModel("ses_a", QWEN)
    expect(await forkModel("ses_a")).toEqual(GLM)
    await host.generate({
      agent: MEMORY_AGENTS.recall,
      title: "r",
      text: "q",
      parentSessionID: "ses_a",
      timeoutMs: 1_000,
    })
    expect(generated.at(-1)).toEqual(GLM)
    // No selection reported: fall back to the recorded request model.
    delete selected.ses_a
    expect(await forkModel("ses_a")).toEqual(QWEN)
  })
})
