import { Api } from 'telegram';
import Telegram from '../client/Telegram';
import OicqClient from '../client/OicqClient';
import ConfigService from '../services/ConfigService';
import { config } from '../providers/userConfig';
import regExps from '../constants/regExps';
import forwardPairs from '../providers/forwardPairs';
import { GroupMessageEvent, PrivateMessageEvent } from 'oicq';

export default class ConfigController {
  private readonly configService: ConfigService;
  private readonly createPrivateMessageGroupBlockList = new Map<number, Promise<void>>();

  constructor(private readonly tgBot: Telegram,
              private readonly tgUser: Telegram,
              private readonly oicq: OicqClient) {
    this.configService = new ConfigService(tgBot, tgUser, oicq);
    tgBot.addNewMessageEventHandler(this.handleMessage);
    tgBot.addNewServiceMessageEventHandler(this.handleServiceMessage);
    oicq.addNewMessageEventHandler(this.handleQqMessage);
    this.configService.configCommands();
    config.workMode === 'personal' && this.configService.setupFilter();
  }

  private handleMessage = async (message: Api.Message) => {
    if (!message.sender.id.eq(config.owner)) {
      return false;
    }
    const messageSplit = message.message.split(' ');
    if (message.isGroup) {
      if (messageSplit.length === 2 && messageSplit[0].startsWith('/start') && regExps.roomId.test(messageSplit[1])) {
        await this.configService.createLinkGroup(Number(messageSplit[1]), Number(message.chat.id));
        return true;
      }
      else
        return false;
    }
    else if (message.isPrivate) {
      if (config.workMode === 'personal') {
        switch (messageSplit[0]) {
          case '/addfriend':
            await this.configService.addFriend();
            return true;
          case '/addgroup':
            await this.configService.addGroup();
            return true;
        }
      }
      else {
        switch (messageSplit[0]) {
          case '/add':
            // 加的参数永远是正的群号
            if (messageSplit.length === 3 && regExps.qq.test(messageSplit[1]) && !isNaN(Number(messageSplit[2]))) {
              await this.configService.createLinkGroup(-Number(messageSplit[1]), Number(messageSplit[2]));
            }
            else if (messageSplit[1] && regExps.qq.test(messageSplit[1])) {
              await this.configService.addExact(Number(messageSplit[1]));
            }
            else {
              await this.configService.addGroup();
            }
            return true;
        }
      }
    }
  };

  private handleServiceMessage = async (message: Api.MessageService) => {
    if (message.action instanceof Api.MessageActionChatMigrateTo) {
      const pair = forwardPairs.find((message.peerId as Api.PeerChat).chatId);
      if (!pair) return;
      pair.tg = await this.tgBot.getChat(message.action.channelId);
    }
  };

  private handleQqMessage = async (message: GroupMessageEvent | PrivateMessageEvent) => {
    if (message.message_type !== 'private') return false;
    const pair = forwardPairs.find(message.friend);
    if (pair) return false;
    // 如果正在创建中，应该阻塞
    let promise = this.createPrivateMessageGroupBlockList.get(message.from_id);
    if (promise) {
      await promise;
      return false;
    }
    // 有未创建转发群的新私聊消息时自动创建
    promise = this.configService.createGroupAndLink(message.from_id, message.friend.remark || message.friend.nickname, true);
    this.createPrivateMessageGroupBlockList.set(message.from_id, promise);
    await promise;
    return false;
  };
}