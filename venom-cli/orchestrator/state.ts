/**
 * VENOM CLI — State Machine & Conversation History
 * (Top-level orchestrator/)
 */

import type { PipelineState, StateTransition, ChatMessage, PipelineContext } from "./types.js";
import { MAX_HISTORY_LENGTH, HISTORY_PRUNE_TARGET } from "./types.js";

// ---------------------------------------------------------------------------
// Conversation History
// ---------------------------------------------------------------------------

export class ConversationHistory {
  private messages: ChatMessage[] = [];
  private maxLen: number;
  private pruneTarget: number;

  constructor(maxLen = MAX_HISTORY_LENGTH, pruneTarget = HISTORY_PRUNE_TARGET) {
    this.maxLen = maxLen;
    this.pruneTarget = pruneTarget;
  }

  push(msg: ChatMessage): void {
    this.messages.push(msg);
    if (this.messages.length > this.maxLen) this.prune();
  }

  getAll(): ChatMessage[] { return [...this.messages]; }
  getLast(n: number): ChatMessage[] { return this.messages.slice(-n); }
  get length(): number { return this.messages.length; }
  clear(): void { this.messages = []; }

  estimateTokens(): number {
    let chars = 0;
    for (const m of this.messages) chars += m.content.length;
    return Math.ceil(chars / 4);
  }

  private prune(): void {
    if (this.messages.length > 0 && this.messages[0].role === "system") {
      this.messages = [this.messages[0], ...this.messages.slice(-(this.pruneTarget - 1))];
    } else {
      this.messages = this.messages.slice(-this.pruneTarget);
    }
  }
}

// ---------------------------------------------------------------------------
// State Machine
// ---------------------------------------------------------------------------

const TRANSITIONS: Record<string, Set<string>> = {
  IDLE: new Set(["PROMPT_OPTIMIZATION", "ERROR"]),
  PROMPT_OPTIMIZATION: new Set(["PLANNING", "ERROR"]),
  PLANNING: new Set(["USER_APPROVAL", "ERROR"]),
  USER_APPROVAL: new Set(["CODE_GENERATION", "PLANNING", "PROMPT_OPTIMIZATION", "IDLE", "ERROR"]),
  CODE_GENERATION: new Set(["DEBUGGING", "COMPLETED", "ERROR"]),
  DEBUGGING: new Set(["COMPLETED", "PLANNING", "CODE_GENERATION", "ERROR"]),
  COMPLETED: new Set(["IDLE"]),
  ERROR: new Set(["IDLE"]),
};

export type StateChangeListener = (from: PipelineState, to: PipelineState) => void;

export class PipelineStateMachine {
  private _state: PipelineState;
  private _history: StateTransition[] = [];
  private _listeners: StateChangeListener[] = [];

  constructor(initial?: PipelineState) {
    this._state = initial || ("IDLE" as PipelineState);
  }

  get currentState(): PipelineState { return this._state; }
  get history(): ReadonlyArray<StateTransition> { return this._history; }

  transition(to: PipelineState, meta?: Record<string, unknown>): void {
    const valid = TRANSITIONS[this._state as string];
    if (!valid?.has(to as string)) {
      throw new Error(`[STATE] Invalid: ${this._state} → ${to}`);
    }
    const from = this._state;
    this._state = to;
    this._history.push({ from, to, timestamp: Date.now(), metadata: meta });
    for (const l of this._listeners) { try { l(from, to); } catch {} }
  }

  forceState(state: PipelineState): void {
    const from = this._state;
    this._state = state;
    this._history.push({ from, to: state, timestamp: Date.now(), metadata: { forced: true } });
  }

  onStateChange(listener: StateChangeListener): () => void {
    this._listeners.push(listener);
    return () => {
      const i = this._listeners.indexOf(listener);
      if (i >= 0) this._listeners.splice(i, 1);
    };
  }

  canTransition(to: PipelineState): boolean {
    return TRANSITIONS[this._state as string]?.has(to as string) || false;
  }

  get isIdle(): boolean { return (this._state as string) === "IDLE"; }
  get isError(): boolean { return (this._state as string) === "ERROR"; }

  reset(): void {
    this._state = "IDLE" as PipelineState;
    this._history = [];
  }
}

// ---------------------------------------------------------------------------
// Context Helpers
// ---------------------------------------------------------------------------

export function createPipelineContext(userInput: string, cwd: string, commandName?: string, cmdPrompt?: string): PipelineContext {
  return { userInput, cwd, commandName, commandSystemPrompt: cmdPrompt, stateHistory: [] };
}
