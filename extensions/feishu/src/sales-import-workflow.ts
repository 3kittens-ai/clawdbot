import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ClawdbotConfig } from "openclaw/plugin-sdk/feishu";
import { sendMessageFeishu } from "./send.js";
import type { FeishuMediaInfo } from "./types.js";

export type SalesImportWorkflowContext = {
  cfg: ClawdbotConfig;
  accountId: string;
  chatId: string;
  senderOpenId: string;
  messageId?: string;
  content: string;
  isGroup: boolean;
  mediaList: FeishuMediaInfo[];
  log?: (msg: string) => void;
};

type SalesImportResult =
  | {
      status: "missing_fields";
      missing_fields: string[];
    }
  | {
      status: "imported";
      inserted_row_count: number;
      inserted_sku_count: number;
      new_sku_count: number;
      date_range?: { start?: string; end?: string };
      added_cities?: string[];
      normalized_cities?: Array<{ from: string; to: string }>;
      added_tags?: string[];
      new_sku_labels?: Array<{
        sku_code: string;
        sku_name: string;
        product_category?: string;
        business_tags?: string[];
        family_tags?: string;
        product_root?: string;
        spec_length?: string;
        spec_size?: string;
        spec_hook?: string;
        spec_qty?: string;
        applied_tags?: string[];
      }>;
    }
  | {
      status: "error";
      message: string;
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

const SALES_FIELD_LABELS: Record<string, string> = {
  shop: "店铺",
  province: "省份",
  city: "城市",
  sale_date: "日期",
  barcode: "商品编码",
  product_name: "商品名称",
  product_category: "产品分类",
  base_price: "基本售价",
  list_price: "市场吊牌价",
  platform: "所属站点",
  sales_volume: "销售数量",
  paid_amount: "已付金额",
};

function normalizeText(text: string): string {
  return text
    .replace(/<at\b[^>]*>[^<]*<\/at>/giu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function parseSalesImportRequest(content: string): boolean {
  const normalized = normalizeText(content);
  return (
    /(导入|入库|写入)/u.test(normalized) && /(excel|xlsx|表格|数据库|sales)/iu.test(normalized)
  );
}

export function formatMissingSalesFields(fields: string[]): string[] {
  return fields.map((field) => SALES_FIELD_LABELS[field] ?? field);
}

function resolveTarget(ctx: SalesImportWorkflowContext): string {
  return ctx.isGroup ? `chat:${ctx.chatId}` : `user:${ctx.senderOpenId}`;
}

async function sendWorkflowReply(ctx: SalesImportWorkflowContext, text: string): Promise<void> {
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
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      cachedPythonExecutable = candidate;
      return candidate;
    } catch {
      continue;
    }
  }
  cachedPythonExecutable = null;
  return null;
}

export function isExcelAttachment(media: FeishuMediaInfo): boolean {
  const ext = path.extname(media.path).toLowerCase();
  const fileNameExt = path.extname(media.fileName ?? "").toLowerCase();
  if (ext === ".xlsx" || ext === ".xls" || fileNameExt === ".xlsx" || fileNameExt === ".xls") {
    return true;
  }
  return Boolean(
    media.contentType?.includes("spreadsheet") || media.contentType?.includes("excel"),
  );
}

function pickExcelAttachment(mediaList: FeishuMediaInfo[]): FeishuMediaInfo | null {
  for (const media of mediaList) {
    if (isExcelAttachment(media)) {
      return media;
    }
  }
  return null;
}

function summarizeImportResult(result: Extract<SalesImportResult, { status: "imported" }>): string {
  const range =
    result.date_range?.start && result.date_range?.end
      ? `${result.date_range.start} 到 ${result.date_range.end}`
      : "没有新增行写入数据库";
  const normalizedCityNote =
    result.normalized_cities && result.normalized_cities.length > 0
      ? `\n城市标准化：${result.normalized_cities
          .map((item) => `${item.from || "(空值)"} -> ${item.to || "(清空)"}`)
          .join("；")}`
      : "";
  const cityNote =
    result.added_cities && result.added_cities.length > 0
      ? `\n已更新 cities.md：${result.added_cities.join("、")}`
      : "";
  const tagNote =
    result.added_tags && result.added_tags.length > 0
      ? `\n已更新 tags.md：${result.added_tags.join("、")}`
      : "";
  const newSkuLabelNote =
    result.new_sku_labels && result.new_sku_labels.length > 0
      ? `\n新增 SKU 标签：\n${result.new_sku_labels
          .map((item) => {
            const details = [
              item.product_root ? `商品标签分类：${item.product_root}` : null,
              item.spec_length ? `length=${item.spec_length}` : null,
              item.spec_size ? `size=${item.spec_size}` : null,
              item.spec_hook ? `hook=${item.spec_hook}` : null,
              item.spec_qty ? `qty=${item.spec_qty}` : null,
              item.applied_tags && item.applied_tags.length > 0
                ? `tags=${item.applied_tags.join("|")}`
                : null,
            ].filter(Boolean);
            return `- ${item.sku_code}${item.sku_name ? ` (${item.sku_name})` : ""}: ${details.join(", ")}`;
          })
          .join("\n")}`
      : "";
  return (
    [
      "Excel 已导入到销售数据库。",
      `数据时间范围：${range}`,
      `包含 SKU 数：${result.inserted_sku_count}`,
      `相对于数据库中的新 SKU 数：${result.new_sku_count}`,
      `新增行数：${result.inserted_row_count}`,
    ].join("\n") +
    normalizedCityNote +
    cityNote +
    tagNote +
    newSkuLabelNote
  );
}

function runSalesImportJob(ctx: SalesImportWorkflowContext, excelPath: string): void {
  const jobId = `sales-import-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const pythonExecutable = resolvePythonExecutable();
  const modelRoot = resolveJiuyanModelRoot();
  const scriptPath = path.join(modelRoot, "scripts", "import_sales_excel.py");

  ctx.log?.(
    `feishu[${ctx.accountId}]: sales import requested (${jobId}): excel=${excelPath}, target=${resolveTarget(ctx)}`,
  );

  if (!pythonExecutable) {
    void sendWorkflowReply(ctx, "Excel 导入失败：未找到可执行的 Python。").catch(() => {});
    return;
  }
  if (!fs.existsSync(scriptPath)) {
    void sendWorkflowReply(ctx, `Excel 导入失败：作业脚本不存在：${scriptPath}`).catch(() => {});
    return;
  }

  const proc = spawn(pythonExecutable, [scriptPath, "--excel-path", excelPath, "--job-id", jobId], {
    cwd: modelRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  proc.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  proc.on("error", async (error) => {
    cachedPythonExecutable = undefined;
    ctx.log?.(`feishu[${ctx.accountId}]: sales import launch failed (${jobId}): ${String(error)}`);
    await sendWorkflowReply(
      ctx,
      `Excel 导入失败：${error instanceof Error ? error.message : String(error)}`,
    ).catch(() => {});
  });
  proc.on("close", async (code) => {
    ctx.log?.(
      `feishu[${ctx.accountId}]: sales import closed (${jobId}): code=${code ?? "null"}, stdout="${stdout.trim()}", stderr="${stderr.trim()}"`,
    );
    if (code !== 0) {
      await sendWorkflowReply(
        ctx,
        `Excel 导入失败：${(stderr || stdout || `exit code ${code}`).trim()}`,
      ).catch(() => {});
      return;
    }
    const jsonLine = stdout
      .split("\n")
      .map((line) => line.trim())
      .reverse()
      .find((line) => line.startsWith("{") && line.endsWith("}"));
    if (!jsonLine) {
      await sendWorkflowReply(ctx, "Excel 导入失败：未拿到导入结果。").catch(() => {});
      return;
    }
    const result = JSON.parse(jsonLine) as SalesImportResult;
    if (result.status === "missing_fields") {
      const displayFields = formatMissingSalesFields(result.missing_fields);
      await sendWorkflowReply(
        ctx,
        `Excel 缺少 sales 表必要字段：${displayFields.join("、")}`,
      ).catch(() => {});
      return;
    }
    if (result.status === "error") {
      await sendWorkflowReply(ctx, `Excel 导入失败：${result.message}`).catch(() => {});
      return;
    }
    await sendWorkflowReply(ctx, summarizeImportResult(result)).catch(() => {});
  });
}

export async function maybeHandleSalesImportWorkflow(
  ctx: SalesImportWorkflowContext,
): Promise<boolean> {
  if (!parseSalesImportRequest(ctx.content)) {
    return false;
  }
  const excelAttachment = pickExcelAttachment(ctx.mediaList);
  if (!excelAttachment) {
    await sendWorkflowReply(
      ctx,
      "没有检测到 Excel 附件。请直接发送 Excel，或回复一个 Excel 文件并附上导入指令。",
    );
    return true;
  }
  await sendWorkflowReply(ctx, "已开始检查 Excel 字段并导入 sales 数据库。");
  runSalesImportJob(ctx, excelAttachment.path);
  return true;
}
