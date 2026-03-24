import type { ClawdbotConfig } from "openclaw/plugin-sdk/feishu";
import {
  formatMissingSalesFields,
  handleJiuyanSalesImportMessage,
  isSalesExcelAttachment,
  parseSalesImportRequest,
} from "openclaw/plugin-sdk/jiuyan-sales";
import { sendMessageFeishu } from "./send.js";
import type { FeishuMediaInfo } from "./types.js";

export type SalesImportWorkflowContext = {
  cfg: ClawdbotConfig;
  accountId: string;
  chatId: string;
  senderOpenId: string;
  messageId?: string;
  content: string;
  isGroup: boolean;
  mediaList: FeishuMediaInfo[];
  log?: (msg: string) => void;
};

function resolveTarget(ctx: SalesImportWorkflowContext): string {
  return ctx.isGroup ? `chat:${ctx.chatId}` : `user:${ctx.senderOpenId}`;
}

async function sendWorkflowReply(ctx: SalesImportWorkflowContext, text: string): Promise<void> {
  await sendMessageFeishu({
    cfg: ctx.cfg,
    to: resolveTarget(ctx),
    text,
    replyToMessageId: ctx.messageId,
    accountId: ctx.accountId,
  });
}

export function isExcelAttachment(media: FeishuMediaInfo): boolean {
  return isSalesExcelAttachment(media);
}

export { formatMissingSalesFields, parseSalesImportRequest };

export async function maybeHandleSalesImportWorkflow(
  ctx: SalesImportWorkflowContext,
): Promise<boolean> {
  return await handleJiuyanSalesImportMessage({
    content: ctx.content,
    attachments: ctx.mediaList,
    adapter: {
      sendText: (text) => sendWorkflowReply(ctx, text),
      sendFile: async () => {
        throw new Error("sales import does not send files");
      },
      log: ctx.log,
      logPrefix: `feishu[${ctx.accountId}]`,
    },
  });
}
