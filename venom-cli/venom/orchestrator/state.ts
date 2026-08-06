/**
 * VENOM CLI — State Manager
 *
 * Manages the pipeline state machine transitions, conversation history
 * with automatic pruning, and pipeline execution context. Provides
 * an event-driven interface for state change notifications.
 */

import type {
  PipelineState,
  StateTransition,
  ChatMessage,
  PipelineContext,
  GeneratedFile,
  DebugLoopSummary,
} from "./types.js";
import {
  MAX_HISTORY_LENGTH,
  HISTORY_PRUNE_TARGET,
} from "./types.js";

// ---------------------------------------------------------------------------
// State Change Listener
// ---------------------------------------------------------------------------

export type StateChangeListener = (
  from: PipelineState,
  to: PipelineState,
  metadata?: Record<string, unknown>
) => void;

// ---------------------------------------------------------------------------
// Conversation History Manager
// ---------------------------------------------------------------------------

export class ConversationHistory {
  private messages: ChatMessage[] = [];
  private maxLength: number;
  private pruneTarget: number;

  constructor(
    maxLength: number = MAX_HISTORY_LENGTH,
    pruneTarget: number = HISTORY_PRUNE_TARGET
  ) {
    this.maxLength = maxLength;
    this.pruneTarget = pruneTarget;
  }

  /** Add a message to history, auto-pruning if over limit. */
  push(message: ChatMessage): void {
    this.messages.push(message);
    if (this.messages.length > this.maxLength) {
      this.prune();
    }
  }

  /** Get all messages (immutable copy). */
  getAll(): ChatMessage[] {
    return [...this.messages];
  }

  /** Get the last N messages. */
  getLast(n: number): ChatMessage[] {
    return this.messages.slice(-n);
  }

  /** Get current message count. */
  get length(): number {
    return this.messages.length;
  }

  /** Clear all history. */
  clear(): void {
    this.messages = [];
  }

  /** Prune old messages, keeping the most recent ones. */
  private prune(): void {
    // Always keep a system message if it's the first entry
    if (
      this.messages.length > 0 &&
      this.messages[0].role === "system"
    ) {
      const systemMsg = this.messages[0];
      this.messages = [
        systemMsg,
        ...this.messages.slice(-(this.pruneTarget - 1)),
      ];
    } else {
      this.messages = this.messages.slice(-this.pruneTarget);
    }
  }

  /** Estimate total token count (rough: 1 token ≈ 4 chars). */
  estimateTokens(): number {
    let totalChars = 0;
    for (const msg of this.messages) {
      totalChars += msg.content.length;
    }
    return Math.ceil(totalChars / 4);
  }
}

// ---------------------------------------------------------------------------
// Pipeline State Machine
// ---------------------------------------------------------------------------

/** Valid state transitions map. */
const VALID_TRANSITIONS: Record<string, Set<string>> = {
  IDLE: new Set([
    "PROMPT_OPTIMIZATION",
    "ERROR",
  ]),
  PROMPT_OPTIMIZATION: new Set([
    "PLANNING",
    "ERROR",
  ]),
  PLANNING: new Set([
    "USER_APPROVAL",
    "ERROR",
  ]),
  USER_APPROVAL: new Set([
    "CODE_GENERATION",
    "PLANNING",           // user requested changes
    "PROMPT_OPTIMIZATION", // re-enter with feedback
    "IDLE",               // user cancelled
    "ERROR",
  ]),
  CODE_GENERATION: new Set([
    "DEBUGGING",
    "COMPLETED",
    "ERROR",
  ]),
  DEBUGGING: new Set([
    "COMPLETED",
    "PLANNING",     // bug found → re-plan
    "CODE_GENERATION", // minor fix → recode
    "ERROR",
  ]),
  COMPLETED: new Set([
    "IDLE",
  ]),
  ERROR: new Set([
    "IDLE",
  ]),
};

export class PipelineStateMachine {
  private _currentState: PipelineState;
  private _history: StateTransition[] = [];
  private _listeners: StateChangeListener[] = [];

  constructor(initialState?: PipelineState) {
    // Use string literal to avoid import issues with enum at runtime
    this._currentState = initialState || ("IDLE" as PipelineState);
  }

  /** Get current pipeline state. */
  get currentState(): PipelineState {
    return this._currentState;
  }

  /** Get full transition history. */
  get history(): ReadonlyArray<StateTransition> {
    return this._history;
  }

  /**
   * Transition to a new state.
   * @throws Error if the transition is invalid.
   */
  transition(
    to: PipelineState,
    metadata?: Record<string, unknown>
  ): void {
    const validTargets = VALID_TRANSITIONS[this._currentState as string];

    if (!validTargets || !validTargets.has(to as string)) {
      throw new Error(
        `[STATE] Invalid transition: ${this._currentState} → ${to}`
      );
    }

    const transition: StateTransition = {
      from: this._currentState,
      to,
      timestamp: Date.now(),
      metadata,
    };

    const from = this._currentState;
    this._currentState = to;
    this._history.push(transition);

    // Notify listeners
    for (const listener of this._listeners) {
      try {
        listener(from, to, metadata);
      } catch {
        // Listeners should not break the state machine
      }
    }
  }

  /**
   * Force-set state without validation (for error recovery).
   */
  forceState(state: PipelineState): void {
    const from = this._currentState;
    this._currentState = state;
    this._history.push({
      from,
      to: state,
      timestamp: Date.now(),
      metadata: { forced: true },
    });
  }

  /** Register a state change listener. Returns an unsubscribe function. */
  onStateChange(listener: StateChangeListener): () => void {
    this._listeners.push(listener);
    return () => {
      const idx = this._listeners.indexOf(listener);
      if (idx >= 0) this._listeners.splice(idx, 1);
    };
  }

  /** Check if a transition to the given state would be valid. */
  canTransition(to: PipelineState): boolean {
    const validTargets = VALID_TRANSITIONS[this._currentState as string];
    return validTargets ? validTargets.has(to as string) : false;
  }

  /** Check if the pipeline is currently idle. */
  get isIdle(): boolean {
    return (this._currentState as string) === "IDLE";
  }

  /** Check if the pipeline is in an error state. */
  get isError(): boolean {
    return (this._currentState as string) === "ERROR";
  }

  /** Get elapsed time since the last transition (ms). */
  get timeSinceLastTransition(): number {
    if (this._history.length === 0) return 0;
    return Date.now() - this._history[this._history.length - 1].timestamp;
  }

  /** Reset to IDLE and clear history. */
  reset(): void {
    this._currentState = "IDLE" as PipelineState;
    this._history = [];
  }
}

// ---------------------------------------------------------------------------
// Pipeline Context Builder
// ---------------------------------------------------------------------------

/**
 * Create a fresh pipeline context for a new task execution.
 */
export function createPipelineContext(
  userInput: string,
  cwd: string
): PipelineContext {
  return {
    userInput,
    cwd,
    stateHistory: [],
  };
}

/**
 * Update the pipeline context with new data from a completed stage.
 * Returns a new context object (immutable update).
 */
export function updateContext(
  ctx: PipelineContext,
  updates: Partial<PipelineContext>
): PipelineContext {
  return { ...ctx, ...updates };
}
