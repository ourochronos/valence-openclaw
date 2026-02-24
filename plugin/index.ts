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
import { registerSessionHooks } from "./session-hooks.js";
import { registerInferenceEndpoint } from "./inference.js";

// --- Tool Helpers ---

function stringEnum<T extends string>(values: readonly T[], opts?: { description?: string }) {
  return Type.Unsafe<T>({ type: "string", enum: [...values], ...opts });
}

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

    // =========================================================================
    // Source tools (C1)
    // =========================================================================

    // 1. source_ingest
    api.registerTool(
      {
        name: "source_ingest",
        label: "Ingest Source",
        description:
          "Ingest a new source into the knowledge substrate. " +
          "Sources are raw, immutable input material from which articles are compiled. " +
          "Call this whenever new information arrives — documents, conversations, web pages, code, observations.",
        parameters: Type.Object({
          content: Type.String({ description: "Raw text content of the source (required)" }),
          source_type: stringEnum(
            ["document", "conversation", "web", "code", "observation", "tool_output", "user_input"],
            {
              description:
                "Source type determines initial reliability score: " +
                "document/code=0.8, web=0.6, conversation=0.5, observation=0.4, tool_output=0.7, user_input=0.75",
            },
          ),
          title: Type.Optional(Type.String({ description: "Optional human-readable title" })),
          url: Type.Optional(Type.String({ description: "Optional canonical URL for web sources" })),
          metadata: Type.Optional(Type.Any({ description: "Optional arbitrary metadata (JSON object)" })),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          const result = await mcpCall(cfg, "source_ingest", params);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
            details: result,
          };
        },
      },
      { name: "source_ingest" },
    );

    // 2. source_get
    api.registerTool(
      {
        name: "source_get",
        label: "Get Source",
        description: "Get a source by ID with full details including content and metadata.",
        parameters: Type.Object({
          source_id: Type.String({ description: "UUID of the source" }),
        }),
        async execute(_id: string, params: { source_id: string }) {
          const result = await mcpCall(cfg, "source_get", params);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
            details: result,
          };
        },
      },
      { name: "source_get" },
    );

    // 3. source_search
    api.registerTool(
      {
        name: "source_search",
        label: "Search Sources",
        description:
          "Full-text search over source content. " +
          "Uses PostgreSQL full-text search. Results ordered by relevance descending.",
        parameters: Type.Object({
          query: Type.String({ description: "Search terms (natural language or keyword phrase)" }),
          limit: Type.Optional(
            Type.Number({ description: "Maximum results (default 20, max 200)" }),
          ),
        }),
        async execute(_id: string, params: { query: string; limit?: number }) {
          const result = await mcpCall(cfg, "source_search", params);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
            details: result,
          };
        },
      },
      { name: "source_search" },
    );

    // =========================================================================
    // Retrieval (C9)
    // =========================================================================

    // 4. knowledge_search
    api.registerTool(
      {
        name: "knowledge_search",
        label: "Search Knowledge",
        description:
          "Unified knowledge retrieval — search articles and optionally raw sources. " +
          "CRITICAL: Call this BEFORE answering questions about any topic that may have been " +
          "discussed, documented, or learned previously. This ensures responses are grounded in accumulated knowledge. " +
          "Results are ranked by: relevance × 0.5 + confidence × 0.35 + freshness × 0.15.",
        parameters: Type.Object({
          query: Type.String({ description: "Natural-language search query" }),
          limit: Type.Optional(
            Type.Number({ description: "Maximum results to return (default 10, max 200)" }),
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
          const result = await mcpCall(cfg, "knowledge_search", params);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
            details: result,
          };
        },
      },
      { name: "knowledge_search" },
    );

    // =========================================================================
    // Article tools (C2)
    // =========================================================================

    // 5. article_get
    api.registerTool(
      {
        name: "article_get",
        label: "Get Article",
        description:
          "Get an article by ID, optionally with its full provenance list. " +
          "Set include_provenance=true to see all linked sources and their relationship types " +
          "(originates, confirms, supersedes, contradicts, contends).",
        parameters: Type.Object({
          article_id: Type.String({ description: "UUID of the article" }),
          include_provenance: Type.Optional(
            Type.Boolean({ description: "Include linked source provenance in the response" }),
          ),
        }),
        async execute(_id: string, params: { article_id: string; include_provenance?: boolean }) {
          const result = await mcpCall(cfg, "article_get", params);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
            details: result,
          };
        },
      },
      { name: "article_get" },
    );

    // 6. article_create
    api.registerTool(
      {
        name: "article_create",
        label: "Create Article",
        description:
          "Manually create a new knowledge article. " +
          "Use this when you want to create an article directly without LLM compilation. " +
          "For compilation from sources, use article_compile instead. " +
          "Optionally link originating source UUIDs — they will be linked with relationship='originates'.",
        parameters: Type.Object({
          content: Type.String({ description: "Article body text (required)" }),
          title: Type.Optional(Type.String({ description: "Optional human-readable title" })),
          source_ids: Type.Optional(
            Type.Array(Type.String(), {
              description: "UUIDs of source documents this article originates from",
            }),
          ),
          author_type: Type.Optional(
            stringEnum(["system", "operator", "agent"], {
              description: "Who authored this article (default: system)",
            }),
          ),
          domain_path: Type.Optional(
            Type.Array(Type.String(), {
              description: "Hierarchical domain tags (e.g. ['python', 'stdlib'])",
            }),
          ),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          const result = await mcpCall(cfg, "article_create", params);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
            details: result,
          };
        },
      },
      { name: "article_create" },
    );

    // 7. article_compile
    api.registerTool(
      {
        name: "article_compile",
        label: "Compile Article",
        description:
          "Compile one or more sources into a new knowledge article using LLM summarization. " +
          "The LLM produces a coherent, right-sized article from the given source documents. " +
          "All sources are linked to the resulting article with appropriate provenance relationship types. " +
          "The compiled article respects right-sizing bounds (default: 200–4000 tokens, target 2000).",
        parameters: Type.Object({
          source_ids: Type.Array(Type.String(), {
            description: "UUIDs of source documents to compile (required, non-empty)",
          }),
          title_hint: Type.Optional(Type.String({ description: "Optional hint for the article title" })),
        }),
        async execute(_id: string, params: { source_ids: string[]; title_hint?: string }) {
          const result = await mcpCall(cfg, "article_compile", params);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
            details: result,
          };
        },
      },
      { name: "article_compile" },
    );

    // 8. article_update
    api.registerTool(
      {
        name: "article_update",
        label: "Update Article",
        description:
          "Update an article's content with new material. " +
          "Increments the article version, records an 'updated' mutation, and optionally links the triggering source. " +
          "The source is linked with a relationship type inferred from content (typically 'confirms' or 'supersedes').",
        parameters: Type.Object({
          article_id: Type.String({ description: "UUID of the article to update" }),
          content: Type.String({ description: "New article body text" }),
          source_id: Type.Optional(
            Type.String({ description: "Optional UUID of the source that triggered this update" }),
          ),
        }),
        async execute(_id: string, params: { article_id: string; content: string; source_id?: string }) {
          const result = await mcpCall(cfg, "article_update", params);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
            details: result,
          };
        },
      },
      { name: "article_update" },
    );

    // =========================================================================
    // Right-sizing tools (C3)
    // =========================================================================

    // 9. article_split
    api.registerTool(
      {
        name: "article_split",
        label: "Split Article",
        description:
          "Split an oversized article into two smaller articles. " +
          "The original article retains its ID and the first half of the content. " +
          "A new article is created for the remainder. Both inherit all provenance sources, " +
          "and mutation records of type 'split' are written for both.",
        parameters: Type.Object({
          article_id: Type.String({ description: "UUID of the article to split" }),
        }),
        async execute(_id: string, params: { article_id: string }) {
          const result = await mcpCall(cfg, "article_split", params);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
            details: result,
          };
        },
      },
      { name: "article_split" },
    );

    // 10. article_merge
    api.registerTool(
      {
        name: "article_merge",
        label: "Merge Articles",
        description:
          "Merge two related articles into one. " +
          "A new article is created with combined content. Both originals are archived. " +
          "The merged article inherits the union of provenance sources from both. " +
          "Mutation records of type 'merged' are written.",
        parameters: Type.Object({
          article_id_a: Type.String({ description: "UUID of the first article" }),
          article_id_b: Type.String({ description: "UUID of the second article" }),
        }),
        async execute(_id: string, params: { article_id_a: string; article_id_b: string }) {
          const result = await mcpCall(cfg, "article_merge", params);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
            details: result,
          };
        },
      },
      { name: "article_merge" },
    );

    // =========================================================================
    // Provenance (C5)
    // =========================================================================

    // 11. provenance_trace
    api.registerTool(
      {
        name: "provenance_trace",
        label: "Trace Provenance",
        description:
          "Trace which sources likely contributed a specific claim in an article. " +
          "Uses text-similarity (TF-IDF) to rank the article's linked sources by " +
          "how much their content overlaps with the given claim text. " +
          "Useful for attribution and fact-checking.",
        parameters: Type.Object({
          article_id: Type.String({ description: "UUID of the article" }),
          claim_text: Type.String({
            description: "The specific claim or sentence to trace back to sources",
          }),
        }),
        async execute(_id: string, params: { article_id: string; claim_text: string }) {
          const result = await mcpCall(cfg, "provenance_trace", params);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
            details: result,
          };
        },
      },
      { name: "provenance_trace" },
    );

    // =========================================================================
    // Contention tools (C7)
    // =========================================================================

    // 12. contention_list
    api.registerTool(
      {
        name: "contention_list",
        label: "List Contentions",
        description:
          "List active contentions (contradictions or disagreements) in the knowledge base. " +
          "Contentions arise when a source contradicts or contends with an existing article. " +
          "Review contentions to identify knowledge that needs reconciliation.",
        parameters: Type.Object({
          article_id: Type.Optional(
            Type.String({ description: "Optional UUID — return only contentions for this article" }),
          ),
          status: Type.Optional(
            stringEnum(["detected", "resolved", "dismissed"], {
              description: "Filter by status (omit to return all)",
            }),
          ),
        }),
        async execute(_id: string, params: { article_id?: string; status?: string }) {
          const result = await mcpCall(cfg, "contention_list", params);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
            details: result,
          };
        },
      },
      { name: "contention_list" },
    );

    // 13. contention_resolve
    api.registerTool(
      {
        name: "contention_resolve",
        label: "Resolve Contention",
        description:
          "Resolve a contention between an article and a source. " +
          "Resolution types:\n" +
          "- supersede_a: Article wins; source is noted but article unchanged.\n" +
          "- supersede_b: Source wins; article content is replaced.\n" +
          "- accept_both: Both perspectives are valid; article is annotated.\n" +
          "- dismiss: Not material; dismissed without change.",
        parameters: Type.Object({
          contention_id: Type.String({ description: "UUID of the contention to resolve" }),
          resolution: stringEnum(["supersede_a", "supersede_b", "accept_both", "dismiss"], {
            description: "Resolution type",
          }),
          rationale: Type.String({
            description: "Free-text rationale recorded on the contention",
          }),
        }),
        async execute(_id: string, params: { contention_id: string; resolution: string; rationale: string }) {
          const result = await mcpCall(cfg, "contention_resolve", params);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
            details: result,
          };
        },
      },
      { name: "contention_resolve" },
    );

    // =========================================================================
    // Admin tools (C10, health)
    // =========================================================================

    // 14. admin_forget
    api.registerTool(
      {
        name: "admin_forget",
        label: "Forget Source/Article",
        description:
          "Permanently remove a source or article from the knowledge system (C10). " +
          "For sources: deletes the source, cascades to article_sources, queues affected articles for recompilation, creates a tombstone. " +
          "For articles: deletes the article and provenance links; sources are unaffected; a tombstone is created. " +
          "This operation is IRREVERSIBLE.",
        parameters: Type.Object({
          target_type: stringEnum(["source", "article"], {
            description: "Whether to delete a source or an article",
          }),
          target_id: Type.String({ description: "UUID of the record to delete" }),
        }),
        async execute(_id: string, params: { target_type: string; target_id: string }) {
          const result = await mcpCall(cfg, "admin_forget", params);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
            details: result,
          };
        },
      },
      { name: "admin_forget" },
    );

    // 15. admin_stats
    api.registerTool(
      {
        name: "admin_stats",
        label: "Admin Stats",
        description:
          "Return health and capacity statistics for the knowledge system. " +
          "Includes: article counts (total/active/pinned), source count, pending mutation queue depth, " +
          "tombstones (last 30 days), and bounded-memory capacity utilization.",
        parameters: Type.Object({}),
        async execute(_id: string, _params: Record<string, never>) {
          const result = await mcpCall(cfg, "admin_stats", {});
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
            details: result,
          };
        },
      },
      { name: "admin_stats" },
    );

    // 16. admin_maintenance
    api.registerTool(
      {
        name: "admin_maintenance",
        label: "Admin Maintenance",
        description:
          "Trigger maintenance operations for the knowledge system. " +
          "Available operations (pass true to enable):\n" +
          "- recompute_scores: Batch-recompute usage_score for all articles.\n" +
          "- process_queue: Process pending entries in mutation_queue (recompile, split, merge_candidate, decay_check).\n" +
          "- evict_if_over_capacity: Run organic forgetting if article count exceeds the configured maximum.",
        parameters: Type.Object({
          recompute_scores: Type.Optional(
            Type.Boolean({ description: "Batch-recompute usage scores for all articles" }),
          ),
          process_queue: Type.Optional(
            Type.Boolean({ description: "Process pending entries in the mutation queue" }),
          ),
          evict_if_over_capacity: Type.Optional(
            Type.Boolean({ description: "Run organic eviction if over capacity" }),
          ),
          evict_count: Type.Optional(
            Type.Number({ description: "Maximum articles to evict per run (default 10)" }),
          ),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          const result = await mcpCall(cfg, "admin_maintenance", params);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
            details: result,
          };
        },
      },
      { name: "admin_maintenance" },
    );

    // =========================================================================
    // Memory tools (agent-friendly interface)
    // =========================================================================

    // 17. memory_store
    api.registerTool(
      {
        name: "memory_store",
        label: "Store Memory",
        description:
          "Store a memory for later recall (agent-friendly wrapper). " +
          "Memories are stored as observation sources with special metadata that makes them easy for agents to search and manage. " +
          "Use this to remember important facts, learnings, decisions, or observations. " +
          "Memories can supersede previous memories and are tagged with importance and optional context tags for better retrieval.",
        parameters: Type.Object({
          content: Type.String({ description: "The memory content (required)" }),
          context: Type.Optional(
            Type.String({
              description:
                "Where this memory came from (e.g., 'session:main', 'conversation:user', 'observation:system')",
            }),
          ),
          importance: Type.Optional(
            Type.Number({
              minimum: 0.0,
              maximum: 1.0,
              description: "How important this memory is (0.0-1.0, default 0.5)",
            }),
          ),
          tags: Type.Optional(
            Type.Array(Type.String(), {
              description: "Optional categorization tags (e.g., ['infrastructure', 'decision'])",
            }),
          ),
          supersedes_id: Type.Optional(
            Type.String({ description: "UUID of a previous memory this replaces" }),
          ),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          const result = await mcpCall(cfg, "memory_store", params);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
            details: result,
          };
        },
      },
      { name: "memory_store" },
    );

    // 18. memory_recall
    api.registerTool(
      {
        name: "memory_recall",
        label: "Recall Memories",
        description:
          "Search and recall memories (agent-friendly wrapper). " +
          "Returns memories ranked by relevance, confidence, and freshness. " +
          "Results are filtered to only include observation sources marked as memories. " +
          "Optionally filter by tags or minimum confidence threshold. " +
          "Use this to retrieve relevant past knowledge before making decisions or answering questions.",
        parameters: Type.Object({
          query: Type.String({ description: "What to recall (natural language query)" }),
          limit: Type.Optional(
            Type.Number({ description: "Maximum results to return (default 5, max 50)" }),
          ),
          min_confidence: Type.Optional(
            Type.Number({
              minimum: 0.0,
              maximum: 1.0,
              description: "Optional minimum confidence threshold (0.0-1.0)",
            }),
          ),
          tags: Type.Optional(
            Type.Array(Type.String(), {
              description: "Optional tag filter — only return memories with at least one matching tag",
            }),
          ),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          const result = await mcpCall(cfg, "memory_recall", params);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
            details: result,
          };
        },
      },
      { name: "memory_recall" },
    );

    // 19. memory_status
    api.registerTool(
      {
        name: "memory_status",
        label: "Memory Status",
        description:
          "Get statistics about the memory system. " +
          "Returns count of stored memories, articles compiled from them, last memory timestamp, and top tags. " +
          "Use this to understand the current state of the memory system.",
        parameters: Type.Object({}),
        async execute(_id: string, _params: Record<string, never>) {
          const result = await mcpCall(cfg, "memory_status", {});
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
            details: result,
          };
        },
      },
      { name: "memory_status" },
    );

    // 20. memory_forget
    api.registerTool(
      {
        name: "memory_forget",
        label: "Forget Memory",
        description:
          "Mark a memory as forgotten (soft delete). " +
          "Sets the memory's metadata to include a 'forgotten' flag and optional reason. " +
          "The memory is not actually deleted from the database, but will be filtered out of future recall results. " +
          "Use this to mark outdated or incorrect memories without losing the audit trail.",
        parameters: Type.Object({
          memory_id: Type.String({ description: "UUID of the memory (source) to forget" }),
          reason: Type.Optional(
            Type.String({ description: "Optional reason why this memory is being forgotten" }),
          ),
        }),
        async execute(_id: string, params: { memory_id: string; reason?: string }) {
          const result = await mcpCall(cfg, "memory_forget", params);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
            details: result,
          };
        },
      },
      { name: "memory_forget" },
    );

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
      "and memory wrappers (memory_store, memory_recall, memory_status, memory_forget). ",
      "Use knowledge_search BEFORE answering questions about past discussions or documented topics.",
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
            const content = (r.content as string)?.slice(0, 600) ?? "";
            const truncated = content.length < ((r.content as string)?.length ?? 0) ? "…" : "";
            return `- ${title}${content}${truncated}`;
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

        valence
          .command("stats")
          .description("Show knowledge system statistics")
          .action(async () => {
            const result = await mcpCall(cfg, "admin_stats", {});
            console.log(JSON.stringify(result, null, 2));
          });
      },
      { commands: ["valence"] },
    );

    // =====================
    // SESSION HOOKS — Capture conversations as sources
    // =====================

    if (cfg.sessionIngestion) {
      registerSessionHooks(api, cfg, log);
      log.info("valence-sessions: session ingestion hooks registered");
    }

    // =====================
    // INFERENCE ENDPOINT — Gateway proxy for Valence compilation
    // =====================

    if (cfg.inferenceEnabled && cfg.serverUrl) {
      registerInferenceEndpoint(api, {
        inferenceModel: cfg.inferenceModel,
        serverUrl: cfg.serverUrl,
        authToken: cfg.authToken,
      });
    }
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
