import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveJiuyanSalesRuntimePaths, summarizeSalesImportResult } from "./jiuyan-sales.js";

describe("summarizeSalesImportResult", () => {
  it("includes optional latest inventory metrics when present", () => {
    expect(
      summarizeSalesImportResult({
        status: "imported",
        inserted_row_count: 3,
        inserted_sku_count: 2,
        new_sku_count: 1,
        date_range: {
          start: "2026-03-01",
          end: "2026-03-02",
        },
        latest_inventory_updated_sku_count: 2,
        latest_in_transit_updated_sku_count: 1,
      }),
    ).toContain("最新库存已更新 SKU 数：2");

    expect(
      summarizeSalesImportResult({
        status: "imported",
        inserted_row_count: 3,
        inserted_sku_count: 2,
        new_sku_count: 1,
        date_range: {
          start: "2026-03-01",
          end: "2026-03-02",
        },
        latest_inventory_updated_sku_count: 2,
        latest_in_transit_updated_sku_count: 1,
      }),
    ).toContain("最新在途已更新 SKU 数：1");
  });
});

describe("resolveJiuyanSalesRuntimePaths", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prefers the source jiuyan sales database when cwd is outside the repo", () => {
    const repoRoot = process.cwd();
    vi.spyOn(process, "cwd").mockReturnValue(os.homedir());

    const paths = resolveJiuyanSalesRuntimePaths();
    expect(paths.dbPath).toBe(
      path.join(
        repoRoot,
        "extensions",
        "shared",
        "jiuyan-sales",
        "model-sales-jiuyan",
        "data-base",
        "sales_filtered.sqlite",
      ),
    );
    expect(paths.modelRoot).toBe(
      path.join(repoRoot, "extensions", "shared", "jiuyan-sales", "model-sales-jiuyan"),
    );
  });
});
