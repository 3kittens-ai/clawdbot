import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ClawdbotConfig } from "openclaw/plugin-sdk/feishu";
import { sendMediaFeishu } from "./media.js";
import { sendMessageFeishu } from "./send.js";

export type ForecastingWorkflowContext = {
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

export type ForecastingAction = "backtest" | "train" | "predict" | "latest_predict";

export type ForecastingWorkflowRequest = {
  action: ForecastingAction;
  label: string;
};

type ForecastingJobResult = {
  action: ForecastingAction;
  excel_path?: string;
  summary_markdown_path?: string;
  attachments?: Array<{ path: string; file_name: string }>;
};

const MAX_LOG_SNIPPET_CHARS = 1_200;
const ABSOLUTE_PYTHON_CANDIDATES = [
  "/opt/homebrew/bin/python3",
  "/opt/homebrew/bin/python",
  "/usr/local/bin/python3",
  "/usr/local/bin/python",
  "/usr/bin/python3",
  "/usr/bin/python",
];

let cachedPythonExecutable: string | null | undefined;

function normalizeText(text: string): string {
  return text
    .replace(/<at\b[^>]*>[^<]*<\/at>/giu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function parseForecastingWorkflowRequest(
  content: string,
): ForecastingWorkflowRequest | null {
  const normalized = normalizeText(content);
  if (
    /(发我|给我|回我|把)/u.test(normalized) &&
    /(最新|最近一次)/u.test(normalized) &&
    /(销量预测|预测结果|生产推理|生产预测|推理结果|excel|xlsx)/iu.test(normalized)
  ) {
    return { action: "latest_predict", label: "最新生产推理结果" };
  }
  if (/回测/u.test(normalized) && /(预测|销量|模型|forecasting|生产)/u.test(normalized)) {
    return { action: "backtest", label: "回测" };
  }
  if (/(生产训练|训练生产模型|触发训练|跑训练)/u.test(normalized)) {
    return { action: "train", label: "生产训练" };
  }
  if (/(生产推理|生产推断|生产预测|触发推理|跑推理)/u.test(normalized)) {
    return { action: "predict", label: "生产推理" };
  }
  return null;
}

function resolveTarget(ctx: ForecastingWorkflowContext): string {
  return ctx.isGroup ? `chat:${ctx.chatId}` : `user:${ctx.senderOpenId}`;
}

async function sendWorkflowReply(ctx: ForecastingWorkflowContext, text: string): Promise<void> {
  await sendMessageFeishu({
    cfg: ctx.cfg,
    to: resolveTarget(ctx),
    text,
    replyToMessageId: ctx.messageId,
    accountId: ctx.accountId,
  });
}

function resolveJiuyanModelRoot(): string {
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

function resolveRuntimePaths() {
  const modelRoot = resolveJiuyanModelRoot();
  return {
    modelRoot,
    scriptPath: path.join(modelRoot, "scripts", "forecasting_feishu_job.py"),
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

function runForecastingJob(
  ctx: ForecastingWorkflowContext,
  request: ForecastingWorkflowRequest,
): void {
  const jobId = `forecasting-${request.action}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const pythonExecutable = resolvePythonExecutable();
  const runtimePaths = resolveRuntimePaths();

  ctx.log?.(
    `feishu[${ctx.accountId}]: forecasting workflow requested (${jobId}): action=${request.action}, target=${resolveTarget(ctx)}`,
  );

  if (!pythonExecutable) {
    void sendWorkflowReply(ctx, "Forecasting 任务失败：未找到可执行的 Python。").catch(() => {});
    return;
  }
  if (!fs.existsSync(runtimePaths.modelRoot)) {
    void sendWorkflowReply(
      ctx,
      `Forecasting 任务失败：模型目录不存在：${runtimePaths.modelRoot}`,
    ).catch(() => {});
    return;
  }
  if (!fs.existsSync(runtimePaths.scriptPath)) {
    void sendWorkflowReply(
      ctx,
      `Forecasting 任务失败：作业脚本不存在：${runtimePaths.scriptPath}`,
    ).catch(() => {});
    return;
  }

  ctx.log?.(
    `feishu[${ctx.accountId}]: forecasting workflow launching (${jobId}): python=${pythonExecutable}, cwd=${runtimePaths.modelRoot}, script=${runtimePaths.scriptPath}, action=${request.action}`,
  );

  const proc = spawn(
    pythonExecutable,
    [runtimePaths.scriptPath, "--action", request.action, "--job-id", jobId],
    {
      cwd: runtimePaths.modelRoot,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  ctx.log?.(
    `feishu[${ctx.accountId}]: forecasting workflow spawned (${jobId}): pid=${proc.pid ?? "unknown"}`,
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
      `feishu[${ctx.accountId}]: forecasting workflow launch failed (${jobId}): ${String(error)}`,
    );
    await sendWorkflowReply(
      ctx,
      `Forecasting ${request.label}失败：${error instanceof Error ? error.message : String(error)}`,
    ).catch(() => {});
  });
  proc.on("close", async (code) => {
    if (failedToLaunch) {
      return;
    }
    ctx.log?.(
      `feishu[${ctx.accountId}]: forecasting workflow closed (${jobId}): pid=${proc.pid ?? "unknown"}, code=${code ?? "null"}, stdout="${toLogSnippet(stdout)}", stderr="${toLogSnippet(stderr)}"`,
    );
    if (code !== 0) {
      await sendWorkflowReply(
        ctx,
        `Forecasting ${request.label}失败：${(stderr || stdout || `exit code ${code}`).trim()}`,
      ).catch(() => {});
      return;
    }

    const jsonLine = stdout
      .split("\n")
      .map((line) => line.trim())
      .reverse()
      .find((line) => line.startsWith("{") && line.endsWith("}"));
    if (!jsonLine) {
      await sendWorkflowReply(ctx, `Forecasting ${request.label}失败：未拿到产物信息。`).catch(
        () => {},
      );
      return;
    }

    const result = JSON.parse(jsonLine) as ForecastingJobResult;
    ctx.log?.(
      `feishu[${ctx.accountId}]: forecasting workflow json (${jobId}): ${JSON.stringify(result)}`,
    );
    await sendWorkflowReply(ctx, `Forecasting ${request.label}已完成，正在回传结果文件。`).catch(
      () => {},
    );

    for (const attachment of result.attachments ?? []) {
      await sendMediaFeishu({
        cfg: ctx.cfg,
        to: resolveTarget(ctx),
        mediaUrl: attachment.path,
        fileName: attachment.file_name,
        replyToMessageId: ctx.messageId,
        accountId: ctx.accountId,
        mediaLocalRoots: [path.dirname(attachment.path)],
      })
        .then((sendResult) => {
          ctx.log?.(
            `feishu[${ctx.accountId}]: forecasting workflow file sent (${jobId}): messageId=${sendResult.messageId}, chatId=${sendResult.chatId}, file=${attachment.path}`,
          );
        })
        .catch(async (error) => {
          ctx.log?.(
            `feishu[${ctx.accountId}]: forecasting workflow file send failed (${jobId}): ${String(error)}`,
          );
          await sendWorkflowReply(
            ctx,
            `Forecasting ${request.label}已完成，但文件回传失败：${String(error)}`,
          ).catch(() => {});
        });
    }
  });
}

function resolveLatestPredictExcelPath(modelRoot: string): string | null {
  const outputDir = path.join(modelRoot, "outputs", "final");
  if (!fs.existsSync(outputDir)) {
    return null;
  }
  const files = fs
    .readdirSync(outputDir)
    .filter((fileName) => /^results-.*-predict-forecast-export-.*\.xlsx$/u.test(fileName))
    .map((fileName) => {
      const fullPath = path.join(outputDir, fileName);
      return {
        fullPath,
        mtimeMs: fs.statSync(fullPath).mtimeMs,
      };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files[0]?.fullPath ?? null;
}

async function sendLatestPredictResult(ctx: ForecastingWorkflowContext): Promise<void> {
  const { modelRoot } = resolveRuntimePaths();
  const latestExcelPath = resolveLatestPredictExcelPath(modelRoot);
  if (!latestExcelPath) {
    await sendWorkflowReply(ctx, "还没有可回传的生产推理 Excel，请先跑一次生产推理。");
    return;
  }

  await sendWorkflowReply(ctx, "已找到最新的生产推理结果，正在回传 Excel。");
  await sendMediaFeishu({
    cfg: ctx.cfg,
    to: resolveTarget(ctx),
    mediaUrl: latestExcelPath,
    fileName: path.basename(latestExcelPath),
    replyToMessageId: ctx.messageId,
    accountId: ctx.accountId,
    mediaLocalRoots: [path.dirname(latestExcelPath)],
  });
  ctx.log?.(
    `feishu[${ctx.accountId}]: latest predict file sent: target=${resolveTarget(ctx)}, file=${latestExcelPath}`,
  );
}

export async function maybeHandleForecastingWorkflow(
  ctx: ForecastingWorkflowContext,
): Promise<boolean> {
  const request = parseForecastingWorkflowRequest(ctx.content);
  if (!request) {
    return false;
  }

  if (request.action === "latest_predict") {
    await sendLatestPredictResult(ctx).catch(async (error) => {
      await sendWorkflowReply(
        ctx,
        `最新生产推理结果回传失败：${error instanceof Error ? error.message : String(error)}`,
      ).catch(() => {});
    });
    return true;
  }

  await sendWorkflowReply(
    ctx,
    `已开始执行 Forecasting ${request.label}，完成后我会把结果文件发回给你。`,
  );
  runForecastingJob(ctx, request);
  return true;
}
