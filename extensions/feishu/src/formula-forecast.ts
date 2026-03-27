import path from "node:path";
import type { ClawdbotConfig } from "openclaw/plugin-sdk/feishu";
import {
  handleJiuyanFormulaForecastMessage,
  parseFormulaForecastRequest,
  resetJiuyanSalesRuntimeCacheForTest,
  resolveJiuyanSalesPythonExecutable,
  resolveJiuyanSalesRuntimePaths,
  type FormulaForecastRequest,
} from "openclaw/plugin-sdk/jiuyan-sales";
import { sendMediaFeishu } from "./media.js";
import { sendMessageFeishu } from "./send.js";
import type { FeishuMediaInfo } from "./types.js";

export type FormulaForecastContext = {
  cfg: ClawdbotConfig;
  accountId: string;
  chatId: string;
  senderOpenId: string;
  messageId?: string;
  content: string;
  isGroup: boolean;
  mentionedBot: boolean;
  mediaList?: FeishuMediaInfo[];
  log?: (msg: string) => void;
};

function resolveTarget(ctx: FormulaForecastContext): string {
  return ctx.isGroup ? `chat:${ctx.chatId}` : `user:${ctx.senderOpenId}`;
}

async function sendWorkflowReply(ctx: FormulaForecastContext, text: string): Promise<void> {
  await sendMessageFeishu({
    cfg: ctx.cfg,
    to: resolveTarget(ctx),
    text,
    replyToMessageId: ctx.messageId,
    accountId: ctx.accountId,
  });
}

export { parseFormulaForecastRequest };
export type { FormulaForecastRequest };

export function resolveFormulaForecastPythonExecutableForTest(): string | null {
  return resolveJiuyanSalesPythonExecutable();
}

export function resolveFormulaForecastRuntimePathsForTest() {
  const runtimePaths = resolveJiuyanSalesRuntimePaths();
  return {
    modelRoot: runtimePaths.modelRoot,
    scriptPath: runtimePaths.formulaForecastScriptPath,
    dbPath: runtimePaths.dbPath,
  };
}

export function resetFormulaForecastRuntimeCacheForTest(): void {
  resetJiuyanSalesRuntimeCacheForTest();
}

export async function maybeHandleFormulaForecastWorkflow(
  ctx: FormulaForecastContext,
): Promise<boolean> {
  return await handleJiuyanFormulaForecastMessage({
    content: ctx.content,
    attachments: ctx.mediaList,
    adapter: {
      sendText: (text) => sendWorkflowReply(ctx, text),
      sendFile: ({ path: filePath, fileName }) =>
        sendMediaFeishu({
          cfg: ctx.cfg,
          to: resolveTarget(ctx),
          mediaUrl: filePath,
          fileName,
          replyToMessageId: ctx.messageId,
          accountId: ctx.accountId,
          mediaLocalRoots: [path.dirname(filePath)],
        }).then(() => {}),
      log: ctx.log,
      logPrefix: `feishu[${ctx.accountId}]`,
    },
  });
}
