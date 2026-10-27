import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { io, type Socket } from "socket.io-client";
import { AGENT_PERMISSIONS } from "@mixedlane/shared";
import { bootApp, invite, listen, settle, signUp, type TestApp, type TestUser } from "./harness";

let ctx: TestApp, owner: TestUser, member: TestUser, org: string;
let project: { id: string }, bot: { id: string }, key: string, otherKey: string;
let own: { id: string; key: string }, human: { id: string; key: string }, other: { id: string };
let ownPage: { id: string }, humanPage: { id: string }, otherPage: { id: string };
let client: Client;
const api = (secret = key) => ({
  get: (path: string) => ctx.http().get(path).set("authorization", `Bearer ${secret}`),
  post: (path: string) => ctx.http().post(path).set("authorization", `Bearer ${secret}`),
  patch: (path: string) => ctx.http().patch(path).set("authorization", `Bearer ${secret}`),
  delete: (path: string) => ctx.http().delete(path).set("authorization", `Bearer ${secret}`),
});
const tool = async (name: string, args: Record<string, unknown>) => {
  const result = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: { text: string }[] };
  return { ...result, data: result.isError ? result.content[0].text : JSON.parse(result.content[0].text) };
};

beforeAll(async () => {
  ctx = await bootApp();
  ({ user: owner, org } = await signUp(ctx));
  member = await invite(ctx, owner, org, "member@isolation.dev", "member");
  project = (await owner.api(org).post("/api/projects").send({ name: "Isolation", key: "ISO", itemTypes: ["story", "task"] }).expect(201)).body;
  for (const name of ["Bot one", "Bot two"]) {
    const created = (await owner.api(org).post("/api/agents").send({ name, projectId: project.id, docAccess: "write" }).expect(201)).body;
    expect(created.agent).toMatchObject({ itemScope: "own", pageScope: "own" });
    await owner.api(org).put(`/api/agents/${created.agent.id}/grants`).send({ projectId: project.id, permissions: [...AGENT_PERMISSIONS] }).expect(200);
    if (!key) { bot = created.agent; key = created.key.secret; } else otherKey = created.key.secret;
  }
  own = (await api().post("/api/items").send({ projectId: project.id, type: "story", title: "Isolation own story" }).expect(201)).body;
  human = (await owner.api(org).post("/api/items").send({ projectId: project.id, type: "story", title: "Isolation human secret" }).expect(201)).body;
  other = (await api(otherKey).post("/api/items").send({ projectId: project.id, type: "story", title: "Isolation other agent" }).expect(201)).body;
  await owner.api(org).post("/api/spaces").send({ name: "Isolation docs", key: "SEC" }).expect(201);
  ownPage = (await api().post("/api/spaces/SEC/pages").send({ title: "Isolation own document", contentHtml: `<p>Isolation ${own.key} ${human.key}</p>` }).expect(201)).body;
  humanPage = (await owner.api(org).post("/api/spaces/SEC/pages").send({ title: "Isolation human document", contentHtml: `<p>Isolation ${own.key}</p>` }).expect(201)).body;
  otherPage = (await api(otherKey).post("/api/spaces/SEC/pages").send({ title: "Isolation other document" }).expect(201)).body;
  client = new Client({ name: "isolation-test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${await listen(ctx)}/api/mcp`), { requestInit: { headers: { authorization: `Bearer ${key}` } } }));
});
afterAll(async () => { await client?.close(); await ctx?.app.close(); });

describe("agent content isolation", () => {
  it("restricts item lists, boards, searches, counts and detail to the agent's creations", async () => {
    for (const path of [`/api/projects/${project.id}/items`, `/api/projects/${project.id}/tree`]) {
      expect((await api().get(path).expect(200)).body.map((i: { id: string }) => i.id)).toEqual([own.id]);
    }
    expect((await api().get("/api/search?q=Isolation")).body.items.map((i: { id: string }) => i.id)).toEqual([own.id]);
    expect((await api().get("/api/projects")).body[0].stats.total).toBe(1);
    for (const item of [human, other]) {
      for (const suffix of ["", "/comments", "/activity", "/pages", "/development"]) await api().get(`/api/items/${item.id}${suffix}`).expect(404);
      await api().patch(`/api/items/${item.id}`).send({ title: "Stolen" }).expect(404);
      await api().patch(`/api/items/${item.id}/move`).send({ status: "done", sortOrder: 1 }).expect(404);
      await api().post(`/api/items/${item.id}/comments`).send({ body: "Intrusion" }).expect(404);
      await api().delete(`/api/items/${item.id}`).expect(404);
    }
    await api().get(`/api/items/by-key/${human.key}`).expect(404);
    await api().post("/api/items").send({ projectId: project.id, type: "task", title: "Invalid parent", parentId: human.id }).expect(404);
    expect((await api().get(`/api/items/${own.id}`)).body.title).toBe("Isolation own story");
  });

  it("restricts document trees, search, history, writes and linked content", async () => {
    expect((await api().get("/api/spaces/SEC/pages")).body.map((p: { id: string }) => p.id)).toEqual([ownPage.id]);
    expect((await api().get("/api/spaces")).body[0].pageCount).toBe(1);
    expect((await tool("search_docs", { query: "Isolation" })).data.map((p: { pageId: string }) => p.pageId)).toEqual([ownPage.id]);
    for (const page of [humanPage, otherPage]) {
      for (const suffix of ["", "/versions", "/versions/1"]) await api().get(`/api/pages/${page.id}${suffix}`).expect(404);
      await api().patch(`/api/pages/${page.id}`).send({ title: "Stolen", baseVersion: 1 }).expect(404);
      await api().delete(`/api/pages/${page.id}`).expect(404);
    }
    await api().post("/api/spaces/SEC/pages").send({ title: "Invalid parent", parentId: humanPage.id }).expect(404);
    expect((await api().get(`/api/items/${own.id}/pages`)).body.map((p: { id: string }) => p.id)).toEqual([ownPage.id]);
    expect((await api().get(`/api/pages/${ownPage.id}`)).body.linkedItems.map((i: { id: string }) => i.id)).toEqual([own.id]);
  });

  it("restricts media bytes to the uploading agent within allowed scopes", async () => {
    const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");
    for (const scope of [{ project: project.id }, { space: "SEC" }]) {
      const upload = (await api(otherKey).post("/api/uploads").field(Object.keys(scope)[0], Object.values(scope)[0]).attach("file", bytes, { filename: "secret.png", contentType: "image/png" }).expect(201)).body;
      await api().get(upload.url).expect(404);
      expect((await tool("read_media", { url: upload.url })).isError).toBe(true);
      await api(otherKey).get(upload.url).expect(200);
    }
  });

  it("enforces the same scope in MCP tools, resources and planning", async () => {
    expect((await tool("get_item", { key: human.key })).isError).toBe(true);
    expect((await tool("get_page", { id: humanPage.id })).isError).toBe(true);
    expect((await tool("search_items", { project: "ISO" })).data.items.map((i: { key: string }) => i.key)).toEqual([own.key]);
    expect((await tool("search_items", { query: "Isolation" })).data.map((i: { key: string }) => i.key)).toEqual([own.key]);
    const resources = await client.listResourceTemplates();
    const board = resources.resourceTemplates.find((r) => r.uriTemplate.includes("board"));
    expect(board).toBeDefined();
    const resource = await client.readResource({ uri: board!.uriTemplate.replace("{project}", "ISO") });
    expect(JSON.stringify(resource)).not.toContain("Isolation human secret");
    const plan = await tool("create_plan", { project: "ISO", items: [{ ref: "child", type: "task", title: "Intrusion", parent: human.key }], confirmed: true });
    expect(plan.isError).toBe(true);
  });

  it("blocks deletion cascades and hides foreign ancestors and children", async () => {
    const child = (await owner.api(org).post("/api/items").send({ projectId: project.id, type: "task", parentId: own.id, title: "Hidden child" }).expect(201)).body;
    expect((await api().get(`/api/items/${own.id}`)).body.children).toEqual([]);
    await api().delete(`/api/items/${own.id}`).expect(403);
    await owner.api(org).get(`/api/items/${child.id}`).expect(200);
    const pageChild = (await owner.api(org).post("/api/spaces/SEC/pages").send({ title: "Hidden child", parentId: ownPage.id }).expect(201)).body;
    await api().delete(`/api/pages/${ownPage.id}`).expect(403);
    await owner.api(org).get(`/api/pages/${pageChild.id}`).expect(200);
    await owner.api(org).post(`/api/pages/${ownPage.id}/move`).send({ parentId: humanPage.id }).expect(200);
    expect((await api().get(`/api/pages/${ownPage.id}`)).body).toMatchObject({ breadcrumbs: [], parentId: null });
  });

  it("filters realtime events and denies presence for other people's content", async () => {
    const socket: Socket = io(await listen(ctx), { path: "/api/socket", auth: { token: key }, transports: ["websocket"], reconnection: false });
    try {
      await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("connect_error", reject); });
      const events: unknown[] = [];
      socket.on("live", (event) => events.push(event));
      expect(await socket.emitWithAck("presence:join", { resource: `item:${human.id}` })).toMatchObject({ ok: false });
      expect(await socket.emitWithAck("presence:join", { resource: `page:${humanPage.id}` })).toMatchObject({ ok: false });
      await owner.api(org).patch(`/api/items/${human.id}`).send({ title: "Realtime secret" }).expect(200);
      await owner.api(org).patch(`/api/items/${own.id}`).send({ title: "Realtime own" }).expect(200);
      await settle(ctx);
      expect(JSON.stringify(events)).not.toContain("Realtime secret");
      expect(JSON.stringify(events)).toContain("Realtime own");
    } finally { socket.disconnect(); }
  });

  it("only admins can widen access; toggles apply to existing keys and MCP connections", async () => {
    await member.api(org).patch(`/api/agents/${bot.id}`).send({ itemScope: "all", pageScope: "all" }).expect(403);
    await api().patch(`/api/agents/${bot.id}`).send({ itemScope: "all" }).expect(403);
    await owner.api(org).patch(`/api/agents/${bot.id}`).send({ itemScope: "all", pageScope: "all" }).expect(200);
    await api().get(`/api/items/${human.id}`).expect(200);
    expect((await tool("get_page", { id: humanPage.id })).isError).toBeFalsy();
    await owner.api(org).patch(`/api/agents/${bot.id}`).send({ itemScope: "own", pageScope: "own" }).expect(200);
    await api().get(`/api/items/${human.id}`).expect(404);
    expect((await tool("get_page", { id: humanPage.id })).isError).toBe(true);
    const extra = (await owner.api(org).post(`/api/agents/${bot.id}/keys`).send({ name: "Same identity" }).expect(201)).body;
    await api(extra.secret).get(`/api/items/${own.id}`).expect(200);
    await api(extra.secret).get(`/api/items/${human.id}`).expect(404);
  });
});
