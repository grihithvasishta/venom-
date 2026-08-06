/**
 * VENOM CLI — Telegram Bot Gateway (Enhanced)
 * (Top-level gateway/)
 *
 * Features:
 * - Inline keyboard approval gate (Approve / Revise)
 * - Live-updating status messages (edit-in-place)
 * - File delivery via sendDocument (multipart/form-data)
 * - Context file uploads (user sends documents for @-style context)
 * - Uses native Node.js https — zero external dependencies.
 */

import * as https from "node:https";
import * as http from "node:http";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TelegramChat {
  id: number;
  type: string;
  first_name?: string;
}

interface TelegramFrom {
  id: number;
  first_name?: string;
  username?: string;
}

interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramFrom;
  text?: string;
  document?: TelegramDocument;
  caption?: string;
  date: number;
}

interface TelegramCallbackQuery {
  id: string;
  from: TelegramFrom;
  message?: TelegramMessage;
  data?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

interface TelegramApiResponse {
  ok: boolean;
  result: TelegramUpdate[] | TelegramMessage | TelegramFileResponse | object;
  description?: string;
}

interface TelegramFileResponse {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

interface NimMsg {
  role: "system" | "user" | "assistant";
  content: string;
}

interface NimResp {
  choices: Array<{ message: { content: string } }>;
}

interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

/** Tracks a pending approval for a chat. */
interface PendingApproval {
  chatId: number;
  plan: string;
  optimizedPrompt: string;
  statusMessageId: number;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TG_BASE = "https://api.telegram.org";
const NIM_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const POLL_TIMEOUT = 30;

// Strict models
const MAIN_MODEL = "deepseek-ai/deepseek-v4-flash";
const PLANNER_MODEL = "moonshotai/kimi-k1.5";
const CODER_MODEL = "qwen/qwen2.5-coder-32b-instruct";
const DEBUGGER_MODEL = "nvidia/llama-3.3-nemotron-super-49b-v1";

const MAIN_PROMPT = `You are the VENOM Main Overview Agent on Telegram. Respond concisely. Use Markdown. For /code /vibe /build — coordinate agents internally, present results.`;

// Approval timeout: 10 minutes
const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// HTTP Helpers (native Node.js — zero external deps)
// ---------------------------------------------------------------------------

function httpReq(
  url: string,
  opts: https.RequestOptions,
  body?: string | Buffer
): Promise<{ status: number; data: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, opts, (res: http.IncomingMessage) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({
          status: res.statusCode || 0,
          data: Buffer.concat(chunks).toString(),
        })
      );
    });
    req.on("error", reject);
    req.setTimeout(60_000, () => req.destroy(new Error("Timeout")));
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Build a multipart/form-data body for file uploads.
 * Returns { body, contentType }.
 */
function buildMultipart(
  fields: Record<string, string>,
  file: { fieldName: string; fileName: string; content: Buffer; mimeType: string }
): { body: Buffer; contentType: string } {
  const boundary = `----VenomBoundary${Date.now()}${Math.random().toString(36).slice(2)}`;
  const parts: Buffer[] = [];

  // Text fields
  for (const [key, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`
      )
    );
  }

  // File field
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.fieldName}"; filename="${file.fileName}"\r\nContent-Type: ${file.mimeType}\r\n\r\n`
    )
  );
  parts.push(file.content);
  parts.push(Buffer.from("\r\n"));

  // Closing boundary
  parts.push(Buffer.from(`--${boundary}--\r\n`));

  const body = Buffer.concat(parts);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

// ---------------------------------------------------------------------------
// Telegram API Client (Enhanced)
// ---------------------------------------------------------------------------

class TgClient {
  private base: string;
  private token: string;

  constructor(token: string) {
    this.token = token;
    this.base = `${TG_BASE}/bot${token}`;
  }

  async getUpdates(offset: number): Promise<TelegramUpdate[]> {
    try {
      const { data } = await httpReq(
        `${this.base}/getUpdates?offset=${offset}&timeout=${POLL_TIMEOUT}&allowed_updates=["message","callback_query"]`,
        { method: "GET" }
      );
      const r: TelegramApiResponse = JSON.parse(data);
      return r.ok ? (r.result as TelegramUpdate[]) : [];
    } catch {
      return [];
    }
  }

  /** Send a text message. Returns the sent message_id. */
  async send(chatId: number, text: string): Promise<number> {
    const t =
      text.length > 4000 ? text.slice(0, 3990) + "\n[truncated]" : text;
    const body = JSON.stringify({
      chat_id: chatId,
      text: t,
      parse_mode: "Markdown",
    });
    try {
      const { data } = await httpReq(
        `${this.base}/sendMessage`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
        },
        body
      );
      const parsed: TelegramApiResponse = JSON.parse(data);
      if (parsed.ok && parsed.result && typeof parsed.result === "object" && "message_id" in parsed.result) {
        return (parsed.result as TelegramMessage).message_id;
      }
      return 0;
    } catch {
      return 0;
    }
  }

  /** Send a message with an inline keyboard. Returns the sent message_id. */
  async sendWithKeyboard(
    chatId: number,
    text: string,
    buttons: InlineKeyboardButton[][]
  ): Promise<number> {
    const t =
      text.length > 4000 ? text.slice(0, 3990) + "\n[truncated]" : text;
    const body = JSON.stringify({
      chat_id: chatId,
      text: t,
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: buttons },
    });
    try {
      const { data } = await httpReq(
        `${this.base}/sendMessage`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
        },
        body
      );
      const parsed: TelegramApiResponse = JSON.parse(data);
      if (parsed.ok && parsed.result && typeof parsed.result === "object" && "message_id" in parsed.result) {
        return (parsed.result as TelegramMessage).message_id;
      }
      return 0;
    } catch {
      return 0;
    }
  }

  /** Edit an existing message's text (live status updates). */
  async editMessage(
    chatId: number,
    messageId: number,
    text: string
  ): Promise<void> {
    const t =
      text.length > 4000 ? text.slice(0, 3990) + "\n[truncated]" : text;
    const body = JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text: t,
      parse_mode: "Markdown",
    });
    try {
      await httpReq(
        `${this.base}/editMessageText`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
        },
        body
      );
    } catch {
      // Non-critical — if edit fails, the old message remains
    }
  }

  /** Answer a callback query (acknowledge a button tap). */
  async answerCallback(callbackQueryId: string, text?: string): Promise<void> {
    const body = JSON.stringify({
      callback_query_id: callbackQueryId,
      text: text || "",
    });
    try {
      await httpReq(
        `${this.base}/answerCallbackQuery`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
        },
        body
      );
    } catch {
      // Non-critical
    }
  }

  /** Send typing indicator. */
  async typing(chatId: number): Promise<void> {
    const body = JSON.stringify({ chat_id: chatId, action: "typing" });
    try {
      await httpReq(
        `${this.base}/sendChatAction`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
        },
        body
      );
    } catch {
      // Non-critical
    }
  }

  /**
   * Send a document (file) to the chat.
   * The file content is sent as a multipart/form-data upload.
   */
  async sendDocument(
    chatId: number,
    fileName: string,
    content: Buffer,
    caption?: string
  ): Promise<void> {
    const fields: Record<string, string> = {
      chat_id: String(chatId),
    };
    if (caption) {
      fields.caption = caption.length > 1000 ? caption.slice(0, 990) + "…" : caption;
      fields.parse_mode = "Markdown";
    }

    const mimeType = guessMimeType(fileName);
    const { body, contentType } = buildMultipart(fields, {
      fieldName: "document",
      fileName,
      content,
      mimeType,
    });

    const url = `${this.base}/sendDocument`;
    const parsed = new URL(url);

    try {
      await httpReq(url, {
        method: "POST",
        hostname: parsed.hostname,
        path: parsed.pathname,
        headers: {
          "Content-Type": contentType,
          "Content-Length": body.length,
        },
      }, body);
    } catch (err) {
      console.error(`[TG] sendDocument error: ${err}`);
    }
  }

  /**
   * Get file metadata from Telegram (to download user-uploaded files).
   */
  async getFileInfo(fileId: string): Promise<TelegramFileResponse | null> {
    try {
      const { data } = await httpReq(
        `${this.base}/getFile?file_id=${fileId}`,
        { method: "GET" }
      );
      const parsed: TelegramApiResponse = JSON.parse(data);
      if (parsed.ok && parsed.result) {
        return parsed.result as TelegramFileResponse;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Download a file from Telegram servers given a file_path.
   */
  async downloadFile(filePath: string): Promise<Buffer | null> {
    const url = `${TG_BASE}/file/bot${this.token}/${filePath}`;
    try {
      return await new Promise<Buffer>((resolve, reject) => {
        https.get(url, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => resolve(Buffer.concat(chunks)));
          res.on("error", reject);
        }).on("error", reject);
      });
    } catch {
      return null;
    }
  }
}

/** Best-effort MIME type from file extension. */
function guessMimeType(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  const map: Record<string, string> = {
    ".ts": "text/x-typescript",
    ".js": "application/javascript",
    ".py": "text/x-python",
    ".json": "application/json",
    ".html": "text/html",
    ".css": "text/css",
    ".md": "text/markdown",
    ".txt": "text/plain",
    ".yaml": "text/yaml",
    ".yml": "text/yaml",
    ".toml": "application/toml",
    ".sh": "text/x-shellscript",
    ".rs": "text/x-rust",
    ".go": "text/x-go",
    ".java": "text/x-java",
    ".c": "text/x-c",
    ".cpp": "text/x-c++",
    ".h": "text/x-c",
  };
  return map[ext] || "application/octet-stream";
}

// ---------------------------------------------------------------------------
// NIM API Client (Telegram variant)
// ---------------------------------------------------------------------------

class NimTg {
  private key: string;
  constructor(key: string) {
    this.key = key;
  }

  async chat(
    model: string,
    sys: string,
    msgs: NimMsg[],
    temp = 0.3,
    max = 4096
  ): Promise<string> {
    const full: NimMsg[] = [{ role: "system", content: sys }, ...msgs];
    const body = JSON.stringify({
      model,
      messages: full,
      temperature: temp,
      max_tokens: max,
      stream: false,
    });
    const u = new URL(NIM_URL);
    const { status, data } = await httpReq(NIM_URL, {
      method: "POST",
      hostname: u.hostname,
      path: u.pathname,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.key}`,
        "Content-Length": Buffer.byteLength(body),
      },
    }, body);
    if (status !== 200)
      throw new Error(`NIM [${status}]: ${data.slice(0, 300)}`);
    const r: NimResp = JSON.parse(data);
    return r.choices?.[0]?.message?.content || "";
  }
}

// ---------------------------------------------------------------------------
// Telegram Pipeline Handler (Enhanced)
// ---------------------------------------------------------------------------

const TRIGGERS = ["/code", "/vibe", "/build"];

/** Status line icons for each pipeline phase. */
const STATUS_ICONS: Record<string, { pending: string; done: string }> = {
  optimize: { pending: "⏳", done: "✅" },
  plan: { pending: "⏳", done: "✅" },
  approve: { pending: "⏳", done: "✅" },
  generate: { pending: "⏳", done: "✅" },
  validate: { pending: "⏳", done: "✅" },
};

/** Build a live-updating status message string. */
function buildStatusText(
  phases: Array<{ key: string; label: string; status: "pending" | "active" | "done" | "skipped" }>
): string {
  const lines = phases.map((p) => {
    const icons = STATUS_ICONS[p.key];
    if (!icons) return `  ${p.label}`;
    switch (p.status) {
      case "done":
        return `${icons.done} ${p.label}`;
      case "active":
        return `⟐ *${p.label}...*`;
      case "skipped":
        return `⏭ ~${p.label}~`;
      default:
        return `${icons.pending} ${p.label}`;
    }
  });
  return `🕷️ *VENOM Pipeline*\n\n${lines.join("\n")}`;
}

/**
 * Extract code blocks with filepath: prefix from LLM output.
 * Returns array of { filepath, content } objects.
 */
function extractCodeBlocks(
  raw: string
): Array<{ filepath: string; content: string }> {
  const results: Array<{ filepath: string; content: string }> = [];
  // Match ```filepath:/path/to/file or ```filepath: /path/to/file
  const pattern = /```(?:filepath:\s*)(.*?)\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(raw)) !== null) {
    const filepath = match[1].trim();
    const content = match[2];
    if (filepath && content) {
      results.push({ filepath, content });
    }
  }

  // If no filepath: blocks found, try generic fenced blocks with a filename-like info string
  if (results.length === 0) {
    const fallback = /```(\S+\.(?:ts|js|py|json|html|css|yaml|yml|md|toml|rs|go|java|c|cpp|h|sh))\n([\s\S]*?)```/g;
    while ((match = fallback.exec(raw)) !== null) {
      const filepath = match[1].trim();
      const content = match[2];
      if (filepath && content) {
        results.push({ filepath, content });
      }
    }
  }

  return results;
}

class TgPipeline {
  private tg: TgClient;
  private nim: NimTg;
  private hist = new Map<number, NimMsg[]>();
  /** Context files uploaded by each chat (cleared after use). */
  private uploadedContext = new Map<number, Array<{ name: string; content: string }>>();
  /** Pending approvals keyed by chatId. */
  private pendingApprovals = new Map<number, PendingApproval>();

  constructor(tg: TgClient, nim: NimTg) {
    this.tg = tg;
    this.nim = nim;
  }

  /** Handle a text message or command. */
  async handle(chatId: number, text: string): Promise<void> {
    const t = text.trim();

    // ── Built-in commands ──
    if (t === "/start") {
      await this.tg.send(
        chatId,
        "🕷️ *VENOM* active.\n\n" +
          "Send a message for a quick answer.\n" +
          "Use `/code`, `/vibe`, or `/build` to trigger the full agentic pipeline.\n" +
          "Upload files for context before running a pipeline.\n\n" +
          "`/help` — show all commands"
      );
      return;
    }

    if (t === "/help") {
      await this.tg.send(
        chatId,
        "*VENOM Commands:*\n" +
          "`/code <task>` — Trigger agentic coding pipeline\n" +
          "`/vibe <task>` — Alias for /code\n" +
          "`/build <task>` — Alias for /code\n" +
          "`/write <topic>` — Human-like text generation\n" +
          "`/clear` — Clear conversation history\n" +
          "`/help` — Show this help\n\n" +
          "📎 Upload files to add context before running a pipeline."
      );
      return;
    }

    if (t === "/clear") {
      this.hist.delete(chatId);
      this.uploadedContext.delete(chatId);
      await this.tg.send(chatId, "🗑 History and uploaded context cleared.");
      return;
    }

    await this.tg.typing(chatId);

    try {
      // ── Detect agentic trigger ──
      let isAgentic = false;
      let body = t;
      for (const p of TRIGGERS) {
        if (t.startsWith(p)) {
          isAgentic = true;
          body = t.slice(p.length).trim();
          break;
        }
      }

      // ── /write command ──
      if (t.startsWith("/write")) {
        const wb = t.slice(6).trim();
        if (!wb) {
          await this.tg.send(chatId, "Usage: `/write <topic>`");
          return;
        }
        const resp = await this.nim.chat(
          MAIN_MODEL,
          "Write as a real human. Vary sentences. Use contractions. No AI phrases. Be casual and genuine.",
          [{ role: "user", content: wb }]
        );
        await this.tg.send(chatId, resp);
        return;
      }

      // ── Agentic pipeline ──
      if (isAgentic && body) {
        await this.handleAgenticPipeline(chatId, body);
      } else {
        // ── Standalone chat ──
        await this.handleStandalone(chatId, t);
      }
    } catch (e) {
      await this.tg.send(
        chatId,
        `❌ ${e instanceof Error ? e.message : e}`
      );
    }
  }

  /** Handle an uploaded document — store its content as context. */
  async handleDocument(chatId: number, doc: TelegramDocument, caption?: string): Promise<void> {
    const fileName = doc.file_name || "uploaded_file";

    // Check file size (reject > 1MB for safety)
    if (doc.file_size && doc.file_size > 1_000_000) {
      await this.tg.send(chatId, `⚠️ File \`${fileName}\` is too large (>1MB). Skipping.`);
      return;
    }

    try {
      const fileInfo = await this.tg.getFileInfo(doc.file_id);
      if (!fileInfo?.file_path) {
        await this.tg.send(chatId, `⚠️ Could not retrieve file \`${fileName}\`.`);
        return;
      }

      const content = await this.tg.downloadFile(fileInfo.file_path);
      if (!content) {
        await this.tg.send(chatId, `⚠️ Could not download file \`${fileName}\`.`);
        return;
      }

      const textContent = content.toString("utf-8");

      if (!this.uploadedContext.has(chatId)) {
        this.uploadedContext.set(chatId, []);
      }
      this.uploadedContext.get(chatId)!.push({ name: fileName, content: textContent });

      await this.tg.send(
        chatId,
        `📎 File \`${fileName}\` stored as context (${textContent.length} chars).\n` +
          `Use a pipeline command to include it.`
      );

      // If a caption is present and looks like a command, handle it
      if (caption) {
        const trimmedCaption = caption.trim();
        for (const p of TRIGGERS) {
          if (trimmedCaption.startsWith(p)) {
            await this.handle(chatId, trimmedCaption);
            return;
          }
        }
      }
    } catch (e) {
      await this.tg.send(
        chatId,
        `❌ Failed to process file: ${e instanceof Error ? e.message : e}`
      );
    }
  }

  /** Handle a callback query (inline keyboard button press). */
  async handleCallback(query: TelegramCallbackQuery): Promise<void> {
    const chatId = query.message?.chat.id;
    if (!chatId || !query.data) return;

    const pending = this.pendingApprovals.get(chatId);
    if (!pending) {
      await this.tg.answerCallback(query.id, "No pending approval.");
      return;
    }

    // Check if the approval has expired
    if (Date.now() - pending.timestamp > APPROVAL_TIMEOUT_MS) {
      this.pendingApprovals.delete(chatId);
      await this.tg.answerCallback(query.id, "Approval expired.");
      await this.tg.editMessage(chatId, pending.statusMessageId, "⏰ Approval timed out.");
      return;
    }

    if (query.data === "approve") {
      await this.tg.answerCallback(query.id, "Approved! Generating code...");
      this.pendingApprovals.delete(chatId);
      await this.executePostApproval(chatId, pending);
    } else if (query.data === "reject") {
      await this.tg.answerCallback(query.id, "Rejected. Send revised task.");
      this.pendingApprovals.delete(chatId);
      await this.tg.editMessage(
        chatId,
        pending.statusMessageId,
        "❌ *Pipeline cancelled.* Send a revised task to try again."
      );
    }
  }

  // ── Private: Standalone chat ──

  private async handleStandalone(chatId: number, text: string): Promise<void> {
    if (!this.hist.has(chatId)) this.hist.set(chatId, []);
    const h = this.hist.get(chatId)!;
    h.push({ role: "user", content: text });
    if (h.length > 20) h.splice(0, h.length - 16);
    const resp = await this.nim.chat(MAIN_MODEL, MAIN_PROMPT, h);
    h.push({ role: "assistant", content: resp });
    await this.tg.send(chatId, resp);
  }

  // ── Private: Agentic pipeline with interactive approval ──

  private async handleAgenticPipeline(
    chatId: number,
    task: string
  ): Promise<void> {
    // Gather uploaded context if any
    const contextFiles = this.uploadedContext.get(chatId) || [];
    let contextBlock = "";
    if (contextFiles.length > 0) {
      contextBlock = contextFiles
        .map((f) => `--- @${f.name} ---\n${f.content}\n--- end ---`)
        .join("\n\n");
      // Clear after use
      this.uploadedContext.delete(chatId);
    }

    // Define pipeline phases
    const phases = [
      { key: "optimize", label: "Prompt Optimization", status: "active" as const },
      { key: "plan", label: "Architecture Planning", status: "pending" as const },
      { key: "approve", label: "User Approval", status: "pending" as const },
      { key: "generate", label: "Code Generation", status: "pending" as const },
      { key: "validate", label: "Validation", status: "pending" as const },
    ];

    // Send initial status message
    const statusMsgId = await this.tg.send(chatId, buildStatusText(phases));

    const updatePhase = async (
      key: string,
      status: "pending" | "active" | "done" | "skipped"
    ) => {
      const phase = phases.find((p) => p.key === key);
      if (phase) (phase as { status: string }).status = status;
      if (statusMsgId) {
        await this.tg.editMessage(chatId, statusMsgId, buildStatusText(phases));
      }
    };

    // ── Step 1: Optimize prompt ──
    await this.tg.typing(chatId);
    const promptInput = contextBlock
      ? `Optimize this task for the Planning Agent:\n\n${task}\n\nContext files:\n${contextBlock}`
      : `Optimize: ${task}`;

    const optimizedPrompt = await this.nim.chat(MAIN_MODEL, MAIN_PROMPT, [
      { role: "user", content: promptInput },
    ]);
    await updatePhase("optimize", "done");

    // ── Step 2: Planning ──
    await updatePhase("plan", "active");
    await this.tg.typing(chatId);
    const plan = await this.nim.chat(
      PLANNER_MODEL,
      "You are the VENOM Planner. Detailed specs only.",
      [{ role: "user", content: optimizedPrompt }],
      0.2,
      8192
    );
    await updatePhase("plan", "done");

    // ── Step 3: Summarize plan & ask for approval ──
    await updatePhase("approve", "active");
    const summary = await this.nim.chat(MAIN_MODEL, MAIN_PROMPT, [
      {
        role: "user",
        content: `Summarize this plan in 2-3 concise lines for Telegram:\n${plan.slice(0, 3000)}`,
      },
    ]);

    // Send plan summary with inline keyboard
    const approvalMsgId = await this.tg.sendWithKeyboard(
      chatId,
      `📋 *Strategy:*\n${summary}`,
      [
        [
          { text: "✅ Approve", callback_data: "approve" },
          { text: "❌ Cancel", callback_data: "reject" },
        ],
      ]
    );

    // Store pending approval
    this.pendingApprovals.set(chatId, {
      chatId,
      plan,
      optimizedPrompt,
      statusMessageId: statusMsgId,
      timestamp: Date.now(),
    });

    // Update status to show we're waiting
    await this.tg.editMessage(
      chatId,
      statusMsgId,
      buildStatusText(phases) + "\n\n⏳ _Waiting for your approval..._"
    );
  }

  /** Execute the pipeline after user approves. */
  private async executePostApproval(
    chatId: number,
    approval: PendingApproval
  ): Promise<void> {
    const { plan, statusMessageId } = approval;

    const phases = [
      { key: "optimize", label: "Prompt Optimization", status: "done" as const },
      { key: "plan", label: "Architecture Planning", status: "done" as const },
      { key: "approve", label: "User Approval", status: "done" as const },
      { key: "generate", label: "Code Generation", status: "active" as const },
      { key: "validate", label: "Validation", status: "pending" as const },
    ];

    const updatePhase = async (
      key: string,
      status: "pending" | "active" | "done" | "skipped"
    ) => {
      const phase = phases.find((p) => p.key === key);
      if (phase) (phase as { status: string }).status = status;
      if (statusMessageId) {
        await this.tg.editMessage(
          chatId,
          statusMessageId,
          buildStatusText(phases)
        );
      }
    };

    try {
      // ── Step 4: Generate code ──
      await this.tg.typing(chatId);
      const codeOutput = await this.nim.chat(
        CODER_MODEL,
        "Complete production code. filepath: blocks.",
        [{ role: "user", content: `Generate:\n${plan}` }],
        0.1,
        16384
      );
      await updatePhase("generate", "done");

      // ── Step 5: Validate ──
      await updatePhase("validate", "active");
      await this.tg.typing(chatId);
      const validation = await this.nim.chat(
        DEBUGGER_MODEL,
        "Output PASSED or BUG_FOUND:",
        [
          {
            role: "user",
            content: `Check:\n${codeOutput.slice(0, 8000)}`,
          },
        ],
        0.1,
        4096
      );
      await updatePhase("validate", "done");

      const passed = validation.includes("PASSED");

      // ── Final status ──
      const finalStatus = passed
        ? buildStatusText(phases) + "\n\n✅ *All checks passed!*"
        : buildStatusText(phases) + "\n\n⚠️ *Issues detected — review output.*";
      await this.tg.editMessage(chatId, statusMessageId, finalStatus);

      // ── Deliver code as files ──
      const codeBlocks = extractCodeBlocks(codeOutput);

      if (codeBlocks.length > 0) {
        // Send each extracted file as a document attachment
        for (const block of codeBlocks) {
          const fileName = path.basename(block.filepath);
          await this.tg.sendDocument(
            chatId,
            fileName,
            Buffer.from(block.content, "utf-8"),
            `\`${block.filepath}\``
          );
        }
      } else {
        // Fallback: send raw output as chunked text
        const chunks = chunkString(codeOutput, 3800);
        for (const chunk of chunks) {
          await this.tg.send(chatId, `\`\`\`\n${chunk}\n\`\`\``);
        }
      }

      // Send validation summary
      if (!passed) {
        const valChunks = chunkString(validation, 3800);
        await this.tg.send(chatId, "*Validation Report:*");
        for (const chunk of valChunks) {
          await this.tg.send(chatId, `\`\`\`\n${chunk}\n\`\`\``);
        }
      }

      await this.tg.send(chatId, "🕷️ *VENOM pipeline complete.*");
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      await this.tg.editMessage(
        chatId,
        statusMessageId,
        `❌ *Pipeline error:* ${errMsg}`
      );
      await this.tg.send(chatId, `❌ ${errMsg}`);
    }
  }
}

function chunkString(str: string, maxLen: number): string[] {
  const chunks: string[] = [];
  let i = 0;
  while (i < str.length) {
    chunks.push(str.slice(i, i + maxLen));
    i += maxLen;
  }
  return chunks.length > 0 ? chunks : ["(empty output)"];
}

// ---------------------------------------------------------------------------
// Main — Long Polling Loop (Enhanced with callback_query support)
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const token = process.env.VENOM_TELEGRAM_TOKEN;
  const apiKey = process.env.NVIDIA_NIM_API_KEY;
  if (!token) {
    console.error("[TG] No token.");
    process.exit(1);
  }
  if (!apiKey) console.warn("[TG] No API key — agentic features will fail.");

  const tg = new TgClient(token);
  const nim = new NimTg(apiKey || "");
  const pipe = new TgPipeline(tg, nim);

  console.log("[TG] VENOM Telegram gateway started (enhanced).");
  let offset = 0;

  process.on("SIGTERM", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));

  while (true) {
    try {
      const updates = await tg.getUpdates(offset);
      for (const u of updates) {
        offset = u.update_id + 1;

        // ── Handle callback queries (inline keyboard button presses) ──
        if (u.callback_query) {
          pipe
            .handleCallback(u.callback_query)
            .catch((e) => console.error(`[TG] Callback error: ${e}`));
          continue;
        }

        // ── Handle document uploads ──
        if (u.message?.document) {
          const chatId = u.message.chat.id;
          pipe
            .handleDocument(chatId, u.message.document, u.message.caption)
            .catch((e) => console.error(`[TG] Document error: ${e}`));
          continue;
        }

        // ── Handle text messages ──
        if (u.message?.text) {
          const chatId = u.message.chat.id;
          pipe
            .handle(chatId, u.message.text)
            .catch((e) => console.error(`[TG] ${e}`));
        }
      }
    } catch (e) {
      console.error(`[TG] Poll error: ${e}`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`[TG FATAL] ${e}`);
    process.exit(1);
  });
}

export { TgClient, TgPipeline };
