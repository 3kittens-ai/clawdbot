import fs from "node:fs";
import type { ClawdbotConfig } from "openclaw/plugin-sdk/feishu";
import {
  createTempSalesDbForTest,
  handleJiuyanSalesDbQueryMessage,
  parseSalesDbQueryRequest,
  queryJiuyanSalesDb,
} from "openclaw/plugin-sdk/jiuyan-sales";
import { sendMessageFeishu } from "./send.js";

export type SalesDbQueryContext = {
  cfg: ClawdbotConfig;
  accountId: string;
  chatId: string;
  senderOpenId: string;
  messageId?: string;
  content: string;
  isGroup: boolean;
  log?: (msg: string) => void;
};

function resolveTarget(ctx: SalesDbQueryContext): string {
  return ctx.isGroup ? `chat:${ctx.chatId}` : `user:${ctx.senderOpenId}`;
}

async function sendWorkflowReply(ctx: SalesDbQueryContext, text: string): Promise<void> {
  await sendMessageFeishu({
    cfg: ctx.cfg,
    to: resolveTarget(ctx),
    text,
    replyToMessageId: ctx.messageId,
    accountId: ctx.accountId,
  });
}

export { createTempSalesDbForTest, parseSalesDbQueryRequest };

export function querySalesDbForTest(
  dbPath: string,
  request: ReturnType<typeof parseSalesDbQueryRequest> extends infer T ? Exclude<T, null> : never,
) {
  return queryJiuyanSalesDb(dbPath, request);
}

export async function maybeHandleSalesDbQueryWorkflow(ctx: SalesDbQueryContext): Promise<boolean> {
  return await handleJiuyanSalesDbQueryMessage({
    content: ctx.content,
    adapter: {
      sendText: (text) => sendWorkflowReply(ctx, text),
      sendFile: async () => {
        throw new Error("sales db query does not send files");
      },
      log: ctx.log,
      logPrefix: `feishu[${ctx.accountId}]`,
    },
  });
}
