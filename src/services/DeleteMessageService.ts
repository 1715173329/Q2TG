import Telegram from '../client/Telegram';
import OicqClient from '../client/OicqClient';
import { getLogger } from 'log4js';
import { Api } from 'telegram';
import { Pair } from '../providers/forwardPairs';
import { config } from '../providers/userConfig';
import db from '../providers/db';
import { Friend, FriendRecallEvent, GroupRecallEvent } from 'oicq';

export default class DeleteMessageService {
  private log = getLogger('DeleteMessageService');

  constructor(private readonly tgBot: Telegram,
              private readonly oicq: OicqClient) {
  }

  async telegramDeleteMessage(messageId: number, pair: Pair, isOthersMsg = false) {
    // 删除的时候会返回记录
    try {
      const messageInfo = await db.message.delete({
        where: { tgChatId_tgMsgId: { tgChatId: pair.tgId, tgMsgId: messageId } },
      });
      if (messageInfo) {
        try {
          const success = await pair.qq.recallMsg(messageInfo.seq, messageInfo.rand,
            pair.qq instanceof Friend ? messageInfo.time : messageInfo.pktnum);
          if (!success) throw new Error();
        }
        catch (e) {
          console.log(123);
          const tipMsg = await pair.tg.sendMessage({
            message: '撤回 QQ 中对应的消息失败' +
              (config.workMode === 'group' ? '，QQ Bot 需要是管理员' : '') +
              (isOthersMsg ? '，而且无法撤回其他管理员的消息' : '') +
              (e.message ? '\n' + e.message : ''),
            silent: true,
          });
          config.workMode === 'group' && setTimeout(async () => await tipMsg.delete({ revoke: true }), 5000);
        }
      }
    }
    catch (e) {
      this.log.error('处理 Telegram 消息删除失败', e);
    }
  }

  /**
   * 处理 TG 里面发送的 /rm
   * @param message
   * @param pair
   */
  async handleTelegramMessageRm(message: Api.Message, pair: Pair) {
    const replyMessage = await message.getReplyMessage();
    if (replyMessage instanceof Api.Message) {
      // 检查权限并撤回被回复的消息
      let hasPermission = config.workMode === 'personal' || replyMessage.senderId?.eq(message.senderId);
      if (!hasPermission && message.chat instanceof Api.Channel) {
        // 可能是超级群
        try {
          const member = (await pair.tg.getMember(message.sender)).participant;
          hasPermission = member instanceof Api.ChannelParticipantCreator ||
            (member instanceof Api.ChannelParticipantAdmin && member.adminRights.deleteMessages);
        }
        catch (e) {
          // 不管了
        }
      }
      if (!hasPermission && message.chat instanceof Api.Chat) {
        // 不是超级群，我也不知道怎么判断，而且应该用不到
      }
      if (hasPermission) {
        // 双平台撤回被回复的消息
        // 撤回 QQ 的
        await this.telegramDeleteMessage(message.replyToMsgId, pair, replyMessage.senderId?.eq(this.tgBot.me.id));
        try {
          // 撤回 TG 的
          await pair.tg.deleteMessages(message.replyToMsgId);
        }
        catch (e) {
          await pair.tg.sendMessage(`删除消息失败：${e.message}`);
        }
      }
      else {
        const tipMsg = await pair.tg.sendMessage({
          message: '不能撤回别人的消息',
          silent: true,
        });
        setTimeout(async () => await tipMsg.delete({ revoke: true }), 5000);
      }
    }
    // 撤回消息本身
    try {
      await message.delete({ revoke: true });
    }
    catch (e) {
      const tipMsg = await message.reply({
        message: 'Bot 目前无法撤回其他用户的消息，Bot 需要「删除消息」权限',
        silent: true,
      });
      setTimeout(async () => await tipMsg.delete({ revoke: true }), 5000);
    }
  }

  public async handleQqRecall(event: FriendRecallEvent | GroupRecallEvent, pair: Pair) {
    try {
      const message = await db.message.findFirst({
        where: {
          seq: event.seq,
          rand: event.rand,
          qqRoomId: pair.qqRoomId,
        },
      });
      if (message) {
        await pair.tg.deleteMessages(message.tgMsgId);
      }
    }
    catch (e) {
      this.log.error('处理 QQ 消息撤回失败', e);
    }
  }
}