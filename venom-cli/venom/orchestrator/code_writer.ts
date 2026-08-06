/**
 * VENOM CLI — Code Writer
 *
 * Extracts generated code files from the Coding Agent's raw output
 * (fenced code blocks with filepath annotations) and writes them to
 * disk with proper directory creation. Supports multiple output formats
 * from different LLM response styles.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { GeneratedFile, CodeExtractionResult } from "./types.js";

// ---------------------------------------------------------------------------
// Extraction Strategies (ordered by specificity)
// ---------------------------------------------------------------------------

/**
 * Strategy 1: Explicit filepath: prefix in fence info string.
 * Example: ```filepath:src/index.ts
 */
function extractByFilepathPrefix(output: string): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  const pattern = /```filepath:([\w.\/\\:-]+)\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(output)) !== null) {
    files.push({
      filepath: match[1].trim(),
      content: match[2],
      language: inferLanguage(match[1].trim()),
    });
  }
  return files;
}

/**
 * Strategy 2: File path in a comment on the first line of the code block.
 * Example: ```typescript
 *          // file: src/index.ts
 */
function extractByInlineComment(output: string): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  const pattern =
    /```[\w]*\n(?:\/\/|#|--|\/\*)\s*(?:file|path|filename):\s*([\w.\/\\:-]+)\s*\*?\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(output)) !== null) {
    const filepath = match[1].trim();
    files.push({
      filepath,
      content: match[2],
      language: inferLanguage(filepath),
    });
  }
  return files;
}

/**
 * Strategy 3: File path in a markdown heading or bold text before the block.
 * Example: **`src/index.ts`**
 *          ```typescript
 */
function extractByPrecedingHeading(output: string): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  const pattern =
    /(?:\*\*`?([\w.\/\\:-]+)`?\*\*|#{1,4}\s*`?([\w.\/\\:-]+)`?)\s*\n+```[\w]*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(output)) !== null) {
    const filepath = (match[1] || match[2]).trim();
    // Validate it looks like a file path
    if (filepath.includes(".") || filepath.includes("/")) {
      files.push({
        filepath,
        content: match[3],
        language: inferLanguage(filepath),
      });
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Main Extraction Function
// ---------------------------------------------------------------------------

/**
 * Extract all code files from the Coding Agent's raw output.
 * Tries multiple extraction strategies in order of specificity.
 * Returns a CodeExtractionResult with all found files.
 */
export function extractCodeFiles(output: string): CodeExtractionResult {
  // Try strategies in order (most specific first)
  let files = extractByFilepathPrefix(output);

  if (files.length === 0) {
    files = extractByInlineComment(output);
  }

  if (files.length === 0) {
    files = extractByPrecedingHeading(output);
  }

  // Count total code blocks for diagnostic purposes
  const blockPattern = /```[\w]*\n[\s\S]*?```/g;
  const allBlocks = output.match(blockPattern);
  const blockCount = allBlocks ? allBlocks.length : 0;

  // Deduplicate by filepath (last occurrence wins)
  const fileMap = new Map<string, GeneratedFile>();
  for (const file of files) {
    fileMap.set(normalizePath(file.filepath), file);
  }

  return {
    files: Array.from(fileMap.values()),
    rawOutput: output,
    blockCount,
  };
}

// ---------------------------------------------------------------------------
// File Writer
// ---------------------------------------------------------------------------

/** Result of writing files to disk. */
export interface WriteResult {
  written: string[];
  failed: Array<{ filepath: string; error: string }>;
  totalBytes: number;
}

/**
 * Write extracted code files to disk under the given base directory.
 * Creates parent directories as needed. Returns a detailed WriteResult.
 */
export function writeGeneratedFiles(
  files: GeneratedFile[],
  baseDir: string
): WriteResult {
  const result: WriteResult = {
    written: [],
    failed: [],
    totalBytes: 0,
  };

  for (const file of files) {
    try {
      const fullPath = path.resolve(baseDir, file.filepath);

      // Security check: prevent path traversal outside baseDir
      const resolvedBase = path.resolve(baseDir);
      if (!fullPath.startsWith(resolvedBase)) {
        result.failed.push({
          filepath: file.filepath,
          error: "Path traversal detected — file would be written outside project directory",
        });
        console.log(
          `  \x1b[91m✗\x1b[0m Blocked: ${file.filepath} (path traversal)`
        );
        continue;
      }

      // Create parent directories
      const dir = path.dirname(fullPath);
      fs.mkdirSync(dir, { recursive: true });

      // Write file
      fs.writeFileSync(fullPath, file.content, "utf-8");

      const bytes = Buffer.byteLength(file.content, "utf-8");
      result.written.push(file.filepath);
      result.totalBytes += bytes;

      console.log(
        `  \x1b[32m✓\x1b[0m Written: ${file.filepath} (${formatBytes(bytes)})`
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      result.failed.push({ filepath: file.filepath, error: errMsg });
      console.log(`  \x1b[91m✗\x1b[0m Failed: ${file.filepath}: ${errMsg}`);
    }
  }

  return result;
}

/**
 * Generate a diff-style summary of file changes (for display purposes).
 */
export function summarizeChanges(files: GeneratedFile[]): string {
  const lines: string[] = [
    `\x1b[1m${files.length} file(s) generated:\x1b[0m`,
  ];

  for (const file of files) {
    const lineCount = file.content.split("\n").length;
    const bytes = Buffer.byteLength(file.content, "utf-8");
    const lang = file.language || "unknown";
    lines.push(
      `  \x1b[36m+\x1b[0m ${file.filepath} \x1b[90m(${lang}, ${lineCount} lines, ${formatBytes(bytes)})\x1b[0m`
    );
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalize a file path for deduplication. */
function normalizePath(filepath: string): string {
  return filepath.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Infer language from file extension. */
function inferLanguage(filepath: string): string {
  const ext = path.extname(filepath).toLowerCase();
  const langMap: Record<string, string> = {
    ".ts": "typescript",
    ".tsx": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".py": "python",
    ".c": "c",
    ".h": "c",
    ".cpp": "cpp",
    ".rs": "rust",
    ".go": "go",
    ".java": "java",
    ".rb": "ruby",
    ".php": "php",
    ".sh": "bash",
    ".bash": "bash",
    ".zsh": "zsh",
    ".sql": "sql",
    ".html": "html",
    ".css": "css",
    ".scss": "scss",
    ".json": "json",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".toml": "toml",
    ".xml": "xml",
    ".md": "markdown",
    ".dockerfile": "dockerfile",
    ".vue": "vue",
    ".svelte": "svelte",
  };
  return langMap[ext] || ext.slice(1) || "plaintext";
}

/** Format byte count for display. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
