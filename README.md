# openclaw-thread-context

An [OpenClaw](https://openclaw.ai) plugin that injects **per-Slack-thread context** into the
system prompt. Each Slack thread can carry its own custom instructions / knowledge (a lead
brief, a client context, a job-site summary, …) that the agent sees only while replying in
that thread.

It is implemented as a [`before_prompt_build`](https://docs.openclaw.ai/plugins/hooks) hook,
so it **composes** with whatever context engine you run (legacy/memory/RAG) instead of taking
the exclusive context-engine slot.

> Scope: this delivers the *context-injection* slice of
> [openclaw/openclaw#97341](https://github.com/openclaw/openclaw/issues/97341). It does **not**
> change session-key construction, per-thread memory isolation, or multi-agent routing — those
> need core changes.

## How it works

Before each model call the hook reads the run's session key:

```
agent:main:slack:channel:<channelId>:thread:<thread_ts>
```

extracts `channelId` + `thread_ts`, looks up a stored record, and returns `appendSystemContext`
so the record's `additionalContext` is appended to the system prompt for that turn. No thread
match → the hook does nothing and the run is unchanged.

## Install

```bash
# from this repository
openclaw plugins install git:github.com/drodecker/openclaw-thread-context@v0.1.0

# or local dev checkout
git clone https://github.com/drodecker/openclaw-thread-context
openclaw plugins install --link ./openclaw-thread-context
```

`npm install` runs the `prepare` build automatically, producing `dist/index.js`
(the entry referenced by `openclaw.extensions`).

Verify:

```bash
openclaw plugins list --enabled
openclaw plugins inspect openclaw-thread-context --runtime --json
```

## Configure

You can configure the plugin using the OpenClaw CLI for idempotent updates:

```bash
openclaw config set 'plugins.entries.openclaw-thread-context.enabled' true
openclaw config set 'plugins.entries.openclaw-thread-context.config.contextDir' "/var/lib/openclaw/thread-context"
openclaw config set 'plugins.entries.openclaw-thread-context.config.useChannelSubFolder' true
openclaw config validate
openclaw gateway restart
```

This will produce an entry in your configuration file that looks like this:

```json5
{
  "plugins": {
    "entries": {
      "openclaw-thread-context": {
        "enabled": true,
        "config": {
          "contextDir": "/var/lib/openclaw/thread-context",  // relative paths resolve against workspaceDir
          "useChannelSubFolder": true                        // per-thread files under <contextDir>/<channelId>/
        }
      }
    }
  }
}
```

Prompt-mutating hooks are honored by default; set
`plugins.entries["openclaw-thread-context"].hooks.allowPromptInjection = false` to disable.

## Context files

**Per-thread file** (preferred), at `<contextDir>[/<channelId>]/slack-thread-<thread_ts>.json`
— note `thread_ts` keeps its dot:

```json
{
  "threadId": "1782413062.538549",
  "additionalContext": "Lead: ABC Plumbing. Contact Mike. Emergency leak repair. Wants callback today.",
  "generatedAt": "2026-06-29T18:22:00-06:00"
}
```

**Fallback `threads.json`** — an array of the same records. Looked up in the channel subfolder
first, then `<contextDir>` root. The per-thread file always wins (a direct read vs. scanning an
array); `threads.json` is parsed once and cached by mtime.

See [`examples/`](./examples) for working samples and [`DESIGN.md`](./DESIGN.md) for the full
spec and the source citations the implementation is verified against.

## Develop

```bash
npm install
npm run typecheck
npm run build
```

## License

MIT
