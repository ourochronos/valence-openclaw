/**
 * Session ingestion hooks for Valence.
 * Captures conversation sessions as sources for compilation into knowledge articles.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { ValenceConfig } from "./config.js";
import { restCall } from "./client.js";

/**
 * Module-level session tracking.
 * Maps channel/provider info to sessionId for cross-hook routing.
 */
let currentSessionId: string | undefined;
let currentChannel: string = "unknown";

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
      await restCall(cfg, "POST", "/api/v1/sessions", {
        session_id: ctx.sessionId || event.sessionId,
        platform: "openclaw",
        channel: "unknown",
        metadata: {
          agent_id: ctx.agentId,
        },
      });
    } catch (err) {
      log.warn(`valence-sessions: session_start failed: ${String(err)}`);
    }
  });

  // 2. message_received — Append user message
  api.on("message_received", async (event, ctx) => {
    try {
      const sessionId = currentSessionId;
      if (!sessionId || !event.content) return;

      await restCall(cfg, "POST", `/api/v1/sessions/${encodeURIComponent(sessionId)}/messages`, {
        speaker: event.from || "user",
        role: "user",
        content: typeof event.content === "string" ? event.content : JSON.stringify(event.content),
        metadata: event.metadata || {},
      });
    } catch (err) {
      log.warn(`valence-sessions: message_received failed: ${String(err)}`);
    }
  });

  // 3. llm_output — Append assistant message
  api.on("llm_output", async (event, ctx) => {
    try {
      const sessionId = currentSessionId || ctx.sessionKey || ctx.sessionId;
      if (!sessionId) return;

      const content = event.lastAssistant || (event.assistantTexts || []).join("\n");
      if (!content) return;

      await restCall(cfg, "POST", `/api/v1/sessions/${encodeURIComponent(sessionId)}/messages`, {
        speaker: event.model || "assistant",
        role: "assistant",
        content,
        metadata: {
          model: event.model,
          provider: event.provider,
          usage: event.usage,
        },
      });
    } catch (err) {
      log.warn(`valence-sessions: llm_output failed: ${String(err)}`);
    }
  });

  // 4. before_compaction — Flush session (PRIMARY flush trigger)
  api.on("before_compaction", async (_event, ctx) => {
    try {
      const sessionId = currentSessionId || ctx.sessionKey || ctx.sessionId;
      if (!sessionId) return;

      const compileParam = cfg.autoCompileOnFlush ? "?compile=true" : "";
      await restCall(cfg, "POST", `/api/v1/sessions/${encodeURIComponent(sessionId)}/flush${compileParam}`);
      log.info(`valence-sessions: flushed session ${sessionId} (pre-compaction)`);
    } catch (err) {
      log.warn(`valence-sessions: before_compaction flush failed: ${String(err)}`);
    }
  });

  // 5. session_end — Finalize session
  api.on("session_end", async (event, ctx) => {
    try {
      const sessionId = ctx.sessionId || event.sessionId;
      if (!sessionId) return;

      await restCall(cfg, "POST", `/api/v1/sessions/${encodeURIComponent(sessionId)}/finalize`);
      log.info(`valence-sessions: finalized session ${sessionId}`);
    } catch (err) {
      log.warn(`valence-sessions: session_end failed: ${String(err)}`);
    }
  });

  // 6. subagent_spawned — Create child session with parent link
  api.on("subagent_spawned", async (event, ctx) => {
    try {
      const parentId = currentSessionId || ctx.sessionKey || ctx.sessionId;

      await restCall(cfg, "POST", "/api/v1/sessions", {
        session_id: event.childSessionKey,
        platform: "openclaw",
        channel: currentChannel,
        metadata: {
          agent_id: event.agentId,
          run_id: event.runId,
        },
        parent_session_id: parentId,
        subagent_label: event.label,
      });
    } catch (err) {
      log.warn(`valence-sessions: subagent_spawned failed: ${String(err)}`);
    }
  });

  // 7. subagent_ended — Finalize child session
  api.on("subagent_ended", async (event) => {
    try {
      const childId = event.targetSessionKey;
      if (!childId) return;

      await restCall(cfg, "POST", `/api/v1/sessions/${encodeURIComponent(childId)}/finalize`);
    } catch (err) {
      log.warn(`valence-sessions: subagent_ended failed: ${String(err)}`);
    }
  });
}
