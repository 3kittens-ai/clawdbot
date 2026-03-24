import { Type } from "@sinclair/typebox";
import { resolveSessionAgentId } from "../agent-scope.js";
import { stringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";
import { callGatewayTool, readGatewayCallOptions } from "./gateway.js";
import { resolveNodeId } from "./nodes-utils.js";

const CALENDAR_TOOL_ACTIONS = ["list", "add"] as const;

const CalendarToolSchema = Type.Object({
  action: stringEnum(CALENDAR_TOOL_ACTIONS),
  gatewayUrl: Type.Optional(Type.String()),
  gatewayToken: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Number()),
  node: Type.Optional(
    Type.String({
      description:
        "Node id/name/IP. Optional when exactly one compatible personal node is available.",
    }),
  ),
  startISO: Type.Optional(
    Type.String({
      description: "ISO-8601 start time. `list` defaults to now; `add` requires it.",
    }),
  ),
  endISO: Type.Optional(
    Type.String({
      description: "ISO-8601 end time. `list` defaults to start+7d; `add` requires it.",
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: "Max events to return for `list` (default node behavior is 50).",
    }),
  ),
  title: Type.Optional(Type.String({ description: "Event title for `add`." })),
  isAllDay: Type.Optional(Type.Boolean()),
  location: Type.Optional(Type.String()),
  notes: Type.Optional(Type.String()),
  calendarId: Type.Optional(Type.String()),
  calendarTitle: Type.Optional(Type.String()),
});

function optionalTrimmedString(params: Record<string, unknown>, key: string): string | undefined {
  return typeof params[key] === "string" && params[key].trim().length > 0
    ? params[key].trim()
    : undefined;
}

export function createCalendarTool(options?: { agentSessionKey?: string }): AnyAgentTool {
  const agentId = resolveSessionAgentId({
    sessionKey: options?.agentSessionKey,
  });

  return {
    label: "Calendar",
    name: "calendar",
    ownerOnly: true,
    description:
      "List upcoming calendar events or create a new calendar event on a paired personal node.",
    parameters: CalendarToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const gatewayOpts = readGatewayCallOptions(params);
      const node = optionalTrimmedString(params, "node");

      try {
        const nodeId = await resolveNodeId(gatewayOpts, node, true);
        if (action === "list") {
          const payload: Record<string, unknown> = {};
          const startISO = optionalTrimmedString(params, "startISO");
          const endISO = optionalTrimmedString(params, "endISO");
          if (startISO) {
            payload.startISO = startISO;
          }
          if (endISO) {
            payload.endISO = endISO;
          }
          if (typeof params.limit === "number" && Number.isFinite(params.limit)) {
            payload.limit = params.limit;
          }
          const raw = await callGatewayTool<{ payload?: unknown }>("node.invoke", gatewayOpts, {
            nodeId,
            command: "calendar.events",
            params: payload,
          });
          return jsonResult(raw?.payload ?? {});
        }

        if (action === "add") {
          const title = readStringParam(params, "title", { required: true });
          const startISO = readStringParam(params, "startISO", { required: true });
          const endISO = readStringParam(params, "endISO", { required: true });
          const payload: Record<string, unknown> = {
            title,
            startISO,
            endISO,
          };
          if (typeof params.isAllDay === "boolean") {
            payload.isAllDay = params.isAllDay;
          }
          const location = optionalTrimmedString(params, "location");
          const notes = optionalTrimmedString(params, "notes");
          const calendarTitle = optionalTrimmedString(params, "calendarTitle");
          const calendarIdRaw = optionalTrimmedString(params, "calendarId");
          if (location) {
            payload.location = location;
          }
          if (notes) {
            payload.notes = notes;
          }
          if (calendarTitle) {
            payload.calendarTitle = calendarTitle;
          }
          if (calendarIdRaw) {
            const parsedId = Number.parseInt(calendarIdRaw, 10);
            payload.calendarId = Number.isFinite(parsedId) ? parsedId : calendarIdRaw;
          }
          const raw = await callGatewayTool<{ payload?: unknown }>("node.invoke", gatewayOpts, {
            nodeId,
            command: "calendar.add",
            params: payload,
          });
          return jsonResult(raw?.payload ?? {});
        }

        throw new Error(`Unknown action: ${action}`);
      } catch (err) {
        const nodeLabel = node ?? "auto";
        const gatewayLabel =
          gatewayOpts.gatewayUrl && gatewayOpts.gatewayUrl.trim()
            ? gatewayOpts.gatewayUrl.trim()
            : "default";
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
          `agent=${agentId ?? "unknown"} node=${nodeLabel} gateway=${gatewayLabel} action=${action}: ${message}`,
          { cause: err },
        );
      }
    },
  };
}
