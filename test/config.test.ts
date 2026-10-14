import { afterEach, describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  MEMORY_AGENTS,
  MemoryConfigError,
  MemoryOptionsSchema,
  parseConfig,
  resolveClaudeConfigDir,
} from "../src/config.js"
import { cleanupTempDirs, tempDir } from "./helpers/index.js"

afterEach(cleanupTempDirs)

describe("parseConfig", () => {
  test("applies defaults when no options are given", () => {
    const config = parseConfig(undefined, {})
    expect(config.extract).toEqual({
      enabled: true,
      timeoutMs: 120_000,
      debounceMs: 10_000,
      maxConversationChars: 60_000,
      maxToolOutputChars: 300,
      catchUpLimit: 5,
    })
    expect(config.autodream).toEqual({ enabled: true, minHours: 24, minSessions: 5, timeoutMs: 300_000 })
    expect(config.recall).toEqual({ enabled: true, waitMs: 1_500, timeoutMs: 30_000, maxMemories: 5 })
    expect(config.agents).toBe(MEMORY_AGENTS)
    expect(config.claudeConfigDir).toBe(join(homedir(), ".claude"))
  })

  test("merges partial nested options with defaults", () => {
    const config = parseConfig({ extract: { timeoutMs: 90_000 }, recall: { waitMs: 0 } }, {})
    expect(config.extract.timeoutMs).toBe(90_000)
    expect(config.extract.enabled).toBe(true)
    expect(config.recall.waitMs).toBe(0)
    expect(config.recall.maxMemories).toBe(5)
  })

  test("reports the path of an invalid value", () => {
    expect(() => parseConfig({ extract: { enabled: "yes" } }, {})).toThrow(/extract\.enabled/)
    expect(() => parseConfig({ extract: { enabled: "yes" } }, {})).toThrow(MemoryConfigError)
  })

  test("rejects unknown keys at every level", () => {
    expect(() => parseConfig({ extrct: {} }, {})).toThrow(/extrct/)
    expect(() => parseConfig({ recall: { waitMS: 5 } }, {})).toThrow(/waitMS/)
  })

  test("rejects out-of-range numbers", () => {
    expect(() => parseConfig({ extract: { timeoutMs: 0 } }, {})).toThrow(/extract\.timeoutMs/)
    expect(() => parseConfig({ extract: { timeoutMs: 2_147_483_648 } }, {})).toThrow(/extract\.timeoutMs/)
    expect(() => parseConfig({ recall: { maxMemories: 21 } }, {})).toThrow(/recall\.maxMemories/)
    expect(() => parseConfig({ autodream: { minSessions: 0 } }, {})).toThrow(/autodream\.minSessions/)
    expect(() => parseConfig({ extract: { maxToolOutputChars: 0 } }, {})).toThrow(/extract\.maxToolOutputChars/)
  })

  test("keeps inline extraction guidance", () => {
    const config = parseConfig({ extract: { guidance: "  ## What to save\n\nDecisions.  " } }, {})
    expect(config.extract.guidance).toBe("## What to save\n\nDecisions.")
  })

  test("reads extraction guidance from an absolute or ~/ file", () => {
    const home = tempDir("ocm-home-")
    writeFileSync(join(home, "guidance.md"), "\n## What to save\n\nDecisions and their reasons.\n")
    const fromHome = parseConfig({ extract: { guidanceFile: "~/guidance.md" } }, {}, home)
    expect(fromHome.extract.guidance).toBe("## What to save\n\nDecisions and their reasons.")
    const absolute = parseConfig({ extract: { guidanceFile: join(home, "guidance.md") } }, {}, home)
    expect(absolute.extract.guidance).toBe(fromHome.extract.guidance)
  })

  test("rejects unusable extraction guidance files", () => {
    const home = tempDir("ocm-home-")
    writeFileSync(join(home, "empty.md"), "  \n")
    expect(() => parseConfig({ extract: { guidanceFile: "guidance.md" } }, {}, home)).toThrow(/absolute or ~\/ path/)
    expect(() => parseConfig({ extract: { guidanceFile: "~/missing.md" } }, {}, home)).toThrow(/cannot read/)
    expect(() => parseConfig({ extract: { guidanceFile: "~/empty.md" } }, {}, home)).toThrow(/is empty/)
    expect(() => parseConfig({ extract: { guidanceFile: "~/missing.md" } }, {}, home)).toThrow(MemoryConfigError)
  })

  test("rejects guidance and guidanceFile together, and empty guidance", () => {
    expect(() => parseConfig({ extract: { guidance: "x", guidanceFile: "/tmp/x.md" } }, {})).toThrow(
      /either guidance or guidanceFile/,
    )
    expect(() => parseConfig({ extract: { guidance: "   " } }, {})).toThrow(/extract\.guidance/)
  })

  test("only reads CLAUDE_CONFIG_DIR from the environment", () => {
    const env = {
      CLAUDE_CONFIG_DIR: "/tmp/claude-home",
      OPENCODE_MEMORY_AGENT: "memory",
      OPENCODE_MEMORY_RECALL_AGENT: "memory",
      OPENCODE_MEMORY_EXTRACT: "0",
    }
    const config = parseConfig({}, env)
    expect(config.claudeConfigDir).toBe("/tmp/claude-home")
    expect(config.extract.enabled).toBe(true)
    expect(config.agents.recall).toBe("opencode-memory-recall")
  })

  test("falls back to ~/.claude for a blank CLAUDE_CONFIG_DIR", () => {
    expect(resolveClaudeConfigDir({ CLAUDE_CONFIG_DIR: "  " })).toBe(join(homedir(), ".claude"))
  })

  test("schema is exported for user-side validation", () => {
    expect(MemoryOptionsSchema.safeParse({ extract: { enabled: false } }).success).toBe(true)
    expect(MemoryOptionsSchema.safeParse({ nope: true }).success).toBe(false)
  })
})
