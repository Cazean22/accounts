import { Session } from "./session.ts";

export interface MessageData {
  from?: string;
  subject?: string;
  body?: string;
  html?: string;
}

export class Message {
  fromAddr: string;
  subject: string;
  body: string;
  htmlBody: string;

  constructor(data: MessageData) {
    this.fromAddr = data.from ?? "";
    this.subject = data.subject ?? "";
    this.body = data.body ?? "";
    this.htmlBody = data.html ?? "";
  }
}

export class EMail {
  private s: Session;
  address = "";
  private token = "";

  private constructor(s: Session) {
    this.s = s;
  }

  static async create(proxy?: string): Promise<EMail> {
    const s = await Session.create({ proxy });
    const inbox = new EMail(s);

    const res = await s.post("https://api.tempmail.lol/v2/inbox/create", {
      json: {},
    });
    if (!res.ok) {
      throw new Error(`TempMail create failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as { address: string; token: string };
    inbox.address = data.address;
    inbox.token = data.token;
    console.log(`[+] 生成邮箱: ${inbox.address} (TempMail.lol)`);
    console.log(`[*] 自动轮询已启动（token 已保存）`);
    return inbox;
  }

  async getMessages(): Promise<MessageData[]> {
    const res = await this.s.get(
      `https://api.tempmail.lol/v2/inbox?token=${this.token}`,
    );
    if (!res.ok) {
      throw new Error(`TempMail inbox failed: ${res.status}`);
    }
    const data = (await res.json()) as { emails?: MessageData[] };
    return data.emails ?? [];
  }

  async waitForMessage(
    timeout = 600_000,
    filterFn?: (msg: Message) => boolean,
  ): Promise<Message> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const msgs = await this.getMessages();
      for (const msgData of msgs) {
        const msg = new Message(msgData);
        if (!filterFn || filterFn(msg)) {
          console.log(`[+] 收到匹配邮件: ${msg.subject}`);
          return msg;
        }
      }
      await Bun.sleep(5000);
    }
    throw new Error("[-] 10 分钟内未收到 OpenAI 验证码");
  }
}
