import { definePluginEntry, type AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { createGeminiImageTool } from "./src/gemini-image-tool.js";

export default definePluginEntry({
  id: "gemini-image",
  name: "Gemini Image",
  description: "Gemini-focused image generation and edit tool for messaging workflows",
  register(api) {
    api.registerTool(createGeminiImageTool(api) as AnyAgentTool, { optional: true });
  },
});
