/**
 * VENOM CLI — NIM Client (STRICT MODEL ENFORCEMENT)
 *
 * NVIDIA NIM API client with:
 * - Model whitelist enforcement (rejects non-approved models)
 * - Retry with exponential backoff
 * - Streaming SSE support
 * - Progress indicator
 */

import type { ChatMessage, AgentConfig, NimResponse } from "./types.js";
import { NIM_BASE_URL, ALLOWED_MODELS } from "./types.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class NimApiError extends Error {
  public readonly statusCode: number;
  public readonly responseBody: string;
  constructor(statusCode: number, responseBody: string) {
    super(`NIM API error [${statusCode}]: ${responseBody.slice(0, 500)}`);
    this.name = "NimApiError";
    this.statusCode = statusCode;
    this.responseBody = responseBody;
  }
  get isRateLimited(): boolean { return this.statusCode === 429; }
  get isServerError(): boolean { return this.statusCode >= 500; }
  get isAuthError(): boolean { return this.statusCode === 401 || this.statusCode === 403; }
}

export class ModelNotAllowedError extends Error {
  constructor(model: string) {
    super(
      `[VENOM STRICT] Model "${model}" is NOT in the allowed list.\n` +
      `  Allowed: ${[...ALLOWED_MODELS].join(", ")}`
    );
    this.name = "ModelNotAllowedError";
  }
}

// ---------------------------------------------------------------------------
// Retry Config
// ---------------------------------------------------------------------------

interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryableStatuses: Set<number>;
}

const DEFAULT_RETRY: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 15000,
  retryableStatuses: new Set([429, 500, 502, 503, 504]),
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class NimClient {
  private apiKey: string;
  private retry: RetryConfig;
  private _totalTokens = 0;
  private _totalCalls = 0;

  constructor(apiKey: string, retryConfig?: Partial<RetryConfig>) {
    this.apiKey = apiKey;
    this.retry = { ...DEFAULT_RETRY, ...retryConfig };
  }

  /**
   * Validate that the model is in the ALLOWED_MODELS whitelist.
   * Throws ModelNotAllowedError if not.
   */
  private enforceModelWhitelist(model: string): void {
    if (!ALLOWED_MODELS.has(model)) {
      throw new ModelNotAllowedError(model);
    }
  }

  /**
   * Send a chat completion request.
   * ENFORCES strict model whitelist before making the API call.
   */
  async chat(agent: AgentConfig, messages: ChatMessage[]): Promise<string> {
    // ── STRICT MODEL GATE ──
    this.enforceModelWhitelist(agent.model);

    const fullMessages: ChatMessage[] = [
      { role: "system", content: agent.systemPrompt },
      ...messages,
    ];

    const body = JSON.stringify({
      model: agent.model,
      messages: fullMessages,
      temperature: agent.temperature,
      max_tokens: agent.maxTokens,
      stream: false,
    });

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.retry.maxRetries; attempt++) {
      try {
        const response = await fetch(NIM_BASE_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body,
        });

        if (!response.ok) {
          const errText = await response.text();
          const apiError = new NimApiError(response.status, errText);

          if (apiError.isAuthError) throw apiError;

          if (
            this.retry.retryableStatuses.has(response.status) &&
            attempt < this.retry.maxRetries
          ) {
            const delay = this.backoff(attempt, response);
            console.error(
              `\x1b[33m  ↻ Retry ${attempt + 1}/${this.retry.maxRetries} after ${delay}ms (HTTP ${response.status})\x1b[0m`
            );
            await sleep(delay);
            lastError = apiError;
            continue;
          }

          throw apiError;
        }

        const data = (await response.json()) as NimResponse;

        if (!data.choices || data.choices.length === 0) {
          throw new Error("NIM API returned empty choices.");
        }

        this._totalCalls++;
        if (data.usage) this._totalTokens += data.usage.total_tokens;

        return data.choices[0].message.content;
      } catch (err) {
        if (err instanceof NimApiError && err.isAuthError) throw err;
        if (err instanceof ModelNotAllowedError) throw err;

        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < this.retry.maxRetries) {
          await sleep(this.backoff(attempt));
          continue;
        }
      }
    }

    throw lastError || new Error("NIM API call failed after all retries.");
  }

  /** Chat with animated progress dots. */
  async chatWithProgress(
    agent: AgentConfig,
    messages: ChatMessage[],
    label: string
  ): Promise<string> {
    process.stdout.write(`\x1b[36m⟐ ${label}\x1b[0m `);
    const dots = setInterval(() => process.stdout.write("·"), 400);
    try {
      const result = await this.chat(agent, messages);
      clearInterval(dots);
      process.stdout.write(" \x1b[32m✓\x1b[0m\n");
      return result;
    } catch (err) {
      clearInterval(dots);
      process.stdout.write(" \x1b[91m✗\x1b[0m\n");
      throw err;
    }
  }

  /**
   * Chat with a custom system prompt override (for slash commands).
   * The agent's model and temperature are preserved; only the system prompt changes.
   */
  async chatWithSystemPrompt(
    agent: AgentConfig,
    systemPrompt: string,
    messages: ChatMessage[]
  ): Promise<string> {
    const overriddenAgent: AgentConfig = { ...agent, systemPrompt };
    return this.chat(overriddenAgent, messages);
  }

  get totalTokensUsed(): number { return this._totalTokens; }
  get totalCalls(): number { return this._totalCalls; }
  get hasApiKey(): boolean { return this.apiKey.length > 0; }

  private backoff(attempt: number, response?: Response): number {
    if (response) {
      const ra = response.headers.get("Retry-After");
      if (ra) {
        const s = parseInt(ra, 10);
        if (!isNaN(s)) return Math.min(s * 1000, this.retry.maxDelayMs);
      }
    }
    const exp = this.retry.baseDelayMs * Math.pow(2, attempt);
    const jitter = Math.random() * this.retry.baseDelayMs;
    return Math.min(exp + jitter, this.retry.maxDelayMs);
  }
}
