/**
 * Session ingestion hooks for Valence (CLI backend).
 * Captures conversation sessions as sources for compilation into knowledge articles.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { ValenceConfig } from "./config.js";
import { valenceExec } from "./client.js";

/**
 * Module-level session tracking.
 * Maps channel/provider info to sessionId for cross-hook routing.
 */
let currentSessionId: string | undefined;
let currentChannel: string = "unknown";
let currentPlatform: string = "openclaw";

/**
 * Register all session lifecycle hooks.
 * Every hook is wrapped in try/catch — session ingestion MUST NOT break the main agent flow.
 */
export function registerSessionHooks(
  api: OpenClawPluginApi,
  cfg: ValenceConfig,
  log: { info: (msg: string) => void; warn: (msg: string) => void },
): void {
  // 0. before_agent_start — Capture session metadata for other hooks
  api.on("before_agent_start", async (_event, ctx) => {
    try {
      if (ctx.sessionKey || ctx.sessionId) {
        currentSessionId = ctx.sessionKey || ctx.sessionId;
        currentChannel = ctx.messageProvider || "unknown";
      }
    } catch (err) {
      log.warn(`valence-sessions: before_agent_start tracking failed: ${String(err)}`);
    }
  });

  // 1. session_start — Create/resume session
  api.on("session_start", async (event, ctx) => {
    try {
      const sessionId = ctx.sessionId || event.sessionId;
      if (!sessionId) return;

      const args = [
        "sessions", "start", sessionId,
        "--platform", currentPlatform,
        "--channel", currentChannel || "unknown"
      ];

      await valenceExec(cfg, args);
    } catch (err) {
      log.warn(`valence-sessions: session_start failed: ${String(err)}`);
    }
  });

  // 2. message_received — Append user message
  api.on("message_received", async (event, ctx) => {
    try {
      const sessionId = currentSessionId;
      if (!sessionId || !event.content) return;

      const content = typeof event.content === "string" ? event.content : JSON.stringify(event.content);
      const speaker = event.from || "user";

      const args = [
        "sessions", "append", sessionId,
        "--role", "user",
        "--speaker", speaker,
        "--content", content
      ];

      await valenceExec(cfg, args);
    } catch (err) {
      log.warn(`valence-sessions: message_received failed: ${String(err)}`);
    }
  });

  // 3. llm_output — Append assistant message
  api.on("llm_output", async (event, ctx) => {
    try {
      const sessionId = currentSessionId || ctx.sessionKey || ctx.sessionId;
      if (!sessionId) return;

      const content = (event.lastAssistant != null ? String(event.lastAssistant) : null) || (event.assistantTexts || []).join("\n");
      if (!content) return;

      const speaker = event.model || "assistant";

      const args = [
        "sessions", "append", sessionId,
        "--role", "assistant",
        "--speaker", speaker,
        "--content", content
      ];

      await valenceExec(cfg, args);
    } catch (err) {
      log.warn(`valence-sessions: llm_output failed: ${String(err)}`);
    }
  });

  // 4. before_compaction — Flush session (PRIMARY flush trigger)
  api.on("before_compaction", async (_event, ctx) => {
    try {
      const sessionId = currentSessionId || ctx.sessionKey || ctx.sessionId;
      if (!sessionId) return;

      const args = ["sessions", "flush", sessionId];
      if (cfg.autoCompileOnFlush) {
        // Note: CLI flush doesn't have --compile flag, we'd need to call compile separately
        await valenceExec(cfg, args);
        await valenceExec(cfg, ["sessions", "compile", sessionId], { timeout: 120000 });
        log.info(`valence-sessions: flushed and compiled session ${sessionId} (pre-compaction)`);
      } else {
        await valenceExec(cfg, args);
        log.info(`valence-sessions: flushed session ${sessionId} (pre-compaction)`);
      }
    } catch (err) {
      log.warn(`valence-sessions: before_compaction flush failed: ${String(err)}`);
    }
  });

  // 5. session_end — Finalize session
  api.on("session_end", async (event, ctx) => {
    try {
      const sessionId = ctx.sessionId || event.sessionId;
      if (!sessionId) return;

      await valenceExec(cfg, ["sessions", "finalize", sessionId]);
      log.info(`valence-sessions: finalized session ${sessionId}`);
    } catch (err) {
      log.warn(`valence-sessions: session_end failed: ${String(err)}`);
    }
  });

  // 6. subagent_spawned — Create child session with parent link
  api.on("subagent_spawned", async (event, ctx) => {
    try {
      const parentId = currentSessionId;
      const childId = event.childSessionKey;

      const args = [
        "sessions", "start", childId,
        "--platform", currentPlatform,
        "--channel", currentChannel
      ];

      if (parentId) {
        args.push("--parent-session-id", parentId);
      }

      await valenceExec(cfg, args);
    } catch (err) {
      log.warn(`valence-sessions: subagent_spawned failed: ${String(err)}`);
    }
  });

  // 7. subagent_ended — Finalize child session
  api.on("subagent_ended", async (event) => {
    try {
      const childId = event.targetSessionKey;
      if (!childId) return;

      await valenceExec(cfg, ["sessions", "finalize", childId]);
    } catch (err) {
      log.warn(`valence-sessions: subagent_ended failed: ${String(err)}`);
    }
  });
}
