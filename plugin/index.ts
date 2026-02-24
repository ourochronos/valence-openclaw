/**
 * OpenClaw Memory Plugin: Valence Knowledge Substrate (v2 compatible)
 *
 * Exposes Valence v2 MCP tools for OpenClaw agents.
 * Provides: source ingestion, article management, knowledge search,
 * contention resolution, admin tools, and memory wrappers.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import { mcpCall, healthCheck } from "./client.js";
import { valenceConfigSchema } from "./config.js";

// --- Plugin Definition ---

const valencePlugin = {
  id: "memory-valence",
  name: "Memory (Valence)",
  description: "Valence v2 knowledge substrate — sources, articles, contentions, memory",
  kind: "memory" as const,
  configSchema: valenceConfigSchema,

  register(api: OpenClawPluginApi) {
    const cfg = valenceConfigSchema.parse(api.pluginConfig);
    const log = api.logger;

    // =====================
    // TOOLS — v2 Substrate (20 tools)
    // =====================

    // Tools will be registered here in Issue #2

    // =====================
    // FILE-BASED MEMORY TOOLS — DR fallback for agents
    // =====================

    // Register OpenClaw's built-in memory_search and memory_get tools.
    // These operate on MEMORY.md and provide a DR fallback if Valence is unreachable.

    try {
      const memorySearchFactory = api.runtime.tools.createMemorySearchTool;
      const memoryGetFactory = api.runtime.tools.createMemoryGetTool;

      api.registerTool(
        (ctx) =>
          memorySearchFactory({ config: ctx.config, agentSessionKey: ctx.sessionKey }) ?? undefined,
        { name: "memory_search", optional: true },
      );

      api.registerTool(
        (ctx) =>
          memoryGetFactory({ config: ctx.config, agentSessionKey: ctx.sessionKey }) ?? undefined,
        { name: "memory_get", optional: true },
      );
    } catch {
      log.warn(
        "memory-valence: could not register file-based memory tools (runtime not available)",
      );
    }

    // =====================
    // HOOKS — Automatic lifecycle
    // =====================

    // System prompt: explain Valence tools to the agent
    const valenceSystemPrompt = [
      "You have access to a structured knowledge base (Valence v2) with tools for: ",
      "sources (source_ingest, source_get, source_search), ",
      "articles (article_get, article_create, article_compile, article_update, article_split, article_merge), ",
      "knowledge search (knowledge_search), ",
      "provenance (provenance_trace), ",
      "contentions (contention_list, contention_resolve), ",
      "admin (admin_forget, admin_stats, admin_maintenance), ",
      "and memory wrappers (memory_store, memory_recall, memory_status, memory_forget).",
    ].join("");

    // Auto-Recall: inject relevant knowledge before agent processes
    api.on("before_agent_start", async (event) => {
      const baseResult: { systemPrompt?: string; prependContext?: string } = {
        systemPrompt: valenceSystemPrompt,
      };

      if (!cfg.autoRecall || !event.prompt || event.prompt.length < 5) {
        return baseResult;
      }

      try {
        const result = (await mcpCall(cfg, "knowledge_search", {
          query: event.prompt,
          limit: cfg.recallMaxResults,
          include_sources: false,
        })) as Record<string, unknown>;

        const results = (result.results ?? []) as Record<string, unknown>[];
        if (results.length === 0) return baseResult;

        const memoryContext = results
          .map((r) => {
            const title = r.title ? `**${r.title}**: ` : "";
            const content = (r.content as string)?.slice(0, 200) ?? "";
            return `- ${title}${content}`;
          })
          .join("\n");

        log.info(`memory-valence: injecting ${results.length} articles into context`);

        return {
          systemPrompt:
            valenceSystemPrompt +
            `\n\n<relevant-knowledge>\n` +
            `The following compiled knowledge may be relevant:\n` +
            `${memoryContext}\n` +
            `</relevant-knowledge>`,
        };
      } catch (err) {
        log.warn(`memory-valence: auto-recall failed: ${String(err)}`);
        return baseResult;
      }
    });

    // Auto-Capture: ingest observations after conversation
    if (cfg.autoCapture) {
      api.on("agent_end", async (event) => {
        if (!event.success || !event.messages || event.messages.length === 0) return;

        try {
          const texts: string[] = [];
          for (const msg of event.messages as Array<{ role: string; content: unknown }>) {
            if (msg.role !== "user" && msg.role !== "assistant") continue;
            if (typeof msg.content === "string") {
              texts.push(msg.content);
            } else if (Array.isArray(msg.content)) {
              for (const block of msg.content) {
                if (block?.type === "text" && typeof block.text === "string") {
                  texts.push(block.text);
                }
              }
            }
          }

          const capturable = texts.filter((t) => shouldCapture(t));
          if (capturable.length === 0) return;

          let captured = 0;
          for (const text of capturable.slice(0, 3)) {
            try {
              await mcpCall(cfg, "memory_store", {
                content: text,
                importance: 0.6,
                context: "conversation:auto-capture",
              });
              captured++;
            } catch (err) {
              log.warn(`memory-valence: capture failed: ${String(err)}`);
            }
          }

          if (captured > 0) {
            log.info(`memory-valence: auto-captured ${captured} observations`);
          }
        } catch (err) {
          log.warn(`memory-valence: auto-capture failed: ${String(err)}`);
        }
      });
    }

    // =====================
    // SERVICE — Health check
    // =====================

    api.registerService({
      id: "memory-valence",
      async start() {
        const health = await healthCheck(cfg);
        if (health.ok) {
          log.info(
            `memory-valence: connected to ${cfg.serverUrl} ` +
              `(v${health.version}, db: ${health.database})`,
          );
        } else {
          log.warn(
            `memory-valence: cannot reach ${cfg.serverUrl} — ${health.error}. ` +
              `Tools will retry on use.`,
          );
        }
      },
      stop() {
        log.info("memory-valence: stopped");
      },
    });

    // =====================
    // CLI — Valence commands
    // =====================

    api.registerCli(
      ({ program }) => {
        const valence = program.command("valence").description("Valence v2 knowledge substrate");

        valence
          .command("status")
          .description("Check Valence server connectivity")
          .action(async () => {
            const health = await healthCheck(cfg);
            if (health.ok) {
              console.log(
                `Connected: ${cfg.serverUrl} (v${health.version}, db: ${health.database})`,
              );
            } else {
              console.error(`Not connected: ${health.error}`);
              process.exitCode = 1;
            }
          });

        valence
          .command("search")
          .description("Search knowledge")
          .argument("<query>", "Search query")
          .option("--limit <n>", "Max results", "10")
          .action(async (query: string, opts: { limit: string }) => {
            const result = (await mcpCall(cfg, "knowledge_search", {
              query,
              limit: parseInt(opts.limit, 10),
            })) as Record<string, unknown>;

            const results = (result.results ?? []) as Record<string, unknown>[];
            if (results.length === 0) {
              console.log("No results found.");
              return;
            }

            for (const r of results) {
              const title = r.title ? `[${r.title}] ` : "";
              const content = (r.content as string)?.slice(0, 100) ?? "";
              console.log(`${title}${content}...`);
            }
          });

        valence
          .command("ingest")
          .description("Ingest a source")
          .argument("<content>", "Source content")
          .option("--type <t>", "Source type", "observation")
          .option("--title <title>", "Title")
          .action(
            async (content: string, opts: { type: string; title?: string }) => {
              const result = await mcpCall(cfg, "source_ingest", {
                content,
                source_type: opts.type,
                title: opts.title,
              });
              console.log("Source ingested:", result);
            },
          );
      },
      { commands: ["valence"] },
    );
  },
};

// --- Capture Heuristics ---

const CAPTURE_TRIGGERS = [
  /remember|don't forget|keep in mind/i,
  /i prefer|i like|i want|i need|i hate/i,
  /we decided|decision:|chose to|going with/i,
  /my .+ is|is my/i,
  /always|never|important to note/i,
  /key takeaway|lesson learned|note to self/i,
];

function shouldCapture(text: string): boolean {
  if (text.length < 15 || text.length > 500) return false;
  if (text.includes("<relevant-knowledge>")) return false;
  if (text.startsWith("<") && text.includes("</")) return false;
  if (text.includes("```")) return false; // Skip code blocks
  return CAPTURE_TRIGGERS.some((r) => r.test(text));
}

export default valencePlugin;
