import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHmac, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { bootApp, invite, signUp, type TestApp, type TestUser } from "./harness";
import { DB, type Db } from "../src/core/database/database";
import { whatsappConnections, whatsappDrafts, whatsappEvents, workItems } from "../src/core/database/schema";
import { WhatsappService } from "../src/modules/whatsapp/whatsapp.service";
import { decrypt } from "../src/modules/github/crypto";
import { triage } from "../src/modules/whatsapp/triage";
import { OpenWaClient } from "../src/modules/whatsapp/client";

let app: TestApp, owner: TestUser, member: TestUser, outsider: TestUser;
let org: string, foreignOrg: string, orgId: string, project: any, sessionId: string;
let db: Db, wa: WhatsappService, webhookSecret: string;
const phone = "919876543210";
const proposal = { type: "task", title: "Fix password reset", description: "Reset links fail.\n\n- [ ] Reset links open successfully", priority: "high", category: "bug", parentId: null, duplicateId: null, reason: "One actionable defect" };
let remoteCalls: { url: string; body: any; method: string }[] = [];

function mockRemote(providerMode: "valid" | "fallback" | "all-fail" = "valid") {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    remoteCalls.push({ url: String(url), body, method: init?.method ?? "GET" });
    if (String(url).startsWith("https://ollama.com")) return providerMode === "all-fail" ? new Response("", { status: 503 }) : Response.json({ message: { content: providerMode === "fallback" ? '{"type":"unknown"}' : JSON.stringify(proposal) } });
    if (String(url).startsWith("https://generativelanguage.googleapis.com")) return providerMode === "all-fail" ? new Response("", { status: 429 }) : Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(proposal) }] } }] });
    if (String(url).startsWith("https://api.x.ai")) return providerMode === "all-fail" ? new Response("", { status: 503 }) : Response.json({ choices: [{ message: { content: JSON.stringify(proposal) } }] });
    if (String(url).endsWith("/sessions") && init?.method === "POST") return Response.json({ id: sessionId, name: body.name });
    if (String(url).endsWith("/sessions")) return Response.json([]);
    if (String(url).endsWith("/webhooks")) return Response.json({ id: randomUUID() });
    if (String(url).endsWith("/qr")) return Response.json({ qrCode: "data:image/png;base64,TEST", status: "qr_ready" });
    return Response.json({ id: sessionId, name: "team-support", status: "qr_ready", engineLoaded: true, messageId: "outbound-1" });
  }));
}

beforeAll(async () => {
  app = await bootApp();
  ({ user: owner, org } = await signUp(app));
  ({ user: outsider, org: foreignOrg } = await signUp(app));
  member = await invite(app, owner, org, "wa-member@test.dev", "member");
  project = (await owner.api(org).post("/api/projects").send({ key: "APP", name: "Application" })).body;
  orgId = (await owner.api(org).get("/api/org")).body.id;
  sessionId = randomUUID();
  db = app.moduleRef.get(DB); wa = app.moduleRef.get(WhatsappService);
  mockRemote();
  await owner.api(org).put("/api/whatsapp/settings").send({ baseUrl: "http://gateway.test:2785", apiKey: "test-gateway-key", callbackUrl: "http://mixedlane.test:3001", providers: { ollama: { model: "ollama-test", apiKey: "ollama-secret" }, gemini: { model: "gemini-test", apiKey: "gemini-secret" }, grok: { model: "grok-test", apiKey: "grok-secret" } } }).expect(200);
  await owner.api(org).post("/api/whatsapp/sessions").send({ name: "team-support" }).expect(201);
  await owner.api(org).put("/api/whatsapp/contacts").send({ phone: `+${phone}`, userId: member.id }).expect(200);
  webhookSecret = (await db.select().from(whatsappConnections).where(eq(whatsappConnections.orgId, orgId)))[0].webhookSecret;
});
afterAll(async () => { vi.unstubAllGlobals(); if (app) await app.app.close(); });
afterEach(() => { remoteCalls = []; mockRemote(); });

async function webhook(body: any, signature?: string) {
  const raw = JSON.stringify(body);
  return app.http().post(`/api/whatsapp/webhook/${orgId}/${sessionId}`).set("content-type", "application/json").set("x-openwa-signature", signature ?? `sha256=${createHmac("sha256", webhookSecret).update(raw).digest("hex")}`).send(raw);
}
function message(extra: Record<string, unknown> = {}) { return { event: "message.received", sessionId, data: { id: randomUUID(), from: `${phone}@c.us`, chatId: `${phone}@c.us`, body: "Password reset fails", fromMe: false, ...extra } }; }
async function ingest(body = message()) {
  await webhook(body).then((r) => expect(r.status).toBe(202));
  const [event] = await db.select().from(whatsappEvents).where(eq(whatsappEvents.eventKey, (await import("node:crypto")).createHash("sha256").update(body.data.id).digest("hex")));
  await wa.processEvent(event.id);
  return (await db.select().from(whatsappDrafts).where(eq(whatsappDrafts.messageId, body.data.id)))[0];
}

describe("WhatsApp integration", () => {
  it("restricts settings, accounts, QR codes, and sender mappings to admins", async () => {
    for (const path of ["settings", "sessions", `sessions/${sessionId}/qr`, "contacts"]) await member.api(org).get(`/api/whatsapp/${path}`).expect(403);
    await outsider.api(foreignOrg).get(`/api/whatsapp/sessions/${sessionId}/qr`).expect(404);
    await owner.api(org).get(`/api/whatsapp/sessions/${sessionId}/qr`).expect(200);
    expect(remoteCalls.some((c) => c.url.endsWith("/webhooks") && c.body?.events?.includes("message.received"))).toBe(true);
  });
  it("encrypts all API keys and never returns credentials or signing secrets", async () => {
    const [stored] = await db.select().from(whatsappConnections).where(eq(whatsappConnections.orgId, orgId));
    expect(stored.apiKeyEnc).not.toContain("test-gateway-key");
    expect(decrypt(stored.apiKeyEnc)).toBe("test-gateway-key");
    expect(stored.providersEnc).not.toContain("ollama-secret");
    const res = await owner.api(org).get("/api/whatsapp/settings").expect(200);
    expect(res.body.providers.ollama).toEqual({ model: "ollama-test", configured: true });
    expect(JSON.stringify(res.body)).not.toContain(webhookSecret);
    expect(JSON.stringify(res.body)).not.toContain("ollama-secret");
  });
  it("rejects invalid signatures and mismatched session envelopes", async () => {
    await webhook(message(), "sha256=bad").then((r) => expect(r.status).toBe(401));
    await webhook({ ...message(), sessionId: randomUUID() }).then((r) => expect(r.status).toBe(400));
  });
  it("ignores groups, outgoing messages, and unlinked phone numbers", async () => {
    for (const data of [{ chatId: "12345@g.us" }, { fromMe: true }, { chatId: "919999999999@c.us" }]) {
      const body = message(data); await webhook(body).then((r) => expect(r.status).toBe(202));
      const eventList = await db.select().from(whatsappEvents);
      const event = eventList.find((e) => (e.payload as any).messageId === body.data.id);
      if (event) await wa.processEvent(event.id);
      expect(await db.select().from(whatsappDrafts).where(eq(whatsappDrafts.messageId, body.data.id))).toHaveLength(0);
    }
  });
  it("deduplicates repeated signed deliveries and generates a structured proposal", async () => {
    const body = message();
    const draft = await ingest(body);
    await webhook(body); await webhook(body);
    await wa.generate(orgId, draft.id);
    const ready = await wa.draft(orgId, draft.id);
    expect(ready).toMatchObject({ status: "review", provider: "ollama", proposal });
    expect(await db.select().from(whatsappDrafts).where(eq(whatsappDrafts.messageId, body.data.id))).toHaveLength(1);
    await wa.notify(orgId, draft.id);
    expect(remoteCalls.some((c) => c.url.endsWith("send-buttons") && c.body.buttons[0].id === `approve:${draft.id}`)).toBe(true);
  });
  it("falls back on invalid AI output and on provider HTTP errors in the requested order", async () => {
    const draft = await ingest(); mockRemote("fallback");
    await wa.generate(orgId, draft.id);
    expect((await wa.draft(orgId, draft.id)).provider).toBe("gemini");
    const original = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: any, init: any) => String(url).startsWith("https://api.x.ai") ? Response.json({ choices: [{ message: { content: JSON.stringify(proposal) } }] }) : new Response("", { status: 503 })));
    const result = await triage({ report: "Reset fails", project, items: [] }, { ollama: { model: "a", apiKey: "a" }, gemini: { model: "b", apiKey: "b" }, grok: { model: "c", apiKey: "c" } });
    expect(result.provider).toBe("grok");
    vi.stubGlobal("fetch", original);
  });
  it("keeps reports retryable when every AI provider fails", async () => {
    const draft = await ingest(); mockRemote("all-fail"); await wa.generate(orgId, draft.id);
    expect(await wa.draft(orgId, draft.id)).toMatchObject({ status: "failed", proposal: null });
    await owner.api(org).post(`/api/whatsapp/drafts/${draft.id}/review`).send({ action: "retry" }).expect(201);
    expect((await wa.draft(orgId, draft.id)).status).toBe("generating");
  });
  it("creates only one ticket when the sender and admin approve concurrently", async () => {
    const draft = await ingest(); await wa.generate(orgId, draft.id);
    const responses = await Promise.all([member.api(org).post(`/api/whatsapp/drafts/${draft.id}/review`).send({ action: "approve" }), owner.api(org).post(`/api/whatsapp/drafts/${draft.id}/review`).send({ action: "approve" })]);
    expect(responses.map((r) => r.status)).toEqual([201, 201]);
    expect(responses[0].body.itemId).toBe(responses[1].body.itemId);
    const items = await db.select().from(workItems).where(and(eq(workItems.projectId, project.id), eq(workItems.title, proposal.title)));
    expect(items).toHaveLength(1);
    expect(items[0].labels).toEqual(["bug", "whatsapp"]);
  });
  it("rejects cross-organization approvals and lets the sender cancel", async () => {
    const draft = await ingest(); await wa.generate(orgId, draft.id);
    await outsider.api(foreignOrg).post(`/api/whatsapp/drafts/${draft.id}/review`).send({ action: "approve" }).expect(404);
    await member.api(org).post(`/api/whatsapp/drafts/${draft.id}/review`).send({ action: "cancel" }).expect(201);
    expect((await wa.draft(orgId, draft.id)).status).toBe("cancelled");
  });
  it("uses list menus when more than one project is available", async () => {
    await owner.api(org).post("/api/projects").send({ key: "WEB", name: "Website" }).expect(201);
    const d = await ingest(); expect(d.status).toBe("select_project");
    expect(remoteCalls.some((c) => c.url.endsWith("send-list") && c.body.sections[0].rows.length === 2)).toBe(true);
    await ingest(message({ body: `project:${d.id}:${project.id}` }));
    expect((await wa.draft(orgId, d.id)).status).toBe("generating");
  });
  it("routes to a configured project, remembers choices when enabled, and can ask again", async () => {
    const settings = (await owner.api(org).get("/api/whatsapp/settings")).body;
    const save = (defaultProjectId: string | null, askProjectEveryTime: boolean) => owner.api(org).put("/api/whatsapp/settings").send({ ...settings, defaultProjectId, askProjectEveryTime });
    await save(project.id, true).expect(200);
    expect(await ingest()).toMatchObject({ projectId: project.id, status: "generating" });
    const web = (await owner.api(org).get("/api/projects")).body.find((p: any) => p.key === "WEB");
    expect(await ingest(message({ body: "WEB Another report" }))).toMatchObject({ projectId: web.id, report: "Another report" });
    await owner.api(org).patch(`/api/projects/${project.key}/access`).send({ defaultRole: "viewer" }).expect(200);
    expect((await ingest()).projectId).not.toBe(project.id);
    await owner.api(org).patch(`/api/projects/${project.key}/access`).send({ defaultRole: "editor" }).expect(200);
    await ingest(message({ body: "APP Remember this project" }));
    await save(null, false).expect(200);
    expect(await ingest()).toMatchObject({ projectId: project.id, status: "generating" });
    await save(null, true).expect(200);
    expect((await ingest()).status).toBe("select_project");
    const foreign = (await outsider.api(foreignOrg).post("/api/projects").send({ key: "EXT", name: "Foreign" })).body;
    await save(foreign.id, true).expect(404);
  });
  it("sends typing and clears it after successful and failed generation", async () => {
    for (const mode of ["valid", "all-fail"] as const) {
      const draft = await ingest(message({ body: "APP Password reset fails" }));
      mockRemote(mode);
      await wa.generate(orgId, draft.id);
      const presence = remoteCalls.filter((c) => c.url.endsWith("/chats/typing"));
      expect(presence.at(-2)?.body).toEqual({ chatId: `${phone}@c.us`, state: "typing" });
      expect(presence.at(-1)?.body.state).toBe("paused");
    }
  });
  it("treats unsupported presence as best effort and cleans up on errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 501 })));
    const client = new OpenWaClient("http://gateway.test", "key");
    await expect(client.whileTyping(sessionId, `${phone}@c.us`, async () => "ok")).resolves.toBe("ok");
    await expect(client.whileTyping(sessionId, `${phone}@c.us`, async () => { throw new Error("work failed"); })).rejects.toThrow("work failed");
  });
  it("refreshes typing during long processing and stops refreshing when finished", async () => {
    const states: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      states.push(JSON.parse(String(init.body)).state);
      return Response.json({ ok: true });
    }));
    vi.useFakeTimers();
    try {
      let finish!: () => void;
      const running = new OpenWaClient("http://gateway.test", "key").whileTyping(sessionId, `${phone}@c.us`, () => new Promise<void>((resolve) => { finish = resolve; }));
      await vi.advanceTimersByTimeAsync(16000);
      finish(); await running;
      expect(states).toEqual(["typing", "typing", "typing", "paused"]);
      await vi.advanceTimersByTimeAsync(16000);
      expect(states).toHaveLength(4);
    } finally { vi.useRealTimers(); }
  });
  it("uses OpenAI and custom chat completions with the configured model and key", async () => {
    for (const provider of ["openai", "custom"] as const) {
      const url = provider === "openai" ? "https://api.openai.com/v1/chat/completions" : "http://custom.test/v1/chat/completions";
      const fetchMock = vi.fn(async () => Response.json({ choices: [{ message: { content: JSON.stringify(proposal) } }] }));
      vi.stubGlobal("fetch", fetchMock);
      const result = await triage({ report: "Reset fails", project, items: [] }, { [provider]: { model: "test-model", apiKey: "test-secret", url } });
      expect(result.provider).toBe(provider);
      expect(fetchMock.mock.calls[0]).toMatchObject([url, { headers: { authorization: "Bearer test-secret" } }]);
      expect(JSON.parse(String((fetchMock.mock.calls[0] as any)[1].body)).model).toBe("test-model");
    }
  });
  it("saves custom credentials securely and rejects invalid endpoint URLs", async () => {
    const settings = (await owner.api(org).get("/api/whatsapp/settings")).body;
    const input = { ...settings, providers: { ...settings.providers, custom: { model: "custom-model", apiKey: "custom-secret", url: "https://custom.test/v1/chat/completions" }, openai: { model: "openai-model", apiKey: "openai-secret" } } };
    const res = await owner.api(org).put("/api/whatsapp/settings").send(input).expect(200);
    expect(res.body.providers.custom).toEqual({ model: "custom-model", configured: true, url: input.providers.custom.url });
    expect(JSON.stringify(res.body)).not.toContain("custom-secret");
    const [stored] = await db.select().from(whatsappConnections).where(eq(whatsappConnections.orgId, orgId));
    expect(stored.providersEnc).not.toContain("custom-secret");
    for (const url of ["file:///tmp/test", "https://user:pass@custom.test/v1", "https://custom.test/v1?key=secret"]) {
      await owner.api(org).put("/api/whatsapp/settings").send({ ...input, providers: { ...input.providers, custom: { ...input.providers.custom, url } } }).expect(400);
    }
  });
  it("falls back to a quoted text reply for an unsupported interactive engine", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => { calls.push(url); return url.endsWith("send-buttons") ? new Response("", { status: 501 }) : Response.json({ messageId: "ok" }); }));
    await new OpenWaClient("http://gateway.test", "key").interactive(sessionId, "send-buttons", { chatId: `${phone}@c.us` }, "approve draft", "test-idem", "original-message");
    expect(calls).toEqual([`http://gateway.test/api/sessions/${sessionId}/messages/send-buttons`, `http://gateway.test/api/sessions/${sessionId}/messages/reply`]);
  });
  it("handles OpenWA button IDs instead of treating the button label as a new report", async () => {
    const draft = await ingest(message({ body: "APP Reset still fails" })); await wa.generate(orgId, draft.id);
    await ingest(message({ body: "Cancel", button: { id: `cancel:${draft.id}`, text: "Cancel" } }));
    expect((await wa.draft(orgId, draft.id)).status).toBe("cancelled");
  });
  it("refines an existing draft when the sender quotes its preview", async () => {
    const draft = await ingest(message({ body: "APP Reset fails on Android" })); await wa.generate(orgId, draft.id); await wa.notify(orgId, draft.id);
    await ingest(message({ body: "Only happens on Android 16", quotedMessage: { id: "outbound-1" } }));
    const edited = await wa.draft(orgId, draft.id);
    expect(edited.status).toBe("generating"); expect(edited.report).toContain("Android 16");
  });
  it("rechecks current project permissions before creating an approved ticket", async () => {
    const draft = await ingest(message({ body: "APP Reset fails with long passwords" })); await wa.generate(orgId, draft.id);
    await owner.api(org).patch(`/api/projects/${project.key}/access`).send({ defaultRole: "viewer" }).expect(200);
    await member.api(org).post(`/api/whatsapp/drafts/${draft.id}/review`).send({ action: "approve" }).expect(403);
    await owner.api(org).patch(`/api/projects/${project.key}/access`).send({ defaultRole: "editor" }).expect(200);
    expect((await wa.draft(orgId, draft.id)).status).toBe("review");
  });
  it("rejects AI parents and duplicates outside the selected project", async () => {
    const base = { report: "Broken reset", project, items: [] };
    const { validateProposal } = await import("../src/modules/whatsapp/triage");
    expect(() => validateProposal({ ...proposal, type: "subtask", parentId: randomUUID() }, base)).toThrow("unknown parent");
    expect(() => validateProposal({ ...proposal, type: "subtask" }, base)).toThrow("invalid hierarchy");
    expect(() => validateProposal({ ...proposal, duplicateId: randomUUID() }, base)).toThrow("unknown duplicate");
  });
});
