/**
 * openclaw-thread-context
 *
 * OpenClaw plugin that hydrates the system prompt with per-Slack-thread context.
 *
 * Implemented as a `before_prompt_build` hook (not a context engine): it reads
 * the channelId + thread_ts from the run's session key, looks up a stored
 * context record, and returns `appendSystemContext` so the text is appended to
 * the system prompt for the turn. This composes with whatever context engine is
 * active (legacy/memory/RAG) instead of seizing the exclusive contextEngine
 * slot, and "append after base" is automatic — the base prompt is already built
 * by the time this hook runs.
 *
 * Verified against openclaw/openclaw@main:
 *  - hook signature: src/plugins/hook-types.ts  `before_prompt_build(event, ctx)`
 *  - event/result:   src/plugins/hook-before-agent-start.types.ts
 *  - ctx fields:     PluginHookAgentContext (sessionKey/sessionId/channelId/workspaceDir)
 *  - entry/api.on:   src/plugin-sdk/plugin-entry.ts, docs/plugins/hooks.md
 *
 * `appendSystemContext` is appended to the *system* prompt and is prompt-cache
 * friendly (stable within a thread). before_prompt_build is not in the
 * allowConversationAccess-gated hook set, so it is honored by default unless an
 * operator sets plugins.entries.<id>.hooks.allowPromptInjection = false.
 *
 * See DESIGN.md for the full spec.
 */

import { promises as fs } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const PLUGIN_ID = "openclaw-thread-context";

/** JSON Schema for plugin config; mirrors openclaw.plugin.json's configSchema. */
const CONFIG_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    enabled: { type: "boolean", default: false },
    contextDir: { type: "string" },
    useChannelSubFolder: { type: "boolean", default: false },
  },
} as const;

interface PluginConfig {
  enabled: boolean;
  contextDir: string;
  useChannelSubFolder: boolean;
}

interface ThreadContextRecord {
  threadId: string;
  additionalContext: string;
  generatedAt?: string;
}

/** Matches `...:channel:<channelId>:thread:<thread_ts>` and pulls both ids. */
const SESSION_RE = /:channel:([^:]+):thread:([^:]+)$/;

function parseSession(sessionKey: string): { channelId?: string; threadId?: string } {
  const m = SESSION_RE.exec(sessionKey ?? "");
  if (!m) return {};
  return { channelId: m[1], threadId: m[2] };
}

/**
 * Resolve plugin config from the per-handler-injected ctx.pluginConfig.
 * A relative contextDir is resolved against the run's workspaceDir.
 */
function resolveConfig(ctx: any): PluginConfig {
  const raw = (ctx?.pluginConfig ?? {}) as Record<string, unknown>;
  const baseDir = (typeof ctx?.workspaceDir === "string" && ctx.workspaceDir) || process.cwd();
  const contextDir = typeof raw.contextDir === "string" ? raw.contextDir : "";
  return {
    enabled: raw.enabled === true,
    contextDir: contextDir && !isAbsolute(contextDir) ? resolve(baseDir, contextDir) : contextDir,
    useChannelSubFolder: raw.useChannelSubFolder === true,
  };
}

// --- threads.json cache (by path + mtime) ----------------------------------
const threadsJsonCache = new Map<string, { mtimeMs: number; records: ThreadContextRecord[] }>();

async function readThreadsJson(path: string): Promise<ThreadContextRecord[] | null> {
  let stat;
  try {
    stat = await fs.stat(path);
  } catch {
    return null; // missing file is normal
  }
  const cached = threadsJsonCache.get(path);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.records;
  try {
    const parsed = JSON.parse(await fs.readFile(path, "utf8"));
    const records: ThreadContextRecord[] = Array.isArray(parsed) ? parsed : [];
    threadsJsonCache.set(path, { mtimeMs: stat.mtimeMs, records });
    return records;
  } catch (err) {
    console.warn(`[${PLUGIN_ID}] failed to parse ${path}:`, err);
    return null;
  }
}

async function readThreadFile(path: string): Promise<ThreadContextRecord | null> {
  try {
    const rec = JSON.parse(await fs.readFile(path, "utf8")) as ThreadContextRecord;
    return rec && typeof rec.additionalContext === "string" ? rec : null;
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      console.warn(`[${PLUGIN_ID}] failed to read ${path}:`, err);
    }
    return null;
  }
}

/**
 * Resolve the additionalContext string for a (channelId, threadId), or null.
 * Per-thread file takes precedence over threads.json; threads.json is checked
 * in both the channel subfolder and the contextDir root.
 */
export async function obtainThreadContext(
  config: PluginConfig,
  channelId?: string,
  threadId?: string,
): Promise<string | null> {
  if (!config?.enabled || !config.contextDir) return null;
  if (!channelId || !threadId) return null; // not a Slack thread => no context

  const threadDir = config.useChannelSubFolder
    ? join(config.contextDir, channelId)
    : config.contextDir;

  // 1. Preferred: per-thread file (threadId keeps the dot).
  const perThread = await readThreadFile(join(threadDir, `slack-thread-${threadId}.json`));
  if (perThread) return perThread.additionalContext;

  // 2. Fallback: threads.json — check channel subfolder first, then contextDir root.
  const candidatePaths = [join(threadDir, "threads.json")];
  if (threadDir !== config.contextDir) candidatePaths.push(join(config.contextDir, "threads.json"));

  for (const path of candidatePaths) {
    const records = await readThreadsJson(path);
    const hit = records?.find((r) => r.threadId === threadId);
    if (hit?.additionalContext) return hit.additionalContext;
  }

  return null;
}

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "OpenClaw Thread Context",
  description: "Appends per-Slack-thread context to the system prompt via before_prompt_build.",
  configSchema: CONFIG_SCHEMA as any,
  register(api: any) {
    api.on("before_prompt_build", async (_event: any, ctx: any) => {
      try {
        const config = resolveConfig(ctx);
        if (!config.enabled) return; // no-op == default behavior

        // The session key carries `...:channel:<channelId>:thread:<thread_ts>`.
        const sessionKey = ctx?.sessionKey ?? ctx?.sessionId ?? "";
        const parsed = parseSession(sessionKey);
        const channelId = parsed.channelId ?? ctx?.channelId;
        const threadId = parsed.threadId;

        const additionalContext = await obtainThreadContext(config, channelId, threadId);
        if (!additionalContext) return; // nothing to inject

        // Appended to the system prompt; stable within a thread => cache-friendly.
        return { appendSystemContext: additionalContext };
      } catch (err) {
        // Never let context lookup break a run.
        console.warn(`[${PLUGIN_ID}] before_prompt_build failed:`, err);
        return;
      }
    });
  },
});
