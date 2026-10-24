import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ITEM_TYPES } from "@mixedlane/shared";
import { bootApp, invite, listen, signUp, type TestApp, type TestUser } from "./harness";
import { signFileToken, signMediaUploadToken } from "../src/modules/auth/crypto";
import { UploadsService } from "../src/modules/uploads/uploads.service";

let ctx: TestApp, owner: TestUser, guest: TestUser, outsider: TestUser;
let org: string, agentId: string, secret: string, client: Client;
let project: { id: string; key: string };
const permissions = ["project.read", "item.create", "item.update", "comment.create", "doc.read", "doc.write"];
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");
const json = (result: any) => JSON.parse(result.content[0].text);
const tool = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
const grant = (perms: string[]) => owner.api(org).put(`/api/agents/${agentId}/grants`).send({ projectId: project.id, permissions: perms });
const upload = (args: Record<string, unknown> = {}) => tool("upload_media", { project: "MED", name: "screenshot.png", mime: "image/png", dataBase64: png.toString("base64"), ...args });
const ticketPath = (url: string) => new URL(url).pathname;

beforeAll(async () => {
  ctx = await bootApp({ APP_URL: "http://mixedlane.example.test/", MAIL_HOST: "" });
  ({ user: owner, org } = await signUp(ctx));
  guest = await invite(ctx, owner, org, "guest@media.test", "guest");
  ({ user: outsider } = await signUp(ctx));
  project = (await owner.api(org).post("/api/projects").send({ name: "Media", key: "MED", visibility: "private", itemTypes: ITEM_TYPES })).body;
  await owner.api(org).post("/api/projects").send({ name: "Hidden", key: "HID", visibility: "private", itemTypes: ["task"] }).expect(201);
  await owner.api(org).post("/api/spaces").send({ name: "Engineering", key: "ENG", projectId: project.id }).expect(201);
  const created = (await owner.api(org).post("/api/agents").send({ name: "Media bot", docAccess: "write" })).body;
  agentId = created.agent.id; secret = created.key.secret;
  await grant(permissions).expect(200);
  client = new Client({ name: "media-test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${await listen(ctx)}/api/mcp`), { requestInit: { headers: { authorization: `Bearer ${secret}` } } }));
});
afterAll(async () => { await client?.close(); await ctx?.app.close(); });

describe("MCP media", () => {
  it("uploads via MCP and renders an image on every hierarchy level and in comments", async () => {
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(expect.arrayContaining(["upload_media", "prepare_media_upload", "read_media"]));
    const media = json(await upload());
    expect(media).toMatchObject({ kind: "image", mime: "image/png", size: png.length });
    expect(media.absoluteUrl).toBe(`http://mixedlane.example.test${media.url}`);
    const stored = await tool("read_media", { url: media.url }) as CallToolResult;
    expect(stored.content[1]).toMatchObject({ type: "image", mimeType: "image/png", data: png.toString("base64") });
    let parent: string | undefined;
    for (const type of ITEM_TYPES) {
      const created = json(await tool("create_item", { project: "MED", type, title: `Media ${type}`, parent, description: media.markdown }));
      expect(created.type).toBe(type);
      expect(created.description).toContain(media.url);
      const detail = (await owner.api(org).get(`/api/items/by-key/${created.key}`)).body;
      expect(detail.description).toContain(`<img src="${media.url}"`);
      await tool("update_item", { key: created.key, description: `Updated\n\n${media.markdown}` });
      expect(json(await tool("get_item", { key: created.key })).description).toContain(media.markdown);
      parent = created.key;
    }
    await tool("add_comment", { key: parent!, body: media.markdown });
    expect(json(await tool("get_item", { key: parent! })).comments.at(-1).body).toContain(media.url);
    expect((await owner.agent.get(media.url)).status).toBe(200);
    expect((await ctx.http().get(media.url).set("authorization", `Bearer ${secret}`)).status).toBe(200);
    expect((await guest.agent.get(media.url)).status).toBe(404);
    expect((await outsider.agent.get(media.url)).status).toBe(404);
    expect((await ctx.http().get(media.url)).status).toBe(404);
  });

  it("embeds image and video uploads in documents and preserves them on edits", async () => {
    const image = json(await upload({ project: undefined, space: "ENG" }));
    const video = json(await upload({ project: undefined, space: "ENG", name: "clip.webm", mime: "video/webm", dataBase64: Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 1, 2, 3]).toString("base64") }));
    const content = `${image.markdown}\n\n${video.markdown}`;
    const page = json(await tool("create_page", { space: "ENG", title: "Media guide", content }));
    const detail = (await owner.api(org).get(`/api/pages/${page.id}`)).body;
    expect(detail.contentHtml).toContain(`<img src="${image.url}"`);
    expect(detail.contentHtml).toContain(`<video src="${video.url}" controls`);
    const read = json(await tool("get_page", { id: page.id }));
    expect(read.content).toContain(video.markdown);
    await tool("update_page", { id: page.id, version: read.version, content: read.content });
    expect(json(await tool("get_page", { id: page.id })).content).toBe(read.content);
    const part = await ctx.http().get(video.url).set("authorization", `Bearer ${secret}`).set("Range", "bytes=0-3");
    expect(part.status).toBe(206);
    expect(part.headers["content-type"]).toContain("video/webm");
    expect((await tool("read_media", { url: video.url, maxBytes: 4 })).isError).not.toBe(true);
  });

  it("uploads a large file with a scoped single-use ticket, without a browser cookie", async () => {
    const data = Buffer.alloc(1024 * 1024 + 1, 42);
    const ticket = json(await tool("prepare_media_upload", { project: "MED", name: "large.png", mime: "image/png", size: data.length }));
    await owner.agent.get(ticket.url).expect(404);
    const path = ticketPath(ticket.uploadUrl);
    const saved = await ctx.http().post(path).attach("file", data, { filename: "large.png", contentType: "image/png" });
    expect(saved.status).toBe(201);
    expect(saved.body.size).toBe(data.length);
    await ctx.http().post(path).expect(409);
    const first = json(await tool("read_media", { url: saved.body.url, maxBytes: 100 }));
    expect(first).toMatchObject({ bytes: 100, nextOffset: 100, size: data.length });
    expect(Buffer.from(first.dataBase64, "base64")).toEqual(data.subarray(0, 100));
  });

  it("keeps failed storage writes private and permits a successful retry", async () => {
    const ticket = json(await tool("prepare_media_upload", { project: "MED", name: "a.png", mime: "image/png", size: png.length }));
    const storage = ctx.app.get(UploadsService).storage;
    const put = vi.spyOn(storage, "put").mockRejectedValueOnce(new Error("temporary storage failure"));
    try {
      await ctx.http().post(ticketPath(ticket.uploadUrl)).attach("file", png, { filename: "a.png", contentType: "image/png" }).expect(503);
      await owner.agent.get(ticket.url).expect(404);
      await ctx.http().post(ticketPath(ticket.uploadUrl)).attach("file", png, { filename: "a.png", contentType: "image/png" }).expect(201);
      await owner.agent.get(ticket.url).expect(200);
    } finally { put.mockRestore(); }
  });

  it("does not expose media or accept a competing upload while storage is still writing", async () => {
    const ticket = json(await tool("prepare_media_upload", { project: "MED", name: "a.png", mime: "image/png", size: png.length }));
    const storage = ctx.app.get(UploadsService).storage;
    const originalPut = storage.put.bind(storage);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const writing = new Promise<void>((resolve) => { entered = resolve; });
    const put = vi.spyOn(storage, "put").mockImplementationOnce(async (key, data, mime) => {
      await originalPut(key, data, mime);
      entered();
      await gate;
    });
    const response = ctx.http().post(ticketPath(ticket.uploadUrl)).attach("file", png, { filename: "a.png", contentType: "image/png" }).then((res) => res);
    try {
      await writing;
      await owner.agent.get(ticket.url).expect(404);
      await ctx.http().post(ticketPath(ticket.uploadUrl)).expect(409);
    } finally { release(); }
    try {
      expect((await response).status).toBe(201);
      await owner.agent.get(ticket.url).expect(200);
    } finally { put.mockRestore(); }
  });

  it("enforces upload permissions, allowed types, base64, scope, and ticket metadata", async () => {
    for (const args of [{ project: "HID" }, { dataBase64: "data:image/png;base64," + png.toString("base64") }, { dataBase64: "invalid!" }, { mime: "image/svg+xml" }, { project: undefined }, { space: "ENG" }]) {
      expect((await upload(args)).isError).toBe(true);
    }
    await grant(["project.read", "doc.read"]).expect(200);
    expect((await upload()).isError).toBe(true);
    expect((await upload({ project: undefined, space: "ENG" })).isError).toBe(true);
    await grant(permissions).expect(200);
    const ticket = json(await tool("prepare_media_upload", { project: "MED", name: "a.png", mime: "image/png", size: png.length }));
    await ctx.http().post(ticketPath(ticket.uploadUrl)).attach("file", Buffer.from("wrong size"), { filename: "a.png", contentType: "image/png" }).expect(400);
    await grant(["project.read"]).expect(200);
    await ctx.http().post(ticketPath(ticket.uploadUrl)).attach("file", png, { filename: "a.png", contentType: "image/png" }).expect(403);
    await grant(permissions).expect(200);
    await ctx.http().post(ticketPath(ticket.uploadUrl)).attach("file", png, { filename: "a.png", contentType: "image/png" }).expect(201);
    // Direct REST uploads also work with agent API keys, but cannot omit scope.
    await ctx.http().post("/api/uploads").set("authorization", `Bearer ${secret}`).field("project", "MED").attach("file", png, { filename: "a.png", contentType: "image/png" }).expect(201);
    await ctx.http().post("/api/uploads").set("authorization", `Bearer ${secret}`).attach("file", png, { filename: "a.png", contentType: "image/png" }).expect(400);
  });

  it("rejects forged, expired, and revoked tickets and removes reads when project access is revoked", async () => {
    const media = json(await upload());
    const ticket = json(await tool("prepare_media_upload", { project: "MED", name: "a.png", mime: "image/png", size: png.length }));
    await ctx.http().post("/api/uploads/agent/forged").expect(401);
    await ctx.http().post(`/api/uploads/agent/${await signFileToken(owner.id)}`).expect(401);
    const keys = (await owner.api(org).get(`/api/agents/${agentId}`)).body.keys;
    let expired: string;
    try {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(Date.now() - 11 * 60_000));
      expired = await signMediaUploadToken(keys[0].id, ticket.url.split("/").pop()!);
    } finally { vi.useRealTimers(); }
    await ctx.http().post(`/api/uploads/agent/${expired!}`).expect(401);
    // Tamper with the signed expiration: signature verification must fail before the file is buffered.
    const parts = ticketPath(ticket.uploadUrl).split("/").pop()!.split(".");
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    parts[1] = Buffer.from(JSON.stringify({ ...payload, exp: 1 })).toString("base64url");
    await ctx.http().post(`/api/uploads/agent/${parts.join(".")}`).expect(401);
    // A valid signature does not make a nonexistent issuing key valid.
    const wrongKeyTicket = await signMediaUploadToken("00000000-0000-4000-8000-000000000000", media.url.split("/").pop()!);
    await ctx.http().post(`/api/uploads/agent/${wrongKeyTicket}`).expect(401);
    await grant([]).expect(200);
    expect((await tool("read_media", { url: media.url })).isError).toBe(true);
    await ctx.http().get(media.url).set("authorization", `Bearer ${secret}`).expect(404);
    await grant(permissions).expect(200);
    await owner.api(org).delete(`/api/agents/${agentId}/keys/${keys[0].id}`).expect(200);
    await ctx.http().post(ticketPath(ticket.uploadUrl)).expect(401);
    await ctx.http().get(media.url).set("authorization", `Bearer ${secret}`).expect(404);
  });
});
