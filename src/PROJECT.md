# Memory agents follow the session model

Fork: `rklosinski/opencode-claude-memory`, branch `feat/configurable-extraction`.
Status (2026-11-24): implemented, tested, built to `dist/`, committed as `e09b35e`. Dream unpinned
2026-11-24 (config only, no code change); its first run on the session model is not yet verified.

## Problem

The three memory agents (`opencode-memory-extract`, `-recall`, `-dream`) run model calls of
their own: extraction and dream as forked child sessions, recall as a one-shot
`ctx.generate.text` call. The plugin passed a model only when the agent had a `model` pin in
the opencode config (`agent.opencode-memory-*.model`); without one it sent no model at all.

With no global `model` key and no pins, opencode does not fall back to the parent session's
model. It picks its own default provider, which here was `opencode` (Zen), still allowed by
`experimental.policies`. When that provider's API key expired, every extraction failed:

```
opencode-memory extraction: provider.auth: This API key has expired. ...
```

Pinning the agents works, but it breaks the goal of using whatever model is active: switching
between `omlx/Qwen3.8-Flash-Next-instrut` and `omlx/GLM-5.3-Flash` with `/model` would leave
the memory agents on the pinned one. Setting the pin when opencode launches has the same flaw,
because it cannot see a `/model` switch made inside a session.

## Design

When a memory agent has **no** pin, the plugin picks the model of the session the agent is
working for, at the moment it runs. Sources, in order:

| # | Source | How it is obtained | Why |
|---|--------|--------------------|-----|
| 1 | Agent pin | `ctx.agent.get(name).model` | Explicit config always wins (no memory agent is pinned now) |
| 2 | Session's selected model | `ctx.session.get({sessionID}).model` (`SessionInfo.model`) | Reflects a `/model` switch at once, including that turn's recall |
| 3 | Model of the session's latest request | Recorded in the `session.hook("context")` handler from `event.model` | Fallback if `session.get` is missing, fails or has no model |
| 4 | Latest model seen in any session | Same recording, last value overall | A session the plugin has not seen yet |
| 5 | Host default | No model sent (previous behaviour) | Nothing known yet |

The parent session is the one being extracted (`parentSessionID`, already passed to
`runFork`) or the one whose turn is being recalled (already passed to `generate`).

All three agents are unpinned. Dream consolidates across sessions, but it still has a parent:
`AutoDream.maybeRun(parentSessionID)` (`src/extraction/autodream.ts`) runs right after a
successful extraction and passes the extracted session to `runFork`. So dream follows that
session's model (source 2 or 3), the same as extraction, and falls back to 4 or 5 only when it
knows nothing about that session.

The first version kept dream pinned to `omlx/Qwen3.8-Flash-Next-instrut`, on the assumption that a
job not tied to one session has no session model to follow. That assumption was wrong (see
*Incident: stale dream pin* below), and the pin made dream depend on one particular model
profile staying in the provider config.

### Considered and rejected

- **Pin all three agents in config.** Works, but ignores `/model` switches.
- **Keep dream pinned.** That was the first version. A pin has to be updated by hand whenever
  that model profile is renamed or removed, and dream failed when it was.
- **Write the pin when opencode launches** (oc-helpers wrapper). Fixed for the whole session, so
  it misses switches made inside opencode.
- **Read the model from the parent's message history.** `SessionInfo.model` is the selected
  model directly and needs no message parsing.

## Implementation

### `src/host/v2/fork.ts`
- `V2SessionApi` gains an optional `get?(input: { sessionID }) => Promise<{ model?: ModelRef } | undefined>`.
  Optional so older hosts and the test mocks still fit the type.

### `src/host/v2/host.ts`
- `sessionModels: Map<sessionID, ModelRef>` plus `lastModel`. The map is capped at
  `SESSION_MODELS_MAX = 200` entries; the oldest is dropped (insertion order, refreshed on
  each note).
- `noteModel(sessionID, model)`: records `{ id, providerID, variant? }`, ignoring incomplete refs.
- `modelFor(agentName, pinned, parentSessionID)` (async): applies the source order above and logs
  one debug line per call:
  ```
  DEBUG Memory agent follows the session model {"agent":"opencode-memory-extract","parentSessionID":"ses_…","model":"omlx/GLM-5.3-Flash","source":"session"}
  ```
  `source` is `session`, `last request` or `latest seen`; `model` is `(host default)` when
  nothing is known.
- `selectedModel(sessionID)`: `session.get` under `SDK_READ_TIMEOUT_MS`; any error or missing
  model yields `undefined`, so the next source applies.
- `generate()` (recall) and `fork()` (extract, dream) now pass `await modelFor(...)` instead of
  `agent?.model`.

### `src/host/v2/plugin.ts`
- In the `context` hook, after the fork and owned-session early returns, call
  `host.noteModel(sessionID, event.model)`. Only real user sessions are recorded, never memory
  forks.

### Tests: `test/v2/sessionModel.test.ts` (new, 5 tests)
- No model seen: no model sent (host default).
- Fork and generate follow the parent session's latest model and switch with it.
- Unknown session: falls back to the latest model seen anywhere.
- A pinned agent model always wins.
- `session.get`'s selected model beats the recorded request model; without it, falls back.

`bun run typecheck` clean, `bun test` 369 pass / 2 skip / 0 fail, `biome ci` clean on the
changed files (the repo-wide `biome ci` already failed before this change).

## Configuration (`~/.config/opencode/opencode.json`)

```jsonc
"agent": {
  "opencode-memory-extract": {},                                    // follows session
  "opencode-memory-recall":  {},                                    // follows session
  "opencode-memory-dream":   {}                                     // follows session
},
"plugins": [{
  "package": "file:///Users/rich/workspace/rck/opencode-claude-memory/dist",
  "options": { "extract": { "guidanceFile": "...", "maxConversationChars": 150000,
                            "maxToolOutputChars": 2000, "timeoutMs": 300000 } }
}]
```

- `extract.timeoutMs` was raised from the 120 s default to 300 s. Switching models on the oMLX
  server takes time to load the new model, and the first GLM extraction after a switch timed out
  at 120 s. Extraction runs in the background, so the longer limit costs nothing.
- `recall.timeoutMs` stays at 30 s: the turn waits on recall, so a slow model switch just skips
  recall for that turn instead of holding up the reply.
- Backups: `opencode.json.bak-mempin-*` (before re-pinning), `.bak-memfollow-*` (before
  unpinning extract and recall), `.bak-extimeout-*` (before the timeout change),
  `.bak-dreamunpin-*` (before unpinning dream).

## Incident: stale dream pin (2026-11-24)

The `omlx/Qwen3.8-Flash-Next-instrut` model profile was removed from the provider config, on the
assumption that every memory agent used whichever model was loaded. Dream's pin still named it,
so dream failed twice ("model isn't loadable on the omlx server"). Extraction and recall were
unaffected: they were unpinned and logged `omlx/Qwen3.8-Flash-Next` (source: session). One dream
attempt at 18:53Z also hit the 300 s `autodream.timeoutMs`.

Fix: removed the pin (`"opencode-memory-dream": {}`), then ran `opencode service restart`. A failed
dream leaves its gate open, so it retries after the next successful extraction.

Lessons:
- Removing a model profile does not remove pins that name it. Check `agent.opencode-memory-*`
  before you remove a profile.
- Processes started before a config change keep the old config. At the time of the fix, an
  `opencode --standalone` and an `opencode serve --stdio` (2.3.2) from 2026-11-23 were still
  running, and either could still run dream with the stale pin.

## Verification (live, temporary `opencode serve` in `/tmp/oc-test`)

| Turn | Session model | Recall used | Extract used | Result |
|------|---------------|-------------|--------------|--------|
| 1 | Qwen3.8-Flash-Next-instrut | Qwen (source: session) | Qwen (source: session) | Completed in ~6 s, saved nothing (generic question; correct) |
| 2 (after `--model` switch) | GLM-5.3-Flash | GLM (source: session) | GLM (source: session) | Timed out at 120 s (before the timeout was raised); not re-tested |

Earlier test with only the extract agent pinned to omlx: extraction completed and saved a correct
memory, which confirmed the expired Zen key as the only cause of the failures.

### Testing notes
- `opencode run` exits before the 10 s idle debounce, so extraction never fires from it. Run
  `opencode serve --port N` (it prints a password; export it as `OPENCODE_PASSWORD`) and send
  turns with `opencode run --server http://127.0.0.1:N [-s <sessionID>] --model ...`.
- If the main agent calls `memory_save` during a turn, the next extraction round is skipped by
  design. Word test prompts so the main agent won't save.
- Log: `~/.claude/opencode-memory/<project-dir-with-dashes>/opencode-memory.log`.

## Deploying

1. `bun run build` in this repo (already done for the current changes).
2. `opencode service restart`, then quit and relaunch any `opencode --standalone` session.
   Processes started before the build still have the old plugin loaded.
3. Check the log for `Memory agent follows the session model` lines naming the active model,
   for `opencode-memory-extract` and `opencode-memory-recall` after a turn, and for
   `opencode-memory-dream` after the next consolidation. Pinned agents log no such line, so a dream
   run without one is still using a pin.

## Open items

- Re-test a GLM extraction after a model switch with the 300 s timeout.
- On the first turn after a model switch, recall may time out at 30 s while the new model loads.
  This is accepted for now.
- Verify dream on the session model: the next `Memory agent follows the session model` line for
  `opencode-memory-dream`, followed by `Auto-dream consolidation completed`.
- Quit the pre-fix `opencode --standalone` and `opencode serve --stdio` (2.3.2) processes from
  2026-11-23.
- Decide whether to offer this upstream (a session-following fallback is likely useful
  to anyone running memory agents without pins).
- Untracked `src/.ts` (empty) and `src/.vscode/` appeared at 13:41–13:42 on 2026-11-23, around
  the rebuild. Their origin is unknown (a tool run or the editor); check them before committing.
