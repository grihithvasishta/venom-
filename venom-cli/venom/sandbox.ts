/**
 * VENOM CLI — Sandbox
 *
 * Local subprocess code execution & log capture harness.
 * Provides a guarded execution environment with timeout enforcement,
 * stdout/stderr capture, and process isolation.
 */

import { spawn, ChildProcess } from "node:child_process";
import * as os from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SandboxOptions {
  /** Working directory for the subprocess. */
  cwd?: string;
  /** Maximum execution time in milliseconds (default: 30000). */
  timeoutMs?: number;
  /** Environment variables to merge with process.env. */
  env?: Record<string, string>;
  /** Maximum output buffer size in bytes (default: 5MB). */
  maxOutputBytes?: number;
  /** Shell to use (default: auto-detect). */
  shell?: string;
}

export interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Blocked Commands (security guard)
// ---------------------------------------------------------------------------

const BLOCKED_PATTERNS: RegExp[] = [
  /\brm\s+(-rf?|--recursive)\s+[\/\\]/i,       // rm -rf /
  /\bformat\s+[a-z]:/i,                          // format C:
  /\bmkfs\b/i,                                   // mkfs
  /\bdd\s+.*of=\/dev\//i,                        // dd to raw devices
  /:(){ :\|:& };:/,                               // fork bomb
  /\bshutdown\b/i,                                // shutdown
  /\breboot\b/i,                                  // reboot
  /\bhalt\b/i,                                    // halt
  />\s*\/dev\/sd[a-z]/i,                          // writing to raw block devices
];

function isCommandBlocked(cmd: string): boolean {
  return BLOCKED_PATTERNS.some((pattern) => pattern.test(cmd));
}

// ---------------------------------------------------------------------------
// Sandbox Executor
// ---------------------------------------------------------------------------

export class Sandbox {
  private defaultShell: string;

  constructor() {
    this.defaultShell =
      os.platform() === "win32" ? "cmd.exe" : "/bin/sh";
  }

  /**
   * Execute a shell command in a sandboxed subprocess.
   * Captures stdout/stderr, enforces timeouts, and blocks dangerous commands.
   */
  async execute(
    command: string,
    options: SandboxOptions = {}
  ): Promise<SandboxResult> {
    const {
      cwd = process.cwd(),
      timeoutMs = 30_000,
      env = {},
      maxOutputBytes = 5 * 1024 * 1024, // 5MB
      shell = this.defaultShell,
    } = options;

    // Security check
    if (isCommandBlocked(command)) {
      return {
        stdout: "",
        stderr: `[VENOM SANDBOX] Command blocked by security policy: ${command}`,
        exitCode: 126,
        signal: null,
        timedOut: false,
        durationMs: 0,
      };
    }

    return new Promise<SandboxResult>((resolve) => {
      const startTime = Date.now();
      let stdoutChunks: Buffer[] = [];
      let stderrChunks: Buffer[] = [];
      let stdoutSize = 0;
      let stderrSize = 0;
      let timedOut = false;
      let finished = false;

      const shellArgs =
        os.platform() === "win32" ? ["/c", command] : ["-c", command];

      const child: ChildProcess = spawn(shell, shellArgs, {
        cwd,
        env: { ...process.env, ...env },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });

      // Timeout enforcement
      const timer = setTimeout(() => {
        if (!finished) {
          timedOut = true;
          child.kill("SIGKILL");
        }
      }, timeoutMs);

      // Capture stdout with size limit
      child.stdout?.on("data", (chunk: Buffer) => {
        if (stdoutSize < maxOutputBytes) {
          stdoutChunks.push(chunk);
          stdoutSize += chunk.length;
        }
      });

      // Capture stderr with size limit
      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderrSize < maxOutputBytes) {
          stderrChunks.push(chunk);
          stderrSize += chunk.length;
        }
      });

      // Handle process exit
      child.on("close", (exitCode: number | null, signal: string | null) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);

        const durationMs = Date.now() - startTime;
        const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
        const stderr = Buffer.concat(stderrChunks).toString("utf-8");

        resolve({
          stdout: stdoutSize >= maxOutputBytes
            ? stdout + "\n[TRUNCATED — output exceeded size limit]"
            : stdout,
          stderr: stderrSize >= maxOutputBytes
            ? stderr + "\n[TRUNCATED — output exceeded size limit]"
            : stderr,
          exitCode,
          signal: signal || null,
          timedOut,
          durationMs,
        });
      });

      // Handle spawn errors
      child.on("error", (err: Error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);

        resolve({
          stdout: "",
          stderr: `[VENOM SANDBOX] Spawn error: ${err.message}`,
          exitCode: 127,
          signal: null,
          timedOut: false,
          durationMs: Date.now() - startTime,
        });
      });
    });
  }

  /**
   * Execute a command and stream output line-by-line via a callback.
   * Useful for long-running processes where real-time output is needed.
   */
  async executeStreaming(
    command: string,
    onLine: (stream: "stdout" | "stderr", line: string) => void,
    options: SandboxOptions = {}
  ): Promise<SandboxResult> {
    const {
      cwd = process.cwd(),
      timeoutMs = 60_000,
      env = {},
      shell = this.defaultShell,
    } = options;

    if (isCommandBlocked(command)) {
      return {
        stdout: "",
        stderr: `[VENOM SANDBOX] Command blocked by security policy: ${command}`,
        exitCode: 126,
        signal: null,
        timedOut: false,
        durationMs: 0,
      };
    }

    return new Promise<SandboxResult>((resolve) => {
      const startTime = Date.now();
      let allStdout = "";
      let allStderr = "";
      let timedOut = false;
      let finished = false;

      const shellArgs =
        os.platform() === "win32" ? ["/c", command] : ["-c", command];

      const child = spawn(shell, shellArgs, {
        cwd,
        env: { ...process.env, ...env },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });

      const timer = setTimeout(() => {
        if (!finished) {
          timedOut = true;
          child.kill("SIGKILL");
        }
      }, timeoutMs);

      let stdoutBuffer = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf-8");
        allStdout += text;
        stdoutBuffer += text;
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() || "";
        for (const line of lines) {
          onLine("stdout", line);
        }
      });

      let stderrBuffer = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf-8");
        allStderr += text;
        stderrBuffer += text;
        const lines = stderrBuffer.split("\n");
        stderrBuffer = lines.pop() || "";
        for (const line of lines) {
          onLine("stderr", line);
        }
      });

      child.on("close", (exitCode, signal) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);

        // Flush remaining buffers
        if (stdoutBuffer) onLine("stdout", stdoutBuffer);
        if (stderrBuffer) onLine("stderr", stderrBuffer);

        resolve({
          stdout: allStdout,
          stderr: allStderr,
          exitCode,
          signal: signal || null,
          timedOut,
          durationMs: Date.now() - startTime,
        });
      });

      child.on("error", (err) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);

        resolve({
          stdout: allStdout,
          stderr: `[VENOM SANDBOX] Spawn error: ${err.message}`,
          exitCode: 127,
          signal: null,
          timedOut: false,
          durationMs: Date.now() - startTime,
        });
      });
    });
  }
}
