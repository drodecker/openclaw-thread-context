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
import { homedir } from "node:os";
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
  /** Inline context text. Combined with workspacePath content when both are present. */
  additionalContext?: string;
  /** Optional: directory to read supplemental context files from (see `files`). */
  workspacePath?: string;
  /** Filenames (relative to workspacePath, no path separators) to read, in order. */
  files?: string[];
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
 * Resolve plugin config from the plugin entry config injected by OpenClaw.
 * A relative contextDir is resolved against the run's workspaceDir; `~` is
 * expanded to the current user's home directory for config-file ergonomics.
 */
function resolveConfig(input: { pluginConfig?: unknown; workspaceDir?: unknown }): PluginConfig {
  const raw = (input?.pluginConfig ?? {}) as Record<string, unknown>;
  const baseDir = (typeof input?.workspaceDir === "string" && input.workspaceDir) || process.cwd();
  const rawContextDir = typeof raw.contextDir === "string" ? raw.contextDir : "";
  const contextDir =
    rawContextDir === "~" ? homedir() : rawContextDir.startsWith("~/") ? join(homedir(), rawContextDir.slice(2)) : rawContextDir;
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
    return rec && (typeof rec.additionalContext === "string" || typeof rec.workspacePath === "string") ? rec : null;
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      console.warn(`[${PLUGIN_ID}] failed to read ${path}:`, err);
    }
    return null;
  }
}

async function readOptionalText(path: string): Promise<string | null> {
  try {
    return (await fs.readFile(path, "utf8")).trim();
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      console.warn(`[${PLUGIN_ID}] failed to read workspace file ${path}:`, err);
    }
    return null;
  }
}

/** Reads `record.files` (default AGENTS/IDENTITY/USER/THREAD.md) out of workspacePath, if set. */
async function contextFromWorkspace(record: ThreadContextRecord): Promise<string | null> {
  const workspacePath = typeof record.workspacePath === "string" ? record.workspacePath.trim() : "";
  if (!workspacePath || !isAbsolute(workspacePath)) return null;

  const files = Array.isArray(record.files) && record.files.length > 0
    ? record.files
    : ["AGENTS.md", "IDENTITY.md", "USER.md", "THREAD.md"];

  const sections: string[] = [
    "OpenClaw plugin-injected thread context for this lead. Treat these sections as thread-scoped workspace files.",
  ];

  for (const file of files) {
    if (typeof file !== "string" || file.includes("/") || file.includes("\\") || file === "." || file === "..") continue;
    const text = await readOptionalText(join(workspacePath, file));
    if (text) sections.push(`### ${file}\n${text}`);
  }

  return sections.length > 1 ? sections.join("\n\n") : null;
}

/**
 * Combines workspacePath-derived file context with inline additionalContext.
 * Neither one supersedes the other: when both are present, additionalContext
 * is supplemental and is appended after the workspace files (so the more
 * specific/dynamic per-thread text lands last, closest to the model's next
 * turn). When only one is present, that one is returned as-is.
 */
async function contextFromRecord(record: ThreadContextRecord): Promise<string | null> {
  const workspaceContext = await contextFromWorkspace(record);
  const inlineContext =
    typeof record.additionalContext === "string" && record.additionalContext.trim()
      ? record.additionalContext.trim()
      : null;

  if (workspaceContext && inlineContext) return [workspaceContext, inlineContext].join("\n\n");
  return workspaceContext ?? inlineContext;
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

  const channelIds = Array.from(new Set([channelId, channelId.toUpperCase(), channelId.toLowerCase()]));
  const threadDirs = config.useChannelSubFolder
    ? channelIds.map((id) => join(config.contextDir, id))
    : [config.contextDir];

  // 1. Preferred: per-thread file (threadId keeps the dot).
  for (const threadDir of threadDirs) {
    const perThread = await readThreadFile(join(threadDir, `slack-thread-${threadId}.json`));
    if (perThread) {
      const context = await contextFromRecord(perThread);
      if (context) return context;
    }
  }

  // 2. Fallback: threads.json — check channel subfolder first, then contextDir root.
  const candidatePaths = threadDirs.map((threadDir) => join(threadDir, "threads.json"));
  if (!candidatePaths.includes(join(config.contextDir, "threads.json"))) {
    candidatePaths.push(join(config.contextDir, "threads.json"));
  }

  for (const path of candidatePaths) {
    const records = await readThreadsJson(path);
    const hit = records?.find((r) => r.threadId === threadId);
    if (hit) {
      const context = await contextFromRecord(hit);
      if (context) return context;
    }
  }

  return null;
}

const pluginEntry: any = definePluginEntry({
  id: PLUGIN_ID,
  name: "OpenClaw Thread Context",
  description: "Appends per-Slack-thread context to the system prompt via before_prompt_build.",
  configSchema: CONFIG_SCHEMA as any,
  register(api: any) {
    api.on("before_prompt_build", async (event: any, ctx: any) => {
      try {
        const pluginConfig = event?.context?.pluginConfig ?? ctx?.pluginConfig ?? api?.pluginConfig;
        const config = resolveConfig({
          pluginConfig,
          workspaceDir: ctx?.workspaceDir,
        });
        if (!config.enabled) return; // no-op == default behavior

        // The session key carries `...:channel:<channelId>:thread:<thread_ts>`.
        const sessionKey = ctx?.sessionKey ?? ctx?.sessionId ?? "";
        const parsed = parseSession(sessionKey);
        const channelId = parsed.channelId ?? ctx?.channelId;
        const threadId = parsed.threadId;

        const additionalContext = await obtainThreadContext(config, channelId, threadId);
        if (!additionalContext) return; // nothing to inject
        api.logger?.debug?.(
          `thread context matched channel=${channelId ?? ""} thread=${threadId ?? ""} chars=${additionalContext.length}`,
        );

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

export default pluginEntry;
