import path from "node:path";
import type { ClawdbotConfig } from "openclaw/plugin-sdk/feishu";
import {
  handleJiuyanScheduleWorkbookMessage,
  parseScheduleWorkbookRequest,
  type ScheduleWorkbookRequest,
} from "openclaw/plugin-sdk/jiuyan-sales";
import { sendMediaFeishu } from "./media.js";
import { sendMessageFeishu } from "./send.js";

export type ScheduleWorkbookWorkflowContext = {
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

function resolveTarget(ctx: ScheduleWorkbookWorkflowContext): string {
  return ctx.isGroup ? `chat:${ctx.chatId}` : `user:${ctx.senderOpenId}`;
}

async function sendWorkflowReply(
  ctx: ScheduleWorkbookWorkflowContext,
  text: string,
): Promise<void> {
  await sendMessageFeishu({
    cfg: ctx.cfg,
    to: resolveTarget(ctx),
    text,
    replyToMessageId: ctx.messageId,
    accountId: ctx.accountId,
  });
}

export { parseScheduleWorkbookRequest };
export type { ScheduleWorkbookRequest };

export async function maybeHandleScheduleWorkbookWorkflow(
  ctx: ScheduleWorkbookWorkflowContext,
): Promise<boolean> {
  return await handleJiuyanScheduleWorkbookMessage({
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
