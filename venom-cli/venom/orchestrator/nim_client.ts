/**
 * VENOM CLI — NIM Client
 *
 * NVIDIA NIM API client supporting both standard request/response and
 * progress-indicator modes. Handles authentication, error mapping,
 * retries with exponential backoff, and rate limit awareness.
 *
 * All API calls go through the single NIM endpoint:
 *   https://integrate.api.nvidia.com/v1/chat/completions
 */

import type {
  ChatMessage,
  AgentConfig,
  NimResponse,
  NimStreamChunk,
} from "./types.js";
import { NIM_BASE_URL } from "./types.js";

// ---------------------------------------------------------------------------
// Error Classes
// ---------------------------------------------------------------------------

export class NimApiError extends Error {
  public readonly statusCode: number;
  public readonly responseBody: string;

  constructor(statusCode: number, responseBody: string) {
    const truncated = responseBody.slice(0, 500);
    super(`NIM API error [${statusCode}]: ${truncated}`);
    this.name = "NimApiError";
    this.statusCode = statusCode;
    this.responseBody = responseBody;
  }

  get isRateLimited(): boolean {
    return this.statusCode === 429;
  }

  get isServerError(): boolean {
    return this.statusCode >= 500;
  }

  get isAuthError(): boolean {
    return this.statusCode === 401 || this.statusCode === 403;
  }
}

export class NimEmptyResponseError extends Error {
  constructor() {
    super("NIM API returned empty choices array.");
    this.name = "NimEmptyResponseError";
  }
}

// ---------------------------------------------------------------------------
// Retry Configuration
// ---------------------------------------------------------------------------

interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryableStatuses: Set<number>;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 15000,
  retryableStatuses: new Set([429, 500, 502, 503, 504]),
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// NIM Client
// ---------------------------------------------------------------------------

export class NimClient {
  private apiKey: string;
  private retryConfig: RetryConfig;

  /** Tracks total tokens consumed across all calls in this session. */
  private _totalTokensUsed: number = 0;
  private _totalCalls: number = 0;

  constructor(apiKey: string, retryConfig?: Partial<RetryConfig>) {
    this.apiKey = apiKey;
    this.retryConfig = { ...DEFAULT_RETRY_CONFIG, ...retryConfig };
  }

  // ── Core API Call ────────────────────────────────────────────────────────

  /**
   * Send a chat completion request to the NIM endpoint.
   * Automatically prepends the agent's system prompt.
   * Retries on transient failures with exponential backoff.
   */
  async chat(agent: AgentConfig, messages: ChatMessage[]): Promise<string> {
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

    for (let attempt = 0; attempt <= this.retryConfig.maxRetries; attempt++) {
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

          // Don't retry auth errors
          if (apiError.isAuthError) {
            throw apiError;
          }

          // Retry on transient errors
          if (
            this.retryConfig.retryableStatuses.has(response.status) &&
            attempt < this.retryConfig.maxRetries
          ) {
            const delay = this.calculateBackoff(attempt, response);
            console.error(
              `\x1b[33m  ↻ Retry ${attempt + 1}/${this.retryConfig.maxRetries} after ${delay}ms (HTTP ${response.status})\x1b[0m`
            );
            await sleep(delay);
            lastError = apiError;
            continue;
          }

          throw apiError;
        }

        const data = (await response.json()) as NimResponse;

        if (!data.choices || data.choices.length === 0) {
          throw new NimEmptyResponseError();
        }

        // Track usage
        this._totalCalls++;
        if (data.usage) {
          this._totalTokensUsed += data.usage.total_tokens;
        }

        return data.choices[0].message.content;
      } catch (err) {
        if (err instanceof NimApiError && err.isAuthError) {
          throw err;
        }

        lastError = err instanceof Error ? err : new Error(String(err));

        if (attempt < this.retryConfig.maxRetries) {
          const delay = this.calculateBackoff(attempt);
          await sleep(delay);
          continue;
        }
      }
    }

    throw lastError || new Error("NIM API call failed after all retries.");
  }

  // ── Chat with Progress Indicator ─────────────────────────────────────────

  /**
   * Send a chat request while displaying an animated progress indicator.
   * Prints a label with dots while waiting, then ✓ on success or ✗ on failure.
   */
  async chatWithProgress(
    agent: AgentConfig,
    messages: ChatMessage[],
    label: string
  ): Promise<string> {
    process.stdout.write(`\x1b[36m⟐ ${label}\x1b[0m `);
    const dotInterval = setInterval(() => process.stdout.write("·"), 400);

    try {
      const result = await this.chat(agent, messages);
      clearInterval(dotInterval);
      process.stdout.write(" \x1b[32m✓\x1b[0m\n");
      return result;
    } catch (err) {
      clearInterval(dotInterval);
      process.stdout.write(" \x1b[91m✗\x1b[0m\n");
      throw err;
    }
  }

  // ── Chat with Streaming Output ───────────────────────────────────────────

  /**
   * Send a chat request with streaming enabled.
   * Calls `onChunk` for each partial token received.
   * Returns the full concatenated response.
   */
  async chatStreaming(
    agent: AgentConfig,
    messages: ChatMessage[],
    onChunk: (token: string) => void
  ): Promise<string> {
    const fullMessages: ChatMessage[] = [
      { role: "system", content: agent.systemPrompt },
      ...messages,
    ];

    const body = JSON.stringify({
      model: agent.model,
      messages: fullMessages,
      temperature: agent.temperature,
      max_tokens: agent.maxTokens,
      stream: true,
    });

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
      throw new NimApiError(response.status, errText);
    }

    if (!response.body) {
      throw new Error("NIM API returned no response body for streaming.");
    }

    let fullContent = "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process SSE lines
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;

        const jsonStr = trimmed.slice(6);
        if (jsonStr === "[DONE]") continue;

        try {
          const chunk = JSON.parse(jsonStr) as NimStreamChunk;
          const delta = chunk.choices?.[0]?.delta?.content;
          if (delta) {
            fullContent += delta;
            onChunk(delta);
          }
        } catch {
          // Skip malformed chunks
        }
      }
    }

    this._totalCalls++;
    return fullContent;
  }

  // ── Usage Stats ──────────────────────────────────────────────────────────

  /** Get cumulative token usage for this session. */
  get totalTokensUsed(): number {
    return this._totalTokensUsed;
  }

  /** Get total API calls made in this session. */
  get totalCalls(): number {
    return this._totalCalls;
  }

  /** Check if the client has a valid API key configured. */
  get hasApiKey(): boolean {
    return this.apiKey.length > 0;
  }

  // ── Private Helpers ──────────────────────────────────────────────────────

  private calculateBackoff(
    attempt: number,
    response?: Response
  ): number {
    // Respect Retry-After header if present
    if (response) {
      const retryAfter = response.headers.get("Retry-After");
      if (retryAfter) {
        const seconds = parseInt(retryAfter, 10);
        if (!isNaN(seconds)) {
          return Math.min(seconds * 1000, this.retryConfig.maxDelayMs);
        }
      }
    }

    // Exponential backoff with jitter
    const exponentialDelay = this.retryConfig.baseDelayMs * Math.pow(2, attempt);
    const jitter = Math.random() * this.retryConfig.baseDelayMs;
    return Math.min(
      exponentialDelay + jitter,
      this.retryConfig.maxDelayMs
    );
  }
}
