/**
 * HTTP client for Valence MCP server.
 * Sends JSON-RPC 2.0 requests to the /api/v1/mcp endpoint.
 */

import type { ValenceConfig } from "./config.js";

let requestId = 0;

type McpResponse = {
  jsonrpc: "2.0";
  result?: { content?: Array<{ type: string; text: string }>; isError?: boolean };
  error?: { code: number; message: string; data?: unknown };
  id: number;
};

/**
 * Call a Valence MCP tool via HTTP JSON-RPC.
 */
export async function mcpCall(
  cfg: ValenceConfig,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const id = ++requestId;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.authToken) headers["Authorization"] = `Bearer ${cfg.authToken}`;

  const resp = await fetch(`${cfg.serverUrl}/api/v1/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: toolName, arguments: args },
      id,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Valence HTTP ${resp.status}: ${body}`);
  }

  const data = (await resp.json()) as McpResponse;

  if (data.error) {
    throw new Error(`Valence MCP error ${data.error.code}: ${data.error.message}`);
  }

  if (data.result?.isError) {
    const text = data.result.content?.map((c) => c.text).join("\n") ?? "Unknown error";
    throw new Error(`Valence tool error: ${text}`);
  }

  // Parse and return the tool result
  const texts = data.result?.content?.filter((c) => c.type === "text").map((c) => c.text) ?? [];
  if (texts.length === 0) return {};

  // Try to parse as JSON (most Valence tools return JSON)
  const joined = texts.join("\n");
  try {
    return JSON.parse(joined);
  } catch {
    return { text: joined };
  }
}

/**
 * Check Valence server health.
 */
export async function healthCheck(
  cfg: ValenceConfig,
): Promise<{ ok: boolean; version?: string; database?: string; error?: string }> {
  try {
    const headers: Record<string, string> = {};
    if (cfg.authToken) headers["Authorization"] = `Bearer ${cfg.authToken}`;

    const resp = await fetch(`${cfg.serverUrl}/api/v1/health`, {
      headers,
      signal: AbortSignal.timeout(5_000),
    });

    if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };

    const data = (await resp.json()) as Record<string, unknown>;
    return {
      ok: true,
      version: String(data.version ?? "unknown"),
      database: String(data.database ?? "unknown"),
    };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/**
 * Call a Valence REST endpoint (not MCP).
 * Used for session ingestion endpoints that are plain REST.
 */
export async function restCall(
  cfg: ValenceConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.authToken) headers["Authorization"] = `Bearer ${cfg.authToken}`;

  const resp = await fetch(`${cfg.serverUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Valence REST ${resp.status}: ${text}`);
  }

  if (resp.status === 204) return {};
  return resp.json();
}
