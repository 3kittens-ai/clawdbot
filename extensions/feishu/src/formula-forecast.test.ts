import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseFormulaForecastRequest,
  resetFormulaForecastRuntimeCacheForTest,
  resolveFormulaForecastPythonExecutableForTest,
  resolveFormulaForecastRuntimePathsForTest,
} from "./formula-forecast.js";

afterEach(() => {
  resetFormulaForecastRuntimeCacheForTest();
});

describe("parseFormulaForecastRequest", () => {
  it("parses a natural-language formula forecast request", () => {
    const parsed = parseFormulaForecastRequest(
      "按照最近3个月平均销量*1.15 公式计算未来 12 个月的 top800SKU销量",
    );

    expect(parsed).toEqual({
      formulaText: "最近3个月平均销量*1.15",
      normalizedFormula: "avg3*1.15",
      horizonMonths: 12,
      topK: 800,
      targetTurnoverDays: 45,
      topBasis: "latest_complete_month",
      scopeMode: "top",
    });
  });

  it("normalizes percentage expressions", () => {
    const parsed = parseFormulaForecastRequest(
      "按照(最近6个月平均销量+上个月销量)*110% 公式计算未来6个月的 top120SKU销量",
    );

    expect(parsed?.normalizedFormula).toBe("(avg6+m1)*(110/100)");
    expect(parsed?.horizonMonths).toBe(6);
    expect(parsed?.topK).toBe(120);
    expect(parsed?.targetTurnoverDays).toBe(45);
  });

  it("parses top sku requests with spaces and count classifiers", () => {
    const parsed = parseFormulaForecastRequest(
      "按照最近12个月平均销量*0.8 公式预测未来 3 个月的 前 50 个 SKU 销量",
    );

    expect(parsed).toEqual({
      formulaText: "最近12个月平均销量*0.8",
      normalizedFormula: "avg12*0.8",
      horizonMonths: 3,
      topK: 50,
      targetTurnoverDays: 45,
      topBasis: "latest_complete_month",
      scopeMode: "top",
    });
  });

  it("parses natural-language formula requests with inferred ring-vs-yoy weights", () => {
    const parsed = parseFormulaForecastRequest(
      "公式计算销量 未来 3 个月 按照环比和全年同比 各 0.5 的权重",
    );

    expect(parsed).toEqual({
      formulaText: "最近一个月销量*0.5 + m12*0.5",
      normalizedFormula: "m1*0.5 + m12*0.5",
      horizonMonths: 3,
      topK: 50,
      targetTurnoverDays: 45,
      topBasis: "latest_complete_month",
      scopeMode: "top",
    });
  });

  it("parses natural-language top sku requests without an explicit formula", () => {
    const parsed = parseFormulaForecastRequest("公式计算 未来 3 个月 前 50 个 sku 销量");

    expect(parsed).toEqual({
      formulaText:
        "第1个月=max(近月销量×历史同期月份比例, 本月累计销量折算值, 短期销量折算值); 第2-5个月=上个月预测×去年同期相邻月份销量比",
      normalizedFormula: "builtin_default_5m",
      horizonMonths: 3,
      topK: 50,
      targetTurnoverDays: 45,
      topBasis: "latest_complete_month",
      scopeMode: "top",
    });
  });

  it("defaults natural-language formula requests to the builtin 5-month strategy", () => {
    const parsed = parseFormulaForecastRequest("公式计算销量");

    expect(parsed).toEqual({
      formulaText:
        "第1个月=max(近月销量×历史同期月份比例, 本月累计销量折算值, 短期销量折算值); 第2-5个月=上个月预测×去年同期相邻月份销量比",
      normalizedFormula: "builtin_default_5m",
      horizonMonths: 5,
      topK: 50,
      targetTurnoverDays: 45,
      topBasis: "latest_complete_month",
      scopeMode: "top",
    });
  });

  it("parses category-limited top sku requests", () => {
    const parsed = parseFormulaForecastRequest("公式计算销量 top 800 的鱼钩 sku");

    expect(parsed).toEqual({
      formulaText:
        "第1个月=max(近月销量×历史同期月份比例, 本月累计销量折算值, 短期销量折算值); 第2-5个月=上个月预测×去年同期相邻月份销量比",
      normalizedFormula: "builtin_default_5m",
      horizonMonths: 5,
      topK: 800,
      targetTurnoverDays: 45,
      productCategory: "鱼钩",
      topBasis: "latest_complete_month",
      scopeMode: "top",
    });
  });

  it("parses category-limited top requests without an explicit sku suffix", () => {
    const parsed = parseFormulaForecastRequest("公式计算销量 top 800 鱼钩");

    expect(parsed).toEqual({
      formulaText:
        "第1个月=max(近月销量×历史同期月份比例, 本月累计销量折算值, 短期销量折算值); 第2-5个月=上个月预测×去年同期相邻月份销量比",
      normalizedFormula: "builtin_default_5m",
      horizonMonths: 5,
      topK: 800,
      targetTurnoverDays: 45,
      productCategory: "鱼钩",
      topBasis: "latest_complete_month",
      scopeMode: "top",
    });
  });

  it("parses attachment-scoped sku requests", () => {
    const parsed = parseFormulaForecastRequest("公式计算销量 文件中的 sku");

    expect(parsed).toEqual({
      formulaText:
        "第1个月=max(近月销量×历史同期月份比例, 本月累计销量折算值, 短期销量折算值); 第2-5个月=上个月预测×去年同期相邻月份销量比",
      normalizedFormula: "builtin_default_5m",
      horizonMonths: 5,
      topK: 50,
      targetTurnoverDays: 45,
      topBasis: "latest_complete_month",
      scopeMode: "attachment_excel",
    });
  });

  it("parses custom target turnover days from natural-language requests", () => {
    const parsed = parseFormulaForecastRequest(
      "公式计算销量 表里的 SKU 库存计划量可周转天数 60 天",
    );

    expect(parsed).toEqual({
      formulaText:
        "第1个月=max(近月销量×历史同期月份比例, 本月累计销量折算值, 短期销量折算值); 第2-5个月=上个月预测×去年同期相邻月份销量比",
      normalizedFormula: "builtin_default_5m",
      horizonMonths: 5,
      topK: 50,
      targetTurnoverDays: 60,
      topBasis: "latest_complete_month",
      scopeMode: "attachment_excel",
    });
  });

  it("parses table-scoped sku requests", () => {
    const parsed = parseFormulaForecastRequest("公式计算销量 表中的 SKU");

    expect(parsed).toEqual({
      formulaText:
        "第1个月=max(近月销量×历史同期月份比例, 本月累计销量折算值, 短期销量折算值); 第2-5个月=上个月预测×去年同期相邻月份销量比",
      normalizedFormula: "builtin_default_5m",
      horizonMonths: 5,
      topK: 50,
      targetTurnoverDays: 45,
      topBasis: "latest_complete_month",
      scopeMode: "attachment_excel",
    });
  });

  it("parses colloquial table-scoped sku requests with 是", () => {
    const parsed = parseFormulaForecastRequest("公式预测销量 表中的是 sku");

    expect(parsed).toEqual({
      formulaText:
        "第1个月=max(近月销量×历史同期月份比例, 本月累计销量折算值, 短期销量折算值); 第2-5个月=上个月预测×去年同期相邻月份销量比",
      normalizedFormula: "builtin_default_5m",
      horizonMonths: 5,
      topK: 50,
      targetTurnoverDays: 45,
      topBasis: "latest_complete_month",
      scopeMode: "attachment_excel",
    });
  });

  it("parses explicit top basis phrases", () => {
    expect(parseFormulaForecastRequest("公式预测 上个月销量 top100 sku")?.topBasis).toBe(
      "latest_complete_month",
    );
    expect(parseFormulaForecastRequest("公式预测 近1年销量 top100 sku")?.topBasis).toBe(
      "trailing_12_months",
    );
    expect(parseFormulaForecastRequest("公式预测 历史销量 top100 sku")?.topBasis).toBe("all_time");
    expect(parseFormulaForecastRequest("公式预测 top100 sku")?.topBasis).toBe(
      "latest_complete_month",
    );
  });

  it("returns null for unrelated messages", () => {
    expect(parseFormulaForecastRequest("最新的销量数据是哪天的")).toBeNull();
  });

  it("resolves a Python executable from PATH or absolute fallbacks", () => {
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = ["/definitely-missing-bin", path.dirname("/usr/bin/python3")].join(
        path.delimiter,
      );
      const resolved = resolveFormulaForecastPythonExecutableForTest();
      expect(resolved).toBeTruthy();
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("resolves runtime paths to real source assets", () => {
    const paths = resolveFormulaForecastRuntimePathsForTest();

    expect(paths.modelRoot.endsWith("extensions/shared/jiuyan-sales/model-sales-jiuyan")).toBe(
      true,
    );
    expect(paths.scriptPath.endsWith("scripts/sales_expression_forecast_job.py")).toBe(true);
    expect(paths.dbPath.endsWith("data-base/sales_filtered.sqlite")).toBe(true);
  });
});
