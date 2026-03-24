import path from "node:path";
import type { ClawdbotConfig } from "openclaw/plugin-sdk/feishu";
import {
  type ForecastingAction,
  type ForecastingWorkflowRequest,
  handleJiuyanForecastingMessage,
  parseForecastingWorkflowRequest,
} from "openclaw/plugin-sdk/jiuyan-sales";
import { sendMediaFeishu } from "./media.js";
import { sendMessageFeishu } from "./send.js";

export type ForecastingWorkflowContext = {
  cfg: ClawdbotConfig;
  accountId: string;
  chatId: string;
  senderOpenId: string;
  messageId?: string;
  content: string;
  isGroup: boolean;
  mentionedBot: boolean;
  log?: (msg: string) => void;
};

function resolveTarget(ctx: ForecastingWorkflowContext): string {
  return ctx.isGroup ? `chat:${ctx.chatId}` : `user:${ctx.senderOpenId}`;
}

async function sendWorkflowReply(ctx: ForecastingWorkflowContext, text: string): Promise<void> {
  await sendMessageFeishu({
    cfg: ctx.cfg,
    to: resolveTarget(ctx),
    text,
    replyToMessageId: ctx.messageId,
    accountId: ctx.accountId,
  });
}

export { parseForecastingWorkflowRequest };
export type { ForecastingAction, ForecastingWorkflowRequest };

export async function maybeHandleForecastingWorkflow(
  ctx: ForecastingWorkflowContext,
): Promise<boolean> {
  return await handleJiuyanForecastingMessage({
    content: ctx.content,
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
