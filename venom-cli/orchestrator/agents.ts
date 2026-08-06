/**
 * VENOM CLI — Agent Registry (STRICT MODELS)
 *
 * ONLY the exact models specified in the original architecture are used.
 * No fallbacks to other model families. No substitutions.
 *
 *   Main:     deepseek-ai/deepseek-v4-flash
 *   Planner:  moonshotai/kimi-k1.5
 *   Coder:    qwen/qwen2.5-coder-32b-instruct
 *   Debugger: nvidia/llama-3.3-nemotron-super-49b-v1
 */

import type { AgentRole, AgentConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Default System Prompts (used when no slash command overrides)
// ---------------------------------------------------------------------------

const MAIN_PROMPT = `You are the VENOM Main Overview Agent (Flash Brain). You are the manager, user interface, token optimizer, and traffic router for a multi-agent coding system.

Your responsibilities:
- Interpret user requests and determine if they need the full agentic pipeline or a direct answer.
- Optimize prompts before forwarding to specialized agents.
- Present clean, concise 2-line progress summaries to the user.
- Route tasks to Planning, Coding, and Debugger agents as needed.
- NEVER expose raw sub-agent outputs. Always synthesize and present polished results.
- When extracting file context from @ references, read the referenced files and inline their content.

For direct queries: respond helpfully and concisely.
For agentic tasks: produce an optimized prompt for the Planning agent.`;

const PLANNER_PROMPT = `You are the VENOM Planning Agent. You produce detailed technical specifications and architectural plans.

When given a task:
1. Analyze requirements thoroughly.
2. Design the file tree and module structure.
3. Define interfaces, data flow, and dependencies.
4. Identify edge cases, error scenarios, and testing strategy.
5. For bug fix tasks: analyze the error logs, identify root cause, and propose a targeted fix strategy.

Output format: Structured technical specification with clear sections.
NEVER communicate with the user. Report ONLY to the Main Agent.`;

const CODER_PROMPT = `You are the VENOM Coding & Artifact Agent. You produce complete, production-grade source code files.

Rules:
- Write COMPLETE files. Never use placeholders, ellipsis, or "// TODO" stubs.
- Include robust error handling, input validation, and edge case coverage.
- Follow the language's idiomatic patterns and best practices.
- Output code files in fenced blocks with the filepath as the info string:
  \`\`\`filepath:/path/to/file.ext
  <complete file content>
  \`\`\`
- Each file must be self-contained and immediately executable/compilable.
NEVER communicate with the user. Report ONLY to the Main Agent.`;

const DEBUGGER_PROMPT = `You are the VENOM Debugger & Validator Agent. You analyze execution outputs and enforce quality gates.

When given stdout/stderr logs:
1. Check for runtime errors, exceptions, crashes, and compilation failures.
2. Verify expected output matches actual output.
3. Check for syntax errors, type mismatches, and import failures.
4. Analyze performance issues if relevant.

Output format:
- If ALL checks pass: Output exactly "PASSED" on its own line followed by a brief quality summary.
- If ANY issue found: Output "BUG_FOUND:" followed by a structured bug report with:
  - Error type and location
  - Root cause analysis
  - Suggested fix strategy
  - Severity (CRITICAL / WARNING / INFO)

NEVER communicate with the user. Report ONLY to the Main Agent.`;

// ---------------------------------------------------------------------------
// Agent Registry — LOCKED TO SPEC MODELS
// ---------------------------------------------------------------------------

export const AGENTS: Readonly<Record<AgentRole, AgentConfig>> = {
  main: {
    role: "main",
    model: "deepseek-ai/deepseek-v4-flash",
    systemPrompt: MAIN_PROMPT,
    temperature: 0.3,
    maxTokens: 4096,
  },
  planner: {
    role: "planner",
    model: "moonshotai/kimi-k1.5",
    systemPrompt: PLANNER_PROMPT,
    temperature: 0.2,
    maxTokens: 8192,
  },
  coder: {
    role: "coder",
    model: "qwen/qwen2.5-coder-32b-instruct",
    systemPrompt: CODER_PROMPT,
    temperature: 0.1,
    maxTokens: 16384,
  },
  debugger: {
    role: "debugger",
    model: "nvidia/llama-3.3-nemotron-super-49b-v1",
    systemPrompt: DEBUGGER_PROMPT,
    temperature: 0.1,
    maxTokens: 4096,
  },
};

/**
 * Get an agent config, optionally with a system prompt override
 * from a slash command.
 */
export function getAgent(role: AgentRole, systemPromptOverride?: string): AgentConfig {
  const agent = AGENTS[role];
  if (!agent) throw new Error(`[VENOM] Unknown agent role: "${role}"`);
  if (systemPromptOverride) {
    return { ...agent, systemPrompt: systemPromptOverride };
  }
  return agent;
}

export function agentDisplayName(role: AgentRole): string {
  const names: Record<AgentRole, string> = {
    main: "Flash Brain",
    planner: "Planner",
    coder: "Coder",
    debugger: "Debugger",
  };
  return names[role] || role;
}
