/**
 * VENOM CLI — Code Writer
 * Extracts code files from LLM output and writes to disk.
 * (Top-level orchestrator/)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { GeneratedFile, CodeExtractionResult } from "./types.js";

// --- Extraction Strategies ---

function byFilepathPrefix(output: string): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  const p = /```filepath:([\w.\/\\:-]+)\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = p.exec(output)) !== null) {
    files.push({ filepath: m[1].trim(), content: m[2], language: lang(m[1]) });
  }
  return files;
}

function byInlineComment(output: string): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  const p = /```[\w]*\n(?:\/\/|#|--|\/\*)\s*(?:file|path|filename):\s*([\w.\/\\:-]+)\s*\*?\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = p.exec(output)) !== null) {
    files.push({ filepath: m[1].trim(), content: m[2], language: lang(m[1]) });
  }
  return files;
}

function byHeading(output: string): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  const p = /(?:\*\*`?([\w.\/\\:-]+)`?\*\*|#{1,4}\s*`?([\w.\/\\:-]+)`?)\s*\n+```[\w]*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = p.exec(output)) !== null) {
    const fp = (m[1] || m[2]).trim();
    if (fp.includes(".") || fp.includes("/")) {
      files.push({ filepath: fp, content: m[3], language: lang(fp) });
    }
  }
  return files;
}

export function extractCodeFiles(output: string): CodeExtractionResult {
  let files = byFilepathPrefix(output);
  if (!files.length) files = byInlineComment(output);
  if (!files.length) files = byHeading(output);

  const blocks = output.match(/```[\w]*\n[\s\S]*?```/g);
  const map = new Map<string, GeneratedFile>();
  for (const f of files) map.set(f.filepath.replace(/\\/g, "/").replace(/^\.\//, ""), f);

  return { files: Array.from(map.values()), rawOutput: output, blockCount: blocks?.length || 0 };
}

export interface WriteResult {
  written: string[];
  failed: Array<{ filepath: string; error: string }>;
  totalBytes: number;
}

export function writeGeneratedFiles(files: GeneratedFile[], baseDir: string): WriteResult {
  const result: WriteResult = { written: [], failed: [], totalBytes: 0 };

  for (const file of files) {
    try {
      const full = path.resolve(baseDir, file.filepath);
      if (!full.startsWith(path.resolve(baseDir))) {
        result.failed.push({ filepath: file.filepath, error: "Path traversal blocked" });
        console.log(`  \x1b[91m✗\x1b[0m Blocked: ${file.filepath} (traversal)`);
        continue;
      }
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, file.content, "utf-8");
      const bytes = Buffer.byteLength(file.content);
      result.written.push(file.filepath);
      result.totalBytes += bytes;
      console.log(`  \x1b[32m✓\x1b[0m ${file.filepath} (${fmtB(bytes)})`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result.failed.push({ filepath: file.filepath, error: msg });
      console.log(`  \x1b[91m✗\x1b[0m ${file.filepath}: ${msg}`);
    }
  }
  return result;
}

export function summarizeChanges(files: GeneratedFile[]): string {
  const lines = [`\x1b[1m${files.length} file(s) generated:\x1b[0m`];
  for (const f of files) {
    const lc = f.content.split("\n").length;
    lines.push(`  \x1b[36m+\x1b[0m ${f.filepath} \x1b[90m(${f.language || "?"}, ${lc}L)\x1b[0m`);
  }
  return lines.join("\n");
}

function lang(fp: string): string {
  const map: Record<string, string> = {
    ".ts":"typescript",".tsx":"typescript",".js":"javascript",".jsx":"javascript",
    ".py":"python",".c":"c",".h":"c",".cpp":"cpp",".rs":"rust",".go":"go",
    ".java":"java",".rb":"ruby",".php":"php",".sh":"bash",".sql":"sql",
    ".html":"html",".css":"css",".json":"json",".yaml":"yaml",".yml":"yaml",
    ".toml":"toml",".md":"markdown",".vue":"vue",".svelte":"svelte",
  };
  const ext = path.extname(fp).toLowerCase();
  return map[ext] || ext.slice(1) || "plaintext";
}

function fmtB(b: number): string {
  if (b < 1024) return `${b}B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)}KB`;
  return `${(b / 1048576).toFixed(1)}MB`;
}
