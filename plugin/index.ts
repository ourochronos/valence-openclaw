/**
 * OpenClaw Memory Plugin: Valence Knowledge Substrate
 *
 * Replaces file-based memory with Valence's belief system.
 * Provides: auto-recall, auto-capture, session tracking,
 * exchange recording, and agent-facing knowledge tools.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { mcpCall, healthCheck, listBeliefs, listPatterns } from "./client.js";
import { valenceConfigSchema } from "./config.js";

// --- Tool Helpers ---

function stringEnum<T extends string>(values: readonly T[], opts?: { description?: string }) {
  return Type.Unsafe<T>({ type: "string", enum: [...values], ...opts });
}

function beliefSummary(belief: Record<string, unknown>): string {
  const conf =
    typeof belief.confidence === "object" && belief.confidence
      ? ((belief.confidence as Record<string, number>).overall ?? "?")
      : "?";
  const domain = Array.isArray(belief.domain_path) ? belief.domain_path.join("/") : "";
  return `[${conf}] ${domain ? `(${domain}) ` : ""}${belief.content}`;
}

// --- Plugin Definition ---

const valencePlugin = {
  id: "memory-valence",
  name: "Memory (Valence)",
  description: "Valence knowledge substrate — beliefs, sessions, patterns, tensions",
  kind: "memory" as const,
  configSchema: valenceConfigSchema,

  register(api: OpenClawPluginApi) {
    const cfg = valenceConfigSchema.parse(api.pluginConfig);
    const log = api.logger;

    // Track active Valence session per OpenClaw session
    const sessionMap = new Map<string, string>(); // openclawSessionKey → valenceSessionId

    // Resolve MEMORY.md path for DR sync
    // Use ~ prefix to ensure home-relative resolution even when cwd is / (launchd)
    let memoryMdAbsPath: string | null = null;
    if (cfg.memoryMdSync) {
      try {
        const memPath = cfg.memoryMdPath;
        // If already absolute or home-relative, use as-is; otherwise anchor to workspace
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
    // TOOLS — Agent-facing
    // =====================

    // 1. belief_query — Search beliefs
    api.registerTool(
      {
        name: "belief_query",
        label: "Search Beliefs",
        description:
          "Search the knowledge base for beliefs matching a query. " +
          "Uses hybrid keyword + semantic search. Returns beliefs with confidence scores.",
        parameters: Type.Object({
          query: Type.String({ description: "Search query (natural language or keywords)" }),
          domain_filter: Type.Optional(
            Type.Array(Type.String(), {
              description: "Filter by domain path, e.g. ['tech', 'python']",
            }),
          ),
          limit: Type.Optional(Type.Number({ description: "Max results (default: 10)" })),
        }),
        async execute(
          _id: string,
          params: { query: string; domain_filter?: string[]; limit?: number },
        ) {
          const result = (await mcpCall(cfg, "belief_query", {
            query: params.query,
            domain_filter: params.domain_filter,
            limit: params.limit ?? 10,
          })) as Record<string, unknown>;

          const beliefs = (result.beliefs ?? []) as Record<string, unknown>[];
          const lines = beliefs.map((b) => beliefSummary(b));

          return {
            content: [
              {
                type: "text" as const,
                text:
                  lines.length > 0
                    ? `Found ${lines.length} beliefs:\n${lines.join("\n")}`
                    : "No beliefs found matching that query.",
              },
            ],
            details: result,
          };
        },
      },
      { name: "belief_query" },
    );

    // 2. belief_create — Store new belief
    api.registerTool(
      {
        name: "belief_create",
        label: "Create Belief",
        description:
          "Store a new belief in the knowledge base. " +
          "Beliefs are factual statements with confidence scores and domain classification.",
        parameters: Type.Object({
          content: Type.String({ description: "The belief — a clear, factual statement" }),
          domain_path: Type.Optional(
            Type.Array(Type.String(), {
              description: "Domain classification, e.g. ['tech', 'python', 'testing']",
            }),
          ),
          confidence: Type.Optional(
            Type.Number({ description: "Overall confidence 0-1 (default: 0.7)" }),
          ),
          source_type: Type.Optional(
            stringEnum(["conversation", "observation", "inference", "user_input", "document"], {
              description: "How this belief was derived",
            }),
          ),
        }),
        async execute(
          _id: string,
          params: {
            content: string;
            domain_path?: string[];
            confidence?: number;
            source_type?: string;
          },
        ) {
          // Duplicate detection — skip if very similar belief already exists
          try {
            const existing = (await mcpCall(cfg, "belief_search", {
              query: params.content,
              limit: 1,
              min_similarity: 0.95,
            })) as Record<string, unknown>;

            const matches = (existing.beliefs ?? []) as Record<string, unknown>[];
            if (matches.length > 0) {
              const match = matches[0];
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `Similar belief already exists: "${(match.content as string)?.slice(0, 100)}"`,
                  },
                ],
                details: {
                  action: "duplicate",
                  existingId: match.id,
                  existingContent: match.content,
                },
              };
            }
          } catch {
            // If dedup check fails, proceed with creation
          }

          const result = await mcpCall(cfg, "belief_create", {
            content: params.content,
            domain_path: params.domain_path ?? cfg.captureDomains,
            confidence: { overall: params.confidence ?? 0.7 },
            source_type: params.source_type ?? "conversation",
          });

          return {
            content: [{ type: "text" as const, text: `Belief created successfully.` }],
            details: result,
          };
        },
      },
      { name: "belief_create" },
    );

    // 3. belief_supersede — Update belief with history
    api.registerTool(
      {
        name: "belief_supersede",
        label: "Update Belief",
        description:
          "Replace an existing belief with updated content, maintaining the history chain. " +
          "Use when information needs correction or refinement.",
        parameters: Type.Object({
          old_belief_id: Type.String({ description: "UUID of the belief to supersede" }),
          new_content: Type.String({ description: "Updated belief content" }),
          reason: Type.String({ description: "Why this belief is being updated" }),
          confidence: Type.Optional(Type.Number({ description: "New confidence 0-1" })),
        }),
        async execute(
          _id: string,
          params: {
            old_belief_id: string;
            new_content: string;
            reason: string;
            confidence?: number;
          },
        ) {
          const args: Record<string, unknown> = {
            old_belief_id: params.old_belief_id,
            new_content: params.new_content,
            reason: params.reason,
          };
          if (params.confidence != null) args.confidence = { overall: params.confidence };

          const result = await mcpCall(cfg, "belief_supersede", args);
          return {
            content: [{ type: "text" as const, text: `Belief superseded successfully.` }],
            details: result,
          };
        },
      },
      { name: "belief_supersede" },
    );

    // 4. belief_get — Get belief details
    api.registerTool(
      {
        name: "belief_get",
        label: "Get Belief",
        description: "Get full details of a specific belief by ID, including history and tensions.",
        parameters: Type.Object({
          belief_id: Type.String({ description: "UUID of the belief" }),
          include_history: Type.Optional(
            Type.Boolean({ description: "Include supersession chain" }),
          ),
          include_tensions: Type.Optional(
            Type.Boolean({ description: "Include related tensions" }),
          ),
        }),
        async execute(
          _id: string,
          params: { belief_id: string; include_history?: boolean; include_tensions?: boolean },
        ) {
          const result = (await mcpCall(cfg, "belief_get", params)) as Record<string, unknown>;
          const belief = result.belief as Record<string, unknown> | undefined;

          return {
            content: [
              { type: "text" as const, text: belief ? beliefSummary(belief) : "Belief not found." },
            ],
            details: result,
          };
        },
      },
      { name: "belief_get" },
    );

    // 5. entity_search — Find entities
    api.registerTool(
      {
        name: "entity_search",
        label: "Search Entities",
        description: "Find entities (people, tools, concepts, projects) in the knowledge base.",
        parameters: Type.Object({
          query: Type.String({ description: "Search query" }),
          type: Type.Optional(
            stringEnum(
              ["person", "organization", "tool", "concept", "project", "location", "service"],
              { description: "Filter by entity type" },
            ),
          ),
          limit: Type.Optional(Type.Number({ description: "Max results (default: 10)" })),
        }),
        async execute(_id: string, params: { query: string; type?: string; limit?: number }) {
          const result = (await mcpCall(cfg, "entity_search", {
            query: params.query,
            type: params.type,
            limit: params.limit ?? 10,
          })) as Record<string, unknown>;

          const entities = (result.entities ?? []) as Record<string, unknown>[];
          const lines = entities.map(
            (e) =>
              `${e.name} (${e.type ?? "unknown"})${e.aliases ? ` — aliases: ${e.aliases}` : ""}`,
          );

          return {
            content: [
              {
                type: "text" as const,
                text:
                  lines.length > 0
                    ? `Found ${lines.length} entities:\n${lines.join("\n")}`
                    : "No entities found.",
              },
            ],
            details: result,
          };
        },
      },
      { name: "entity_search" },
    );

    // 6. entity_get — Get entity with beliefs
    api.registerTool(
      {
        name: "entity_get",
        label: "Get Entity",
        description: "Get full entity details including related beliefs.",
        parameters: Type.Object({
          entity_id: Type.String({ description: "UUID of the entity" }),
          include_beliefs: Type.Optional(Type.Boolean({ description: "Include related beliefs" })),
        }),
        async execute(_id: string, params: { entity_id: string; include_beliefs?: boolean }) {
          const result = (await mcpCall(cfg, "entity_get", {
            entity_id: params.entity_id,
            include_beliefs: params.include_beliefs ?? true,
          })) as Record<string, unknown>;

          const entity = result.entity as Record<string, unknown> | undefined;

          return {
            content: [
              {
                type: "text" as const,
                text: entity ? `${entity.name} (${entity.type})` : "Entity not found.",
              },
            ],
            details: result,
          };
        },
      },
      { name: "entity_get" },
    );

    // 7. tension_list — List contradictions
    api.registerTool(
      {
        name: "tension_list",
        label: "List Tensions",
        description:
          "List contradictions or tensions between beliefs. " +
          "Tensions indicate conflicting knowledge that may need resolution.",
        parameters: Type.Object({
          severity: Type.Optional(
            stringEnum(["low", "medium", "high", "critical"], {
              description: "Minimum severity filter",
            }),
          ),
          status: Type.Optional(
            stringEnum(["detected", "investigating", "resolved", "accepted"], {
              description: "Filter by status",
            }),
          ),
          limit: Type.Optional(Type.Number({ description: "Max results (default: 10)" })),
        }),
        async execute(_id: string, params: { severity?: string; status?: string; limit?: number }) {
          const result = (await mcpCall(cfg, "tension_list", {
            severity: params.severity,
            status: params.status,
            limit: params.limit ?? 10,
          })) as Record<string, unknown>;

          const tensions = (result.tensions ?? []) as Record<string, unknown>[];

          return {
            content: [
              {
                type: "text" as const,
                text:
                  tensions.length > 0 ? `Found ${tensions.length} tensions.` : "No tensions found.",
              },
            ],
            details: result,
          };
        },
      },
      { name: "tension_list" },
    );

    // 8. tension_resolve — Resolve contradiction
    api.registerTool(
      {
        name: "tension_resolve",
        label: "Resolve Tension",
        description:
          "Mark a tension as resolved with an explanation of how the conflict was reconciled.",
        parameters: Type.Object({
          tension_id: Type.String({ description: "UUID of the tension" }),
          resolution: Type.String({ description: "How the tension was resolved" }),
          action: stringEnum(["supersede_a", "supersede_b", "keep_both", "archive_both"], {
            description: "What to do with the conflicting beliefs",
          }),
        }),
        async execute(
          _id: string,
          params: { tension_id: string; resolution: string; action: string },
        ) {
          const result = await mcpCall(cfg, "tension_resolve", params);
          return {
            content: [{ type: "text" as const, text: `Tension resolved.` }],
            details: result,
          };
        },
      },
      { name: "tension_resolve" },
    );

    // 9. pattern_search — Search behavioral patterns
    api.registerTool(
      {
        name: "pattern_search",
        label: "Search Patterns",
        description: "Search for recurring behavioral patterns across conversations.",
        parameters: Type.Object({
          query: Type.String({ description: "Search query" }),
          limit: Type.Optional(Type.Number({ description: "Max results (default: 10)" })),
        }),
        async execute(_id: string, params: { query: string; limit?: number }) {
          const result = await mcpCall(cfg, "pattern_search", {
            query: params.query,
            limit: params.limit ?? 10,
          });
          return {
            content: [{ type: "text" as const, text: "Pattern search complete." }],
            details: result,
          };
        },
      },
      { name: "pattern_search" },
    );

    // 10. belief_search — Pure semantic/vector search
    api.registerTool(
      {
        name: "belief_search",
        label: "Semantic Search Beliefs",
        description:
          "Semantic search for beliefs using vector embeddings. " +
          "Best for finding conceptually related beliefs even with different wording. " +
          "Use instead of belief_query when exact keywords may not match but the concept is the same.",
        parameters: Type.Object({
          query: Type.String({
            description: "Natural language query to find semantically similar beliefs",
          }),
          min_similarity: Type.Optional(
            Type.Number({ description: "Minimum similarity threshold 0-1 (default: 0.5)" }),
          ),
          min_confidence: Type.Optional(
            Type.Number({ description: "Filter by minimum overall confidence" }),
          ),
          domain_filter: Type.Optional(
            Type.Array(Type.String(), { description: "Filter by domain path" }),
          ),
          include_archived: Type.Optional(
            Type.Boolean({ description: "Include archived beliefs (default: false)" }),
          ),
          limit: Type.Optional(Type.Number({ description: "Max results (default: 10)" })),
          ranking: Type.Optional(
            Type.Object({
              semantic_weight: Type.Optional(
                Type.Number({ description: "Weight for semantic similarity (0-1, default: 0.50)" }),
              ),
              confidence_weight: Type.Optional(
                Type.Number({ description: "Weight for belief confidence (0-1, default: 0.35)" }),
              ),
              recency_weight: Type.Optional(
                Type.Number({ description: "Weight for recency (0-1, default: 0.15)" }),
              ),
              explain: Type.Optional(
                Type.Boolean({ description: "Include score breakdown in results" }),
              ),
            }),
          ),
        }),
        async execute(
          _id: string,
          params: {
            query: string;
            min_similarity?: number;
            min_confidence?: number;
            domain_filter?: string[];
            include_archived?: boolean;
            limit?: number;
            ranking?: Record<string, unknown>;
          },
        ) {
          const args: Record<string, unknown> = {
            query: params.query,
            limit: params.limit ?? 10,
          };
          if (params.min_similarity != null) args.min_similarity = params.min_similarity;
          if (params.min_confidence != null) args.min_confidence = params.min_confidence;
          if (params.domain_filter) args.domain_filter = params.domain_filter;
          if (params.include_archived != null) args.include_archived = params.include_archived;
          if (params.ranking) args.ranking = params.ranking;

          const result = (await mcpCall(cfg, "belief_search", args)) as Record<string, unknown>;
          const beliefs = (result.beliefs ?? []) as Record<string, unknown>[];
          const lines = beliefs.map((b) => beliefSummary(b));

          return {
            content: [
              {
                type: "text" as const,
                text:
                  lines.length > 0
                    ? `Found ${lines.length} beliefs (semantic):\n${lines.join("\n")}`
                    : "No semantically similar beliefs found.",
              },
            ],
            details: result,
          };
        },
      },
      { name: "belief_search" },
    );

    // 11. confidence_explain — Explain belief confidence breakdown
    api.registerTool(
      {
        name: "confidence_explain",
        label: "Explain Confidence",
        description:
          "Explain why a belief has a particular confidence score, showing all contributing dimensions. " +
          "Use to understand which dimensions are weak and need improvement.",
        parameters: Type.Object({
          belief_id: Type.String({ description: "UUID of the belief to explain" }),
        }),
        async execute(_id: string, params: { belief_id: string }) {
          const result = (await mcpCall(cfg, "confidence_explain", {
            belief_id: params.belief_id,
          })) as Record<string, unknown>;

          const explanation = result.explanation as string | undefined;
          const dimensions = result.dimensions as Record<string, unknown>[] | undefined;

          let text = explanation ?? "No explanation available.";
          if (dimensions && dimensions.length > 0) {
            const dimLines = dimensions.map(
              (d) =>
                `  ${d.name}: ${d.score ?? "?"} (weight: ${d.weight ?? "?"})${d.recommendation ? ` — ${d.recommendation}` : ""}`,
            );
            text += `\n\nDimensions:\n${dimLines.join("\n")}`;
          }

          return {
            content: [{ type: "text" as const, text }],
            details: result,
          };
        },
      },
      { name: "confidence_explain" },
    );

    // 12. insight_extract — Extract insight from session into belief
    api.registerTool(
      {
        name: "insight_extract",
        label: "Extract Insight",
        description:
          "Extract an insight from a conversation session and create a belief in the knowledge base. " +
          "Use proactively when decisions are made, preferences expressed, or novel approaches discovered. " +
          "This bridges conversation tracking to the knowledge substrate with full provenance.",
        parameters: Type.Object({
          session_id: Type.String({ description: "Source session UUID" }),
          content: Type.String({ description: "The insight/belief content" }),
          domain_path: Type.Optional(
            Type.Array(Type.String(), { description: "Domain classification" }),
          ),
          confidence: Type.Optional(
            Type.Object({
              overall: Type.Optional(Type.Number({ description: "Overall confidence 0-1" })),
            }),
          ),
          entities: Type.Optional(
            Type.Array(
              Type.Object({
                name: Type.String(),
                type: Type.Optional(Type.String()),
                role: Type.Optional(Type.String()),
              }),
              { description: "Entities to link" },
            ),
          ),
        }),
        async execute(
          _id: string,
          params: {
            session_id: string;
            content: string;
            domain_path?: string[];
            confidence?: { overall?: number };
            entities?: Array<{ name: string; type?: string; role?: string }>;
          },
        ) {
          const args: Record<string, unknown> = {
            session_id: params.session_id,
            content: params.content,
          };
          if (params.domain_path) args.domain_path = params.domain_path;
          if (params.confidence) args.confidence = params.confidence;
          if (params.entities) args.entities = params.entities;

          const result = await mcpCall(cfg, "insight_extract", args);
          return {
            content: [
              {
                type: "text" as const,
                text: "Insight extracted and stored as belief.",
              },
            ],
            details: result,
          };
        },
      },
      { name: "insight_extract" },
    );

    // 13. pattern_record — Record a new behavioral pattern
    api.registerTool(
      {
        name: "pattern_record",
        label: "Record Pattern",
        description:
          "Record a new behavioral pattern. " +
          "Use when you notice recurring topics, consistent preferences, " +
          "working style patterns, or common problem-solving approaches.",
        parameters: Type.Object({
          type: Type.String({
            description:
              "Pattern type (topic_recurrence, preference, working_style, problem_solving, etc.)",
          }),
          description: Type.String({ description: "What the pattern is" }),
          evidence: Type.Optional(
            Type.Array(Type.String(), { description: "Session IDs as evidence" }),
          ),
          confidence: Type.Optional(Type.Number({ description: "Confidence 0-1 (default: 0.5)" })),
        }),
        async execute(
          _id: string,
          params: {
            type: string;
            description: string;
            evidence?: string[];
            confidence?: number;
          },
        ) {
          const args: Record<string, unknown> = {
            type: params.type,
            description: params.description,
          };
          if (params.evidence) args.evidence = params.evidence;
          if (params.confidence != null) args.confidence = params.confidence;

          const result = await mcpCall(cfg, "pattern_record", args);
          return {
            content: [{ type: "text" as const, text: "Pattern recorded." }],
            details: result,
          };
        },
      },
      { name: "pattern_record" },
    );

    // 14. pattern_reinforce — Strengthen existing pattern with new evidence
    api.registerTool(
      {
        name: "pattern_reinforce",
        label: "Reinforce Pattern",
        description:
          "Strengthen an existing pattern with new evidence. " +
          "Call when you observe a pattern that matches one already recorded. " +
          "This is how patterns naturally strengthen through use — stigmergy in action.",
        parameters: Type.Object({
          pattern_id: Type.String({ description: "UUID of the pattern to reinforce" }),
          session_id: Type.Optional(
            Type.String({ description: "Session that supports this pattern" }),
          ),
        }),
        async execute(_id: string, params: { pattern_id: string; session_id?: string }) {
          const args: Record<string, unknown> = {
            pattern_id: params.pattern_id,
          };
          if (params.session_id) args.session_id = params.session_id;

          const result = await mcpCall(cfg, "pattern_reinforce", args);
          return {
            content: [{ type: "text" as const, text: "Pattern reinforced." }],
            details: result,
          };
        },
      },
      { name: "pattern_reinforce" },
    );

    // 15. memory_forget — Archive/forget beliefs (GDPR-compliant)
    api.registerTool(
      {
        name: "memory_forget",
        label: "Forget",
        description:
          "Archive or forget a belief. GDPR-compliant. " +
          "Maintains history chain — the original belief is superseded, not deleted. " +
          "Provide either a belief_id for direct archival, or a query to search for candidates.",
        parameters: Type.Object({
          query: Type.Optional(Type.String({ description: "Search to find belief to forget" })),
          belief_id: Type.Optional(Type.String({ description: "Specific belief UUID" })),
        }),
        async execute(_id: string, params: { query?: string; belief_id?: string }) {
          if (params.belief_id) {
            await mcpCall(cfg, "belief_supersede", {
              old_belief_id: params.belief_id,
              new_content: "[archived by user request]",
              reason: "User requested removal via memory_forget",
            });
            return {
              content: [{ type: "text" as const, text: `Belief ${params.belief_id} archived.` }],
              details: { action: "archived", id: params.belief_id },
            };
          }

          if (params.query) {
            const result = (await mcpCall(cfg, "belief_search", {
              query: params.query,
              limit: 5,
              min_similarity: 0.5,
            })) as Record<string, unknown>;

            const beliefs = (result.beliefs ?? []) as Record<string, unknown>[];
            if (beliefs.length === 0) {
              return {
                content: [{ type: "text" as const, text: "No matching beliefs found." }],
                details: { found: 0 },
              };
            }

            const topMatch = beliefs[0];
            const topSimilarity = (topMatch.similarity as number) ?? 0;

            // Auto-archive if single high-confidence match
            if (beliefs.length === 1 || topSimilarity > 0.9) {
              await mcpCall(cfg, "belief_supersede", {
                old_belief_id: topMatch.id,
                new_content: "[archived by user request]",
                reason: "User requested removal via memory_forget",
              });
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `Archived: "${(topMatch.content as string)?.slice(0, 80)}"`,
                  },
                ],
                details: { action: "archived", id: topMatch.id },
              };
            }

            // Multiple candidates — ask for confirmation
            const list = beliefs
              .map(
                (b) =>
                  `- [${(b.id as string)?.slice(0, 8)}] ${(b.content as string)?.slice(0, 60)}...`,
              )
              .join("\n");

            return {
              content: [
                {
                  type: "text" as const,
                  text: `Found ${beliefs.length} candidates. Specify belief_id:\n${list}`,
                },
              ],
              details: {
                action: "candidates",
                candidates: beliefs.map((b) => ({ id: b.id, content: b.content })),
              },
            };
          }

          return {
            content: [{ type: "text" as const, text: "Provide query or belief_id." }],
            details: { error: "missing_param" },
          };
        },
      },
      { name: "memory_forget" },
    );

    // =====================
    // FILE-BASED MEMORY TOOLS — DR fallback for agents
    // =====================

    // Register OpenClaw's built-in memory_search and memory_get tools alongside Valence tools.
    // These operate on MEMORY.md (synced from Valence) and provide a DR fallback if Valence
    // is unreachable. The factory pattern lets OpenClaw inject per-agent config/session context.

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
      "You have access to a structured knowledge base (Valence) through belief_query, belief_search, belief_create, belief_supersede, entity_search, entity_get, tension_list, tension_resolve, pattern_search, pattern_record, pattern_reinforce, insight_extract, confidence_explain, and memory_forget tools.",
      "Use belief_query or belief_search BEFORE answering questions about past decisions, user preferences, technical approaches, or any topic that may have been discussed before.",
      "Use belief_create proactively when decisions are made, preferences are expressed, or important facts are shared.",
      "You also have memory_search and memory_get for file-based memory (MEMORY.md) as a fallback.",
    ].join(" ");

    // Auto-Recall: inject relevant beliefs before agent processes + system prompt
    api.on("before_agent_start", async (event) => {
      const baseResult: { systemPrompt?: string; prependContext?: string } = {
        systemPrompt: valenceSystemPrompt,
      };

      if (!cfg.autoRecall || !event.prompt || event.prompt.length < 5) {
        return baseResult;
      }

      try {
        const result = (await mcpCall(cfg, "belief_query", {
          query: event.prompt,
          limit: cfg.recallMaxResults,
        })) as Record<string, unknown>;

        const beliefs = (result.beliefs ?? []) as Record<string, unknown>[];
        if (beliefs.length === 0) return baseResult;

        const memoryContext = beliefs.map((b) => `- ${beliefSummary(b)}`).join("\n");

        log.info(`memory-valence: injecting ${beliefs.length} beliefs into context`);

        return {
          systemPrompt:
            valenceSystemPrompt +
            `\n\n<relevant-knowledge>\n` +
            `The following beliefs from the knowledge base may be relevant:\n` +
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
              // Duplicate detection — skip if very similar belief already exists
              const existing = (await mcpCall(cfg, "belief_search", {
                query: text,
                limit: 1,
                min_similarity: 0.95,
              })) as Record<string, unknown>;

              const matches = (existing.beliefs ?? []) as Record<string, unknown>[];
              if (matches.length > 0) continue;

              await mcpCall(cfg, "belief_create", {
                content: text,
                domain_path: cfg.captureDomains,
                confidence: { overall: 0.6 },
                source_type: "conversation",
              });
              captured++;
            } catch (err) {
              log.warn(`memory-valence: capture failed for belief: ${String(err)}`);
            }
          }

          if (captured > 0) {
            log.info(`memory-valence: auto-captured ${captured} beliefs`);
          }
        } catch (err) {
          log.warn(`memory-valence: auto-capture failed: ${String(err)}`);
        }
      });
    }

    // Session Tracking: map OpenClaw sessions to Valence
    if (cfg.sessionTracking) {
      api.on("session_start", async (event, ctx) => {
        try {
          const result = (await mcpCall(cfg, "session_start", {
            platform: "openclaw",
            metadata: {
              openclaw_session_id: ctx.sessionId,
              openclaw_agent_id: ctx.agentId,
            },
          })) as Record<string, unknown>;

          const valenceId = result.session_id as string | undefined;
          if (valenceId) {
            sessionMap.set(ctx.sessionId, valenceId);
            log.info(`memory-valence: started session ${valenceId}`);
          }
        } catch (err) {
          log.warn(`memory-valence: session_start failed: ${String(err)}`);
        }
      });

      api.on("session_end", async (_event, ctx) => {
        const valenceSessionId = sessionMap.get(ctx.sessionId);
        if (!valenceSessionId) return;

        try {
          await mcpCall(cfg, "session_end", {
            session_id: valenceSessionId,
            status: "completed",
          });
          sessionMap.delete(ctx.sessionId);
          log.info(`memory-valence: ended session ${valenceSessionId}`);
        } catch (err) {
          log.warn(`memory-valence: session_end failed: ${String(err)}`);
        }
      });
    }

    // Exchange Recording: record conversation turns
    if (cfg.exchangeRecording) {
      api.on("message_received", async (event, ctx) => {
        // Look up Valence session via conversationId or channelId
        const key = ctx.conversationId ?? ctx.channelId;
        const valenceSessionId = findValenceSession(sessionMap, key);
        if (!valenceSessionId) return;

        try {
          if (!event.content) return;
          await mcpCall(cfg, "exchange_add", {
            session_id: valenceSessionId,
            role: "user",
            content: event.content,
          });
        } catch (err) {
          log.warn(`memory-valence: exchange_add (user) failed: ${String(err)}`);
        }
      });

      api.on("message_sent", async (event, ctx) => {
        const key = ctx.conversationId ?? ctx.channelId;
        const valenceSessionId = findValenceSession(sessionMap, key);
        if (!valenceSessionId) return;

        try {
          if (!event.content) return;
          await mcpCall(cfg, "exchange_add", {
            session_id: valenceSessionId,
            role: "assistant",
            content: event.content,
          });
        } catch (err) {
          log.warn(`memory-valence: exchange_add (assistant) failed: ${String(err)}`);
        }
      });
    }

    // =====================
    // MEMORY.MD SYNC — Disaster recovery fallback
    // =====================

    /**
     * Sync MEMORY.md from Valence beliefs.
     * Queries high-confidence beliefs and active patterns, then writes
     * a markdown snapshot to the workspace. This file serves as a
     * disaster-recovery fallback if Valence is unavailable.
     */
    async function syncMemoryMd(): Promise<void> {
      if (!memoryMdAbsPath) return;

      try {
        // Fetch beliefs sorted by confidence (REST API for bulk listing)
        const { beliefs } = await listBeliefs(cfg, {
          limit: 100,
          min_confidence: 0.5,
        });

        // Fetch active patterns
        let patterns: Record<string, unknown>[] = [];
        try {
          const patternResult = await listPatterns(cfg, { limit: 30 });
          patterns = patternResult.patterns;
        } catch {
          /* patterns are optional */
        }

        const md = generateMemoryMd(beliefs, patterns);

        await mkdir(dirname(memoryMdAbsPath), { recursive: true });
        await writeFile(memoryMdAbsPath, md, "utf-8");

        log.info(
          `memory-valence: synced MEMORY.md (${beliefs.length} beliefs, ${patterns.length} patterns)`,
        );
      } catch (err) {
        log.warn(`memory-valence: MEMORY.md sync failed: ${String(err)}`);
      }
    }

    // Sync on after_compaction — context was just compressed, update DR file
    api.on("after_compaction", async () => {
      await syncMemoryMd();
    });

    // Also sync on session_end — ensure DR file has final session state
    if (cfg.sessionTracking) {
      api.on("session_end", async () => {
        await syncMemoryMd();
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
        // Flush any pending session mappings
        sessionMap.clear();
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
          .description("Search beliefs")
          .argument("<query>", "Search query")
          .option("--limit <n>", "Max results", "10")
          .action(async (query: string, opts: { limit: string }) => {
            const result = (await mcpCall(cfg, "belief_query", {
              query,
              limit: parseInt(opts.limit, 10),
            })) as Record<string, unknown>;

            const beliefs = (result.beliefs ?? []) as Record<string, unknown>[];
            if (beliefs.length === 0) {
              console.log("No beliefs found.");
              return;
            }

            for (const b of beliefs) {
              console.log(beliefSummary(b));
            }
          });

        valence
          .command("add")
          .description("Add a belief")
          .argument("<content>", "Belief content")
          .option("--domain <path>", "Domain path (slash-separated)", "conversations")
          .option("--confidence <n>", "Confidence 0-1", "0.7")
          .action(async (content: string, opts: { domain: string; confidence: string }) => {
            await mcpCall(cfg, "belief_create", {
              content,
              domain_path: opts.domain.split("/"),
              confidence: { overall: parseFloat(opts.confidence) },
              source_type: "user_input",
            });
            console.log("Belief created.");
          });
      },
      { commands: ["valence"] },
    );
  },
};

// --- Session Helpers ---

/**
 * Find a Valence session ID by checking the session map.
 * Message hooks don't have sessionId directly, so we look up
 * by conversationId or channelId stored during session_start.
 */
function findValenceSession(
  sessionMap: Map<string, string>,
  key: string | undefined,
): string | undefined {
  if (!key) return undefined;
  // Direct match (sessionId → valenceId)
  if (sessionMap.has(key)) return sessionMap.get(key);
  // Fallback: check all values (small map, linear scan is fine)
  for (const [, valenceId] of sessionMap) {
    return valenceId; // Return most recent if only one active
  }
  return undefined;
}

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
 * Generate a markdown snapshot from Valence beliefs and patterns.
 * Used as disaster-recovery fallback — if Valence is unreachable,
 * OpenClaw's file-based memory system can still read this file.
 */
function generateMemoryMd(
  beliefs: Record<string, unknown>[],
  patterns: Record<string, unknown>[],
): string {
  const now = new Date().toISOString();
  const lines: string[] = [
    "# Knowledge Snapshot",
    "",
    `> Auto-synced from Valence. Last updated: ${now}`,
    "> This file is a disaster-recovery fallback. Source of truth is Valence.",
    "",
  ];

  if (beliefs.length > 0) {
    // Group by top-level domain
    const byDomain = new Map<string, Record<string, unknown>[]>();
    for (const b of beliefs) {
      const domainPath = Array.isArray(b.domain_path) ? (b.domain_path as string[]) : [];
      const domain = domainPath[0] ?? "general";
      if (!byDomain.has(domain)) byDomain.set(domain, []);
      byDomain.get(domain)!.push(b);
    }

    lines.push("## Beliefs", "");

    // Sort domains alphabetically, "general" last
    const sortedDomains = [...byDomain.keys()].sort((a, b) => {
      if (a === "general") return 1;
      if (b === "general") return -1;
      return a.localeCompare(b);
    });

    for (const domain of sortedDomains) {
      const domainBeliefs = byDomain.get(domain)!;
      lines.push(`### ${domain}`, "");

      // Sort by confidence descending within domain
      domainBeliefs.sort((a, b) => {
        const confA =
          typeof a.confidence === "object" && a.confidence
            ? ((a.confidence as Record<string, number>).overall ?? 0)
            : 0;
        const confB =
          typeof b.confidence === "object" && b.confidence
            ? ((b.confidence as Record<string, number>).overall ?? 0)
            : 0;
        return (confB as number) - (confA as number);
      });

      for (const b of domainBeliefs) {
        const conf =
          typeof b.confidence === "object" && b.confidence
            ? ((b.confidence as Record<string, number>).overall ?? "?")
            : "?";
        lines.push(`- ${b.content} (confidence: ${conf})`);
      }
      lines.push("");
    }
  }

  if (patterns.length > 0) {
    lines.push("## Patterns", "");

    for (const p of patterns) {
      const status = (p.status as string) ?? "emerging";
      const conf = typeof p.confidence === "number" ? p.confidence.toFixed(2) : "?";
      lines.push(`- [${status}] ${p.description} (confidence: ${conf})`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export default valencePlugin;
