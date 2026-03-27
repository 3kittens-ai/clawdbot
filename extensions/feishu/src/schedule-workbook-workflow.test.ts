import { describe, expect, it } from "vitest";
import { parseScheduleWorkbookRequest } from "./schedule-workbook-workflow.js";

describe("parseScheduleWorkbookRequest", () => {
  it("parses direct workbook refresh requests", () => {
    expect(parseScheduleWorkbookRequest("通过飞书指令用当前数据库更新计划排单表")).toEqual({
      workbookLabel: "常规鱼钩计划排单表",
    });
  });

  it("parses fishhook-specific workbook refresh requests", () => {
    expect(parseScheduleWorkbookRequest("刷新常规鱼钩排单表，用当前 sales 数据库重算")).toEqual({
      workbookLabel: "常规鱼钩计划排单表",
    });
  });

  it("ignores unrelated messages", () => {
    expect(parseScheduleWorkbookRequest("最新销量数据是哪天的")).toBeNull();
  });
});
