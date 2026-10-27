import { AppError } from "../../core/http";

export class OpenWaClient {
  constructor(private baseUrl: string, private key: string) {}
  async whileTyping<T>(session: string, chatId: string, work: () => Promise<T>): Promise<T> {
    let pending: Promise<void> | undefined;
    const presence = (state: "typing" | "paused") => this.call(`/sessions/${session}/chats/typing`, "POST", { chatId, state }, undefined, 3000).then(() => {}, () => {});
    // Presence is best effort: an unsupported or offline gateway must not block reports.
    const refresh = () => { if (!pending) pending = presence("typing").finally(() => { pending = undefined; }); };
    refresh();
    const timer = setInterval(refresh, 8000);
    try { return await work(); }
    finally { clearInterval(timer); await pending; await presence("paused"); }
  }
  async call<T = any>(path: string, method = "GET", body?: unknown, idempotencyKey?: string, timeoutMs = 35000): Promise<T> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/api${path}`, {
      method, headers: { "content-type": "application/json", "X-API-Key": this.key, ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeoutMs), redirect: "error",
    });
    if (!res.ok) throw new AppError(res.status === 501 ? 501 : 502, `OpenWA request failed (${res.status}). Check gateway connectivity, permissions, and session status.`);
    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }
  async text(session: string, chatId: string, text: string, key: string, quote?: string) {
    return this.call(`/sessions/${session}/messages/${quote ? "reply" : "send-text"}`, "POST", { chatId, text: text.slice(0, 4096), ...(quote ? { quotedMessageId: quote } : {}) }, key);
  }
  async interactive(session: string, route: "send-list" | "send-buttons", body: Record<string, unknown>, fallback: string, key: string, quote?: string) {
    try { return await this.call(`/sessions/${session}/messages/${route}`, "POST", body, key); }
    catch (e) {
      // Only a definite unsupported-engine response is safe to replace; timeouts may have delivered.
      if (!(e instanceof AppError) || e.status !== 501) throw e;
      return this.text(session, String(body.chatId), fallback, `${key}:text`, quote);
    }
  }
}
