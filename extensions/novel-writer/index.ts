import { definePluginEntry, type AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { createNovelWriterTool } from "./src/novel-writer-tool.js";

export default definePluginEntry({
  id: "novel-writer",
  name: "Novel Writer",
  description: "Gemini-powered long-form fiction writing tool",
  register(api) {
    api.registerTool((context) => createNovelWriterTool(api, context) as AnyAgentTool, {
      optional: true,
    });
  },
});
