import { describe, expect, it } from "vitest";
import { parseForecastingWorkflowRequest } from "./forecasting-workflow.js";

describe("parseForecastingWorkflowRequest", () => {
  it("parses backtest requests", () => {
    expect(parseForecastingWorkflowRequest("通过 forecasting 跑一遍销量回测")).toEqual({
      action: "backtest",
      label: "回测",
    });
  });

  it("parses production train requests", () => {
    expect(parseForecastingWorkflowRequest("帮我触发生产训练")).toEqual({
      action: "train",
      label: "生产训练",
    });
  });

  it("parses production predict requests", () => {
    expect(parseForecastingWorkflowRequest("现在执行生产推理")).toEqual({
      action: "predict",
      label: "生产推理",
    });
  });

  it("parses latest predict file requests", () => {
    expect(parseForecastingWorkflowRequest("发我最新的销量预测")).toEqual({
      action: "latest_predict",
      label: "最新生产推理结果",
    });
  });

  it("parses plain predict file requests without latest wording", () => {
    expect(parseForecastingWorkflowRequest("发我销量预测文件")).toEqual({
      action: "latest_predict",
      label: "最新生产推理结果",
    });
  });

  it("ignores unrelated messages", () => {
    expect(parseForecastingWorkflowRequest("最新销量数据是哪天的")).toBeNull();
  });
});
