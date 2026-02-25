/**
 * CLI client for Valence.
 * Executes valence CLI commands and parses JSON output.
 */

import { execFile, spawn } from "child_process";
import { promisify } from "util";
import type { ValenceConfig } from "./config.js";

const execFileAsync = promisify(execFile);

export interface ValenceResult {
  success: boolean;
  data?: any;
  error?: string;
}

/**
 * Execute a valence CLI command and return parsed JSON output.
 * Auth token and server URL are passed via environment variables.
 */
export async function valenceExec(
  cfg: ValenceConfig,
  args: string[],
  options?: { timeout?: number }
): Promise<ValenceResult> {
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    VALENCE_OUTPUT: "json",
  };
  if (cfg.serverUrl) env.VALENCE_SERVER_URL = cfg.serverUrl;
  if (cfg.authToken) env.VALENCE_TOKEN = cfg.authToken;

  try {
    const { stdout, stderr } = await execFileAsync("valence", ["--json", ...args], {
      env,
      timeout: options?.timeout ?? 30000,
      maxBuffer: 10 * 1024 * 1024, // 10MB for large search results
    });

    try {
      const parsed = JSON.parse(stdout);
      return { success: true, data: parsed };
    } catch {
      // CLI returned non-JSON (e.g. plain text success message)
      return { success: true, data: { text: stdout.trim() } };
    }
  } catch (err: any) {
    const stderr = err.stderr || "";
    const stdout = err.stdout || "";
    // Try to parse error JSON from stdout
    try {
      const parsed = JSON.parse(stdout);
      return { success: false, data: parsed, error: parsed.error || stderr };
    } catch {
      return { success: false, error: stderr || err.message || String(err) };
    }
  }
}

/**
 * Execute a valence CLI command with stdin input.
 */
export async function valenceExecWithStdin(
  cfg: ValenceConfig,
  args: string[],
  stdin: string,
  options?: { timeout?: number }
): Promise<ValenceResult> {
  return new Promise((resolve) => {
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      VALENCE_OUTPUT: "json",
    };
    if (cfg.serverUrl) env.VALENCE_SERVER_URL = cfg.serverUrl;
    if (cfg.authToken) env.VALENCE_TOKEN = cfg.authToken;

    const proc = spawn("valence", ["--json", ...args], {
      env,
      timeout: options?.timeout ?? 30000,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on("close", (code) => {
      try {
        const parsed = JSON.parse(stdout);
        resolve({ success: code === 0, data: parsed, error: code !== 0 ? (parsed.error || stderr) : undefined });
      } catch {
        resolve({ success: code === 0, data: { text: stdout.trim() }, error: code !== 0 ? stderr : undefined });
      }
    });

    proc.on("error", (err) => {
      resolve({ success: false, error: String(err) });
    });

    proc.stdin.write(stdin);
    proc.stdin.end();
  });
}

/**
 * Health check — run `valence status --json`
 */
export async function healthCheck(cfg: ValenceConfig): Promise<{ ok: boolean; version?: string; database?: string; error?: string }> {
  const result = await valenceExec(cfg, ["status"], { timeout: 5000 });
  if (result.success && result.data) {
    return { 
      ok: true, 
      version: result.data.version || result.data.valence_version,
      database: result.data.database || result.data.db_name
    };
  }
  return { ok: false, error: result.error };
}
