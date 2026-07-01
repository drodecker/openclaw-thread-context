# openclaw-thread-context

An OpenClaw plugin that hydrates the system prompt with per-Slack-thread context, implemented
as a [`before_prompt_build`](https://docs.openclaw.ai/plugins/hooks) hook.

## What it does

Before each model call, OpenClaw runs the `before_prompt_build` hook with the run's agent
context. For Slack threads the session key looks like:

```
agent:main:slack:channel:<channelId>:thread:<thread_ts>
```

The hook extracts `channelId` and `thread_ts`, looks up a stored context record for that
thread, and returns `appendSystemContext` so the record's `additionalContext` is appended to
the system prompt for the turn. When there is no thread context the hook returns nothing and
the run is unchanged.

## Why a hook (not a context engine)

The original sketch targeted the context-engine `assemble` event, but `assemble` is only
reachable by *owning* the single exclusive `plugins.slots.contextEngine` slot — which would
displace `legacy`/memory/RAG engines and force us to reimplement their ingest/assemble/compact
behavior. A `before_prompt_build` hook is the purpose-built seam for exactly this ("add dynamic
context or system-prompt text before the model call"), and the docs say to *"use the
phase-specific hooks for new plugins."* Benefits:

- **Composable** — coexists with any active context engine; doesn't take the exclusive slot.
- **"Append after base" is free** — the base system prompt (incl. memory guidance from the
  active engine) is already built when the hook runs, so `appendSystemContext` lands after it.
- **Cache-friendly** — `appendSystemContext` (vs `appendContext`) appends to the *system*
  prompt, which is stable within a thread and so prompt-cacheable.
- **No special gating** — `before_prompt_build` is **not** in the `allowConversationAccess`
  hook set, so it is honored by default. Only `plugins.entries.<id>.hooks.allowPromptInjection
  = false` would disable it.

### Verified against actual source (`openclaw/openclaw@main`)

- Register via `definePluginEntry({ id, name, description, configSchema, register(api){...} })`
  from `openclaw/plugin-sdk/plugin-entry`, then `api.on("before_prompt_build", handler)`
  (`docs/plugins/hooks.md`, `src/plugin-sdk/plugin-entry.ts`).
- Handler signature (`src/plugins/hook-types.ts`):
  `before_prompt_build(event: PluginHookBeforePromptBuildEvent, ctx: PluginHookAgentContext)`.
- `PluginHookBeforePromptBuildEvent = { prompt: string; messages: unknown[] }`
  (`src/plugins/hook-before-agent-start.types.ts`).
- `PluginHookBeforePromptBuildResult = { systemPrompt?; prependContext?; appendContext?;
  prependSystemContext?; appendSystemContext? }` — we return `appendSystemContext`.
- `PluginHookAgentContext` provides `sessionKey`, `sessionId`, `channelId`, `messageProvider`,
  `workspaceDir`, plus the per-handler-injected resolved `pluginConfig`.

### Packaging (verified)

- Imports use the **unscoped** focused subpath `openclaw/plugin-sdk/plugin-entry` (the docs'
  "Import conventions" forbid the root barrel; `@openclaw/plugin-sdk` is the internal workspace
  package, not the consumer import).
- External code plugins **must** declare `openclaw.compat.pluginApi` and
  `openclaw.build.openclawVersion` (`packages/plugin-package-contract`:
  `EXTERNAL_CODE_PLUGIN_REQUIRED_FIELD_PATHS`); both are in `package.json` with placeholder
  versions to pin at build time, plus `minGatewayVersion`/`pluginSdkVersion` and `extensions`
  pointing at built JS (`./dist/index.js`).
- A root **`openclaw.plugin.json`** manifest (`id` + `configSchema` + `activation.onStartup`)
  lets config validate and the plugin load at startup without a slot declaration. No `kind`
  (that field is only for the exclusive `plugins.slots.*` engines).

## Configuration (`openclaw.json`)

Config keys sit directly on the plugin entry and reach the hook as the per-handler-injected
`ctx.pluginConfig`. A relative `contextDir` is resolved against `ctx.workspaceDir`. No
`plugins.slots` entry is needed.

```json5
{
  plugins: {
    entries: {
      "openclaw-thread-context": {
        enabled: true,                       // feature toggle; false => hook is a no-op
        contextDir: "/var/lib/openclaw/thread-context",
        useChannelSubFolder: true,           // per-thread files under <contextDir>/<channelId>/
      },
    },
  },
}
```

## Lookup algorithm (`obtainThreadContext`)

Inputs: `channelId`, `threadId` (the raw `thread_ts`, e.g. `1782413062.538549`).

1. If `config.enabled` is false → return `null` (no-op).
2. If `channelId` **or** `threadId` is missing → return `null` (non-Slack/non-thread run).
3. Resolve candidate thread directories: `join(contextDir, id)` for `channelId` and both its
   case variants when `useChannelSubFolder`, else just `contextDir`. Channel ids are matched
   case-insensitively since Slack channel ids and directory casing don't always agree.
4. **Per-thread file (preferred, fastest)** — `slack-thread-<threadId>.json` in each candidate
   dir, in order.
   - `threadId` keeps the dot: `slack-thread-1782413062.538549.json`.
   - File is a **single record**. If present and parseable → resolve via `contextFromRecord`
     (below) and return the result if non-empty.
5. **Fallback `threads.json` (array)** — *check both* locations, in order:
   1. `join(threadDir, "threads.json")` (channel-scoped, when `useChannelSubFolder`)
   2. `join(contextDir, "threads.json")` (global root)
   - First file containing a record whose `threadId === threadId` wins → resolve via
     `contextFromRecord` and return the result if non-empty.
6. Nothing found → return `null`.

`contextFromRecord` combines a record's `workspacePath` file content with its inline
`additionalContext` — see "Supplemental workspace files" below for the merge order.

The per-thread file always takes precedence over `threads.json` (faster: a direct stat/read
vs. parsing/searching a potentially large array).

## Record shape

Per-thread file (single object) / each element of `threads.json` (array):

```json
{
  "threadId": "1782413062.538549",
  "additionalContext": "Lead: ABC Plumbing. Contact Mike. Emergency leak repair. Wants callback today.",
  "generatedAt": "2026-06-29T18:22:00-06:00"
}
```

`generatedAt` is metadata (provenance / future staleness checks); not used for hydration.

### Supplemental workspace files (optional)

A record may also set `workspacePath` (absolute dir) and optionally `files` (default
`["AGENTS.md", "IDENTITY.md", "USER.md", "THREAD.md"]`, no path separators allowed). When set,
the plugin reads those files fresh each turn and renders them as `### <file>\n<contents>`
sections.

`workspacePath` content and `additionalContext` are **supplemental, not exclusive** — neither
one supersedes the other. When both are present on a record they are concatenated, workspace
files first and `additionalContext` appended after (so the more specific/dynamic per-thread text
lands closest to the model's next turn). When only one is present, that one is used as-is.

```json
{
  "threadId": "1782413062.538549",
  "workspacePath": "/root/.openclaw/workspaces/profile_124955",
  "additionalContext": "Lead: ABC Plumbing. Contact Mike. Emergency leak repair. Wants callback today.",
  "generatedAt": "2026-06-29T18:22:00-06:00"
}
```

Use this when the bulk of the context is a slower-changing, business-level workspace (business
identity, agent role) that shouldn't be duplicated into every thread's JSON, plus a small
per-thread/per-lead `additionalContext` string layered on top.

## System prompt composition ("append after base")

No explicit composition is needed. The active context engine builds the base system prompt
(including memory/wiki guidance) *before* `before_prompt_build` runs; returning
`appendSystemContext` makes the host append our thread context after that base. So "append
after base" is structural, not something this plugin computes.

## No-op / safety guarantees

The hook returns nothing (run unchanged) when:
- `enabled` is false,
- the run is not a Slack thread (no `channelId`/`thread_ts` in the session key),
- no matching context file/record exists, or
- a file read/parse error occurs (logged as a warning; the handler **never throws** — a throw
  is caught and treated as no-op).

## Performance notes

- Per-thread file: read fresh each turn (single small file — cheap).
- `threads.json`: parsed array cached by `path + mtime`; re-parsed only when the file changes.
- Optional `hooks.timeouts.before_prompt_build` can bound the handler if a context store is slow.

## Verified from source (`openclaw/openclaw@main`)

- Hook map + handler signature: `src/plugins/hook-types.ts` (`before_prompt_build(event, ctx)`).
- Event/result types: `src/plugins/hook-before-agent-start.types.ts` (`appendSystemContext`).
- `ctx` (`PluginHookAgentContext`) fields incl. `sessionKey`/`channelId`/`workspaceDir`:
  `src/plugins/hook-types.ts`.
- Entry/`api.on` + `definePluginEntry`: `src/plugin-sdk/plugin-entry.ts`, `docs/plugins/hooks.md`.
- Import-path convention + packaging: `docs/plugins/building-plugins.md`,
  `packages/plugin-package-contract`.

## Open items to confirm against a live install

- **Version pins**: `compat.pluginApi` / `build.openclawVersion` / `pluginSdkVersion` use the
  doc's example values — pin to the target release before publishing.
- **`extensions` target**: set to built `./dist/index.js` per "published plugins point at built
  JS"; in-repo/source-checkout dev uses the pnpm `extensions/*` workspace instead.

## Resolved against a live install

- **`pluginConfig` delivery to the hook**: on the deployed runtime it arrives as
  `event.context.pluginConfig`, not `ctx.pluginConfig`. The handler now reads
  `event?.context?.pluginConfig ?? ctx?.pluginConfig ?? api?.pluginConfig` to cover both shapes.
- **`contextDir` `~` expansion**: config files write `contextDir: "~/.openclaw/thread-context"`;
  `resolveConfig` expands a leading `~` to `homedir()` before resolving relative paths.
- **Channel id casing**: Slack channel ids and on-disk subfolder names don't reliably agree on
  case; `obtainThreadContext` checks the id as given plus its upper/lower variants.
