import { Telegram } from '../client/Telegram';
import { BigInteger } from 'big-integer';
import { Api } from 'telegram';

export default class WaitForInputHelper {
  // BugInteger 好像不能用 === 判断，Telegram 的 ID 还没有超过 number
  private map = new Map<number, (event: Api.Message) => any>();

  constructor(private tg: Telegram) {
    tg.addNewMessageEventHandler(e => {
      const handler = this.map.get(Number(e.chat.id));
      if (handler) {
        this.map.delete(Number(e.chat.id));
        handler(e);
      }
    });
  }

  public waitForInput(chatId: BigInteger | number) {
    return new Promise<Api.Message>(resolve => {
      chatId = Number(chatId);
      console.log(chatId);
      this.map.set(chatId, resolve);
    });
  }

  public cancel(chatId: BigInteger | number | string) {
    this.map.delete(Number(chatId));
  }
}
