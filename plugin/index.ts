/**
 * OpenClaw Memory Plugin: Valence Knowledge Substrate v2
 *
 * Replaces file-based memory with Valence's knowledge system.
 * Provides: auto-recall, auto-capture, and agent-facing knowledge tools.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { mcpCall, healthCheck } from "./client.js";
import { valenceConfigSchema } from "./config.js";

// --- Plugin Definition ---

const valencePlugin = {
  id: "memory-valence",
  name: "Memory (Valence)",
  description: "Valence knowledge substrate — articles, sources, and semantic search",
  kind: "memory" as const,
  configSchema: valenceConfigSchema,

  register(api: OpenClawPluginApi) {
    const cfg = valenceConfigSchema.parse(api.pluginConfig);
    const log = api.logger;

    // Resolve MEMORY.md path for DR sync
    let memoryMdAbsPath: string | null = null;
    if (cfg.memoryMdSync) {
      try {
        const memPath = cfg.memoryMdPath;
        const resolvedPath =
          memPath.startsWith("/") || memPath.startsWith("~")
            ? memPath
            : `~/.openclaw/workspace/${memPath}`;
        memoryMdAbsPath = api.resolvePath(resolvedPath);
      } catch {
        log.warn("memory-valence: could not resolve MEMORY.md path, sync disabled");
      }
    }

    // =====================
    // TOOLS — Agent-facing (v2 API)
    // =====================

    // 1. memory_store — Store a memory (agent-friendly wrapper)
    api.registerTool(
      {
        name: "memory_store",
        label: "Store Memory",
        description:
          "Store a memory for later recall. " +
          "Memories are indexed for semantic search and can supersede previous memories.",
        parameters: Type.Object({
          content: Type.String({ description: "The memory content" }),
          context: Type.Optional(
            Type.String({
              description: "Where this memory came from (e.g., 'session:main', 'conversation:user')",
            }),
          ),
          importance: Type.Optional(
            Type.Number({
              description: "How important this memory is (0.0-1.0, default 0.5)",
              minimum: 0,
              maximum: 1,
            }),
          ),
          tags: Type.Optional(
            Type.Array(Type.String(), {
              description: "Optional categorization tags",
            }),
          ),
          supersedes_id: Type.Optional(
            Type.String({
              description: "UUID of a previous memory this replaces",
            }),
          ),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          const result = await mcpCall(cfg, "memory_store", params);
          return {
            content: [{ type: "text" as const, text: "Memory stored successfully." }],
            details: result,
          };
        },
      },
      { name: "memory_store" },
    );

    // 2. memory_recall — Search memories (agent-friendly wrapper)
    api.registerTool(
      {
        name: "memory_recall",
        label: "Recall Memories",
        description:
          "Search and recall memories by query. " +
          "Returns memories ranked by relevance, confidence, and freshness. " +
          "Use this to retrieve relevant past knowledge before making decisions.",
        parameters: Type.Object({
          query: Type.String({ description: "What to recall (natural language query)" }),
          limit: Type.Optional(
            Type.Number({
              description: "Maximum results to return (default 5, max 50)",
            }),
          ),
          min_confidence: Type.Optional(
            Type.Number({
              description: "Optional minimum confidence threshold (0.0-1.0)",
              minimum: 0,
              maximum: 1,
            }),
          ),
          tags: Type.Optional(
            Type.Array(Type.String(), {
              description: "Optional tag filter",
            }),
          ),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          const result = (await mcpCall(cfg, "memory_recall", params)) as Record<string, unknown>;
          const memories = (result.memories ?? []) as Record<string, unknown>[];

          const lines = memories.map((m) => `- ${m.content}`);

          return {
            content: [
              {
                type: "text" as const,
                text:
                  lines.length > 0
                    ? `Found ${lines.length} memories:\n${lines.join("\n")}`
                    : "No memories found matching that query.",
              },
            ],
            details: result,
          };
        },
      },
      { name: "memory_recall" },
    );

    // 3. memory_status — Get memory system stats
    api.registerTool(
      {
        name: "memory_status",
        label: "Memory Status",
        description:
          "Get statistics about the memory system: " +
          "count of stored memories, articles compiled from them, and top tags.",
        parameters: Type.Object({}),
        async execute() {
          const result = await mcpCall(cfg, "memory_status", {});
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
            details: result,
          };
        },
      },
      { name: "memory_status" },
    );

    // 4. memory_forget — Mark a memory as forgotten
    api.registerTool(
      {
        name: "memory_forget",
        label: "Forget Memory",
        description:
          "Mark a memory as forgotten (soft delete). " +
          "The memory remains in the database for audit trails but is filtered from recall.",
        parameters: Type.Object({
          memory_id: Type.String({ description: "UUID of the memory to forget" }),
          reason: Type.Optional(
            Type.String({ description: "Optional reason for forgetting this memory" }),
          ),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          const result = await mcpCall(cfg, "memory_forget", params);
          return {
            content: [{ type: "text" as const, text: "Memory marked as forgotten." }],
            details: result,
          };
        },
      },
      { name: "memory_forget" },
    );

    // 5. knowledge_search — Unified knowledge retrieval
    api.registerTool(
      {
        name: "knowledge_search",
        label: "Search Knowledge",
        description:
          "Search articles and optionally raw sources. " +
          "CRITICAL: Call this BEFORE answering questions about any topic that may have " +
          "been discussed, documented, or learned previously. " +
          "Results are ranked by relevance, confidence, and freshness.",
        parameters: Type.Object({
          query: Type.String({ description: "Natural-language search query" }),
          limit: Type.Optional(
            Type.Number({ description: "Maximum results (default 10, max 200)" }),
          ),
          include_sources: Type.Optional(
            Type.Boolean({
              description: "Include ungrouped raw sources alongside compiled articles",
            }),
          ),
          session_id: Type.Optional(
            Type.String({ description: "Optional session ID for usage trace attribution" }),
          ),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          const result = (await mcpCall(cfg, "knowledge_search", params)) as Record<
            string,
            unknown
          >;
          const articles = (result.articles ?? []) as Record<string, unknown>[];
          const sources = (result.sources ?? []) as Record<string, unknown>[];

          const lines: string[] = [];
          if (articles.length > 0) {
            lines.push(`Articles (${articles.length}):`);
            articles.forEach((a) => {
              const title = a.title ? `"${a.title}"` : "(untitled)";
              lines.push(`  - ${title}`);
            });
          }
          if (sources.length > 0) {
            lines.push(`Sources (${sources.length}):`);
            sources.forEach((s) => {
              const title = s.title ? `"${s.title}"` : "(untitled)";
              lines.push(`  - ${title}`);
            });
          }

          return {
            content: [
              {
                type: "text" as const,
                text:
                  lines.length > 0
                    ? lines.join("\n")
                    : "No knowledge found matching that query.",
              },
            ],
            details: result,
          };
        },
      },
      { name: "knowledge_search" },
    );

    // 6. source_ingest — Ingest a new source
    api.registerTool(
      {
        name: "source_ingest",
        label: "Ingest Source",
        description:
          "Ingest a new source into the knowledge substrate. " +
          "Sources are the raw, immutable input material from which articles are compiled. " +
          "Call this whenever new information arrives.",
        parameters: Type.Object({
          content: Type.String({ description: "Raw text content of the source" }),
          source_type: Type.Union([
            Type.Literal("document"),
            Type.Literal("conversation"),
            Type.Literal("web"),
            Type.Literal("code"),
            Type.Literal("observation"),
            Type.Literal("tool_output"),
            Type.Literal("user_input"),
          ], {
            description: "Source type determines initial reliability score",
          }),
          title: Type.Optional(Type.String({ description: "Optional human-readable title" })),
          url: Type.Optional(Type.String({ description: "Optional canonical URL for web sources" })),
          metadata: Type.Optional(
            Type.Object({}, { description: "Optional arbitrary metadata", additionalProperties: true }),
          ),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          const result = await mcpCall(cfg, "source_ingest", params);
          return {
            content: [{ type: "text" as const, text: "Source ingested successfully." }],
            details: result,
          };
        },
      },
      { name: "source_ingest" },
    );

    // 7. source_search — Full-text search over sources
    api.registerTool(
      {
        name: "source_search",
        label: "Search Sources",
        description:
          "Full-text search over source content using PostgreSQL full-text search. " +
          "Results ordered by relevance.",
        parameters: Type.Object({
          query: Type.String({ description: "Search terms (natural language or keyword phrase)" }),
          limit: Type.Optional(
            Type.Number({ description: "Maximum results (default 20, max 200)" }),
          ),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          const result = await mcpCall(cfg, "source_search", params);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
            details: result,
          };
        },
      },
      { name: "source_search" },
    );

    // 8. article_get — Get article with optional provenance
    api.registerTool(
      {
        name: "article_get",
        label: "Get Article",
        description:
          "Get an article by ID, optionally with its full provenance list (linked sources).",
        parameters: Type.Object({
          article_id: Type.String({ description: "UUID of the article" }),
          include_provenance: Type.Optional(
            Type.Boolean({ description: "Include linked source provenance in the response" }),
          ),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          const result = await mcpCall(cfg, "article_get", params);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
            details: result,
          };
        },
      },
      { name: "article_get" },
    );

    // 9. article_compile — Compile sources into an article
    api.registerTool(
      {
        name: "article_compile",
        label: "Compile Article",
        description:
          "Compile one or more sources into a new knowledge article using LLM summarization. " +
          "The LLM produces a coherent, right-sized article from the given source documents.",
        parameters: Type.Object({
          source_ids: Type.Array(Type.String(), {
            description: "UUIDs of source documents to compile (required, non-empty)",
          }),
          title_hint: Type.Optional(
            Type.String({ description: "Optional hint for the article title" }),
          ),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          const result = await mcpCall(cfg, "article_compile", params);
          return {
            content: [{ type: "text" as const, text: "Article compiled successfully." }],
            details: result,
          };
        },
      },
      { name: "article_compile" },
    );

    // 10. article_update — Update an article's content
    api.registerTool(
      {
        name: "article_update",
        label: "Update Article",
        description:
          "Update an article's content with new material. " +
          "Increments the article version and records an 'updated' mutation.",
        parameters: Type.Object({
          article_id: Type.String({ description: "UUID of the article to update" }),
          content: Type.String({ description: "New article body text" }),
          source_id: Type.Optional(
            Type.String({ description: "Optional UUID of the source that triggered this update" }),
          ),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          const result = await mcpCall(cfg, "article_update", params);
          return {
            content: [{ type: "text" as const, text: "Article updated successfully." }],
            details: result,
          };
        },
      },
      { name: "article_update" },
    );

    // 11. contention_list — List active contentions
    api.registerTool(
      {
        name: "contention_list",
        label: "List Contentions",
        description:
          "List active contentions (contradictions or disagreements) in the knowledge base. " +
          "Contentions arise when a source contradicts an existing article.",
        parameters: Type.Object({
          article_id: Type.Optional(
            Type.String({ description: "Optional UUID — return only contentions for this article" }),
          ),
          status: Type.Optional(
            Type.Union([
              Type.Literal("detected"),
              Type.Literal("resolved"),
              Type.Literal("dismissed"),
            ], {
              description: "Filter by status",
            }),
          ),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          const result = await mcpCall(cfg, "contention_list", params);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
            details: result,
          };
        },
      },
      { name: "contention_list" },
    );

    // 12. contention_resolve — Resolve a contention
    api.registerTool(
      {
        name: "contention_resolve",
        label: "Resolve Contention",
        description:
          "Resolve a contention between an article and a source. " +
          "Resolution types: supersede_a (article wins), supersede_b (source wins), " +
          "accept_both (both valid), dismiss (not material).",
        parameters: Type.Object({
          contention_id: Type.String({ description: "UUID of the contention to resolve" }),
          resolution: Type.Union([
            Type.Literal("supersede_a"),
            Type.Literal("supersede_b"),
            Type.Literal("accept_both"),
            Type.Literal("dismiss"),
          ], {
            description: "Resolution type",
          }),
          rationale: Type.String({ description: "Free-text rationale" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          const result = await mcpCall(cfg, "contention_resolve", params);
          return {
            content: [{ type: "text" as const, text: "Contention resolved." }],
            details: result,
          };
        },
      },
      { name: "contention_resolve" },
    );

    // 13. admin_stats — Get system statistics
    api.registerTool(
      {
        name: "admin_stats",
        label: "System Stats",
        description:
          "Return health and capacity statistics for the knowledge system: " +
          "article counts, source count, pending mutation queue depth, tombstones, " +
          "and bounded-memory capacity utilization.",
        parameters: Type.Object({}),
        async execute() {
          const result = await mcpCall(cfg, "admin_stats", {});
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
            details: result,
          };
        },
      },
      { name: "admin_stats" },
    );

    // =====================
    // FILE-BASED MEMORY TOOLS — DR fallback for agents
    // =====================

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
      "You have access to a structured knowledge base (Valence) with tools for: " +
      "memory management (memory_store, memory_recall, memory_status, memory_forget), " +
      "knowledge search (knowledge_search), " +
      "source management (source_ingest, source_search), " +
      "article management (article_get, article_compile, article_update), " +
      "and contentions (contention_list, contention_resolve).",
      "Use memory_recall or knowledge_search BEFORE answering questions about past decisions, " +
      "user preferences, technical approaches, or any topic that may have been discussed before.",
      "Use memory_store proactively when decisions are made, preferences are expressed, " +
      "or important facts are shared.",
      "You also have memory_search and memory_get for file-based memory (MEMORY.md) as a fallback.",
    ].join(" ");

    // Auto-Recall: inject relevant memories before agent processes + system prompt
    api.on("before_agent_start", async (event) => {
      const baseResult: { systemPrompt?: string; prependContext?: string } = {
        systemPrompt: valenceSystemPrompt,
      };

      if (!cfg.autoRecall || !event.prompt || event.prompt.length < 5) {
        return baseResult;
      }

      try {
        const result = (await mcpCall(cfg, "memory_recall", {
          query: event.prompt,
          limit: cfg.recallMaxResults,
        })) as Record<string, unknown>;

        const memories = (result.memories ?? []) as Record<string, unknown>[];
        if (memories.length === 0) return baseResult;

        const memoryContext = memories
          .map((m) => `- ${m.content}`)
          .join("\n");

        log.info(`memory-valence: injecting ${memories.length} memories into context`);

        return {
          systemPrompt:
            valenceSystemPrompt +
            `\n\n<relevant-knowledge>\n` +
            `The following memories from the knowledge base may be relevant:\n` +
            `${memoryContext}\n` +
            `</relevant-knowledge>`,
        };
      } catch (err) {
        log.warn(`memory-valence: auto-recall failed: ${String(err)}`);

        // Fallback: read MEMORY.md if Valence is unreachable
        if (memoryMdAbsPath) {
          try {
            const mdContent = await readFile(memoryMdAbsPath, "utf-8");
            if (mdContent.trim().length > 0) {
              log.info("memory-valence: falling back to MEMORY.md for recall");
              return {
                systemPrompt:
                  valenceSystemPrompt +
                  `\n\n<relevant-knowledge source="MEMORY.md" fallback="true">\n` +
                  `Valence was unreachable. Here is the last-synced knowledge snapshot:\n` +
                  `${mdContent.slice(0, 4000)}\n` +
                  `</relevant-knowledge>`,
              };
            }
          } catch {
            // MEMORY.md doesn't exist yet — that's fine
          }
        }

        return baseResult;
      }
    });

    // Auto-Capture: extract insights after conversation
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
              // Store as memory using memory_store (auto-deduplication handled server-side)
              await mcpCall(cfg, "memory_store", {
                content: text,
                context: "conversation:auto-capture",
                importance: 0.6,
                tags: cfg.captureDomains,
              });
              captured++;
            } catch (err) {
              log.warn(`memory-valence: capture failed for memory: ${String(err)}`);
            }
          }

          if (captured > 0) {
            log.info(`memory-valence: auto-captured ${captured} memories`);
          }
        } catch (err) {
          log.warn(`memory-valence: auto-capture failed: ${String(err)}`);
        }
      });
    }

    // =====================
    // MEMORY.MD SYNC — Disaster recovery fallback
    // =====================

    /**
     * Sync MEMORY.md from Valence knowledge.
     * Queries high-scoring articles and writes a markdown snapshot
     * to the workspace as a disaster-recovery fallback if Valence
     * is unavailable.
     */
    async function syncMemoryMd(): Promise<void> {
      if (!memoryMdAbsPath) return;

      try {
        // Fetch top articles via knowledge_search (broad query to get comprehensive coverage)
        const result = (await mcpCall(cfg, "knowledge_search", {
          query: "knowledge overview summary",
          limit: 50,
          include_sources: false,
        })) as Record<string, unknown>;

        const articles = (result.articles ?? []) as Record<string, unknown>[];
        const md = generateMemoryMd(articles);

        await mkdir(dirname(memoryMdAbsPath), { recursive: true });
        await writeFile(memoryMdAbsPath, md, "utf-8");

        log.info(
          `memory-valence: synced MEMORY.md (${articles.length} articles)`,
        );
      } catch (err) {
        log.warn(`memory-valence: MEMORY.md sync failed: ${String(err)}`);
      }
    }

    // Sync on after_compaction — context was just compressed, update DR file
    api.on("after_compaction", async () => {
      await syncMemoryMd();
    });

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
          // Initial MEMORY.md sync on startup
          await syncMemoryMd();
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
        const valence = program.command("valence").description("Valence knowledge substrate");

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

            const articles = (result.articles ?? []) as Record<string, unknown>[];
            if (articles.length === 0) {
              console.log("No knowledge found.");
              return;
            }

            for (const a of articles) {
              const title = a.title ? `"${a.title}"` : "(untitled)";
              console.log(title);
            }
          });

        valence
          .command("add")
          .description("Store a memory")
          .argument("<content>", "Memory content")
          .option("--tags <tags>", "Comma-separated tags")
          .option("--importance <n>", "Importance 0-1", "0.5")
          .action(async (content: string, opts: { tags?: string; importance: string }) => {
            const tags = opts.tags ? opts.tags.split(",") : undefined;
            await mcpCall(cfg, "memory_store", {
              content,
              tags,
              importance: parseFloat(opts.importance),
              context: "cli:add",
            });
            console.log("Memory stored.");
          });
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

// --- MEMORY.md Generation ---

/**
 * Generate a markdown snapshot from Valence articles.
 * Used as disaster-recovery fallback — if Valence is unreachable,
 * OpenClaw's file-based memory system can still read this file.
 */
function generateMemoryMd(articles: Record<string, unknown>[]): string {
  const now = new Date().toISOString();
  const lines: string[] = [
    "# Knowledge Snapshot",
    "",
    `> Auto-synced from Valence. Last updated: ${now}`,
    "> This file is a disaster-recovery fallback. Source of truth is Valence.",
    "",
  ];

  if (articles.length > 0) {
    lines.push("## Knowledge Articles", "");

    // Sort by usage score descending
    articles.sort((a, b) => {
      const scoreA = typeof a.usage_score === "number" ? a.usage_score : 0;
      const scoreB = typeof b.usage_score === "number" ? b.usage_score : 0;
      return (scoreB as number) - (scoreA as number);
    });

    for (const article of articles) {
      const title = article.title ? `### ${article.title}` : "### (untitled)";
      const content = typeof article.content === "string" ? article.content : "";
      const preview = content.length > 500 ? content.slice(0, 500) + "..." : content;
      
      lines.push(title, "");
      lines.push(preview, "");
    }
  }

  return lines.join("\n");
}

export default valencePlugin;
