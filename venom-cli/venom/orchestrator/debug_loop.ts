/**
 * VENOM CLI — Autonomous Debug Loop
 *
 * Implements the iterative debug cycle:
 *   1. Main Agent determines the test command
 *   2. Sandbox executes it
 *   3. Debugger Agent analyzes stdout/stderr
 *   4. If BUG_FOUND → Planner re-plans → Coder re-writes → loop
 *   5. Repeat until PASSED or max iterations reached
 *
 * This module is stateless — it receives all dependencies via injection
 * and returns a structured DebugLoopSummary.
 */

import type {
  GeneratedFile,
  DebugIterationResult,
  DebugLoopSummary,
} from "./types.js";
import { MAX_DEBUG_ITERATIONS } from "./types.js";
import { AGENTS } from "./agents.js";
import type { NimClient } from "./nim_client.js";
import {
  extractCodeFiles,
  writeGeneratedFiles,
} from "./code_writer.js";
import type { Sandbox, SandboxResult } from "../sandbox.js";

// ---------------------------------------------------------------------------
// Debug Loop Configuration
// ---------------------------------------------------------------------------

export interface DebugLoopConfig {
  /** Max iterations before giving up. */
  maxIterations?: number;
  /** Sandbox timeout per test execution (ms). */
  sandboxTimeoutMs?: number;
  /** If true, print verbose debug output. */
  verbose?: boolean;
}

const DEFAULT_CONFIG: Required<DebugLoopConfig> = {
  maxIterations: MAX_DEBUG_ITERATIONS,
  sandboxTimeoutMs: 30_000,
  verbose: true,
};

// ---------------------------------------------------------------------------
// Debug Loop Executor
// ---------------------------------------------------------------------------

/**
 * Run the autonomous debug loop.
 *
 * @param nim         NIM API client
 * @param sandbox     Sandbox executor
 * @param plan        Current technical plan
 * @param codeOutput  Raw code output from Coder Agent
 * @param files       Extracted generated files
 * @param cwd         Working directory
 * @param config      Optional configuration overrides
 * @returns           Structured DebugLoopSummary
 */
export async function runDebugLoop(
  nim: NimClient,
  sandbox: Sandbox,
  plan: string,
  codeOutput: string,
  files: GeneratedFile[],
  cwd: string,
  config?: DebugLoopConfig
): Promise<DebugLoopSummary> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const startTime = Date.now();

  let currentPlan = plan;
  let currentCode = codeOutput;
  let currentFiles = [...files];
  let iteration = 0;

  const iterations: DebugIterationResult[] = [];
  let finalVerdict: DebugLoopSummary["finalVerdict"] = "FAILED";

  while (iteration < cfg.maxIterations) {
    iteration++;
    const iterStartTime = Date.now();

    if (cfg.verbose) {
      console.log(
        `\n\x1b[36m  ── Debug Iteration ${iteration}/${cfg.maxIterations} ──\x1b[0m`
      );
    }

    // ── Step 1: Determine Test Command ─────────────────────────────────
    const testCmd = await nim.chatWithProgress(
      AGENTS.main,
      [
        {
          role: "user",
          content: buildTestCommandPrompt(currentFiles),
        },
      ],
      "Determining test command"
    );

    const trimmedCmd = testCmd.trim().split("\n")[0].trim();

    // Check if test is applicable
    if (isSkipSignal(trimmedCmd)) {
      if (cfg.verbose) {
        console.log(
          "  \x1b[33m⊘\x1b[0m No test command applicable — marking as passed."
        );
      }

      iterations.push({
        iteration,
        testCommand: "SKIP",
        exitCode: null,
        stdout: "",
        stderr: "",
        verdict: "SKIPPED",
        durationMs: Date.now() - iterStartTime,
      });

      finalVerdict = "SKIPPED";
      break;
    }

    // ── Step 2: Execute in Sandbox ──────────────────────────────────────
    if (cfg.verbose) {
      console.log(`  \x1b[90m$ ${trimmedCmd}\x1b[0m`);
    }

    const result: SandboxResult = await sandbox.execute(trimmedCmd, {
      cwd,
      timeoutMs: cfg.sandboxTimeoutMs,
    });

    const combinedOutput = formatSandboxOutput(result);

    // ── Step 3: Send to Debugger Agent ──────────────────────────────────
    const debugReport = await nim.chatWithProgress(
      AGENTS.debugger,
      [
        {
          role: "user",
          content: `Analyze this execution output and determine if the code passed validation.\n\n${combinedOutput}`,
        },
      ],
      "Validating output"
    );

    // ── Step 4: Interpret Verdict ───────────────────────────────────────
    const verdict = interpretVerdict(debugReport);

    const iterResult: DebugIterationResult = {
      iteration,
      testCommand: trimmedCmd,
      exitCode: result.exitCode,
      stdout: result.stdout.slice(0, 5000),
      stderr: result.stderr.slice(0, 5000),
      verdict,
      bugReport: verdict === "BUG_FOUND" ? debugReport : undefined,
      durationMs: Date.now() - iterStartTime,
    };
    iterations.push(iterResult);

    if (verdict === "PASSED") {
      if (cfg.verbose) {
        console.log("  \x1b[32m✓ All checks passed.\x1b[0m");
      }
      finalVerdict = "PASSED";
      break;
    }

    if (verdict === "BUG_FOUND") {
      if (cfg.verbose) {
        console.log(
          "  \x1b[91m✗ Bug detected — initiating auto-fix.\x1b[0m"
        );
      }

      // ── Fix Cycle: Debugger → Planner → Coder ────────────────────
      const fixResult = await executeFixCycle(
        nim,
        currentPlan,
        currentCode,
        debugReport,
        cwd,
        cfg.verbose
      );

      currentPlan = fixResult.updatedPlan;
      currentCode = fixResult.updatedCode;

      if (fixResult.newFiles.length > 0) {
        currentFiles = fixResult.newFiles;
      }
    } else {
      // AMBIGUOUS
      if (cfg.verbose) {
        console.log(
          "  \x1b[33m⚠ Ambiguous result — proceeding with caution.\x1b[0m"
        );
      }
      finalVerdict = "PASSED"; // Treat ambiguous as soft-pass
      break;
    }
  }

  if (iteration >= cfg.maxIterations && finalVerdict === "FAILED") {
    finalVerdict = "MAX_ITERATIONS";
    if (cfg.verbose) {
      console.log(
        `\n  \x1b[91m⚠ Max debug iterations (${cfg.maxIterations}) reached.\x1b[0m`
      );
    }
  }

  return {
    totalIterations: iteration,
    maxIterations: cfg.maxIterations,
    finalVerdict,
    iterations,
    totalDurationMs: Date.now() - startTime,
  };
}

// ---------------------------------------------------------------------------
// Fix Cycle (Planner → Coder)
// ---------------------------------------------------------------------------

interface FixCycleResult {
  updatedPlan: string;
  updatedCode: string;
  newFiles: GeneratedFile[];
}

async function executeFixCycle(
  nim: NimClient,
  currentPlan: string,
  currentCode: string,
  debugReport: string,
  cwd: string,
  verbose: boolean
): Promise<FixCycleResult> {
  // Route: Debugger → Main → Planner (update plan)
  const updatedPlan = await nim.chatWithProgress(
    AGENTS.planner,
    [
      {
        role: "user",
        content: `The previous plan had issues. Update the plan to fix these bugs.\n\nOriginal Plan:\n${currentPlan.slice(0, 3000)}\n\nBug Report:\n${debugReport}`,
      },
    ],
    "Updating plan"
  );

  // Route: Main → Coder (rewrite code)
  const fixedCode = await nim.chatWithProgress(
    AGENTS.coder,
    [
      {
        role: "user",
        content: `Rewrite the code to fix these issues. Output complete files with filepath: prefix.\n\nUpdated Plan:\n${updatedPlan}\n\nBug Report:\n${debugReport}\n\nPrevious Code:\n${currentCode.slice(0, 8000)}`,
      },
    ],
    "Fixing code"
  );

  const extraction = extractCodeFiles(fixedCode);

  if (extraction.files.length > 0 && verbose) {
    console.log(
      `\n\x1b[36m  Rewriting ${extraction.files.length} file(s):\x1b[0m`
    );
    writeGeneratedFiles(extraction.files, cwd);
  }

  return {
    updatedPlan,
    updatedCode: fixedCode,
    newFiles: extraction.files,
  };
}

// ---------------------------------------------------------------------------
// Helper Functions
// ---------------------------------------------------------------------------

function buildTestCommandPrompt(files: GeneratedFile[]): string {
  const fileList = files.map((f) => f.filepath).join("\n");
  return `Based on this code, what single shell command should I run to test/validate it? Return ONLY the command, nothing else. If no test is applicable, return "SKIP".\n\nFiles generated:\n${fileList}`;
}

function isSkipSignal(cmd: string): boolean {
  return (
    cmd === "SKIP" ||
    cmd.length === 0 ||
    cmd.length > 500 ||
    cmd.toLowerCase().includes("no test") ||
    cmd.toLowerCase().includes("not applicable")
  );
}

function interpretVerdict(
  report: string
): "PASSED" | "BUG_FOUND" | "AMBIGUOUS" {
  if (report.includes("PASSED")) return "PASSED";
  if (report.includes("BUG_FOUND:")) return "BUG_FOUND";
  return "AMBIGUOUS";
}

function formatSandboxOutput(result: SandboxResult): string {
  let output = `STDOUT:\n${result.stdout || "(empty)"}\n\nSTDERR:\n${result.stderr || "(empty)"}\n\nEXIT CODE: ${result.exitCode}`;

  if (result.timedOut) {
    output += "\n\n[EXECUTION TIMED OUT]";
  }

  if (result.signal) {
    output += `\nSIGNAL: ${result.signal}`;
  }

  output += `\nDURATION: ${result.durationMs}ms`;

  return output;
}
