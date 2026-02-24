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

async function callModel(
  api: OpenClawPluginApi,
  inferenceModel: string | undefined,
  prompt: string,
  system?: string,
): Promise<string> {
  const modelsConfig = api.config?.models;
  if (!modelsConfig?.providers) {
    throw new Error("No model providers configured in OpenClaw");
  }

  // Parse inferenceModel as "provider/model" or just "model" (search all providers)
  let targetProvider: string | undefined;
  let targetModelId: string | undefined;

  if (inferenceModel?.includes("/")) {
    const [p, m] = inferenceModel.split("/", 2);
    targetProvider = p;
    targetModelId = m;
  } else {
    targetModelId = inferenceModel;
  }

  // Find the provider and model
  for (const [providerName, providerConfig] of Object.entries(modelsConfig.providers)) {
    if (targetProvider && providerName !== targetProvider) continue;

    for (const model of providerConfig.models || []) {
      if (targetModelId && model.id !== targetModelId) continue;

      // Found a match — or if no target specified, use first available
      const apiType = model.api || providerConfig.api || "openai-completions";

      if (!["openai-completions", "openai-responses", "github-copilot", "ollama"].includes(apiType)) {
        throw new Error(`Unsupported API type '${apiType}' for inference. Use an OpenAI-compatible provider.`);
      }

      const baseUrl = providerConfig.baseUrl?.replace(/\/$/, "");
      const apiKey = providerConfig.apiKey;

      if (!baseUrl) {
        throw new Error(`Provider '${providerName}' has no baseUrl configured`);
      }

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (apiKey) {
        headers["Authorization"] = `Bearer ${apiKey}`;
      }
      // Some providers use custom auth headers
      if (providerConfig.headers) {
        Object.assign(headers, providerConfig.headers);
      }

      const systemMessage = system || "You are a precise knowledge-management assistant. Respond ONLY with valid JSON; no markdown, no commentary.";

      const requestBody = {
        model: model.id,
        messages: [
          { role: "system", content: systemMessage },
          { role: "user", content: prompt },
        ],
      };

      // Use native fetch (available in Node 18+)
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
      ? `Model '${inferenceModel}' not found in OpenClaw providers`
      : "No models available in OpenClaw providers"
  );
}
