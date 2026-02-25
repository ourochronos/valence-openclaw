/**
 * Gateway inference endpoint for Valence compilation.
 * Exposes a POST /valence/inference route that proxies to OpenClaw's configured model providers.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { IncomingMessage, ServerResponse } from "http";

interface InferenceRequest {
  prompt: string;
  system?: string;
}

interface InferenceResponse {
  text: string;
}

export function registerInferenceEndpoint(
  api: OpenClawPluginApi,
  config: { inferenceModel?: string; serverUrl: string; authToken?: string },
): void {
  const log = api.logger;

  api.registerHttpRoute({
    path: "/valence/inference",
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== "POST") {
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Method not allowed" }));
        return;
      }

      // Read body
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      }
      const body: InferenceRequest = JSON.parse(Buffer.concat(chunks).toString("utf-8"));

      if (!body.prompt) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing 'prompt' field" }));
        return;
      }

      try {
        const text = await callModel(api, config.inferenceModel, body.prompt, body.system);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ text }));
      } catch (err) {
        log.warn(`valence-inference: completion failed: ${String(err)}`);
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
    },
  });

  log.info("valence-inference: registered POST /valence/inference endpoint");
}

/**
 * Resolve an auth credential from OpenClaw's auth-profiles store.
 * Returns the token and its type (token = OAuth Bearer, api_key = x-api-key).
 */
async function resolveAuthProfileCredential(
  api: OpenClawPluginApi,
  provider: string,
): Promise<{ token: string; type: "token" | "api_key" } | undefined> {
  const { readFileSync, readdirSync, existsSync } = await import("fs");
  const { join } = await import("path");

  const homeDir = process.env.HOME || process.env.USERPROFILE || "";
  const stateDir = process.env.OPENCLAW_STATE_DIR || join(homeDir, ".openclaw");
  const agentsDir = join(stateDir, "agents");

  if (!existsSync(agentsDir)) return undefined;

  try {
    const agents = readdirSync(agentsDir);
    for (const agentId of agents) {
      const profilePath = join(agentsDir, agentId, "agent", "auth-profiles.json");
      if (!existsSync(profilePath)) continue;

      try {
        const data = JSON.parse(readFileSync(profilePath, "utf-8"));
        const profiles = data.profiles || data;

        for (const [profileId, profile] of Object.entries(profiles)) {
          const p = profile as any;
          if (p.provider !== provider) continue;

          // Prefer api_key type, fall back to token (OAuth)
          if (p.type === "api_key" && p.key) {
            return { token: p.key, type: "api_key" };
          }
          if (p.type === "token" && p.token) {
            return { token: p.token, type: "token" };
          }
        }
      } catch {
        // Skip malformed files
      }
    }
  } catch {
    // agents dir not readable
  }

  return undefined;
}

/**
 * Call Anthropic Messages API directly.
 * Supports both OAuth Bearer tokens (sk-ant-oat) and standard API keys (sk-ant-api).
 */
async function callAnthropic(
  credential: { token: string; type: "token" | "api_key" },
  model: string,
  prompt: string,
  system?: string,
): Promise<string> {
  const systemMessage = system || "You are a precise knowledge-management assistant. Respond ONLY with valid JSON; no markdown, no commentary.";

  // OAuth tokens use Bearer auth; API keys use x-api-key header
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
  };

  if (credential.type === "token") {
    // OAuth token (sk-ant-oat) — use Bearer auth like OpenClaw does internally
    headers["Authorization"] = `Bearer ${credential.token}`;
    headers["anthropic-beta"] = "oauth-2025-04-20";
  } else {
    // Standard API key (sk-ant-api)
    headers["x-api-key"] = credential.token;
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system: systemMessage,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Anthropic API returned ${response.status}: ${errorText.slice(0, 500)}`);
  }

  const data = await response.json() as any;
  const content = data?.content?.[0]?.text;

  if (typeof content !== "string") {
    throw new Error(`Unexpected Anthropic response format: ${JSON.stringify(data).slice(0, 500)}`);
  }

  return content;
}

async function callModel(
  api: OpenClawPluginApi,
  inferenceModel: string | undefined,
  prompt: string,
  system?: string,
): Promise<string> {
  // Parse inferenceModel as "provider/model" or just "model"
  let targetProvider: string | undefined;
  let targetModelId: string | undefined;

  if (inferenceModel?.includes("/")) {
    const [p, m] = inferenceModel.split("/", 2);
    targetProvider = p;
    targetModelId = m;
  } else {
    targetModelId = inferenceModel;
  }

  // --- Anthropic provider: resolve from auth-profiles ---
  if (targetProvider === "anthropic" || (!targetProvider && targetModelId?.startsWith("claude"))) {
    const credential = await resolveAuthProfileCredential(api, "anthropic");
    if (credential) {
      const model = targetModelId || "claude-sonnet-4-20250514";
      api.logger.info(`valence-inference: using Anthropic auth-profile (${credential.type}), model=${model}`);
      return callAnthropic(credential, model, prompt, system);
    }
    if (targetProvider === "anthropic") {
      throw new Error("Anthropic provider requested but no auth-profile credential found");
    }
    // Fall through to models.providers search
  }

  // --- models.providers config (existing logic) ---
  const modelsConfig = api.config?.models;
  if (!modelsConfig?.providers) {
    throw new Error("No model providers configured in OpenClaw and no matching auth-profile found");
  }

  for (const [providerName, providerConfig] of Object.entries(modelsConfig.providers)) {
    if (targetProvider && providerName !== targetProvider) continue;

    for (const model of (providerConfig as any).models || []) {
      if (targetModelId && model.id !== targetModelId) continue;

      const apiType = model.api || (providerConfig as any).api || "openai-completions";

      if (!["openai-completions", "openai-responses", "github-copilot", "ollama"].includes(apiType)) {
        throw new Error(`Unsupported API type '${apiType}' for inference. Use an OpenAI-compatible provider.`);
      }

      const baseUrl = (providerConfig as any).baseUrl?.replace(/\/$/, "");
      const apiKey = (providerConfig as any).apiKey;

      if (!baseUrl) {
        throw new Error(`Provider '${providerName}' has no baseUrl configured`);
      }

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (apiKey) {
        headers["Authorization"] = `Bearer ${apiKey}`;
      }
      if ((providerConfig as any).headers) {
        Object.assign(headers, (providerConfig as any).headers);
      }

      const systemMessage = system || "You are a precise knowledge-management assistant. Respond ONLY with valid JSON; no markdown, no commentary.";

      const requestBody = {
        model: model.id,
        messages: [
          { role: "system", content: systemMessage },
          { role: "user", content: prompt },
        ],
      };

      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        throw new Error(`Model API returned ${response.status}: ${errorText.slice(0, 500)}`);
      }

      const data = await response.json() as any;
      const content = data?.choices?.[0]?.message?.content;

      if (typeof content !== "string") {
        throw new Error(`Unexpected response format from model API: ${JSON.stringify(data).slice(0, 500)}`);
      }

      return content;
    }
  }

  throw new Error(
    targetModelId
      ? `Model '${inferenceModel}' not found in OpenClaw providers or auth-profiles`
      : "No models available in OpenClaw providers"
  );
}
