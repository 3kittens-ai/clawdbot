import { beforeEach, describe, expect, it, vi } from "vitest";

const gatewayMocks = vi.hoisted(() => ({
  callGatewayTool: vi.fn(),
  readGatewayCallOptions: vi.fn(() => ({})),
}));

const nodeUtilsMocks = vi.hoisted(() => ({
  resolveNodeId: vi.fn(async () => "node-1"),
}));

let createCalendarTool: typeof import("./calendar-tool.js").createCalendarTool;

describe("calendar tool", () => {
  beforeEach(() => {
    gatewayMocks.callGatewayTool.mockReset();
    gatewayMocks.readGatewayCallOptions.mockReset().mockReturnValue({});
    nodeUtilsMocks.resolveNodeId.mockReset().mockResolvedValue("node-1");
  });

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock("./gateway.js", () => ({
      callGatewayTool: gatewayMocks.callGatewayTool,
      readGatewayCallOptions: gatewayMocks.readGatewayCallOptions,
    }));
    vi.doMock("./nodes-utils.js", () => ({
      resolveNodeId: nodeUtilsMocks.resolveNodeId,
    }));
    ({ createCalendarTool } = await import("./calendar-tool.js"));
  });

  it("lists events with optional range filters", async () => {
    gatewayMocks.callGatewayTool.mockResolvedValue({
      payload: { events: [{ identifier: "evt-1", title: "Standup" }] },
    });
    const tool = createCalendarTool({ agentSessionKey: "agent:ops:main" });

    const result = await tool.execute("1", {
      action: "list",
      startISO: "2026-03-23T09:00:00Z",
      endISO: "2026-03-24T09:00:00Z",
      limit: 10,
    });

    expect(nodeUtilsMocks.resolveNodeId).toHaveBeenCalledWith(
      { gatewayToken: undefined, gatewayUrl: undefined, timeoutMs: undefined },
      undefined,
      true,
    );
    expect(gatewayMocks.callGatewayTool).toHaveBeenCalledWith(
      "node.invoke",
      { gatewayToken: undefined, gatewayUrl: undefined, timeoutMs: undefined },
      {
        nodeId: "node-1",
        command: "calendar.events",
        params: {
          startISO: "2026-03-23T09:00:00Z",
          endISO: "2026-03-24T09:00:00Z",
          limit: 10,
        },
      },
    );
    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({ events: [{ identifier: "evt-1", title: "Standup" }] }, null, 2),
        },
      ],
      details: { events: [{ identifier: "evt-1", title: "Standup" }] },
    });
  });

  it("creates calendar events via calendar.add", async () => {
    gatewayMocks.callGatewayTool.mockResolvedValue({
      payload: { event: { identifier: "evt-2", title: "Review" } },
    });
    const tool = createCalendarTool();

    await tool.execute("1", {
      action: "add",
      node: "pixel",
      title: "Review",
      startISO: "2026-03-23T10:00:00Z",
      endISO: "2026-03-23T11:00:00Z",
      isAllDay: false,
      location: "Room 2",
      notes: "Bring notes",
      calendarTitle: "Work",
      calendarId: "42",
    });

    expect(nodeUtilsMocks.resolveNodeId).toHaveBeenCalledWith(
      { gatewayToken: undefined, gatewayUrl: undefined, timeoutMs: undefined },
      "pixel",
      true,
    );
    expect(gatewayMocks.callGatewayTool).toHaveBeenCalledWith(
      "node.invoke",
      { gatewayToken: undefined, gatewayUrl: undefined, timeoutMs: undefined },
      {
        nodeId: "node-1",
        command: "calendar.add",
        params: {
          title: "Review",
          startISO: "2026-03-23T10:00:00Z",
          endISO: "2026-03-23T11:00:00Z",
          isAllDay: false,
          location: "Room 2",
          notes: "Bring notes",
          calendarTitle: "Work",
          calendarId: 42,
        },
      },
    );
  });
});
