/**
 * VENOM CLI — Orchestrator Types (Top-Level)
 *
 * Shared type definitions across all orchestrator modules.
 */

// ---------------------------------------------------------------------------
// Chat & API
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface NimResponse {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices: Array<{
    index: number;
    message: { role: string; content: string };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export type AgentRole = "main" | "planner" | "coder" | "debugger";

export interface AgentConfig {
  role: AgentRole;
  model: string;
  systemPrompt: string;
  temperature: number;
  maxTokens: number;
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export enum PipelineState {
  IDLE = "IDLE",
  PROMPT_OPTIMIZATION = "PROMPT_OPTIMIZATION",
  PLANNING = "PLANNING",
  USER_APPROVAL = "USER_APPROVAL",
  CODE_GENERATION = "CODE_GENERATION",
  DEBUGGING = "DEBUGGING",
  COMPLETED = "COMPLETED",
  ERROR = "ERROR",
}

export interface StateTransition {
  from: PipelineState;
  to: PipelineState;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface GeneratedFile {
  filepath: string;
  content: string;
  language?: string;
}

export interface CodeExtractionResult {
  files: GeneratedFile[];
  rawOutput: string;
  blockCount: number;
}

export interface FileContextResult {
  cleaned: string;
  context: string;
  resolvedPaths: string[];
  failedPaths: string[];
}

export interface DebugIterationResult {
  iteration: number;
  testCommand: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  verdict: "PASSED" | "BUG_FOUND" | "SKIPPED" | "AMBIGUOUS";
  bugReport?: string;
  durationMs: number;
}

export interface DebugLoopSummary {
  totalIterations: number;
  maxIterations: number;
  finalVerdict: "PASSED" | "FAILED" | "SKIPPED" | "MAX_ITERATIONS";
  iterations: DebugIterationResult[];
  totalDurationMs: number;
}

export interface PipelineContext {
  userInput: string;
  cwd: string;
  /** Which slash command triggered this pipeline. */
  commandName?: string;
  /** Override system prompt from the slash command. */
  commandSystemPrompt?: string;
  optimizedPrompt?: string;
  plan?: string;
  planSummary?: string;
  codeOutput?: string;
  generatedFiles?: GeneratedFile[];
  debugSummary?: DebugLoopSummary;
  stateHistory: StateTransition[];
  error?: Error;
}

// ---------------------------------------------------------------------------
// Constants — STRICT MODEL LOCK
// ---------------------------------------------------------------------------

export const NIM_BASE_URL = "https://integrate.api.nvidia.com/v1/chat/completions";

/**
 * ALLOWED MODELS — only these exact model IDs can be used.
 * Any attempt to call a model not in this list will throw.
 */
export const ALLOWED_MODELS: ReadonlySet<string> = new Set([
  "deepseek-ai/deepseek-v4-flash",
  "moonshotai/kimi-k1.5",
  "zai-org/glm-5.2",
  "qwen/qwen2.5-coder-32b-instruct",
  "nvidia/nemotron-4-340b-instruct",
  "nvidia/llama-3.3-nemotron-super-49b-v1",
]);

export const MAX_DEBUG_ITERATIONS = 8;
export const MAX_HISTORY_LENGTH = 40;
export const HISTORY_PRUNE_TARGET = 30;
