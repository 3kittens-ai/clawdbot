import { describe, expect, it } from "vitest";
import {
  formatMissingSalesFields,
  isExcelAttachment,
  parseSalesImportRequest,
} from "./sales-import-workflow.js";

describe("parseSalesImportRequest", () => {
  it("parses sales import requests", () => {
    expect(parseSalesImportRequest("请把这个 Excel 导入数据库")).toBe(true);
    expect(parseSalesImportRequest("回复这个 xlsx，入库到 sales")).toBe(true);
    expect(parseSalesImportRequest("更新数据库")).toBe(true);
  });

  it("ignores unrelated messages", () => {
    expect(parseSalesImportRequest("最新销量数据是哪天的")).toBe(false);
    expect(parseSalesImportRequest("跑生产推理")).toBe(false);
  });
});

describe("isExcelAttachment", () => {
  it("accepts excel by original filename even when saved path becomes zip", () => {
    expect(
      isExcelAttachment({
        path: "/tmp/uploaded.zip",
        fileName: "销售主题分析.xlsx",
        contentType: "application/zip",
        placeholder: "<media:document>",
      }),
    ).toBe(true);
  });

  it("rejects non-excel files", () => {
    expect(
      isExcelAttachment({
        path: "/tmp/uploaded.zip",
        fileName: "资料压缩包.zip",
        contentType: "application/zip",
        placeholder: "<media:document>",
      }),
    ).toBe(false);
  });
});

describe("formatMissingSalesFields", () => {
  it("maps canonical sales fields to Chinese labels", () => {
    expect(formatMissingSalesFields(["shop", "province", "sales_volume", "unknown_field"])).toEqual(
      ["店铺", "省份", "销售数量", "unknown_field"],
    );
  });
});
