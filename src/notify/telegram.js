/**
 * Telegram notifier - fire and forget. Never throws, queues messages,
 * retries once on failure. Disabled when token/chat id are missing.
 */

import axios from 'axios';

export class TelegramNotifier {
  constructor({ botToken = '', chatId = '', enabled = true, logger = null } = {}) {
    this.botToken = botToken;
    this.chatId = chatId;
    this.enabled = enabled && Boolean(botToken && chatId);
    this.logger = logger;
    this.http = axios.create({ timeout: 10000 });
    this.queue = Promise.resolve();
  }

  /** Send (or queue) a text message. Long messages are split at 4096 chars. */
  send(text) {
    if (!this.enabled) return;
    const chunks = split(text, 4000);
    for (const chunk of chunks) {
      this.queue = this.queue.then(() => this._sendChunk(chunk)).catch(() => {});
    }
  }

  async _sendChunk(text) {
    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    try {
      await this.http.post(url, { chat_id: this.chatId, text, disable_web_page_preview: true });
    } catch (err) {
      const desc = err.response?.data?.description || err.message;
      this.logger?.warn(`Telegram send failed: ${desc} - retrying once`);
      await sleep(3000);
      try {
        await this.http.post(url, { chat_id: this.chatId, text, disable_web_page_preview: true });
      } catch (err2) {
        this.logger?.warn(`Telegram send failed permanently: ${err2.message}`);
      }
    }
  }
}

function split(text, max) {
  const out = [];
  let rest = String(text);
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut <= 0) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length) out.push(rest);
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
