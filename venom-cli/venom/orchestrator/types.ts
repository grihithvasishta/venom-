/**
 * VENOM CLI — Orchestrator Types
 *
 * Shared type definitions, interfaces, and enums used across all
 * orchestrator modules. This is the single source of truth for the
 * type system — every other module imports from here.
 */

// ---------------------------------------------------------------------------
// Chat & API Types
// ---------------------------------------------------------------------------

/** Standard OpenAI-compatible chat message format. */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Raw response shape from NVIDIA NIM /chat/completions endpoint. */
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

/** Streaming chunk from NIM when stream=true. */
export interface NimStreamChunk {
  id: string;
  choices: Array<{
    index: number;
    delta: { role?: string; content?: string };
    finish_reason: string | null;
  }>;
}

// ---------------------------------------------------------------------------
// Agent Types
// ---------------------------------------------------------------------------

/** Canonical agent role identifiers. */
export type AgentRole = "main" | "planner" | "coder" | "debugger";

/** Full configuration for a single agent in the cluster. */
export interface AgentConfig {
  role: AgentRole;
  model: string;
  systemPrompt: string;
  temperature: number;
  maxTokens: number;
  /** Optional fallback model if primary is unavailable. */
  fallbackModel?: string;
}

// ---------------------------------------------------------------------------
// Pipeline State Machine
// ---------------------------------------------------------------------------

/** All possible states in the agentic pipeline. */
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

/** Transition event that moves the pipeline between states. */
export interface StateTransition {
  from: PipelineState;
  to: PipelineState;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Code Generation Types
// ---------------------------------------------------------------------------

/** A single file extracted from the Coding Agent's output. */
export interface GeneratedFile {
  filepath: string;
  content: string;
  language?: string;
}

/** Result of the code extraction pass. */
export interface CodeExtractionResult {
  files: GeneratedFile[];
  rawOutput: string;
  blockCount: number;
}

// ---------------------------------------------------------------------------
// File Context Types
// ---------------------------------------------------------------------------

/** Result of extracting @ file references from user input. */
export interface FileContextResult {
  /** User input with @ references stripped out. */
  cleaned: string;
  /** Concatenated file/directory contents for context injection. */
  context: string;
  /** List of resolved file paths that were successfully read. */
  resolvedPaths: string[];
  /** List of paths that failed to resolve or read. */
  failedPaths: string[];
}

// ---------------------------------------------------------------------------
// Debug Loop Types
// ---------------------------------------------------------------------------

/** Outcome of a single debug iteration. */
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

/** Summary of the full debug loop execution. */
export interface DebugLoopSummary {
  totalIterations: number;
  maxIterations: number;
  finalVerdict: "PASSED" | "FAILED" | "SKIPPED" | "MAX_ITERATIONS";
  iterations: DebugIterationResult[];
  totalDurationMs: number;
}

// ---------------------------------------------------------------------------
// Pipeline Execution Context
// ---------------------------------------------------------------------------

/** Shared context object threaded through the entire pipeline execution. */
export interface PipelineContext {
  /** Original user input (raw). */
  userInput: string;
  /** Working directory for file operations and sandbox. */
  cwd: string;
  /** Optimized prompt after Main Agent processing. */
  optimizedPrompt?: string;
  /** Technical plan from Planning Agent. */
  plan?: string;
  /** 2-line summary for user approval gate. */
  planSummary?: string;
  /** Raw code output from Coding Agent. */
  codeOutput?: string;
  /** Extracted generated files. */
  generatedFiles?: GeneratedFile[];
  /** Debug loop summary. */
  debugSummary?: DebugLoopSummary;
  /** State transition history. */
  stateHistory: StateTransition[];
  /** Error encountered during pipeline execution. */
  error?: Error;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** NVIDIA NIM API base URL. */
export const NIM_BASE_URL =
  "https://integrate.api.nvidia.com/v1/chat/completions";

/** Maximum autonomous debug iterations before stopping. */
export const MAX_DEBUG_ITERATIONS = 8;

/** Maximum conversation history entries before pruning. */
export const MAX_HISTORY_LENGTH = 40;

/** Number of history entries to keep after pruning. */
export const HISTORY_PRUNE_TARGET = 30;

/** Slash commands that trigger the agentic pipeline. */
export const AGENTIC_TRIGGERS = ["/code", "/vibe", "/build"] as const;
