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
    });
  });

  it("normalizes percentage expressions", () => {
    const parsed = parseFormulaForecastRequest(
      "按照(最近6个月平均销量+上个月销量)*110% 公式计算未来6个月的 top120SKU销量",
    );

    expect(parsed?.normalizedFormula).toBe("(avg6+m1)*(110/100)");
    expect(parsed?.horizonMonths).toBe(6);
    expect(parsed?.topK).toBe(120);
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
    });
  });

  it("parses natural-language top sku requests without an explicit formula", () => {
    const parsed = parseFormulaForecastRequest("公式计算 未来 3 个月 前 50 个 sku 销量");

    expect(parsed).toEqual({
      formulaText: "最近一个月销量",
      normalizedFormula: "m1",
      horizonMonths: 3,
      topK: 50,
    });
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

    expect(paths.modelRoot.endsWith("extensions/feishu/jiuyan-sales/model-sales-jiuyan")).toBe(
      true,
    );
    expect(paths.scriptPath.endsWith("scripts/formula_forecast_job.py")).toBe(true);
    expect(paths.dbPath.endsWith("data-base/sales_filtered.sqlite")).toBe(true);
  });
});
