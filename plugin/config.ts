/**
 * Configuration for the Valence memory plugin.
 */

export type ValenceConfig = {
  serverUrl: string;
  authToken?: string;
  autoRecall: boolean;
  autoCapture: boolean;
  sessionTracking: boolean;
  exchangeRecording: boolean;
  recallMaxResults: number;
  recallMinScore: number;
  captureDomains: string[];
  memoryMdSync: boolean;
  memoryMdPath: string;
};

export const valenceConfigSchema = {
  parse(value: unknown): ValenceConfig {
    const raw = (value ?? {}) as Record<string, unknown>;

    const serverUrl = resolveEnvVar(String(raw.serverUrl ?? "http://localhost:8420"));
    const authToken = raw.authToken ? resolveEnvVar(String(raw.authToken)) : undefined;

    return {
      serverUrl: serverUrl.replace(/\/+$/, ""),
      authToken,
      autoRecall: raw.autoRecall !== false,
      autoCapture: raw.autoCapture !== false,
      sessionTracking: raw.sessionTracking !== false,
      exchangeRecording: raw.exchangeRecording !== false,
      recallMaxResults: typeof raw.recallMaxResults === "number" ? raw.recallMaxResults : 5,
      recallMinScore: typeof raw.recallMinScore === "number" ? raw.recallMinScore : 0.3,
      captureDomains: Array.isArray(raw.captureDomains)
        ? raw.captureDomains.map(String)
        : ["conversations"],
      memoryMdSync: raw.memoryMdSync !== false,
      memoryMdPath: typeof raw.memoryMdPath === "string" ? raw.memoryMdPath : "MEMORY.md",
    };
  },
};

function resolveEnvVar(value: string): string {
  return value.replace(/\$\{(\w+)\}/g, (_match, name) => {
    const envValue = process.env[name];
    if (!envValue) throw new Error(`Environment variable ${name} is not set`);
    return envValue;
  });
}
