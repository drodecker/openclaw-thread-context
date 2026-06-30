I built a small userland plugin that covers the **context-injection** part of this today, without any core changes: **[openclaw-thread-context](https://github.com/drodecker/openclaw-thread-context)**.

It's a `before_prompt_build` hook that parses `channelId` + `thread_ts` out of the session key (`agent:main:slack:channel:<channelId>:thread:<thread_ts>`), looks up a per-thread record on disk, and returns `appendSystemContext` so each Slack thread gets its own custom instructions/knowledge appended to the system prompt — scoped to that thread, no bleed into others. It uses a hook rather than the context-engine slot so it composes with legacy/memory/RAG engines instead of replacing them.

What it deliberately does **not** solve (and where I think the real product decision lives):

- thread-aware **session-key construction** — I'm parsing an existing key, not changing routing;
- per-thread **memory isolation**;
- multi-agent **routing** per thread.

Sharing in case the hook seam is a useful "good enough today" answer for the injection slice, and to help scope what genuinely needs core support. Happy to adapt the plugin if the session-key/routing direction firms up.
