/**
 * Configuration for the Valence memory plugin.
 */

export type ValenceConfig = {
  serverUrl: string;
  authToken?: string;
  autoRecall: boolean;
  autoCapture: boolean;
  recallMaxResults: number;
  recallMinScore: number;
  captureDomains: string[];
  memoryMdSync: boolean;
  memoryMdPath: string;
  sessionIngestion: boolean;
  staleSessionMinutes: number;
  autoCompileOnFlush: boolean;
  includeSystemMessages: boolean;
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
      autoCapture: raw.autoCapture === true,
      recallMaxResults: typeof raw.recallMaxResults === "number" ? raw.recallMaxResults : 5,
      // Reserved for future use — parsed but not yet wired to behavior
      recallMinScore: typeof raw.recallMinScore === "number" ? raw.recallMinScore : 0.3, // TODO: wire to knowledge_search min_score filter
      captureDomains: Array.isArray(raw.captureDomains)
        ? raw.captureDomains.map(String)
        : ["conversations"], // TODO: wire to memory_store tags on auto-capture
      memoryMdSync: raw.memoryMdSync !== false, // TODO: implement MEMORY.md sync from Valence
      memoryMdPath: typeof raw.memoryMdPath === "string" ? raw.memoryMdPath : "MEMORY.md", // TODO: used when memoryMdSync is implemented
      sessionIngestion: raw.sessionIngestion !== false,
      staleSessionMinutes: typeof raw.staleSessionMinutes === "number" ? raw.staleSessionMinutes : 30, // TODO: wire to session flush-stale cron/timer
      autoCompileOnFlush: raw.autoCompileOnFlush !== false,
      includeSystemMessages: raw.includeSystemMessages !== false, // TODO: filter system messages in session hooks
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
