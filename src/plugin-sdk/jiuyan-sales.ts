import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

const ABSOLUTE_PYTHON_CANDIDATES = [
  "/opt/homebrew/bin/python3",
  "/opt/homebrew/bin/python",
  "/usr/local/bin/python3",
  "/usr/local/bin/python",
  "/usr/bin/python3",
  "/usr/bin/python",
];

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

let cachedPythonExecutable: string | null | undefined;

export type JiuyanSalesRuntimePaths = {
  modelRoot: string;
  forecastingScriptPath: string;
  salesImportScriptPath: string;
  formulaForecastScriptPath: string;
  scheduleWorkbookScriptPath: string;
  dbPath: string;
  outputsDir: string;
  formulaOutputsDir: string;
  scheduleWorkbookPath: string;
  scheduleWorkbookSourcePath: string;
};

export type ForecastingAction = "backtest" | "train" | "predict" | "latest_predict";

export type ForecastingWorkflowRequest = {
  action: ForecastingAction;
  label: string;
};

export type ForecastingJobResult = {
  action: ForecastingAction;
  excel_path?: string;
  summary_markdown_path?: string;
  attachments?: Array<{ path: string; file_name: string }>;
};

export type FormulaForecastRequest = {
  formulaText: string;
  normalizedFormula: string;
  horizonMonths: number;
  topK: number;
  targetTurnoverDays: number;
  productCategory?: string;
  topBasis: "latest_day" | "latest_complete_month" | "trailing_12_months" | "all_time";
  scopeMode?: "top" | "attachment_excel";
  skuListExcelPath?: string;
};

const DEFAULT_FORMULA_FORECAST_MONTHS = 5;
const DEFAULT_FORMULA_FORECAST_TOP_K = 50;
const DEFAULT_FORMULA_FORECAST_TARGET_TURNOVER_DAYS = 45;
const DEFAULT_FORMULA_FORECAST_TOP_BASIS = "latest_complete_month";
const DEFAULT_FORMULA_FORECAST_STRATEGY = "builtin_default_5m";
const DEFAULT_FORMULA_FORECAST_TEXT =
  "第1个月=max(近月销量×历史同期月份比例, 本月累计销量折算值, 短期销量折算值); 第2-5个月=上个月预测×去年同期相邻月份销量比";
const JIUYAN_PRODUCT_CATEGORIES = ["加长子线", "无结子线", "线组", "鱼钩"] as const;

export type FormulaForecastJobResult = {
  file_path: string;
  file_name: string;
  summary_sheet: string;
  formula_sheet: string;
  latest_month: string;
};

const FORMULA_FORECAST_TOP_BASIS_LABELS = {
  latest_day: "昨天销量",
  latest_complete_month: "上个月销量",
  trailing_12_months: "近1年销量",
  all_time: "历史销量",
} satisfies Record<FormulaForecastRequest["topBasis"], string>;

export type ScheduleWorkbookRequest = {
  workbookLabel: string;
};

export type ScheduleWorkbookJobResult = {
  file_path: string;
  file_name: string;
  source_file_path: string;
  source_file_name: string;
  latest_date: string;
  updated_sku_count: number;
};

export type JiuyanSalesChannelAdapter = {
  sendText: (text: string) => Promise<void>;
  sendFile: (params: { path: string; fileName: string }) => Promise<void>;
  log?: (message: string) => void;
  logPrefix?: string;
};

export type SalesAttachmentLike = {
  path: string;
  fileName?: string;
  contentType?: string;
};

export type SalesImportResult =
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
      latest_inventory_updated_sku_count?: number;
      latest_in_transit_updated_sku_count?: number;
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

type QueryMetric =
  | "record_count"
  | "total_qty"
  | "total_paid_amount"
  | "active_sku_count"
  | "avg_base_price"
  | "avg_list_price";

type QueryDimension = "province" | "city" | "platform" | "shop" | "product_category" | "sku";

type QueryTimeRange =
  | { kind: "all_time"; label: string }
  | { kind: "latest_day"; label: string }
  | { kind: "latest_minus_days"; days: number; label: string }
  | { kind: "last_n_days"; days: number; label: string }
  | { kind: "previous_calendar_week"; label: string }
  | { kind: "last_n_months"; months: number; label: string }
  | { kind: "specific_year"; year: string; label: string }
  | { kind: "specific_date"; date: string; label: string }
  | { kind: "specific_month"; month: string; label: string };

type AggregateSalesDbQueryRequest = {
  kind: "aggregate";
  metric: QueryMetric;
  timeRange: QueryTimeRange;
  groupBy?: QueryDimension;
  sortDirection?: "asc" | "desc";
  limit?: number;
};

type CompareWindow =
  | { kind: "calendar_month"; offsetMonths: number; label: string }
  | { kind: "rolling_days"; days: number; offsetWindows: number; label: string };

type PeriodChangeSalesDbQueryRequest = {
  kind: "period_change";
  metric: QueryMetric;
  currentWindow: CompareWindow;
  previousWindow: CompareWindow;
  groupBy?: QueryDimension;
  sortDirection?: "asc" | "desc";
  limit?: number;
};

type AnomalySummarySalesDbQueryRequest = {
  kind: "anomaly_summary";
  metric: QueryMetric;
  months: number;
  dimensions: QueryDimension[];
  topN: number;
  label: string;
};

export type SalesDbQueryRequest =
  | { kind: "latest_date" }
  | { kind: "date_range" }
  | { kind: "new_sku_count"; month: string; label: string }
  | PeriodChangeSalesDbQueryRequest
  | AnomalySummarySalesDbQueryRequest
  | AggregateSalesDbQueryRequest;

type SalesDbQueryPlan = {
  normalized: string;
  intent:
    | "latest_date"
    | "date_range"
    | "new_sku_count"
    | "aggregate"
    | "period_change"
    | "anomaly_summary";
  metric?: QueryMetric;
  timeRange?: QueryTimeRange;
  dimension?: QueryDimension;
  wantsRanking?: boolean;
  wantsGrouping?: boolean;
  limit?: number;
  month?: string;
  label?: string;
  months?: number;
  dimensions?: QueryDimension[];
  topN?: number;
  currentWindow?: CompareWindow;
  previousWindow?: CompareWindow;
};

type AggregateRow = {
  label: string;
  secondaryLabel?: string;
  value: number;
};

export type SalesDbQueryResult =
  | { kind: "latest_date"; latestDate: string | null }
  | { kind: "date_range"; minDate: string | null; maxDate: string | null }
  | {
      kind: "new_sku_count";
      month: string;
      label: string;
      skuCount: number;
    }
  | {
      kind: "aggregate";
      metric: QueryMetric;
      timeLabel: string;
      resolvedRangeLabel: string;
      latestDate: string | null;
      groupBy?: QueryDimension;
      rows: AggregateRow[];
      limit?: number;
    }
  | {
      kind: "period_change";
      metric: QueryMetric;
      currentLabel: string;
      previousLabel: string;
      groupBy?: QueryDimension;
      rows: Array<{
        label: string;
        secondaryLabel?: string;
        currentValue: number;
        previousValue: number;
        changeValue: number;
        changeRate: number | null;
      }>;
      limit?: number;
      latestDate: string | null;
    }
  | {
      kind: "anomaly_summary";
      metric: QueryMetric;
      label: string;
      latestDate: string | null;
      sections: Array<{
        dimension: QueryDimension;
        rows: Array<{
          label: string;
          secondaryLabel?: string;
          latestValue: number;
          baselineValue: number;
          changeValue: number;
          changeRate: number | null;
        }>;
      }>;
    };

type QueryExecutionPlan =
  | { sql: string; params: Array<string | number>; timeLabel: string; resolvedRangeLabel: string }
  | {
      sql: string;
      params: Array<string | number>;
      timeLabel: string;
      resolvedRangeLabel: string;
      groupBy: QueryDimension;
      limit?: number;
    };

type MetricSpec = {
  sql: string;
  label: string;
  formatter: (value: number) => string;
};

type DimensionSpec = {
  column: string;
  label: string;
};

type PythonJobCompletion<T> = {
  jobId: string;
  stdout: string;
  stderr: string;
  result: T;
};

const METRICS: Record<QueryMetric, MetricSpec> = {
  record_count: {
    sql: "COUNT(*)",
    label: "记录数",
    formatter: (value) => formatNumber(value, false),
  },
  total_qty: {
    sql: "COALESCE(SUM(sales_volume), 0)",
    label: "销量",
    formatter: (value) => formatNumber(value, false),
  },
  total_paid_amount: {
    sql: "COALESCE(SUM(paid_amount), 0)",
    label: "销售额",
    formatter: (value) => formatNumber(value, true),
  },
  active_sku_count: {
    sql: "COUNT(DISTINCT barcode)",
    label: "活跃 SKU 数",
    formatter: (value) => formatNumber(value, false),
  },
  avg_base_price: {
    sql: "COALESCE(AVG(base_price), 0)",
    label: "平均基本售价",
    formatter: (value) => formatNumber(value, true),
  },
  avg_list_price: {
    sql: "COALESCE(AVG(list_price), 0)",
    label: "平均吊牌价",
    formatter: (value) => formatNumber(value, true),
  },
};

const DIMENSIONS: Record<Exclude<QueryDimension, "sku">, DimensionSpec> = {
  province: { column: "province", label: "省份" },
  city: { column: "city", label: "城市" },
  platform: { column: "platform", label: "平台" },
  shop: { column: "shop", label: "店铺" },
  product_category: { column: "product_category", label: "品类" },
};

const LEGACY_FORMULA_TRIGGER_RE =
  /按照(?<formula>.+?)公式(?:计算|预测)(?:未来)?\s*(?<months>\d{1,2})\s*个?月.*?(?:top|前)\s*(?<topk>\d{1,4})\s*(?:个)?\s*sku.*销量/iu;
const NATURAL_FORMULA_TRIGGER_RE = /^(?:用数据库中的数据使用)?公式(?:计算|预测)(?:销量)?/iu;

function normalizeText(text: string): string {
  return text
    .replace(/<at\b[^>]*>[^<]*<\/at>/giu, " ")
    .replace(/[“”"'`「」【】〔〕［］（）()，,。！？!?：:；;]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizeFormulaRequestText(text: string): string {
  return text
    .replace(/<at\b[^>]*>[^<]*<\/at>/giu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizeFormulaText(formulaText: string): string {
  if (formulaText === DEFAULT_FORMULA_FORECAST_TEXT) {
    return DEFAULT_FORMULA_FORECAST_STRATEGY;
  }
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
    .replace(/(\d+(?:\.\d+)?)%/gu, "($1/100)")
    .trim();
}

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function candidateRootsFrom(start: string, into: string[], seen: Set<string>) {
  let current = path.resolve(start);
  for (let depth = 0; depth < 8; depth += 1) {
    if (!seen.has(current)) {
      seen.add(current);
      into.push(current);
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
}

export function resolveJiuyanSalesModelRoot(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const sharedSuffix = path.join("extensions", "shared", "jiuyan-sales", "model-sales-jiuyan");
  const legacySuffix = path.join("extensions", "feishu", "jiuyan-sales", "model-sales-jiuyan");
  const candidateBases: string[] = [];
  const seen = new Set<string>();

  candidateRootsFrom(moduleDir, candidateBases, seen);
  candidateRootsFrom(process.cwd(), candidateBases, seen);

  const cwdShared = path.resolve(process.cwd(), sharedSuffix);
  const cwdLegacy = path.resolve(process.cwd(), legacySuffix);
  const moduleShared = path.resolve(
    moduleDir,
    "../../extensions/shared/jiuyan-sales/model-sales-jiuyan",
  );
  const moduleLegacy = path.resolve(
    moduleDir,
    "../../extensions/feishu/jiuyan-sales/model-sales-jiuyan",
  );

  const candidates = [
    cwdShared,
    cwdLegacy,
    moduleShared,
    moduleLegacy,
    ...candidateBases.map((base) => path.join(base, sharedSuffix)),
    ...candidateBases.map((base) => path.join(base, legacySuffix)),
    path.resolve(process.cwd(), "extensions/shared/jiuyan-sales/model-sales-jiuyan"),
    path.resolve(process.cwd(), "extensions/feishu/jiuyan-sales/model-sales-jiuyan"),
  ];

  const existingCandidates = candidates.filter(
    (candidate, index) => candidates.indexOf(candidate) === index && fs.existsSync(candidate),
  );
  const existingWithDb = existingCandidates.find((candidate) =>
    fs.existsSync(path.join(candidate, "data-base", "sales_filtered.sqlite")),
  );
  if (existingWithDb) {
    return existingWithDb;
  }

  for (const candidate of existingCandidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0];
}

export function resolveJiuyanSalesRuntimePaths(): JiuyanSalesRuntimePaths {
  const modelRoot = resolveJiuyanSalesModelRoot();
  const formulaOutputsDir = path.join(modelRoot, "outputs", "formula");
  return {
    modelRoot,
    forecastingScriptPath: path.join(modelRoot, "scripts", "forecasting_job.py"),
    salesImportScriptPath: path.join(modelRoot, "scripts", "sales_import_job.py"),
    formulaForecastScriptPath: path.join(modelRoot, "scripts", "sales_expression_forecast_job.py"),
    scheduleWorkbookScriptPath: path.join(modelRoot, "scripts", "update_hook_schedule_workbook.py"),
    dbPath: path.join(modelRoot, "data-base", "sales_filtered.sqlite"),
    outputsDir: path.join(modelRoot, "outputs", "final"),
    formulaOutputsDir,
    scheduleWorkbookPath: path.join(formulaOutputsDir, "20260324计划排单表-常规鱼钩.xlsx"),
    scheduleWorkbookSourcePath: path.join(
      formulaOutputsDir,
      "20260301-0323商品主题分析_全商品档案_20260324092322_149676800_1.xlsx",
    ),
  };
}

export function listJiuyanSalesPythonCandidates(): string[] {
  const seen = new Set<string>();
  const candidates: string[] = [];
  const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    for (const bin of ["python3", "python"]) {
      const candidate = path.join(entry, bin);
      if (!seen.has(candidate)) {
        seen.add(candidate);
        candidates.push(candidate);
      }
    }
  }
  for (const candidate of ABSOLUTE_PYTHON_CANDIDATES) {
    if (!seen.has(candidate)) {
      seen.add(candidate);
      candidates.push(candidate);
    }
  }
  return candidates;
}

export function resolveJiuyanSalesPythonExecutable(): string | null {
  if (cachedPythonExecutable !== undefined) {
    return cachedPythonExecutable;
  }
  for (const candidate of listJiuyanSalesPythonCandidates()) {
    if (isExecutable(candidate)) {
      cachedPythonExecutable = candidate;
      return candidate;
    }
  }
  cachedPythonExecutable = null;
  return null;
}

export function resetJiuyanSalesRuntimeCacheForTest(): void {
  cachedPythonExecutable = undefined;
}

function runJsonPythonJob<T>(params: {
  scriptPath: string;
  cwd: string;
  args: string[];
  pythonMissingMessage: string;
  missingPaths?: Array<{ path: string; message: string }>;
  env?: NodeJS.ProcessEnv;
}): Promise<PythonJobCompletion<T>> {
  const pythonExecutable = resolveJiuyanSalesPythonExecutable();
  if (!pythonExecutable) {
    throw new Error(params.pythonMissingMessage);
  }
  for (const missingPath of params.missingPaths ?? []) {
    if (!fs.existsSync(missingPath.path)) {
      throw new Error(missingPath.message);
    }
  }
  if (!fs.existsSync(params.scriptPath)) {
    throw new Error(`作业脚本不存在：${params.scriptPath}`);
  }

  const jobIdIndex = params.args.findIndex((arg) => arg === "--job-id");
  const jobId =
    jobIdIndex >= 0 && typeof params.args[jobIdIndex + 1] === "string"
      ? params.args[jobIdIndex + 1]
      : randomUUID().slice(0, 8);

  return new Promise<PythonJobCompletion<T>>((resolve, reject) => {
    const proc = spawn(pythonExecutable, [params.scriptPath, ...params.args], {
      cwd: params.cwd,
      env: {
        ...process.env,
        ...params.env,
      },
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
    proc.on("error", (error) => {
      cachedPythonExecutable = undefined;
      reject(error);
    });
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error((stderr || stdout || `exit code ${code}`).trim()));
        return;
      }
      const jsonLine = stdout
        .split("\n")
        .map((line) => line.trim())
        .toReversed()
        .find((line) => line.startsWith("{") && line.endsWith("}"));
      if (!jsonLine) {
        reject(new Error("未拿到产物信息。"));
        return;
      }
      resolve({
        jobId,
        stdout,
        stderr,
        result: JSON.parse(jsonLine) as T,
      });
    });
  });
}

export function parseForecastingWorkflowRequest(
  content: string,
): ForecastingWorkflowRequest | null {
  const normalized = normalizeText(content);
  if (
    /(发我|给我|回我|把)/u.test(normalized) &&
    /(销量预测|预测结果|生产推理|生产预测|推理结果|excel|xlsx|文件)/iu.test(normalized)
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

function logWithAdapter(adapter: JiuyanSalesChannelAdapter, message: string): void {
  adapter.log?.(adapter.logPrefix ? `${adapter.logPrefix}: ${message}` : message);
}

function isRetryableFileSendError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /status code 500/i.test(message) ||
    /internal server error/i.test(message) ||
    /\b40009\b/.test(message) ||
    /timeout/i.test(message)
  );
}

async function delayMs(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendJiuyanFileWithRetry(params: {
  adapter: JiuyanSalesChannelAdapter;
  file: { path: string; fileName: string };
  logContext: string;
}): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await params.adapter.sendFile(params.file);
      if (attempt > 1) {
        logWithAdapter(
          params.adapter,
          `${params.logContext}: file send recovered on retry ${attempt}/2`,
        );
      }
      return;
    } catch (error) {
      lastError = error;
      if (attempt >= 2 || !isRetryableFileSendError(error)) {
        throw error;
      }
      logWithAdapter(
        params.adapter,
        `${params.logContext}: transient file send failure on attempt ${attempt}/2, retrying: ${String(error)}`,
      );
      await delayMs(1200);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function handleJiuyanForecastingMessage(params: {
  content: string;
  adapter: JiuyanSalesChannelAdapter;
}): Promise<boolean> {
  const request = parseForecastingWorkflowRequest(params.content);
  if (!request) {
    return false;
  }

  if (request.action === "latest_predict") {
    const latestExcelPath = findLatestPredictExcelPath(resolveJiuyanSalesRuntimePaths().modelRoot);
    if (!latestExcelPath) {
      await params.adapter.sendText("还没有可回传的生产推理 Excel，请先跑一次生产推理。");
      return true;
    }
    await params.adapter.sendText("已找到最新的生产推理结果，正在回传 Excel。");
    await sendJiuyanFileWithRetry({
      adapter: params.adapter,
      file: {
        path: latestExcelPath,
        fileName: path.basename(latestExcelPath),
      },
      logContext: "latest predict file send",
    });
    logWithAdapter(params.adapter, `latest predict file sent: file=${latestExcelPath}`);
    return true;
  }

  const jobId = `forecasting-${request.action}-${Date.now()}`;
  await params.adapter.sendText(
    `已开始执行 Forecasting ${request.label}，完成后我会把结果文件发回给你。`,
  );
  logWithAdapter(
    params.adapter,
    `forecasting workflow requested (${jobId}): action=${request.action}`,
  );
  void executeForecastingJob(request, jobId)
    .then(async ({ result }) => {
      logWithAdapter(
        params.adapter,
        `forecasting workflow json (${jobId}): ${JSON.stringify(result)}`,
      );
      await params.adapter.sendText(`Forecasting ${request.label}已完成，正在回传结果文件。`);
      for (const attachment of result.attachments ?? []) {
        try {
          await sendJiuyanFileWithRetry({
            adapter: params.adapter,
            file: {
              path: attachment.path,
              fileName: attachment.file_name,
            },
            logContext: `forecasting workflow file send (${jobId})`,
          });
          logWithAdapter(
            params.adapter,
            `forecasting workflow file sent (${jobId}): file=${attachment.path}`,
          );
        } catch (error) {
          logWithAdapter(
            params.adapter,
            `forecasting workflow file send failed (${jobId}): ${String(error)}`,
          );
          await params.adapter.sendText(
            `Forecasting ${request.label}已完成，但文件回传失败：${String(error)}`,
          );
        }
      }
    })
    .catch(async (error) => {
      logWithAdapter(params.adapter, `forecasting workflow failed (${jobId}): ${String(error)}`);
      await params.adapter.sendText(
        `Forecasting ${request.label}失败：${error instanceof Error ? error.message : String(error)}`,
      );
    });
  return true;
}

export async function executeForecastingJob(
  request: Exclude<ForecastingWorkflowRequest, { action: "latest_predict" }>,
  jobId = `forecasting-${request.action}-${Date.now()}-${randomUUID().slice(0, 8)}`,
): Promise<PythonJobCompletion<ForecastingJobResult>> {
  const runtimePaths = resolveJiuyanSalesRuntimePaths();
  return runJsonPythonJob<ForecastingJobResult>({
    scriptPath: runtimePaths.forecastingScriptPath,
    cwd: runtimePaths.modelRoot,
    args: ["--action", request.action, "--job-id", jobId],
    pythonMissingMessage: "未找到可执行的 Python。",
    env: {
      OPENCLAW_JIUYAN_SALES_DB_PATH: runtimePaths.dbPath,
    },
    missingPaths: [
      { path: runtimePaths.modelRoot, message: `模型目录不存在：${runtimePaths.modelRoot}` },
    ],
  });
}

export function findLatestPredictExcelPath(
  modelRoot = resolveJiuyanSalesRuntimePaths().modelRoot,
): string | null {
  const outputDir = path.join(modelRoot, "outputs", "final");
  if (!fs.existsSync(outputDir)) {
    return null;
  }
  const files = fs
    .readdirSync(outputDir)
    .filter((fileName) => /^results-.*-predict-forecast-export-.*\.xlsx$/u.test(fileName))
    .map((fileName) => {
      const fullPath = path.join(outputDir, fileName);
      return { fullPath, mtimeMs: fs.statSync(fullPath).mtimeMs };
    })
    .toSorted((a, b) => b.mtimeMs - a.mtimeMs);
  return files[0]?.fullPath ?? null;
}

export function parseFormulaForecastRequest(content: string): FormulaForecastRequest | null {
  const normalized = normalizeFormulaRequestText(content);
  const legacyMatch = LEGACY_FORMULA_TRIGGER_RE.exec(normalized);
  let horizonMonths: number;
  let topK: number;
  let formulaText: string;
  const productCategory = extractFormulaForecastProductCategory(normalized);
  const topBasis = extractFormulaForecastTopBasis(normalized);
  const scopeMode = extractFormulaForecastScopeMode(normalized);
  const targetTurnoverDaysMatch = normalized.match(/库存计划量可周转天数\s*(\d{1,3})\s*天?/u);
  const targetTurnoverDays = Number.parseInt(
    targetTurnoverDaysMatch?.[1] ?? String(DEFAULT_FORMULA_FORECAST_TARGET_TURNOVER_DAYS),
    10,
  );

  if (legacyMatch?.groups) {
    horizonMonths = Number.parseInt(legacyMatch.groups.months, 10);
    topK = Number.parseInt(legacyMatch.groups.topk, 10);
    formulaText = legacyMatch.groups.formula.trim();
  } else {
    if (!NATURAL_FORMULA_TRIGGER_RE.test(normalized)) {
      return null;
    }
    const monthsMatch = normalized.match(/未来\s*(\d{1,2})\s*个?月/u);
    horizonMonths = Number.parseInt(
      monthsMatch?.[1] ?? String(DEFAULT_FORMULA_FORECAST_MONTHS),
      10,
    );
    const topKMatch = normalized.match(
      /(?:top|前)\s*(\d{1,4})(?:\s*个)?(?:\s*的?\s*[\u4e00-\u9fa5a-z0-9]+)*(?:\s*sku)?/iu,
    );
    topK = Number.parseInt(topKMatch?.[1] ?? String(DEFAULT_FORMULA_FORECAST_TOP_K), 10);
    formulaText = inferNaturalLanguageFormulaText(normalized);
  }

  if (!Number.isFinite(horizonMonths) || !Number.isFinite(topK) || !formulaText) {
    return null;
  }
  return {
    formulaText,
    normalizedFormula: normalizeFormulaText(formulaText),
    horizonMonths: Math.min(Math.max(horizonMonths, 1), 24),
    topK: Math.min(Math.max(topK, 1), 2000),
    targetTurnoverDays: Math.min(Math.max(targetTurnoverDays, 1), 365),
    productCategory,
    topBasis,
    scopeMode,
  };
}

function extractFormulaForecastScopeMode(normalized: string): FormulaForecastRequest["scopeMode"] {
  if (
    /(文件|附件|表)中(?:的)?\s*sku/iu.test(normalized) ||
    /(文件|附件|表)中的是\s*sku/iu.test(normalized) ||
    /(文件|附件|表)里(?:的)?\s*sku/iu.test(normalized) ||
    /(文件|附件|表)里的是\s*sku/iu.test(normalized) ||
    /(文件|附件|表).*(?:中|里的?)\s*sku/iu.test(normalized) ||
    /sku.*(文件|附件|表).*(?:中|里的?)/iu.test(normalized)
  ) {
    return "attachment_excel";
  }
  return "top";
}

function extractFormulaForecastProductCategory(normalized: string): string | undefined {
  return JIUYAN_PRODUCT_CATEGORIES.find((category) => normalized.includes(category));
}

function extractFormulaForecastTopBasis(normalized: string): FormulaForecastRequest["topBasis"] {
  if (/历史销量/u.test(normalized)) {
    return "all_time";
  }
  if (/近\s*1\s*年销量/u.test(normalized) || /近一年销量/u.test(normalized)) {
    return "trailing_12_months";
  }
  if (/上个月销量/u.test(normalized)) {
    return "latest_complete_month";
  }
  if (/昨天销量/u.test(normalized)) {
    return "latest_day";
  }
  return DEFAULT_FORMULA_FORECAST_TOP_BASIS;
}

function inferNaturalLanguageFormulaText(normalized: string): string {
  const hasExplicitFormulaHint =
    /(环比|最近值)/u.test(normalized) ||
    /(同比|去年同期|全年同比)/u.test(normalized) ||
    /最近\d{1,2}个月(?:平均|总)?销量/u.test(normalized) ||
    /上个月销量/u.test(normalized);
  const explicitWeightMatch = normalized.match(/各\s*(\d+(?:\.\d+)?)\s*的?权重/u);
  if (/(环比|最近值)/u.test(normalized) && /(同比|去年同期|全年同比)/u.test(normalized)) {
    const weight = Number.parseFloat(explicitWeightMatch?.[1] ?? "0.5");
    if (Number.isFinite(weight) && weight >= 0 && weight <= 1) {
      const otherWeight = Number((1 - weight).toFixed(6));
      return `最近一个月销量*${weight} + m12*${otherWeight}`;
    }
    return "最近一个月销量*0.5 + m12*0.5";
  }
  if (/(同比|去年同期|全年同比)/u.test(normalized)) {
    return "m12";
  }
  if (/(环比|最近值)/u.test(normalized)) {
    return "最近一个月销量";
  }
  if (!hasExplicitFormulaHint) {
    return DEFAULT_FORMULA_FORECAST_TEXT;
  }
  return "最近一个月销量";
}

export async function executeFormulaForecastJob(
  request: FormulaForecastRequest,
  jobId = `formula-forecast-${Date.now()}-${randomUUID().slice(0, 8)}`,
): Promise<PythonJobCompletion<FormulaForecastJobResult>> {
  const runtimePaths = resolveJiuyanSalesRuntimePaths();
  return runJsonPythonJob<FormulaForecastJobResult>({
    scriptPath: runtimePaths.formulaForecastScriptPath,
    cwd: runtimePaths.modelRoot,
    args: [
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
      "--target-turnover-days",
      String(request.targetTurnoverDays),
      "--top-basis",
      request.topBasis,
      ...(request.skuListExcelPath ? ["--sku-list-excel", request.skuListExcelPath] : []),
      ...(request.productCategory ? ["--product-category", request.productCategory] : []),
      "--job-id",
      jobId,
    ],
    pythonMissingMessage: `当前 gateway 运行环境未找到可执行的 Python。已尝试：${listJiuyanSalesPythonCandidates().join(", ")}`,
    missingPaths: [
      { path: runtimePaths.modelRoot, message: `模型目录不存在：${runtimePaths.modelRoot}` },
      { path: runtimePaths.dbPath, message: `销量数据库不存在：${runtimePaths.dbPath}` },
    ],
  });
}

function formatFormulaForecastScope(request: FormulaForecastRequest): string {
  if (request.scopeMode === "attachment_excel") {
    return `文件中的 SKU，未来 ${request.horizonMonths} 个月`;
  }
  const scopeParts = [
    `${FORMULA_FORECAST_TOP_BASIS_LABELS[request.topBasis]} Top ${request.topK} SKU`,
    `未来 ${request.horizonMonths} 个月`,
  ];
  if (request.productCategory) {
    scopeParts.unshift(request.productCategory);
  }
  return scopeParts.join("，");
}

export function parseScheduleWorkbookRequest(content: string): ScheduleWorkbookRequest | null {
  const normalized = normalizeText(content);
  if (!/更新|刷新|生成|重做|重算|同步/u.test(normalized)) {
    return null;
  }
  if (!/(计划排单表|排单表|常规鱼钩)/u.test(normalized)) {
    return null;
  }
  return {
    workbookLabel: "常规鱼钩计划排单表",
  };
}

export async function executeScheduleWorkbookJob(
  request: ScheduleWorkbookRequest,
  jobId = `schedule-workbook-${Date.now()}-${randomUUID().slice(0, 8)}`,
): Promise<PythonJobCompletion<ScheduleWorkbookJobResult>> {
  const runtimePaths = resolveJiuyanSalesRuntimePaths();
  return runJsonPythonJob<ScheduleWorkbookJobResult>({
    scriptPath: runtimePaths.scheduleWorkbookScriptPath,
    cwd: runtimePaths.modelRoot,
    args: [
      "--db",
      runtimePaths.dbPath,
      "--source-workbook",
      runtimePaths.scheduleWorkbookSourcePath,
      "--plan-workbook",
      runtimePaths.scheduleWorkbookPath,
      "--job-id",
      jobId,
    ],
    pythonMissingMessage: `当前 gateway 运行环境未找到可执行的 Python。已尝试：${listJiuyanSalesPythonCandidates().join(", ")}`,
    missingPaths: [
      { path: runtimePaths.modelRoot, message: `模型目录不存在：${runtimePaths.modelRoot}` },
      { path: runtimePaths.dbPath, message: `销量数据库不存在：${runtimePaths.dbPath}` },
      {
        path: runtimePaths.scheduleWorkbookSourcePath,
        message: `排单表数据源不存在：${runtimePaths.scheduleWorkbookSourcePath}`,
      },
      {
        path: runtimePaths.scheduleWorkbookPath,
        message: `计划排单表不存在：${runtimePaths.scheduleWorkbookPath}`,
      },
    ],
  });
}

export async function handleJiuyanScheduleWorkbookMessage(params: {
  content: string;
  adapter: JiuyanSalesChannelAdapter;
}): Promise<boolean> {
  const request = parseScheduleWorkbookRequest(params.content);
  if (!request) {
    return false;
  }
  const jobId = `schedule-workbook-${Date.now()}`;
  await params.adapter.sendText(
    `已开始用当前数据库刷新 ${request.workbookLabel}，完成后我会把更新后的 Excel 回传给你。`,
  );
  logWithAdapter(
    params.adapter,
    `schedule workbook requested (${jobId}): ${request.workbookLabel}`,
  );
  void executeScheduleWorkbookJob(request, jobId)
    .then(async ({ result }) => {
      logWithAdapter(
        params.adapter,
        `schedule workbook json (${jobId}): ${JSON.stringify(result)}`,
      );
      await params.adapter.sendText(
        `排单表已刷新，正在回传 Excel。\n数据截止：${result.latest_date}\n更新 SKU 数：${result.updated_sku_count}`,
      );
      try {
        await sendJiuyanFileWithRetry({
          adapter: params.adapter,
          file: {
            path: result.file_path,
            fileName: result.file_name,
          },
          logContext: `schedule workbook file send (${jobId})`,
        });
        logWithAdapter(
          params.adapter,
          `schedule workbook file sent (${jobId}): file=${result.file_path}`,
        );
      } catch (error) {
        logWithAdapter(
          params.adapter,
          `schedule workbook file send failed (${jobId}): ${String(error)}`,
        );
        await params.adapter.sendText(`排单表已刷新，但 Excel 回传失败：${String(error)}`);
      }
    })
    .catch(async (error) => {
      const message = error instanceof Error ? error.message : String(error);
      logWithAdapter(params.adapter, `schedule workbook failed (${jobId}): ${message}`);
      await params.adapter.sendText(
        message.includes("Python")
          ? `排单表刷新失败。\n原因：${message}\n已尝试 Python 路径：${listJiuyanSalesPythonCandidates().join(", ")}`
          : `排单表刷新失败。\n原因：${message}`,
      );
    });
  return true;
}

export async function handleJiuyanFormulaForecastMessage(params: {
  content: string;
  attachments?: readonly SalesAttachmentLike[];
  adapter: JiuyanSalesChannelAdapter;
}): Promise<boolean> {
  const request = parseFormulaForecastRequest(params.content);
  if (!request) {
    return false;
  }
  if (request.scopeMode === "attachment_excel") {
    const excelAttachment = pickSalesExcelAttachment(params.attachments ?? []);
    if (!excelAttachment) {
      await params.adapter.sendText(
        "没有检测到 Excel 附件。请直接发送 Excel，或回复一个 Excel 文件并附上“公式计算销量 文件中的 sku”。",
      );
      return true;
    }
    request.skuListExcelPath = excelAttachment.path;
  }
  const jobId = `formula-forecast-${Date.now()}`;
  await params.adapter.sendText(
    `已开始按公式计算销量。\n公式：${request.formulaText}\n范围：${formatFormulaForecastScope(request)}\n库存计划量可周转天数：${request.targetTurnoverDays} 天\n计算完成后我会把 Excel 回传给你。`,
  );
  logWithAdapter(
    params.adapter,
    `formula forecast requested (${jobId}): formula="${request.formulaText}", normalized="${request.normalizedFormula}", months=${request.horizonMonths}, topK=${request.topK}, targetTurnoverDays=${request.targetTurnoverDays}, productCategory="${request.productCategory ?? ""}"`,
  );
  void executeFormulaForecastJob(request, jobId)
    .then(async ({ result }) => {
      logWithAdapter(params.adapter, `formula forecast json (${jobId}): ${JSON.stringify(result)}`);
      await params.adapter.sendText(
        `公式预测已完成，正在回传 Excel。\n公式：${request.formulaText}\n范围：${formatFormulaForecastScope(request)}\n库存计划量可周转天数：${request.targetTurnoverDays} 天\n历史截止：${result.latest_month}`,
      );
      try {
        await sendJiuyanFileWithRetry({
          adapter: params.adapter,
          file: {
            path: result.file_path,
            fileName: result.file_name,
          },
          logContext: `formula forecast file send (${jobId})`,
        });
        logWithAdapter(
          params.adapter,
          `formula forecast file sent (${jobId}): file=${result.file_path}`,
        );
      } catch (error) {
        logWithAdapter(
          params.adapter,
          `formula forecast file send failed (${jobId}): ${String(error)}`,
        );
        await params.adapter.sendText(`公式预测已完成，但 Excel 回传失败：${String(error)}`);
      }
    })
    .catch(async (error) => {
      const message = error instanceof Error ? error.message : String(error);
      logWithAdapter(params.adapter, `formula forecast failed (${jobId}): ${message}`);
      await params.adapter.sendText(
        message.includes("Python")
          ? `公式预测失败。\n原因：${message}\n已尝试 Python 路径：${listJiuyanSalesPythonCandidates().join(", ")}`
          : `公式预测失败。\n公式：${request.formulaText}\n原因：${message}`,
      );
    });
  return true;
}

export function parseSalesImportRequest(content: string): boolean {
  const normalized = normalizeText(content);
  return (
    /(导入|入库|写入|更新)/u.test(normalized) && /(excel|xlsx|表格|数据库|sales)/iu.test(normalized)
  );
}

export function formatMissingSalesFields(fields: string[]): string[] {
  return fields.map((field) => SALES_FIELD_LABELS[field] ?? field);
}

export function isSalesExcelAttachment(media: SalesAttachmentLike): boolean {
  const ext = path.extname(media.path).toLowerCase();
  const fileNameExt = path.extname(media.fileName ?? "").toLowerCase();
  if (ext === ".xlsx" || ext === ".xls" || fileNameExt === ".xlsx" || fileNameExt === ".xls") {
    return true;
  }
  return Boolean(
    media.contentType?.includes("spreadsheet") || media.contentType?.includes("excel"),
  );
}

export async function executeSalesImportJob(
  excelPath: string,
  jobId = `sales-import-${Date.now()}-${randomUUID().slice(0, 8)}`,
): Promise<PythonJobCompletion<SalesImportResult>> {
  const runtimePaths = resolveJiuyanSalesRuntimePaths();
  return runJsonPythonJob<SalesImportResult>({
    scriptPath: runtimePaths.salesImportScriptPath,
    cwd: runtimePaths.modelRoot,
    args: ["--excel-path", excelPath, "--job-id", jobId, "--db-path", runtimePaths.dbPath],
    pythonMissingMessage: "未找到可执行的 Python。",
    env: {
      OPENCLAW_JIUYAN_SALES_DB_PATH: runtimePaths.dbPath,
    },
    missingPaths: [
      { path: runtimePaths.modelRoot, message: `模型目录不存在：${runtimePaths.modelRoot}` },
    ],
  });
}

function pickSalesExcelAttachment(
  attachments: readonly SalesAttachmentLike[],
): SalesAttachmentLike | null {
  for (const attachment of attachments) {
    if (isSalesExcelAttachment(attachment)) {
      return attachment;
    }
  }
  return null;
}

export async function handleJiuyanSalesImportMessage(params: {
  content: string;
  attachments: readonly SalesAttachmentLike[];
  adapter: JiuyanSalesChannelAdapter;
}): Promise<boolean> {
  if (!parseSalesImportRequest(params.content)) {
    return false;
  }
  const excelAttachment = pickSalesExcelAttachment(params.attachments);
  if (!excelAttachment) {
    await params.adapter.sendText(
      "没有检测到 Excel 附件。请直接发送 Excel，或回复一个 Excel 文件并附上导入指令。",
    );
    return true;
  }
  const jobId = `sales-import-${Date.now()}`;
  await params.adapter.sendText("已开始检查 Excel 字段并导入 sales 数据库。");
  logWithAdapter(
    params.adapter,
    `sales import requested (${jobId}): excel=${excelAttachment.path}`,
  );
  void executeSalesImportJob(excelAttachment.path, jobId)
    .then(async ({ result }) => {
      if (result.status === "missing_fields") {
        await params.adapter.sendText(
          `Excel 缺少 sales 表必要字段：${formatMissingSalesFields(result.missing_fields).join("、")}`,
        );
        return;
      }
      if (result.status === "error") {
        await params.adapter.sendText(`Excel 导入失败：${result.message}`);
        return;
      }
      await params.adapter.sendText(summarizeSalesImportResult(result));
    })
    .catch(async (error) => {
      const message = error instanceof Error ? error.message : String(error);
      logWithAdapter(params.adapter, `sales import failed (${jobId}): ${message}`);
      await params.adapter.sendText(`Excel 导入失败：${message}`);
    });
  return true;
}

export function summarizeSalesImportResult(
  result: Extract<SalesImportResult, { status: "imported" }>,
): string {
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
  const latestMetricNotes = [
    result.latest_inventory_updated_sku_count
      ? `最新库存已更新 SKU 数：${result.latest_inventory_updated_sku_count}`
      : null,
    result.latest_in_transit_updated_sku_count
      ? `最新在途已更新 SKU 数：${result.latest_in_transit_updated_sku_count}`
      : null,
  ].filter(Boolean);
  const latestMetricNote = latestMetricNotes.length > 0 ? `\n${latestMetricNotes.join("\n")}` : "";
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
              item.applied_tags?.length ? `tags=${item.applied_tags.join("|")}` : null,
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
    latestMetricNote +
    newSkuLabelNote
  );
}

function normalizeSqlToken(input: string): string {
  return input.replace(/[^a-z0-9_(), *.+/<>=-]/giu, "").trim();
}

function formatNumber(value: number, forceTwoDecimals: boolean): string {
  if (!Number.isFinite(value)) {
    return "0";
  }
  if (!forceTwoDecimals && Number.isInteger(value)) {
    return String(value);
  }
  const normalized = value.toFixed(2);
  return normalized.replace(/\.00$/u, "").replace(/(\.\d)0$/u, "$1");
}

function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseIsoDate(dateText: string): Date | null {
  const match = dateText.match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  if (!match) {
    return null;
  }
  const candidate = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00`);
  return Number.isNaN(candidate.getTime()) ? null : candidate;
}

function currentYear(): number {
  return new Date().getFullYear();
}

function resolveYearMonth(yearText: string | undefined, monthText: string): string | null {
  const month = Number(monthText);
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    return null;
  }
  if (!yearText) {
    return `${currentYear()}-${String(month).padStart(2, "0")}`;
  }
  let year = Number(yearText);
  if (!Number.isInteger(year)) {
    return null;
  }
  if (year < 100) {
    year += 2000;
  }
  return `${year}-${String(month).padStart(2, "0")}`;
}

function resolveYear(yearText: string): string | null {
  let year = Number(yearText);
  if (!Number.isInteger(year)) {
    return null;
  }
  if (year < 100) {
    year += 2000;
  }
  if (year < 2000 || year > 2099) {
    return null;
  }
  return String(year);
}

function resolveSpecificDate(
  yearText: string | undefined,
  monthText: string,
  dayText: string,
): string | null {
  const month = Number(monthText);
  const day = Number(dayText);
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    return null;
  }
  if (!Number.isInteger(day) || day < 1 || day > 31) {
    return null;
  }
  const year = yearText ? resolveYear(yearText) : String(currentYear());
  if (!year) {
    return null;
  }
  const normalized = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return parseIsoDate(normalized) ? normalized : null;
}

function resolvePreviousWeekdayDate(weekdayText: string): string {
  const weekdayMap: Record<string, number> = {
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    日: 0,
    天: 0,
  };
  const targetWeekday = weekdayMap[weekdayText];
  const now = new Date();
  const mondayBasedOffset = (now.getDay() + 6) % 7;
  const monday = new Date(now);
  monday.setDate(now.getDate() - mondayBasedOffset);
  const lastWeekTarget = new Date(monday);
  lastWeekTarget.setDate(monday.getDate() - 7 + ((targetWeekday + 6) % 7));
  return formatDate(lastWeekTarget);
}

function parseTimeRange(normalized: string): QueryTimeRange | null {
  const hyphenDateMatch = normalized.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/u);
  if (hyphenDateMatch) {
    const date = resolveSpecificDate(hyphenDateMatch[1], hyphenDateMatch[2], hyphenDateMatch[3]);
    if (date) {
      return { kind: "specific_date", date, label: date };
    }
  }
  const chineseDateMatch = normalized.match(
    /(?:(\d{2,4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/u,
  );
  if (chineseDateMatch) {
    const date = resolveSpecificDate(chineseDateMatch[1], chineseDateMatch[2], chineseDateMatch[3]);
    if (date) {
      return { kind: "specific_date", date, label: date };
    }
  }
  const monthMatch = normalized.match(/(?:(\d{2,4})\s*年\s*)?(\d{1,2})\s*月/u);
  if (monthMatch) {
    const month = resolveYearMonth(monthMatch[1], monthMatch[2]);
    if (month) {
      return { kind: "specific_month", month, label: `${month} 月` };
    }
  }
  const lastWeekdayMatch = normalized.match(/上周([一二三四五六日天])/u);
  if (lastWeekdayMatch) {
    return {
      kind: "specific_date",
      date: resolvePreviousWeekdayDate(lastWeekdayMatch[1]),
      label: `上周${lastWeekdayMatch[1]}`,
    };
  }
  if (/上周/u.test(normalized)) {
    return { kind: "previous_calendar_week", label: "上周" };
  }
  if (/(最近|最新).*(一天|1天)/u.test(normalized)) {
    return { kind: "latest_day", label: "最近一天" };
  }
  if (/昨天/u.test(normalized)) {
    return { kind: "latest_minus_days", days: 1, label: "昨天" };
  }
  const recentYearsMatch = normalized.match(/(?:最近|近|过去)\s*(\d{1,2}|一|两)\s*年/u);
  if (recentYearsMatch) {
    const rawYears = recentYearsMatch[1];
    const years = rawYears === "一" ? 1 : rawYears === "两" ? 2 : Number.parseInt(rawYears, 10);
    if (Number.isInteger(years) && years >= 1) {
      const months = Math.min(years * 12, 24);
      return {
        kind: "last_n_months",
        months,
        label: `最近 ${months} 个月`,
      };
    }
  }
  const recentMonthsMatch = normalized.match(/(?:最近|近)\s*(\d{1,2})\s*(?:个)?月/u);
  if (recentMonthsMatch) {
    const months = Number.parseInt(recentMonthsMatch[1], 10);
    if (Number.isInteger(months) && months >= 1) {
      return {
        kind: "last_n_months",
        months: Math.min(months, 24),
        label: `最近 ${Math.min(months, 24)} 个月`,
      };
    }
  }
  if (/(最近|近)(一周|7天)/u.test(normalized)) {
    return { kind: "last_n_days", days: 7, label: "最近 7 天" };
  }
  const yearMatch = normalized.match(/(\d{2,4})\s*年/u);
  if (yearMatch) {
    const year = resolveYear(yearMatch[1]);
    if (year) {
      return { kind: "specific_year", year, label: `${year} 年` };
    }
  }
  return null;
}

function parseDimension(normalized: string): QueryDimension | undefined {
  if (/(SKU|sku|商品编码|条码|单品)/u.test(normalized)) {
    return "sku";
  }
  if (/省份|哪个省|哪省/u.test(normalized)) {
    return "province";
  }
  if (/城市|哪个市|哪座城市/u.test(normalized)) {
    return "city";
  }
  if (/平台|渠道|站点/u.test(normalized)) {
    return "platform";
  }
  if (/店铺|店/u.test(normalized)) {
    return "shop";
  }
  if (/品类|分类/u.test(normalized)) {
    return "product_category";
  }
  return undefined;
}

function parseMetric(normalized: string): QueryMetric | null {
  if (
    /(记录数|记录总数|总记录数|总共有多少条记录|多少条记录|多少条数据|数据条数|总条数|总行数|行数)/u.test(
      normalized,
    )
  ) {
    return "record_count";
  }
  if (/(活跃).*(SKU|sku)/u.test(normalized)) {
    return "active_sku_count";
  }
  if (/销售额|销售金额|成交额|已付金额/u.test(normalized)) {
    return "total_paid_amount";
  }
  if (/均价|平均基本售价/u.test(normalized)) {
    return "avg_base_price";
  }
  if (/平均吊牌价|吊牌均价/u.test(normalized)) {
    return "avg_list_price";
  }
  if (/(销量|销售数量|总量|卖了多少|卖得|卖的|总和|总共|合计|汇总|综合)/u.test(normalized)) {
    return "total_qty";
  }
  return null;
}

function parseLimit(normalized: string): number | undefined {
  const match = normalized.match(/(?:top|前)\s*(\d{1,3})/iu);
  if (!match) {
    return undefined;
  }
  const limit = Number(match[1]);
  if (!Number.isInteger(limit) || limit < 1) {
    return undefined;
  }
  return Math.min(limit, 50);
}

function parseAnomalyDimensions(normalized: string): QueryDimension[] {
  const dimensions: QueryDimension[] = [];
  if (/(SKU|sku|单品)/u.test(normalized)) {
    dimensions.push("sku");
  }
  if (/省份|哪个省|哪省/u.test(normalized)) {
    dimensions.push("province");
  }
  if (/城市|哪个市|哪座城市/u.test(normalized)) {
    dimensions.push("city");
  }
  if (/平台|渠道|站点/u.test(normalized)) {
    dimensions.push("platform");
  }
  return dimensions;
}

function shouldIgnoreSalesDbQuery(normalized: string): boolean {
  return (
    /(发我|给我|回我|把).*(文件|excel|xlsx|预测结果|推理结果)/iu.test(normalized) ||
    /((生产)?推理|(生产)?推断|(生产)?预测|回测|训练)/u.test(normalized)
  );
}

function buildSalesDbQueryPlan(content: string): SalesDbQueryPlan | null {
  const normalized = normalizeText(content);
  if (shouldIgnoreSalesDbQuery(normalized)) {
    return null;
  }
  if (
    /((数据库|sales).*(记录数|记录总数|总记录数|总共有多少条记录|多少条记录|多少条数据|数据条数|总条数|总行数|行数))|((记录数|记录总数|总记录数|总共有多少条记录|多少条记录|多少条数据|数据条数|总条数|总行数|行数).*(数据库|sales))/u.test(
      normalized,
    )
  ) {
    return {
      normalized,
      intent: "aggregate",
      metric: "record_count",
      timeRange: { kind: "all_time", label: "全部数据" },
    };
  }
  if (
    /((数据库|sales).*(时间范围|数据范围|日期范围|起止|覆盖范围))|((时间范围|数据范围|日期范围).*(数据库|sales))/u.test(
      normalized,
    )
  ) {
    return { normalized, intent: "date_range" };
  }
  if (
    /((数据库|sales).*(最新|最近).*(哪天|日期|时间|到哪天|截止))|((最新|最近).*(数据|销量数据|销售数据).*(哪天|日期|时间|到哪天|截止))/u.test(
      normalized,
    )
  ) {
    return { normalized, intent: "latest_date" };
  }
  if (/分析/u.test(normalized) && /异常/u.test(normalized)) {
    const anomalyMonthsMatch = normalized.match(/(?:最近|近)\s*(\d{1,2})\s*(?:个)?月/u);
    const months = anomalyMonthsMatch ? Number.parseInt(anomalyMonthsMatch[1], 10) : 3;
    const dimensions = parseAnomalyDimensions(normalized);
    return {
      normalized,
      intent: "anomaly_summary",
      metric: parseMetric(normalized) ?? "total_qty",
      months: Number.isInteger(months) && months >= 2 ? Math.min(months, 12) : 3,
      dimensions: dimensions.length > 0 ? dimensions : ["sku", "province", "platform"],
      topN: 3,
      label: `最近 ${Number.isInteger(months) && months >= 2 ? Math.min(months, 12) : 3} 个月`,
    };
  }
  const newSkuMonthMatch = normalized.match(
    /(?:(\d{2,4})\s*年\s*)?(\d{1,2})\s*月.*(才有|新增|新上|首次出现).*(SKU|sku)/u,
  );
  if (newSkuMonthMatch) {
    const month = resolveYearMonth(newSkuMonthMatch[1], newSkuMonthMatch[2]);
    if (month) {
      return { normalized, intent: "new_sku_count", month, label: `${month} 月` };
    }
  }

  const metric = parseMetric(normalized);
  const dimension = parseDimension(normalized);
  if (!metric) {
    return null;
  }
  const currentVsPreviousMonth =
    /(这个月|本月)/u.test(normalized) &&
    /上个月/u.test(normalized) &&
    /(增长|变化|提升|下降|环比|多少)/u.test(normalized);
  if (currentVsPreviousMonth) {
    return {
      normalized,
      intent: "period_change",
      metric,
      currentWindow: { kind: "calendar_month", offsetMonths: 0, label: "这个月" },
      previousWindow: { kind: "calendar_month", offsetMonths: 1, label: "上个月" },
    };
  }
  const lastMonthChange =
    /上个月/u.test(normalized) && /(增长|变化|提升|下降|环比)/u.test(normalized);
  if (lastMonthChange) {
    return {
      normalized,
      intent: "period_change",
      metric,
      dimension,
      wantsRanking:
        /哪个|哪家|哪座|最高|最多|最大|最好|最佳|top|前/u.test(normalized) &&
        dimension !== undefined,
      limit: 1,
      currentWindow: { kind: "calendar_month", offsetMonths: 1, label: "上个月" },
      previousWindow: { kind: "calendar_month", offsetMonths: 2, label: "上上个月" },
    };
  }
  const rollingDaysCompareMatch = normalized.match(
    /最近\s*(\d{1,2})\s*天.*前\s*\1\s*天.*(变化|增长|下降|环比|多少)/u,
  );
  if (rollingDaysCompareMatch) {
    const days = Number.parseInt(rollingDaysCompareMatch[1], 10);
    if (Number.isInteger(days) && days >= 1) {
      return {
        normalized,
        intent: "period_change",
        metric,
        currentWindow: { kind: "rolling_days", days, offsetWindows: 0, label: `最近 ${days} 天` },
        previousWindow: { kind: "rolling_days", days, offsetWindows: 1, label: `前 ${days} 天` },
      };
    }
  }
  const timeRange = parseTimeRange(normalized) ?? { kind: "latest_day", label: "最近一天" };
  const wantsRanking =
    /(最高|最多|最大|top|前\d+|排行|排名|哪个|哪家|哪座|最好|最佳)/iu.test(normalized) &&
    dimension !== undefined;
  const wantsGrouping =
    wantsRanking || /(?:按|分)(?:省份|城市|平台|店铺|品类|分类|SKU|sku|单品)/u.test(normalized);
  return {
    normalized,
    intent: "aggregate",
    metric,
    timeRange,
    dimension,
    wantsRanking,
    wantsGrouping,
    limit: wantsRanking ? (parseLimit(normalized) ?? 1) : undefined,
  };
}

function compileSalesDbQueryPlan(plan: SalesDbQueryPlan): SalesDbQueryRequest | null {
  if (plan.intent === "latest_date") {
    return { kind: "latest_date" };
  }
  if (plan.intent === "date_range") {
    return { kind: "date_range" };
  }
  if (plan.intent === "new_sku_count") {
    return plan.month && plan.label
      ? { kind: "new_sku_count", month: plan.month, label: plan.label }
      : null;
  }
  if (plan.intent === "anomaly_summary") {
    return plan.metric && plan.months && plan.dimensions && plan.label
      ? {
          kind: "anomaly_summary",
          metric: plan.metric,
          months: plan.months,
          dimensions: plan.dimensions,
          topN: plan.topN ?? 3,
          label: plan.label,
        }
      : null;
  }
  if (plan.intent === "period_change") {
    return plan.metric && plan.currentWindow && plan.previousWindow
      ? {
          kind: "period_change",
          metric: plan.metric,
          currentWindow: plan.currentWindow,
          previousWindow: plan.previousWindow,
          groupBy: plan.dimension && plan.wantsRanking ? plan.dimension : undefined,
          sortDirection: plan.wantsRanking ? "desc" : undefined,
          limit: plan.wantsRanking ? (plan.limit ?? 1) : undefined,
        }
      : null;
  }
  if (!plan.metric || !plan.timeRange) {
    return null;
  }
  const groupBy =
    plan.dimension && (plan.wantsGrouping || plan.wantsRanking) ? plan.dimension : undefined;
  return {
    kind: "aggregate",
    metric: plan.metric,
    timeRange: plan.timeRange,
    groupBy,
    sortDirection: plan.wantsRanking ? "desc" : undefined,
    limit: plan.wantsRanking ? plan.limit : undefined,
  };
}

export function parseSalesDbQueryRequest(content: string): SalesDbQueryRequest | null {
  const plan = buildSalesDbQueryPlan(content);
  return plan ? compileSalesDbQueryPlan(plan) : null;
}

function loadNodeSqlite(): typeof import("node:sqlite") {
  return require("node:sqlite") as typeof import("node:sqlite");
}

function openSalesDatabase(dbPath: string, readOnly = true) {
  const { DatabaseSync } = loadNodeSqlite();
  const db = new DatabaseSync(dbPath, { readOnly });
  db.exec("PRAGMA busy_timeout = 5000;");
  return db;
}

function readLatestDate(db: ReturnType<typeof openSalesDatabase>): string | null {
  const latestDateRow = db.prepare("SELECT MAX(sale_date) AS latest_date FROM sales").get() as
    | { latest_date?: string | null }
    | undefined;
  return latestDateRow?.latest_date ?? null;
}

function resolveTimeFilter(
  db: ReturnType<typeof openSalesDatabase>,
  timeRange: QueryTimeRange,
): { clause: string; params: string[]; latestDate: string | null; resolvedRangeLabel: string } {
  const latestDate = readLatestDate(db);
  if (timeRange.kind === "all_time") {
    return {
      clause: "1 = 1",
      params: [],
      latestDate,
      resolvedRangeLabel: timeRange.label,
    };
  }
  if (!latestDate) {
    return { clause: "1 = 0", params: [], latestDate: null, resolvedRangeLabel: "无可用日期" };
  }
  if (timeRange.kind === "latest_day") {
    return {
      clause: "sale_date = ?",
      params: [latestDate],
      latestDate,
      resolvedRangeLabel: latestDate,
    };
  }
  if (timeRange.kind === "latest_minus_days") {
    const row = db
      .prepare("SELECT date(?, ?) AS target_date")
      .get(latestDate, `-${timeRange.days} day`) as { target_date?: string | null } | undefined;
    const targetDate = row?.target_date ?? null;
    return {
      clause: "sale_date = ?",
      params: [targetDate ?? ""],
      latestDate,
      resolvedRangeLabel: targetDate ?? "无可用日期",
    };
  }
  if (timeRange.kind === "last_n_days") {
    const row = db
      .prepare("SELECT date(?, ?) AS start_date")
      .get(latestDate, `-${timeRange.days - 1} day`) as { start_date?: string | null } | undefined;
    const startDate = row?.start_date ?? null;
    return {
      clause: "sale_date BETWEEN ? AND ?",
      params: [startDate ?? "", latestDate],
      latestDate,
      resolvedRangeLabel: startDate ? `${startDate} 到 ${latestDate}` : latestDate,
    };
  }
  if (timeRange.kind === "previous_calendar_week") {
    const latest = parseIsoDate(latestDate);
    if (!latest) {
      return { clause: "1 = 0", params: [], latestDate, resolvedRangeLabel: "无可用日期" };
    }
    const currentWeekMonday = new Date(latest);
    currentWeekMonday.setDate(latest.getDate() - ((latest.getDay() + 6) % 7));
    const previousWeekMonday = new Date(currentWeekMonday);
    previousWeekMonday.setDate(currentWeekMonday.getDate() - 7);
    const previousWeekSunday = new Date(previousWeekMonday);
    previousWeekSunday.setDate(previousWeekMonday.getDate() + 6);
    const startDate = formatDate(previousWeekMonday);
    const endDate = formatDate(previousWeekSunday);
    return {
      clause: "sale_date BETWEEN ? AND ?",
      params: [startDate, endDate],
      latestDate,
      resolvedRangeLabel: `${startDate} 到 ${endDate}`,
    };
  }
  if (timeRange.kind === "last_n_months") {
    const row = db
      .prepare("SELECT date(?, 'start of month', ?) AS start_date")
      .get(latestDate, `-${timeRange.months - 1} month`) as
      | { start_date?: string | null }
      | undefined;
    const startDate = row?.start_date ?? null;
    const startMonth = startDate?.slice(0, 7) ?? null;
    return {
      clause: "sale_date BETWEEN ? AND ?",
      params: [startDate ?? "", latestDate],
      latestDate,
      resolvedRangeLabel: startMonth
        ? `${startMonth} 到 ${latestDate.slice(0, 7)}`
        : latestDate.slice(0, 7),
    };
  }
  if (timeRange.kind === "specific_date") {
    return {
      clause: "sale_date = ?",
      params: [timeRange.date],
      latestDate,
      resolvedRangeLabel: timeRange.date,
    };
  }
  if (timeRange.kind === "specific_year") {
    return {
      clause: "substr(sale_date, 1, 4) = ?",
      params: [timeRange.year],
      latestDate,
      resolvedRangeLabel: timeRange.year,
    };
  }
  return {
    clause: "substr(sale_date, 1, 7) = ?",
    params: [timeRange.month],
    latestDate,
    resolvedRangeLabel: timeRange.month,
  };
}

function buildAggregateExecutionPlan(
  db: ReturnType<typeof openSalesDatabase>,
  request: AggregateSalesDbQueryRequest,
): QueryExecutionPlan {
  const metric = METRICS[request.metric];
  const timeFilter = resolveTimeFilter(db, request.timeRange);
  if (!request.groupBy) {
    return {
      sql: `SELECT ${normalizeSqlToken(metric.sql)} AS metric_value FROM sales WHERE ${timeFilter.clause}`,
      params: timeFilter.params,
      timeLabel: request.timeRange.label,
      resolvedRangeLabel: timeFilter.resolvedRangeLabel,
    };
  }
  if (request.groupBy === "sku") {
    return {
      sql: [
        "SELECT barcode AS sku_code, COALESCE(NULLIF(product_name, ''), barcode) AS sku_name,",
        `${normalizeSqlToken(metric.sql)} AS metric_value`,
        "FROM sales",
        `WHERE ${timeFilter.clause} AND COALESCE(barcode, '') != ''`,
        "GROUP BY barcode, COALESCE(NULLIF(product_name, ''), barcode)",
        "ORDER BY metric_value DESC, sku_code ASC",
        `LIMIT ${request.limit ?? 1}`,
      ].join(" "),
      params: timeFilter.params,
      timeLabel: request.timeRange.label,
      resolvedRangeLabel: timeFilter.resolvedRangeLabel,
      groupBy: request.groupBy,
      limit: request.limit,
    };
  }
  const dimension = DIMENSIONS[request.groupBy];
  return {
    sql: [
      `SELECT ${dimension.column} AS group_value, ${normalizeSqlToken(metric.sql)} AS metric_value`,
      "FROM sales",
      `WHERE ${timeFilter.clause} AND COALESCE(${dimension.column}, '') != ''`,
      `GROUP BY ${dimension.column}`,
      `ORDER BY metric_value ${request.sortDirection ?? "desc"}, group_value ASC`,
      request.limit ? `LIMIT ${request.limit}` : "",
    ]
      .filter(Boolean)
      .join(" "),
    params: timeFilter.params,
    timeLabel: request.timeRange.label,
    resolvedRangeLabel: timeFilter.resolvedRangeLabel,
    groupBy: request.groupBy,
    limit: request.limit,
  };
}

function resolveCompareWindow(
  db: ReturnType<typeof openSalesDatabase>,
  window: CompareWindow,
): { clause: string; params: string[]; label: string } {
  const latestDate = readLatestDate(db);
  if (!latestDate) {
    return { clause: "1 = 0", params: [], label: "无可用日期" };
  }
  if (window.kind === "calendar_month") {
    const row = db
      .prepare("SELECT strftime('%Y-%m', date(?, 'start of month', ?)) AS target_month")
      .get(latestDate, `-${window.offsetMonths} month`) as
      | { target_month?: string | null }
      | undefined;
    const month = row?.target_month ?? "";
    return {
      clause: "substr(sale_date, 1, 7) = ?",
      params: [month],
      label: month || window.label,
    };
  }
  const endRow = db
    .prepare("SELECT date(?, ?) AS end_date")
    .get(latestDate, `-${window.days * window.offsetWindows} day`) as
    | { end_date?: string | null }
    | undefined;
  const endDate = endRow?.end_date ?? latestDate;
  const startRow = db
    .prepare("SELECT date(?, ?) AS start_date")
    .get(endDate, `-${window.days - 1} day`) as { start_date?: string | null } | undefined;
  const startDate = startRow?.start_date ?? endDate;
  return {
    clause: "sale_date BETWEEN ? AND ?",
    params: [startDate, endDate],
    label: `${startDate} 到 ${endDate}`,
  };
}

function fetchMetricTotal(
  db: ReturnType<typeof openSalesDatabase>,
  metric: QueryMetric,
  filter: { clause: string; params: string[] },
): number {
  const row = db
    .prepare(
      `SELECT ${normalizeSqlToken(METRICS[metric].sql)} AS metric_value FROM sales WHERE ${filter.clause}`,
    )
    .get(...filter.params) as { metric_value?: number | null } | undefined;
  return Number(row?.metric_value ?? 0);
}

function fetchGroupedMetricRows(
  db: ReturnType<typeof openSalesDatabase>,
  metric: QueryMetric,
  groupBy: QueryDimension,
  filter: { clause: string; params: string[] },
): Array<{ key: string; label: string; secondaryLabel?: string; value: number }> {
  if (groupBy === "sku") {
    const rows = db
      .prepare(
        [
          "SELECT barcode AS sku_code, COALESCE(NULLIF(product_name, ''), barcode) AS sku_name,",
          `${normalizeSqlToken(METRICS[metric].sql)} AS metric_value`,
          "FROM sales",
          `WHERE ${filter.clause} AND COALESCE(barcode, '') != ''`,
          "GROUP BY barcode, COALESCE(NULLIF(product_name, ''), barcode)",
        ].join(" "),
      )
      .all(...filter.params) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      key: String((row.sku_code as string | number | null) ?? ""),
      label: String(
        (row.sku_name as string | number | null) ?? (row.sku_code as string | number | null) ?? "",
      ),
      secondaryLabel: String((row.sku_code as string | number | null) ?? ""),
      value: Number(row.metric_value ?? 0),
    }));
  }
  const dimension = DIMENSIONS[groupBy];
  const rows = db
    .prepare(
      [
        `SELECT ${dimension.column} AS group_value, ${normalizeSqlToken(METRICS[metric].sql)} AS metric_value`,
        "FROM sales",
        `WHERE ${filter.clause} AND COALESCE(${dimension.column}, '') != ''`,
        `GROUP BY ${dimension.column}`,
      ].join(" "),
    )
    .all(...filter.params) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    key: String((row.group_value as string | number | null) ?? ""),
    label: String((row.group_value as string | number | null) ?? ""),
    value: Number(row.metric_value ?? 0),
  }));
}

function queryPeriodChange(
  db: ReturnType<typeof openSalesDatabase>,
  request: PeriodChangeSalesDbQueryRequest,
): Extract<SalesDbQueryResult, { kind: "period_change" }> {
  const currentFilter = resolveCompareWindow(db, request.currentWindow);
  const previousFilter = resolveCompareWindow(db, request.previousWindow);
  if (!request.groupBy) {
    const currentValue = fetchMetricTotal(db, request.metric, currentFilter);
    const previousValue = fetchMetricTotal(db, request.metric, previousFilter);
    const changeValue = currentValue - previousValue;
    return {
      kind: "period_change",
      metric: request.metric,
      currentLabel: currentFilter.label,
      previousLabel: previousFilter.label,
      latestDate: readLatestDate(db),
      rows: [
        {
          label: METRICS[request.metric].label,
          currentValue,
          previousValue,
          changeValue,
          changeRate: previousValue === 0 ? null : changeValue / previousValue,
        },
      ],
    };
  }

  const currentRows = fetchGroupedMetricRows(db, request.metric, request.groupBy, currentFilter);
  const previousRows = fetchGroupedMetricRows(db, request.metric, request.groupBy, previousFilter);
  const previousByKey = new Map(previousRows.map((row) => [row.key, row]));
  const merged = currentRows.map((row) => {
    const previousRow = previousByKey.get(row.key);
    const previousValue = previousRow?.value ?? 0;
    const changeValue = row.value - previousValue;
    return {
      label: row.label,
      secondaryLabel: row.secondaryLabel,
      currentValue: row.value,
      previousValue,
      changeValue,
      changeRate: previousValue === 0 ? null : changeValue / previousValue,
    };
  });
  merged.sort(
    (a, b) =>
      b.changeValue - a.changeValue ||
      b.currentValue - a.currentValue ||
      a.label.localeCompare(b.label),
  );
  return {
    kind: "period_change",
    metric: request.metric,
    currentLabel: currentFilter.label,
    previousLabel: previousFilter.label,
    groupBy: request.groupBy,
    latestDate: readLatestDate(db),
    rows: merged.slice(0, request.limit ?? merged.length),
    limit: request.limit,
  };
}

function queryAnomalySummary(
  db: ReturnType<typeof openSalesDatabase>,
  request: AnomalySummarySalesDbQueryRequest,
): Extract<SalesDbQueryResult, { kind: "anomaly_summary" }> {
  const latestDate = readLatestDate(db);
  if (!latestDate) {
    return {
      kind: "anomaly_summary",
      metric: request.metric,
      label: request.label,
      latestDate: null,
      sections: [],
    };
  }
  const latestMonth = latestDate.slice(0, 7);
  const monthRows = db
    .prepare(
      "WITH RECURSIVE seq(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM seq WHERE n + 1 < ?) SELECT strftime('%Y-%m', date(?, 'start of month', printf('-%d month', n))) AS ym FROM seq",
    )
    .all(request.months, latestDate) as Array<{ ym?: string | null }>;
  const months = monthRows.map((row) => row.ym).filter((ym): ym is string => Boolean(ym));

  const sections = request.dimensions.map((dimension) => {
    const monthlyRows = db
      .prepare(
        dimension === "sku"
          ? [
              "SELECT barcode AS group_key, COALESCE(NULLIF(product_name, ''), barcode) AS group_label, substr(sale_date, 1, 7) AS sale_month,",
              `${normalizeSqlToken(METRICS[request.metric].sql)} AS metric_value`,
              "FROM sales",
              `WHERE substr(sale_date, 1, 7) IN (${months.map(() => "?").join(", ")}) AND COALESCE(barcode, '') != ''`,
              "GROUP BY barcode, COALESCE(NULLIF(product_name, ''), barcode), substr(sale_date, 1, 7)",
            ].join(" ")
          : [
              `SELECT ${DIMENSIONS[dimension].column} AS group_key, ${DIMENSIONS[dimension].column} AS group_label, substr(sale_date, 1, 7) AS sale_month,`,
              `${normalizeSqlToken(METRICS[request.metric].sql)} AS metric_value`,
              "FROM sales",
              `WHERE substr(sale_date, 1, 7) IN (${months.map(() => "?").join(", ")}) AND COALESCE(${dimension === "platform" ? DIMENSIONS.platform.column : DIMENSIONS[dimension].column}, '') != ''`,
              `GROUP BY ${dimension === "platform" ? DIMENSIONS.platform.column : DIMENSIONS[dimension].column}, substr(sale_date, 1, 7)`,
            ].join(" "),
      )
      .all(...months) as Array<{
      group_key?: string;
      group_label?: string;
      sale_month?: string;
      metric_value?: number;
    }>;

    const series = new Map<
      string,
      { label: string; secondaryLabel?: string; values: Map<string, number> }
    >();
    for (const row of monthlyRows) {
      const key = String((row.group_key as string | number | null) ?? "");
      const entry = series.get(key) ?? {
        label: String((row.group_label as string | number | null) ?? key),
        secondaryLabel: dimension === "sku" ? key : undefined,
        values: new Map(),
      };
      entry.values.set(
        String((row.sale_month as string | number | null) ?? ""),
        Number(row.metric_value ?? 0),
      );
      series.set(key, entry);
    }
    const ranked = [...series.values()]
      .map((entry) => {
        const baselineMonths = months.filter((month) => month !== latestMonth);
        const baselineValues = baselineMonths.map((month) => entry.values.get(month) ?? 0);
        const baselineValue =
          baselineValues.length > 0
            ? baselineValues.reduce((sum, value) => sum + value, 0) / baselineValues.length
            : 0;
        const latestValue = entry.values.get(latestMonth) ?? 0;
        const changeValue = latestValue - baselineValue;
        return {
          label: entry.label,
          secondaryLabel: entry.secondaryLabel,
          latestValue,
          baselineValue,
          changeValue,
          changeRate: baselineValue === 0 ? null : changeValue / baselineValue,
        };
      })
      .toSorted(
        (a, b) =>
          Math.abs(b.changeValue) - Math.abs(a.changeValue) || b.latestValue - a.latestValue,
      )
      .slice(0, request.topN)
      .map(({ label, secondaryLabel, latestValue, baselineValue, changeValue, changeRate }) => ({
        label,
        secondaryLabel,
        latestValue,
        baselineValue,
        changeValue,
        changeRate,
      }));
    return { dimension, rows: ranked };
  });

  return {
    kind: "anomaly_summary",
    metric: request.metric,
    label: request.label,
    latestDate,
    sections,
  };
}

export function queryJiuyanSalesDb(
  dbPath: string,
  request: SalesDbQueryRequest,
): SalesDbQueryResult {
  const db = openSalesDatabase(dbPath);
  try {
    if (request.kind === "latest_date") {
      return { kind: request.kind, latestDate: readLatestDate(db) };
    }
    if (request.kind === "date_range") {
      const rangeRow = db
        .prepare("SELECT MIN(sale_date) AS min_date, MAX(sale_date) AS max_date FROM sales")
        .get() as { min_date?: string | null; max_date?: string | null } | undefined;
      return {
        kind: request.kind,
        minDate: rangeRow?.min_date ?? null,
        maxDate: rangeRow?.max_date ?? null,
      };
    }
    if (request.kind === "new_sku_count") {
      const row = db
        .prepare(
          [
            "SELECT COUNT(DISTINCT barcode) AS sku_count",
            "FROM sales",
            "WHERE substr(sale_date, 1, 7) = ?",
            "  AND barcode NOT IN (",
            "    SELECT DISTINCT barcode FROM sales WHERE substr(sale_date, 1, 7) < ?",
            "  )",
          ].join(" "),
        )
        .get(request.month, request.month) as { sku_count?: number | null } | undefined;
      return {
        kind: request.kind,
        month: request.month,
        label: request.label,
        skuCount: Number(row?.sku_count ?? 0),
      };
    }
    if (request.kind === "period_change") {
      return queryPeriodChange(db, request);
    }
    if (request.kind === "anomaly_summary") {
      return queryAnomalySummary(db, request);
    }
    const metric = METRICS[request.metric];
    const plan = buildAggregateExecutionPlan(db, request);
    if ("groupBy" in plan && plan.groupBy) {
      const rawRows = db.prepare(plan.sql).all(...plan.params) as Array<Record<string, unknown>>;
      const rows = rawRows.map((row) =>
        plan.groupBy === "sku"
          ? {
              label: String(
                (row.sku_name as string | number | null) ??
                  (row.sku_code as string | number | null) ??
                  "",
              ),
              secondaryLabel: String((row.sku_code as string | number | null) ?? ""),
              value: Number(row.metric_value ?? 0),
            }
          : {
              label: String((row.group_value as string | number | null) ?? ""),
              value: Number(row.metric_value ?? 0),
            },
      );
      return {
        kind: "aggregate",
        metric: request.metric,
        timeLabel: plan.timeLabel,
        resolvedRangeLabel: plan.resolvedRangeLabel,
        latestDate: readLatestDate(db),
        groupBy: plan.groupBy,
        rows,
        limit: plan.limit,
      };
    }
    const row = db.prepare(plan.sql).get(...plan.params) as
      | { metric_value?: number | null }
      | undefined;
    return {
      kind: "aggregate",
      metric: request.metric,
      timeLabel: plan.timeLabel,
      resolvedRangeLabel: plan.resolvedRangeLabel,
      latestDate: readLatestDate(db),
      rows: [{ label: metric.label, value: Number(row?.metric_value ?? 0) }],
    };
  } finally {
    db.close();
  }
}

export function formatSalesDbQueryResult(result: SalesDbQueryResult): string {
  if (result.kind === "latest_date") {
    return result.latestDate
      ? `当前 sales 数据库里的最新日期是 ${result.latestDate}。`
      : "当前 sales 数据库还没有数据。";
  }
  if (result.kind === "date_range") {
    if (!result.minDate || !result.maxDate) {
      return "当前 sales 数据库还没有可查询的日期数据。";
    }
    return `当前 sales 数据库的时间范围是 ${result.minDate} 到 ${result.maxDate}。`;
  }
  if (result.kind === "new_sku_count") {
    return `${result.label} 才出现过的 SKU 数量是 ${result.skuCount}。`;
  }
  if (result.kind === "period_change") {
    const metric = METRICS[result.metric];
    const topRow = result.rows[0];
    if (!topRow) {
      return `${result.currentLabel} 和 ${result.previousLabel} 没有可用于对比的${metric.label}数据。`;
    }
    if (!result.groupBy) {
      const direction = topRow.changeValue >= 0 ? "增长" : "下降";
      return `${result.currentLabel} 相比 ${result.previousLabel} 的${metric.label}${direction}了 ${metric.formatter(
        Math.abs(topRow.changeValue),
      )}，${result.currentLabel} 为 ${metric.formatter(topRow.currentValue)}，${result.previousLabel} 为 ${metric.formatter(topRow.previousValue)}。`;
    }
    const label = topRow.secondaryLabel
      ? `${topRow.label}（${topRow.secondaryLabel}）`
      : topRow.label;
    const dimensionLabel = result.groupBy === "sku" ? "SKU" : DIMENSIONS[result.groupBy].label;
    return `${result.currentLabel} 相比 ${result.previousLabel} ${metric.label}增长最多的${dimensionLabel}是 ${label}，增长 ${metric.formatter(
      Math.abs(topRow.changeValue),
    )}。`;
  }
  if (result.kind === "anomaly_summary") {
    if (result.sections.length === 0) {
      return `${result.label} 暂时没有足够的异常分析数据。`;
    }
    const metric = METRICS[result.metric];
    const sections = result.sections
      .map((section) => {
        const dimensionLabel =
          section.dimension === "sku" ? "异常 SKU" : `异常${DIMENSIONS[section.dimension].label}`;
        if (section.rows.length === 0) {
          return `${dimensionLabel}：暂无明显异常。`;
        }
        const preview = section.rows
          .map((row) => {
            const label = row.secondaryLabel ? `${row.label}（${row.secondaryLabel}）` : row.label;
            const direction = row.changeValue >= 0 ? "高于" : "低于";
            return `${label}（最新月 ${metric.formatter(row.latestValue)}，较前序均值${direction} ${metric.formatter(Math.abs(row.changeValue))}）`;
          })
          .join("；");
        return `${dimensionLabel}：${preview}`;
      })
      .join("\n");
    return `${result.label} 的异常分析如下：\n${sections}`;
  }
  const metric = METRICS[result.metric];
  if (!result.groupBy) {
    const value = result.rows[0]?.value ?? 0;
    return `${result.resolvedRangeLabel} 的${metric.label}是 ${metric.formatter(value)}。`;
  }
  const topRow = result.rows[0];
  if (!topRow) {
    const dLabel = result.groupBy === "sku" ? "SKU" : DIMENSIONS[result.groupBy].label;
    return `${result.resolvedRangeLabel} 没有可查询的${dLabel}数据。`;
  }
  if (result.limit && result.limit > 1) {
    const preview = result.rows
      .slice(0, result.limit)
      .map((row, index) => {
        const label = row.secondaryLabel ? `${row.label}（${row.secondaryLabel}）` : row.label;
        return `${index + 1}. ${label}: ${metric.formatter(row.value)}`;
      })
      .join("\n");
    return `${result.resolvedRangeLabel} 的 ${metric.label} Top ${result.limit}：\n${preview}`;
  }
  const label = topRow.secondaryLabel
    ? `${topRow.label}（${topRow.secondaryLabel}）`
    : topRow.label;
  const dimensionLabel = result.groupBy === "sku" ? "SKU" : DIMENSIONS[result.groupBy].label;
  return `${result.resolvedRangeLabel} ${metric.label}最高的${dimensionLabel}是 ${label}，${metric.label} ${metric.formatter(topRow.value)}。`;
}

export async function handleJiuyanSalesDbQueryMessage(params: {
  content: string;
  adapter: JiuyanSalesChannelAdapter;
}): Promise<boolean> {
  const request = parseSalesDbQueryRequest(params.content);
  if (!request) {
    return false;
  }
  const dbPath = resolveJiuyanSalesRuntimePaths().dbPath;
  if (!fs.existsSync(dbPath)) {
    await params.adapter.sendText(`销售查询失败：数据库文件不存在：${dbPath}`);
    return true;
  }
  try {
    const result = queryJiuyanSalesDb(dbPath, request);
    logWithAdapter(
      params.adapter,
      `sales db query handled: request=${JSON.stringify(request)}, db=${dbPath}, result=${JSON.stringify(result)}`,
    );
    await params.adapter.sendText(formatSalesDbQueryResult(result));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logWithAdapter(
      params.adapter,
      `sales db query failed: request=${JSON.stringify(request)}, error=${message}`,
    );
    await params.adapter.sendText(`销售查询失败：${message}`);
  }
  return true;
}

export function createTempSalesDbForTest(
  rows: Array<{
    saleDate: string;
    province: string;
    city?: string;
    platform?: string;
    shop?: string;
    productCategory?: string;
    barcode?: string;
    productName?: string;
    salesVolume: number;
    paidAmount?: number;
    basePrice?: number;
    listPrice?: number;
  }>,
): string {
  const dbPath = path.join(
    os.tmpdir(),
    `openclaw-feishu-sales-${Date.now()}-${Math.random()}.sqlite`,
  );
  const db = openSalesDatabase(":memory:", false);
  try {
    db.exec(
      [
        "CREATE TABLE sales (",
        "  shop TEXT,",
        "  province TEXT,",
        "  city TEXT,",
        "  sale_date TEXT,",
        "  barcode TEXT,",
        "  product_name TEXT,",
        "  product_category TEXT,",
        "  base_price REAL,",
        "  list_price REAL,",
        "  platform TEXT,",
        "  sales_volume INTEGER,",
        "  paid_amount REAL",
        ");",
      ].join("\n"),
    );
    const insert = db.prepare(
      [
        "INSERT INTO sales (shop, province, city, sale_date, barcode, product_name, product_category, base_price, list_price, platform, sales_volume, paid_amount)",
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ].join(" "),
    );
    let barcodeCounter = 0;
    for (const row of rows) {
      barcodeCounter += 1;
      insert.run(
        row.shop ?? "",
        row.province,
        row.city ?? "",
        row.saleDate,
        row.barcode ?? `SKU-${barcodeCounter}`,
        row.productName ?? row.barcode ?? `SKU-${barcodeCounter}`,
        row.productCategory ?? "",
        row.basePrice ?? 0,
        row.listPrice ?? 0,
        row.platform ?? "",
        row.salesVolume,
        row.paidAmount ?? 0,
      );
    }
    db.exec(`VACUUM INTO '${dbPath.replace(/'/g, "''")}';`);
  } finally {
    db.close();
  }
  return dbPath;
}
