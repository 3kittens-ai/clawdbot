import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTempSalesDbForTest,
  parseSalesDbQueryRequest,
  querySalesDbForTest,
} from "./sales-db-query-workflow.js";

const tempDbPaths: string[] = [];

afterEach(() => {
  for (const dbPath of tempDbPaths.splice(0, tempDbPaths.length)) {
    fs.rmSync(dbPath, { force: true });
  }
});

describe("parseSalesDbQueryRequest", () => {
  it("parses database date range queries", () => {
    expect(parseSalesDbQueryRequest("数据库的时间范围")).toEqual({
      kind: "date_range",
    });
  });

  it("parses latest date queries", () => {
    expect(parseSalesDbQueryRequest("最新销量数据是哪天的")).toEqual({
      kind: "latest_date",
    });
  });

  it("parses recent-week aggregate queries", () => {
    expect(parseSalesDbQueryRequest("最近一周的销量")).toEqual({
      kind: "aggregate",
      metric: "total_qty",
      timeRange: { kind: "last_n_days", days: 7, label: "最近 7 天" },
      groupBy: undefined,
      sortDirection: undefined,
      limit: undefined,
    });
  });

  it("parses recent-month aggregate queries", () => {
    expect(parseSalesDbQueryRequest("最近 5 个月的销量综合")).toEqual({
      kind: "aggregate",
      metric: "total_qty",
      timeRange: { kind: "last_n_months", months: 5, label: "最近 5 个月" },
      groupBy: undefined,
      sortDirection: undefined,
      limit: undefined,
    });
  });

  it("parses recent-year aggregate queries", () => {
    expect(parseSalesDbQueryRequest("最近一年的销量总和")).toEqual({
      kind: "aggregate",
      metric: "total_qty",
      timeRange: { kind: "last_n_months", months: 12, label: "最近 12 个月" },
      groupBy: undefined,
      sortDirection: undefined,
      limit: undefined,
    });
  });

  it("parses freer-form recent-year quantity queries", () => {
    expect(parseSalesDbQueryRequest("帮我看一下过去一年总共卖了多少")).toEqual({
      kind: "aggregate",
      metric: "total_qty",
      timeRange: { kind: "last_n_months", months: 12, label: "最近 12 个月" },
      groupBy: undefined,
      sortDirection: undefined,
      limit: undefined,
    });
  });

  it("parses yesterday top province queries", () => {
    expect(parseSalesDbQueryRequest("昨天销量最高的省份")).toEqual({
      kind: "aggregate",
      metric: "total_qty",
      timeRange: { kind: "latest_minus_days", days: 1, label: "昨天" },
      groupBy: "province",
      sortDirection: "desc",
      limit: 1,
    });
  });

  it("parses specific month total queries", () => {
    expect(parseSalesDbQueryRequest("26 年 2 月的销量是多少")).toEqual({
      kind: "aggregate",
      metric: "total_qty",
      timeRange: { kind: "specific_month", month: "2026-02", label: "2026-02 月" },
      groupBy: undefined,
      sortDirection: undefined,
      limit: undefined,
    });
  });

  it("parses previous-calendar-week total queries", () => {
    expect(parseSalesDbQueryRequest("上周总销量")).toEqual({
      kind: "aggregate",
      metric: "total_qty",
      timeRange: { kind: "previous_calendar_week", label: "上周" },
      groupBy: undefined,
      sortDirection: undefined,
      limit: undefined,
    });
  });

  it("parses specific-date total queries", () => {
    expect(parseSalesDbQueryRequest("2026-03-24 的总销量")).toEqual({
      kind: "aggregate",
      metric: "total_qty",
      timeRange: { kind: "specific_date", date: "2026-03-24", label: "2026-03-24" },
      groupBy: undefined,
      sortDirection: undefined,
      limit: undefined,
    });
  });

  it("parses previous-week weekday top-city queries", () => {
    const request = parseSalesDbQueryRequest("上周五哪个城市销量最高");
    expect(request?.kind).toBe("aggregate");
    if (!request || request.kind !== "aggregate") {
      return;
    }
    expect(request.metric).toBe("total_qty");
    expect(request.groupBy).toBe("city");
    expect(request.sortDirection).toBe("desc");
    expect(request.limit).toBe(1);
    expect(request.timeRange.kind).toBe("specific_date");
  });

  it("parses top-sku queries phrased as sell-best", () => {
    expect(parseSalesDbQueryRequest("上周五哪个sku卖得最好")).toEqual({
      kind: "aggregate",
      metric: "total_qty",
      timeRange: expect.objectContaining({ kind: "specific_date", label: "上周五" }),
      groupBy: "sku",
      sortDirection: "desc",
      limit: 1,
    });
  });

  it("parses latest-date queries with database wording", () => {
    expect(parseSalesDbQueryRequest("数据库最新的数据到哪天")).toEqual({
      kind: "latest_date",
    });
  });

  it("parses total record-count queries", () => {
    expect(parseSalesDbQueryRequest("现在数据库总共有多少条记录")).toEqual({
      kind: "aggregate",
      metric: "record_count",
      timeRange: { kind: "all_time", label: "全部数据" },
      groupBy: undefined,
      sortDirection: undefined,
      limit: undefined,
    });
  });

  it("parses year aggregate queries", () => {
    expect(parseSalesDbQueryRequest("2025年的总销量是多少")).toEqual({
      kind: "aggregate",
      metric: "total_qty",
      timeRange: { kind: "specific_year", year: "2025", label: "2025 年" },
      groupBy: undefined,
      sortDirection: undefined,
      limit: undefined,
    });
  });

  it("parses month-over-month top sku growth queries", () => {
    expect(parseSalesDbQueryRequest("上个月哪个 SKU 销量增长最多")).toEqual({
      kind: "period_change",
      metric: "total_qty",
      currentWindow: { kind: "calendar_month", offsetMonths: 1, label: "上个月" },
      previousWindow: { kind: "calendar_month", offsetMonths: 2, label: "上上个月" },
      groupBy: "sku",
      sortDirection: "desc",
      limit: 1,
    });
  });

  it("parses current-vs-previous-month change queries", () => {
    expect(parseSalesDbQueryRequest("这个月比上个月销量增长了多少")).toEqual({
      kind: "period_change",
      metric: "total_qty",
      currentWindow: { kind: "calendar_month", offsetMonths: 0, label: "这个月" },
      previousWindow: { kind: "calendar_month", offsetMonths: 1, label: "上个月" },
    });
  });

  it("parses rolling-day comparison queries", () => {
    expect(parseSalesDbQueryRequest("最近 7 天比前 7 天销量变化多少")).toEqual({
      kind: "period_change",
      metric: "total_qty",
      currentWindow: { kind: "rolling_days", days: 7, offsetWindows: 0, label: "最近 7 天" },
      previousWindow: { kind: "rolling_days", days: 7, offsetWindows: 1, label: "前 7 天" },
    });
  });

  it("parses anomaly summary queries", () => {
    expect(
      parseSalesDbQueryRequest("分析最近3个月的销售数据，重点看异常SKU、异常省份和异常渠道"),
    ).toEqual({
      kind: "anomaly_summary",
      metric: "total_qty",
      months: 3,
      dimensions: ["sku", "province", "platform"],
      topN: 3,
      label: "最近 3 个月",
    });
  });

  it("parses latest active sku count queries", () => {
    expect(parseSalesDbQueryRequest("最近一天活跃的 SKU 有多少个")).toEqual({
      kind: "aggregate",
      metric: "active_sku_count",
      timeRange: { kind: "latest_day", label: "最近一天" },
      groupBy: undefined,
      sortDirection: undefined,
      limit: undefined,
    });
  });

  it("parses new sku count queries", () => {
    expect(parseSalesDbQueryRequest("3 月份才有的 SKU 有多少")).toEqual({
      kind: "new_sku_count",
      month: "2026-03",
      label: "2026-03 月",
    });
  });

  it("ignores unrelated messages", () => {
    expect(parseSalesDbQueryRequest("跑一次生产推理")).toBeNull();
  });

  it("does not steal latest predict file requests", () => {
    expect(parseSalesDbQueryRequest("发我最新销量预测文件")).toBeNull();
  });
});

describe("querySalesDbForTest", () => {
  it("returns the database date range", () => {
    const dbPath = createTempSalesDbForTest([
      { saleDate: "2026-03-21", province: "浙江", salesVolume: 20 },
      { saleDate: "2026-03-23", province: "广东", salesVolume: 10 },
    ]);
    tempDbPaths.push(dbPath);

    expect(querySalesDbForTest(dbPath, { kind: "date_range" })).toEqual({
      kind: "date_range",
      minDate: "2026-03-21",
      maxDate: "2026-03-23",
    });
  });

  it("returns total record count across the full database", () => {
    const dbPath = createTempSalesDbForTest([
      { saleDate: "2026-03-21", province: "浙江", salesVolume: 20 },
      { saleDate: "2026-03-23", province: "广东", salesVolume: 10 },
      { saleDate: "2026-03-23", province: "广东", salesVolume: 11 },
    ]);
    tempDbPaths.push(dbPath);

    expect(
      querySalesDbForTest(dbPath, {
        kind: "aggregate",
        metric: "record_count",
        timeRange: { kind: "all_time", label: "全部数据" },
      }),
    ).toEqual({
      kind: "aggregate",
      metric: "record_count",
      timeLabel: "全部数据",
      resolvedRangeLabel: "全部数据",
      latestDate: "2026-03-23",
      rows: [{ label: "记录数", value: 3 }],
    });
  });

  it("returns a specific-month total quantity", () => {
    const dbPath = createTempSalesDbForTest([
      { saleDate: "2026-02-21", province: "浙江", salesVolume: 20 },
      { saleDate: "2026-02-23", province: "广东", salesVolume: 10 },
      { saleDate: "2026-03-01", province: "广东", salesVolume: 99 },
    ]);
    tempDbPaths.push(dbPath);

    expect(
      querySalesDbForTest(dbPath, {
        kind: "aggregate",
        metric: "total_qty",
        timeRange: { kind: "specific_month", month: "2026-02", label: "2026-02 月" },
      }),
    ).toEqual({
      kind: "aggregate",
      metric: "total_qty",
      timeLabel: "2026-02 月",
      resolvedRangeLabel: "2026-02",
      latestDate: "2026-03-01",
      rows: [{ label: "销量", value: 30 }],
    });
  });

  it("returns a specific-year total quantity", () => {
    const dbPath = createTempSalesDbForTest([
      { saleDate: "2024-12-31", province: "浙江", salesVolume: 7 },
      { saleDate: "2025-01-01", province: "浙江", salesVolume: 10 },
      { saleDate: "2025-06-15", province: "江苏", salesVolume: 20 },
      { saleDate: "2025-12-31", province: "广东", salesVolume: 30 },
      { saleDate: "2026-01-01", province: "广东", salesVolume: 99 },
    ]);
    tempDbPaths.push(dbPath);

    expect(
      querySalesDbForTest(dbPath, {
        kind: "aggregate",
        metric: "total_qty",
        timeRange: { kind: "specific_year", year: "2025", label: "2025 年" },
      }),
    ).toEqual({
      kind: "aggregate",
      metric: "total_qty",
      timeLabel: "2025 年",
      resolvedRangeLabel: "2025",
      latestDate: "2026-01-01",
      rows: [{ label: "销量", value: 60 }],
    });
  });

  it("returns a grouped top province result based on latest minus one day", () => {
    const dbPath = createTempSalesDbForTest([
      { saleDate: "2026-03-22", province: "江苏", salesVolume: 50 },
      { saleDate: "2026-03-22", province: "浙江", salesVolume: 80 },
      { saleDate: "2026-03-23", province: "广东", salesVolume: 10 },
    ]);
    tempDbPaths.push(dbPath);

    expect(
      querySalesDbForTest(dbPath, {
        kind: "aggregate",
        metric: "total_qty",
        timeRange: { kind: "latest_minus_days", days: 1, label: "昨天" },
        groupBy: "province",
        sortDirection: "desc",
        limit: 1,
      }),
    ).toEqual({
      kind: "aggregate",
      metric: "total_qty",
      timeLabel: "昨天",
      resolvedRangeLabel: "2026-03-22",
      latestDate: "2026-03-23",
      groupBy: "province",
      rows: [{ label: "浙江", value: 80 }],
      limit: 1,
    });
  });

  it("returns a recent-week aggregate", () => {
    const dbPath = createTempSalesDbForTest([
      { saleDate: "2026-03-17", province: "浙江", salesVolume: 10 },
      { saleDate: "2026-03-18", province: "江苏", salesVolume: 20 },
      { saleDate: "2026-03-20", province: "浙江", salesVolume: 30 },
      { saleDate: "2026-03-23", province: "广东", salesVolume: 40 },
    ]);
    tempDbPaths.push(dbPath);

    expect(
      querySalesDbForTest(dbPath, {
        kind: "aggregate",
        metric: "total_qty",
        timeRange: { kind: "last_n_days", days: 7, label: "最近 7 天" },
      }),
    ).toEqual({
      kind: "aggregate",
      metric: "total_qty",
      timeLabel: "最近 7 天",
      resolvedRangeLabel: "2026-03-17 到 2026-03-23",
      latestDate: "2026-03-23",
      rows: [{ label: "销量", value: 100 }],
    });
  });

  it("returns a previous-calendar-week aggregate based on the latest date", () => {
    const dbPath = createTempSalesDbForTest([
      { saleDate: "2026-03-16", province: "浙江", salesVolume: 10 },
      { saleDate: "2026-03-18", province: "江苏", salesVolume: 20 },
      { saleDate: "2026-03-22", province: "广东", salesVolume: 30 },
      { saleDate: "2026-03-24", province: "广东", salesVolume: 40 },
    ]);
    tempDbPaths.push(dbPath);

    expect(
      querySalesDbForTest(dbPath, {
        kind: "aggregate",
        metric: "total_qty",
        timeRange: { kind: "previous_calendar_week", label: "上周" },
      }),
    ).toEqual({
      kind: "aggregate",
      metric: "total_qty",
      timeLabel: "上周",
      resolvedRangeLabel: "2026-03-16 到 2026-03-22",
      latestDate: "2026-03-24",
      rows: [{ label: "销量", value: 60 }],
    });
  });

  it("returns a specific-date aggregate", () => {
    const dbPath = createTempSalesDbForTest([
      { saleDate: "2026-03-23", province: "浙江", salesVolume: 10 },
      { saleDate: "2026-03-24", province: "江苏", salesVolume: 20 },
      { saleDate: "2026-03-24", province: "广东", salesVolume: 30 },
    ]);
    tempDbPaths.push(dbPath);

    expect(
      querySalesDbForTest(dbPath, {
        kind: "aggregate",
        metric: "total_qty",
        timeRange: { kind: "specific_date", date: "2026-03-24", label: "2026-03-24" },
      }),
    ).toEqual({
      kind: "aggregate",
      metric: "total_qty",
      timeLabel: "2026-03-24",
      resolvedRangeLabel: "2026-03-24",
      latestDate: "2026-03-24",
      rows: [{ label: "销量", value: 50 }],
    });
  });

  it("returns a recent-month aggregate", () => {
    const dbPath = createTempSalesDbForTest([
      { saleDate: "2025-10-31", province: "浙江", salesVolume: 9 },
      { saleDate: "2025-11-02", province: "浙江", salesVolume: 10 },
      { saleDate: "2025-12-10", province: "江苏", salesVolume: 20 },
      { saleDate: "2026-01-15", province: "广东", salesVolume: 30 },
      { saleDate: "2026-02-20", province: "广东", salesVolume: 40 },
      { saleDate: "2026-03-23", province: "广东", salesVolume: 50 },
    ]);
    tempDbPaths.push(dbPath);

    expect(
      querySalesDbForTest(dbPath, {
        kind: "aggregate",
        metric: "total_qty",
        timeRange: { kind: "last_n_months", months: 5, label: "最近 5 个月" },
      }),
    ).toEqual({
      kind: "aggregate",
      metric: "total_qty",
      timeLabel: "最近 5 个月",
      resolvedRangeLabel: "2025-11 到 2026-03",
      latestDate: "2026-03-23",
      rows: [{ label: "销量", value: 150 }],
    });
  });

  it("returns a recent-year aggregate", () => {
    const dbPath = createTempSalesDbForTest([
      { saleDate: "2025-03-22", province: "浙江", salesVolume: 8 },
      { saleDate: "2025-03-23", province: "浙江", salesVolume: 10 },
      { saleDate: "2025-06-01", province: "江苏", salesVolume: 20 },
      { saleDate: "2025-12-10", province: "广东", salesVolume: 30 },
      { saleDate: "2026-03-23", province: "广东", salesVolume: 40 },
    ]);
    tempDbPaths.push(dbPath);

    expect(
      querySalesDbForTest(dbPath, {
        kind: "aggregate",
        metric: "total_qty",
        timeRange: { kind: "last_n_months", months: 12, label: "最近 12 个月" },
      }),
    ).toEqual({
      kind: "aggregate",
      metric: "total_qty",
      timeLabel: "最近 12 个月",
      resolvedRangeLabel: "2025-04 到 2026-03",
      latestDate: "2026-03-23",
      rows: [{ label: "销量", value: 90 }],
    });
  });

  it("returns a new-sku count for a month", () => {
    const dbPath = createTempSalesDbForTest([
      { saleDate: "2026-02-28", province: "浙江", barcode: "SKU-A", salesVolume: 1 },
      { saleDate: "2026-03-01", province: "江苏", barcode: "SKU-A", salesVolume: 2 },
      { saleDate: "2026-03-02", province: "广东", barcode: "SKU-B", salesVolume: 3 },
      { saleDate: "2026-03-03", province: "广东", barcode: "SKU-C", salesVolume: 4 },
    ]);
    tempDbPaths.push(dbPath);

    expect(
      querySalesDbForTest(dbPath, {
        kind: "new_sku_count",
        month: "2026-03",
        label: "2026-03 月",
      }),
    ).toEqual({
      kind: "new_sku_count",
      month: "2026-03",
      label: "2026-03 月",
      skuCount: 2,
    });
  });

  it("returns a month-over-month top sku growth result", () => {
    const dbPath = createTempSalesDbForTest([
      {
        saleDate: "2026-01-10",
        province: "浙江",
        barcode: "SKU-A",
        productName: "A",
        salesVolume: 10,
      },
      {
        saleDate: "2026-01-11",
        province: "浙江",
        barcode: "SKU-B",
        productName: "B",
        salesVolume: 20,
      },
      {
        saleDate: "2026-02-10",
        province: "浙江",
        barcode: "SKU-A",
        productName: "A",
        salesVolume: 40,
      },
      {
        saleDate: "2026-02-11",
        province: "浙江",
        barcode: "SKU-B",
        productName: "B",
        salesVolume: 25,
      },
      {
        saleDate: "2026-03-23",
        province: "浙江",
        barcode: "SKU-C",
        productName: "C",
        salesVolume: 5,
      },
    ]);
    tempDbPaths.push(dbPath);

    expect(
      querySalesDbForTest(dbPath, {
        kind: "period_change",
        metric: "total_qty",
        currentWindow: { kind: "calendar_month", offsetMonths: 1, label: "上个月" },
        previousWindow: { kind: "calendar_month", offsetMonths: 2, label: "上上个月" },
        groupBy: "sku",
        sortDirection: "desc",
        limit: 1,
      }),
    ).toEqual({
      kind: "period_change",
      metric: "total_qty",
      currentLabel: "2026-02",
      previousLabel: "2026-01",
      latestDate: "2026-03-23",
      groupBy: "sku",
      rows: [
        {
          label: "A",
          secondaryLabel: "SKU-A",
          currentValue: 40,
          previousValue: 10,
          changeValue: 30,
          changeRate: 3,
        },
      ],
      limit: 1,
    });
  });

  it("returns an aggregate period-change result", () => {
    const dbPath = createTempSalesDbForTest([
      { saleDate: "2026-02-10", province: "浙江", salesVolume: 30 },
      { saleDate: "2026-03-10", province: "浙江", salesVolume: 50 },
      { saleDate: "2026-03-23", province: "广东", salesVolume: 10 },
    ]);
    tempDbPaths.push(dbPath);

    expect(
      querySalesDbForTest(dbPath, {
        kind: "period_change",
        metric: "total_qty",
        currentWindow: { kind: "calendar_month", offsetMonths: 0, label: "这个月" },
        previousWindow: { kind: "calendar_month", offsetMonths: 1, label: "上个月" },
      }),
    ).toEqual({
      kind: "period_change",
      metric: "total_qty",
      currentLabel: "2026-03",
      previousLabel: "2026-02",
      latestDate: "2026-03-23",
      rows: [
        {
          label: "销量",
          currentValue: 60,
          previousValue: 30,
          changeValue: 30,
          changeRate: 1,
        },
      ],
    });
  });

  it("returns an anomaly summary across sku, province, and platform", () => {
    const dbPath = createTempSalesDbForTest([
      {
        saleDate: "2026-01-05",
        province: "浙江",
        platform: "抖音",
        barcode: "SKU-A",
        productName: "A",
        salesVolume: 10,
      },
      {
        saleDate: "2026-02-05",
        province: "浙江",
        platform: "抖音",
        barcode: "SKU-A",
        productName: "A",
        salesVolume: 12,
      },
      {
        saleDate: "2026-03-05",
        province: "浙江",
        platform: "抖音",
        barcode: "SKU-A",
        productName: "A",
        salesVolume: 80,
      },
      {
        saleDate: "2026-01-06",
        province: "江苏",
        platform: "天猫",
        barcode: "SKU-B",
        productName: "B",
        salesVolume: 40,
      },
      {
        saleDate: "2026-02-06",
        province: "江苏",
        platform: "天猫",
        barcode: "SKU-B",
        productName: "B",
        salesVolume: 38,
      },
      {
        saleDate: "2026-03-06",
        province: "江苏",
        platform: "天猫",
        barcode: "SKU-B",
        productName: "B",
        salesVolume: 5,
      },
      {
        saleDate: "2026-03-23",
        province: "浙江",
        platform: "抖音",
        barcode: "SKU-C",
        productName: "C",
        salesVolume: 6,
      },
    ]);
    tempDbPaths.push(dbPath);

    const result = querySalesDbForTest(dbPath, {
      kind: "anomaly_summary",
      metric: "total_qty",
      months: 3,
      dimensions: ["sku", "province", "platform"],
      topN: 3,
      label: "最近 3 个月",
    });
    expect(result.kind).toBe("anomaly_summary");
    if (result.kind !== "anomaly_summary") {
      return;
    }
    expect(result.latestDate).toBe("2026-03-23");
    expect(result.sections).toHaveLength(3);
    expect(result.sections[0]?.dimension).toBe("sku");
    expect(result.sections[0]?.rows[0]?.label).toBe("A");
    expect(result.sections[1]?.dimension).toBe("province");
    expect(result.sections[2]?.dimension).toBe("platform");
  });
});
