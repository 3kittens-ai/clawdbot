import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ClawdbotConfig } from "openclaw/plugin-sdk/feishu";
import { sendMediaFeishu } from "./media.js";
import { sendMessageFeishu } from "./send.js";

export type FormulaForecastContext = {
  cfg: ClawdbotConfig;
  accountId: string;
  chatId: string;
  senderOpenId: string;
  messageId?: string;
  content: string;
  isGroup: boolean;
  mentionedBot: boolean;
  log?: (msg: string) => void;
};

export type FormulaForecastRequest = {
  formulaText: string;
  normalizedFormula: string;
  horizonMonths: number;
  topK: number;
};

const ABSOLUTE_PYTHON_CANDIDATES = [
  "/opt/homebrew/bin/python3",
  "/opt/homebrew/bin/python",
  "/usr/local/bin/python3",
  "/usr/local/bin/python",
  "/usr/bin/python3",
  "/usr/bin/python",
];

let cachedPythonExecutable: string | null | undefined;
const MAX_LOG_SNIPPET_CHARS = 1_200;

const FORMULA_TRIGGER_RE =
  /按照(?<formula>.+?)公式(?:计算|预测)(?:未来)?\s*(?<months>\d{1,2})\s*个?月.*?(?:top|前)\s*(?<topk>\d{1,4})\s*(?:个)?\s*sku.*销量/iu;

function normalizeText(text: string): string {
  return text
    .replace(/<at\b[^>]*>[^<]*<\/at>/giu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizeFormulaText(formulaText: string): string {
  return formulaText
    .replace(/最近一个月销量/gu, "m1")
    .replace(/最近1个月销量/gu, "m1")
    .replace(/上个月销量/gu, "m1")
    .replace(/最近3个月平均销量/gu, "avg3")
    .replace(/最近6个月平均销量/gu, "avg6")
    .replace(/最近12个月平均销量/gu, "avg12")
    .replace(/最近3个月总销量/gu, "sum3")
    .replace(/最近6个月总销量/gu, "sum6")
    .replace(/最近12个月总销量/gu, "sum12")
    .replace(/销量增长率/gu, "growth")
    .replace(/增长率/gu, "growth")
    .replace(/趋势值/gu, "trend")
    .replace(/（/gu, "(")
    .replace(/）/gu, ")")
    .replace(/，/gu, ",")
    .replace(/×/gu, "*")
    .replace(/（/gu, "(")
    .replace(/）/gu, ")")
    .replace(/(\d+(?:\.\d+)?)%/gu, "($1/100)")
    .trim();
}

export function parseFormulaForecastRequest(content: string): FormulaForecastRequest | null {
  const normalized = normalizeText(content);
  const match = FORMULA_TRIGGER_RE.exec(normalized);
  if (!match?.groups) {
    return null;
  }

  const horizonMonths = Number.parseInt(match.groups.months, 10);
  const topK = Number.parseInt(match.groups.topk, 10);
  if (!Number.isFinite(horizonMonths) || !Number.isFinite(topK)) {
    return null;
  }

  const formulaText = match.groups.formula.trim();
  if (!formulaText) {
    return null;
  }

  return {
    formulaText,
    normalizedFormula: normalizeFormulaText(formulaText),
    horizonMonths: Math.min(Math.max(horizonMonths, 1), 24),
    topK: Math.min(Math.max(topK, 1), 2000),
  };
}

function resolveTarget(ctx: FormulaForecastContext): string {
  return ctx.isGroup ? `chat:${ctx.chatId}` : `user:${ctx.senderOpenId}`;
}

async function sendWorkflowReply(ctx: FormulaForecastContext, text: string): Promise<void> {
  await sendMessageFeishu({
    cfg: ctx.cfg,
    to: resolveTarget(ctx),
    text,
    replyToMessageId: ctx.messageId,
    accountId: ctx.accountId,
  });
}

type FormulaForecastJobResult = {
  file_path: string;
  file_name: string;
  summary_sheet: string;
  formula_sheet: string;
  latest_month: string;
};

function resolveFormulaForecastModelRoot(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const suffix = path.join("extensions", "feishu", "jiuyan-sales", "model-sales-jiuyan");
  const candidateBases: string[] = [];
  const seen = new Set<string>();

  function pushAncestors(start: string) {
    let current = path.resolve(start);
    for (let depth = 0; depth < 8; depth += 1) {
      if (!seen.has(current)) {
        seen.add(current);
        candidateBases.push(current);
      }
      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
  }

  pushAncestors(moduleDir);
  pushAncestors(process.cwd());

  const candidates = [
    ...candidateBases.map((base) => path.join(base, suffix)),
    path.resolve(moduleDir, "../jiuyan-sales/model-sales-jiuyan"),
    path.resolve(process.cwd(), "extensions/feishu/jiuyan-sales/model-sales-jiuyan"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[0];
}

function resolveFormulaForecastRuntimePaths() {
  const modelRoot = resolveFormulaForecastModelRoot();
  return {
    modelRoot,
    scriptPath: path.join(modelRoot, "scripts", "formula_forecast_job.py"),
    dbPath: path.join(modelRoot, "data-base", "sales_filtered.sqlite"),
  };
}

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function listPythonCandidates(): string[] {
  const seen = new Set<string>();
  const candidates: string[] = [];
  const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    for (const bin of ["python3", "python"]) {
      const candidate = path.join(entry, bin);
      if (seen.has(candidate)) {
        continue;
      }
      seen.add(candidate);
      candidates.push(candidate);
    }
  }
  for (const candidate of ABSOLUTE_PYTHON_CANDIDATES) {
    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    candidates.push(candidate);
  }
  return candidates;
}

function resolvePythonExecutable(): string | null {
  if (cachedPythonExecutable !== undefined) {
    return cachedPythonExecutable;
  }
  for (const candidate of listPythonCandidates()) {
    if (isExecutable(candidate)) {
      cachedPythonExecutable = candidate;
      return candidate;
    }
  }
  cachedPythonExecutable = null;
  return null;
}

export function resolveFormulaForecastPythonExecutableForTest(): string | null {
  return resolvePythonExecutable();
}

export function resolveFormulaForecastRuntimePathsForTest() {
  return resolveFormulaForecastRuntimePaths();
}

export function resetFormulaForecastRuntimeCacheForTest(): void {
  cachedPythonExecutable = undefined;
}

function formatPythonLaunchFailure(reason: string): string {
  const tried = listPythonCandidates().join(", ");
  return `公式预测失败。\n原因：${reason}\n已尝试 Python 路径：${tried}`;
}

function toLogSnippet(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.length <= MAX_LOG_SNIPPET_CHARS) {
    return trimmed;
  }
  return `${trimmed.slice(0, MAX_LOG_SNIPPET_CHARS)}...`;
}

function runFormulaForecastJob(ctx: FormulaForecastContext, request: FormulaForecastRequest): void {
  const jobId = `formula-forecast-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const pythonExecutable = resolvePythonExecutable();
  const runtimePaths = resolveFormulaForecastRuntimePaths();
  ctx.log?.(
    `feishu[${ctx.accountId}]: formula forecast requested (${jobId}): formula="${request.formulaText}", normalized="${request.normalizedFormula}", months=${request.horizonMonths}, topK=${request.topK}, target=${resolveTarget(ctx)}`,
  );
  if (!pythonExecutable) {
    ctx.log?.(
      `feishu[${ctx.accountId}]: formula forecast launch blocked (${jobId}): no python executable`,
    );
    void sendWorkflowReply(
      ctx,
      formatPythonLaunchFailure("当前 gateway 运行环境未找到可执行的 Python。"),
    ).catch(() => {});
    return;
  }
  if (!fs.existsSync(runtimePaths.modelRoot)) {
    ctx.log?.(
      `feishu[${ctx.accountId}]: formula forecast launch blocked (${jobId}): modelRoot missing: ${runtimePaths.modelRoot}`,
    );
    void sendWorkflowReply(
      ctx,
      `公式预测失败。\n原因：模型目录不存在：${runtimePaths.modelRoot}`,
    ).catch(() => {});
    return;
  }
  if (!fs.existsSync(runtimePaths.scriptPath)) {
    ctx.log?.(
      `feishu[${ctx.accountId}]: formula forecast launch blocked (${jobId}): script missing: ${runtimePaths.scriptPath}`,
    );
    void sendWorkflowReply(
      ctx,
      `公式预测失败。\n原因：预测脚本不存在：${runtimePaths.scriptPath}`,
    ).catch(() => {});
    return;
  }
  if (!fs.existsSync(runtimePaths.dbPath)) {
    ctx.log?.(
      `feishu[${ctx.accountId}]: formula forecast launch blocked (${jobId}): db missing: ${runtimePaths.dbPath}`,
    );
    void sendWorkflowReply(
      ctx,
      `公式预测失败。\n原因：销量数据库不存在：${runtimePaths.dbPath}`,
    ).catch(() => {});
    return;
  }
  ctx.log?.(
    `feishu[${ctx.accountId}]: formula forecast launching (${jobId}): python=${pythonExecutable}, cwd=${runtimePaths.modelRoot}, script=${runtimePaths.scriptPath}, db=${runtimePaths.dbPath}`,
  );

  const proc = spawn(
    pythonExecutable,
    [
      runtimePaths.scriptPath,
      "--db",
      runtimePaths.dbPath,
      "--formula",
      request.normalizedFormula,
      "--formula-text",
      request.formulaText,
      "--months",
      String(request.horizonMonths),
      "--top-k",
      String(request.topK),
      "--job-id",
      jobId,
    ],
    {
      cwd: runtimePaths.modelRoot,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  ctx.log?.(
    `feishu[${ctx.accountId}]: formula forecast spawned (${jobId}): pid=${proc.pid ?? "unknown"}`,
  );

  let stdout = "";
  let stderr = "";
  let failedToLaunch = false;
  proc.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  proc.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  proc.on("error", async (error) => {
    failedToLaunch = true;
    cachedPythonExecutable = undefined;
    ctx.log?.(
      `feishu[${ctx.accountId}]: formula forecast launch failed (${jobId}): ${String(error)}`,
    );
    await sendWorkflowReply(
      ctx,
      formatPythonLaunchFailure(
        `预测进程启动失败：${error instanceof Error ? error.message : String(error)}`,
      ),
    ).catch(() => {});
  });

  proc.on("close", async (code) => {
    if (failedToLaunch) {
      return;
    }
    ctx.log?.(
      `feishu[${ctx.accountId}]: formula forecast closed (${jobId}): pid=${proc.pid ?? "unknown"}, code=${code ?? "null"}, stdout="${toLogSnippet(stdout)}", stderr="${toLogSnippet(stderr)}"`,
    );
    if (code !== 0) {
      ctx.log?.(
        `feishu[${ctx.accountId}]: formula forecast job failed (${jobId}): ${stderr || stdout}`,
      );
      await sendWorkflowReply(
        ctx,
        `公式预测失败。\n公式：${request.formulaText}\n原因：${(stderr || stdout || `exit code ${code}`).trim()}`,
      ).catch(() => {});
      return;
    }

    const jsonLine = stdout
      .split("\n")
      .map((line) => line.trim())
      .reverse()
      .find((line) => line.startsWith("{") && line.endsWith("}"));

    if (!jsonLine) {
      await sendWorkflowReply(ctx, `公式预测失败：未拿到输出文件信息。`).catch(() => {});
      return;
    }

    const result = JSON.parse(jsonLine) as FormulaForecastJobResult;
    ctx.log?.(
      `feishu[${ctx.accountId}]: formula forecast json (${jobId}): ${JSON.stringify(result)}`,
    );
    await sendWorkflowReply(
      ctx,
      `公式预测已完成，正在回传 Excel。\n公式：${request.formulaText}\n范围：Top ${request.topK} SKU，未来 ${request.horizonMonths} 个月\n历史截止：${result.latest_month}`,
    ).catch(() => {});
    await sendMediaFeishu({
      cfg: ctx.cfg,
      to: resolveTarget(ctx),
      mediaUrl: result.file_path,
      fileName: result.file_name,
      replyToMessageId: ctx.messageId,
      accountId: ctx.accountId,
      mediaLocalRoots: [path.dirname(result.file_path)],
    })
      .then((sendResult) => {
        ctx.log?.(
          `feishu[${ctx.accountId}]: formula forecast file sent (${jobId}): messageId=${sendResult.messageId}, chatId=${sendResult.chatId}, file=${result.file_path}`,
        );
      })
      .catch(async (error) => {
        ctx.log?.(
          `feishu[${ctx.accountId}]: formula forecast file send failed (${jobId}): ${String(error)}`,
        );
        await sendWorkflowReply(ctx, `公式预测已完成，但 Excel 回传失败：${String(error)}`).catch(
          () => {},
        );
      });
  });
}

export async function maybeHandleFormulaForecastWorkflow(
  ctx: FormulaForecastContext,
): Promise<boolean> {
  const request = parseFormulaForecastRequest(ctx.content);
  if (!request) {
    return false;
  }

  await sendWorkflowReply(
    ctx,
    `已开始按公式计算销量。\n公式：${request.formulaText}\n范围：Top ${request.topK} SKU，未来 ${request.horizonMonths} 个月\n计算完成后我会把 Excel 回传给你。`,
  );
  runFormulaForecastJob(ctx, request);
  return true;
}
