import Telegram from '../client/Telegram';
import { Friend, FriendInfo, Group } from 'oicq';
import { config } from '../providers/userConfig';
import { Button } from 'telegram/tl/custom/button';
import { getLogger } from 'log4js';
import { getAvatar } from '../utils/urls';
import { CustomFile } from 'telegram/client/uploads';
import db from '../providers/db';
import { Api, utils } from 'telegram';
import commands from '../constants/commands';
import OicqClient from '../client/OicqClient';
import { md5B64 } from '../utils/hashing';
import TelegramChat from '../client/TelegramChat';
import forwardPairs from '../providers/forwardPairs';

const DEFAULT_FILTER_ID = 114; // 514

export default class ConfigService {
  private owner: Promise<TelegramChat>;
  private log = getLogger('ConfigService');
  private filter: Api.DialogFilter;

  constructor(private readonly tgBot: Telegram,
              private readonly tgUser: Telegram,
              private readonly oicq: OicqClient) {
    this.owner = tgBot.getChat(config.owner);
  }

  private getAssociateLink(roomId: number) {
    return `https://t.me/${this.tgBot.me.username}?startgroup=${roomId}`;
  }

  public async configCommands() {
    await this.tgBot.setCommands([], new Api.BotCommandScopeUsers());
    await this.tgBot.setCommands(
      config.workMode === 'personal' ? commands.personalPrivateCommands : commands.groupPrivateCommands,
      new Api.BotCommandScopePeer({
        peer: (await this.owner).inputPeer,
      }),
    );
  }

  // region 打开添加关联的菜单

  // 开始添加转发群组流程
  public async addGroup() {
    const qGroups = Array.from(this.oicq.gl).map(e => e[1]);
    const buttons = qGroups.map(e =>
      config.workMode === 'personal' ?
        [Button.inline(
          `${e.group_name} (${e.group_id})`,
          this.tgBot.registerCallback(() => this.createGroupAndLink(-e.group_id, e.group_name)),
        )] :
        [Button.url(
          `${e.group_name} (${e.group_id})`,
          this.getAssociateLink(-e.group_id),
        )]);
    await (await this.owner).createPaginatedInlineSelector(
      '选择 QQ 群组' + (config.workMode === 'group' ? '\n然后选择在 TG 中的群组' : ''), buttons);
  }

  // 只可能是 personal 运行模式
  public async addFriend() {
    const classes = Array.from(this.oicq.classes);
    const friends = Array.from(this.oicq.fl).map(e => e[1]);
    classes.sort((a, b) => {
      if (a[1] < b[1]) {
        return -1;
      }
      else if (a[1] == b[1]) {
        return 0;
      }
      else {
        return 1;
      }
    });
    await (await this.owner).createPaginatedInlineSelector('选择分组', classes.map(e => [
      Button.inline(e[1], this.tgBot.registerCallback(
        () => this.openFriendSelection(friends.filter(f => f.class_id === e[0]), e[1]),
      )),
    ]));
  }

  private async openFriendSelection(clazz: FriendInfo[], name: string) {
    await (await this.owner).createPaginatedInlineSelector(`选择 QQ 好友\n分组：${name}`, clazz.map(e => [
      Button.inline(`${e.remark || e.nickname} (${e.user_id})`, this.tgBot.registerCallback(
        () => this.createGroupAndLink(e.user_id, e.remark || e.nickname),
      )),
    ]));
  }

  public async addExact(gin: number) {
    const group = this.oicq.gl.get(gin);
    let avatar: Buffer;
    try {
      avatar = await getAvatar(-group.group_id);
    }
    catch (e) {
      avatar = null;
      this.log.error(`加载 ${group.group_name} (${gin}) 的头像失败`, e);
    }
    const message = `${group.group_name}\n${group.group_id}\n${group.member_count} 名成员`;
    await (await this.owner).sendMessage({
      message,
      file: avatar ? new CustomFile('avatar.png', avatar.length, '', avatar) : undefined,
      buttons: Button.url('关联 Telegram 群组', this.getAssociateLink(-group.group_id)),
    });
  }

  // endregion

  public async createGroupAndLink(roomId: number, title?: string, silent = false) {
    this.log.info(`创建群组并关联：${roomId}`);
    const qEntity = this.oicq.getChat(roomId);
    if (!title) {
      // TS 这边不太智能
      if (qEntity instanceof Friend) {
        title = qEntity.remark || qEntity.nickname;
      }
      else {
        title = qEntity.name;
      }
    }
    let isFinish = false;
    try {
      // 状态信息
      const status = !silent && await (await this.owner).sendMessage('正在创建 Telegram 群…');

      // 创建群聊，拿到的是 user 的 chat
      const chat = await this.tgUser.createChat({
        title,
        users: [this.tgBot.me.username],
      });

      // 设置管理员
      status && await status.edit({ text: '正在设置管理员…' });
      await chat.editAdmin(this.tgBot.me.username, true);
      const chatForBot = await this.tgBot.getChat(chat.id);

      // 添加到 Filter
      status && await status.edit({ text: '正在将群添加到文件夹…' });
      this.filter.includePeers.push(utils.getInputPeer(chat));
      await this.tgUser.updateDialogFilter({
        id: this.filter.id,
        filter: this.filter,
      });

      // 关闭【添加成员】快捷条
      status && await status.edit({ text: '正在关闭【添加成员】快捷条…' });
      await chat.hidePeerSettingsBar();

      // 对于私聊，默认解除静音
      if (roomId > 0) {
        status && await status.edit({ text: '正在解除静音…' });
        await chat.setNotificationSettings({ silent: false, showPreviews: true });
      }

      // 关联写入数据库
      status && await status.edit({ text: '正在写数据库…' });
      const dbPair = await forwardPairs.add(qEntity, chatForBot);
      isFinish = true;

      // 更新头像
      status && await status.edit({ text: '正在更新头像…' });
      const avatar = await getAvatar(roomId);
      const avatarHash = md5B64(avatar);
      await chatForBot.setProfilePhoto(avatar);
      await db.avatarCache.create({
        data: { forwardPairId: dbPair.id, hash: avatarHash },
      });

      // 更新关于文本
      status && await status.edit({ text: '正在更新关于文本…' });
      await chatForBot.editAbout(await this.getAboutText(qEntity));

      // 完成
      if (status) {
        await status.edit({ text: '正在获取链接…' });
        const { link } = await chat.getInviteLink();
        await status.edit({
          text: '创建完成！',
          buttons: Button.url('打开', link),
        });
      }
    }
    catch (e) {
      this.log.error('创建群组并关联失败', e);
      await (await this.owner).sendMessage(`创建群组并关联${isFinish ? '成功了但没完全成功' : '失败'}\n<code>${e}</code>`);
    }
  }

  public async createLinkGroup(qqRoomId: number, tgChatId: number) {
    let message: string;
    try {
      const qGroup = this.oicq.getChat(qqRoomId) as Group;
      const tgChat = await this.tgBot.getChat(tgChatId);
      message = `QQ群：${qGroup.group_id} (<code>${qGroup.group_id}</code>)已与 ` +
        `Telegram 群 ${(tgChat.entity as Api.Chat).title} (<code>${tgChatId}</code>)关联`;
      await forwardPairs.add(qGroup, tgChat);
    }
    catch (e) {
      message = `错误：<code>${e}</code>`;
    }
    await (await this.owner).sendMessage({ message });
  }

  // 创建 QQ 群组的文件夹
  public async setupFilter() {
    const result = await this.tgUser.getDialogFilters();
    this.filter = result.find(e => e.id === DEFAULT_FILTER_ID);
    if (!this.filter) {
      this.log.info('创建 TG 文件夹');
      // 要自己计算新的 id，随意 id 也是可以的
      // https://github.com/morethanwords/tweb/blob/7d646bc9a87d943426d831f30b69d61b743f51e0/src/lib/storages/filters.ts#L251
      // 创建
      this.filter = new Api.DialogFilter({
        id: DEFAULT_FILTER_ID,
        title: 'QQ',
        pinnedPeers: [
          (await this.tgUser.getChat(this.tgBot.me.username)).inputPeer,
        ],
        includePeers: [],
        excludePeers: [],
        emoticon: '🐧',
      });
      let errorText = '设置文件夹失败';
      try {
        const isSuccess = await this.tgUser.updateDialogFilter({
          id: DEFAULT_FILTER_ID,
          filter: this.filter,
        });
        if (!isSuccess) {
          this.filter = null;
          this.log.error(errorText);
          await (await this.owner).sendMessage(errorText);
        }
      }
      catch (e) {
        this.filter = null;
        this.log.error(errorText, e);
        await (await this.owner).sendMessage(errorText + `\n<code>${e}</code>`);
      }
    }
  }

  private async getAboutText(entity: Friend | Group) {
    let text = '';
    if (entity instanceof Friend) {
      text = `备注：${entity.remark}\n` +
        `昵称：${entity.nickname}\n` +
        `账号：${entity.user_id}`;
    }
    else {
      const owner = entity.pickMember(entity.info.owner_id);
      await owner.renew();
      const self = entity.pickMember(this.oicq.uin);
      await self.renew();
      text = `群名称：${entity.name}\n` +
        `${entity.info.member_count} 名成员\n` +
        `群号：${entity.group_id}\n` +
        (self ? `我的群名片：${self.title ? `【${self.title}】` : ''}${self.card}\n` : '') +
        (owner ? `群主：${owner.title ? `【${owner.title}】` : ''}${owner.card || owner.info.nickname} (${owner.user_id})` : '') +
        ((entity.is_admin || entity.is_owner) ? '\n可管理' : '');
    }

    return text + `\n\n由 @${this.tgBot.me.username} 管理`;
  }
}
