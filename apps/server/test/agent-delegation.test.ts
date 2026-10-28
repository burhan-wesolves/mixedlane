import { afterAll, beforeAll, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { AGENT_PERMISSIONS } from "@mixedlane/shared";
import { DB, type Db } from "../src/core/database/database";
import { apiKeys, users } from "../src/core/database/schema";
import { AgentsService } from "../src/modules/agents/agents.service";
import { UploadsService } from "../src/modules/uploads/uploads.service";
import { bootApp, connectSocket, invite, settle, signUp, type TestApp } from "./harness";

let ctx: TestApp, db: Db;
beforeAll(async () => { ctx = await bootApp(); db = ctx.moduleRef.get(DB); });
afterAll(async () => { await ctx.app.close(); });
const bearer = (token: string) => ({
  get: (path: string) => ctx.http().get(path).set("authorization", `Bearer ${token}`),
  post: (path: string) => ctx.http().post(path).set("authorization", `Bearer ${token}`),
  patch: (path: string) => ctx.http().patch(path).set("authorization", `Bearer ${token}`),
});

it("caps existing keys at their creator's current role, revocations and document rights", async () => {
  const { user: owner, org } = await signUp(ctx);
  const o = owner.api(org);
  const creator = await invite(ctx, owner, org, "creator@delegation.test", "admin");
  const a = (await o.post("/api/projects").send({ key: "CAP", name: "Capped", itemTypes: ["task"] })).body;
  const b = (await o.post("/api/projects").send({ key: "HID", name: "Hidden", itemTypes: ["task"] })).body;
  const item = (await o.post("/api/items").send({ projectId: a.id, type: "task", title: "Human ticket" })).body;
  const space = (await o.post("/api/spaces").send({ key: "DOC", name: "Docs", projectId: a.id })).body;
  const page = (await o.post(`/api/spaces/${space.id}/pages`).send({ title: "Human page" })).body;
  const made = (await creator.api(org).post("/api/agents").send({ name: "Delegated", itemScope: "all", pageScope: "all", docAccess: "write" }).expect(201)).body;
  for (const p of [a, b]) await o.put(`/api/agents/${made.agent.id}/grants`).send({ projectId: p.id, permissions: AGENT_PERMISSIONS }).expect(200);
  const bot = bearer(made.key.secret);
  const service = ctx.moduleRef.get(AgentsService);
  const initialContext = (await service.contextForKey(made.key.key.id))!;
  const uploads = ctx.moduleRef.get(UploadsService);
  const docUpload = await uploads.prepare(initialContext, { space: space.id, name: "proof.png", mime: "image/png", size: 1 });
  const hiddenUpload = await uploads.prepare(initialContext, { project: b.id, name: "proof.png", mime: "image/png", size: 1 });
  await bot.patch(`/api/items/${item.id}`).send({ title: "Allowed before downgrade" }).expect(200);
  const live = await connectSocket(ctx, null, org, made.key.secret);
  try {
    await o.patch(`/api/org/members/${creator.id}`).send({ role: "member" }).expect(204);
    await o.post(`/api/projects/${a.id}/access`).send({ principalType: "user", principalId: creator.id, role: "viewer" }).expect(200);
    await o.patch(`/api/projects/${b.id}/revocations`).send({ userId: creator.id, revoked: true }).expect(200);
    const visible = (await bot.get("/api/projects").expect(200)).body;
    expect(visible.map((p: { key: string }) => p.key)).toEqual(["CAP"]);
    expect(visible[0].access.role).toBe("viewer");
    await bot.patch(`/api/items/${item.id}`).send({ title: "Denied" }).expect(403);
    await bot.post(`/api/items/${item.id}/comments`).send({ body: "Viewer finding" }).expect(201);
    await bot.get(`/api/projects/${b.id}`).expect(404);
    await bot.get(`/api/pages/${page.id}`).expect(200);
    await bot.patch(`/api/pages/${page.id}`).send({ title: "Denied", baseVersion: 1 }).expect(403);
    // Tickets issued before the downgrade must recheck the delegating accounts.
    await ctx.http().post(new URL(docUpload.uploadUrl).pathname).expect(403);
    await ctx.http().post(new URL(hiddenUpload.uploadUrl).pathname).expect(404);
    const keyContext = await service.contextForKey(made.key.key.id);
    expect(keyContext?.delegators?.map((person) => person.userId)).toEqual([creator.id]);
    await settle(ctx); live.events.length = 0;
    await o.post("/api/items").send({ projectId: b.id, type: "task", title: "Must not leak" }).expect(201);
    await settle(ctx);
    expect(live.events.filter((event) => event.type === "item")).toEqual([]);
    // A narrower configured agent grant still wins when the person has more rights.
    await o.post(`/api/projects/${a.id}/access`).send({ principalType: "user", principalId: creator.id, role: "editor" }).expect(200);
    await o.put(`/api/agents/${made.agent.id}/grants`).send({ projectId: a.id, permissions: ["project.read"] }).expect(200);
    await bot.post(`/api/items/${item.id}/comments`).send({ body: "Disabled toggle" }).expect(403);
    await o.delete(`/api/org/members/${creator.id}`).expect(204);
    await bot.get("/api/projects").expect(401);
    expect(await service.contextForKey(made.key.key.id)).toBeNull();
    expect(await service.keyActive(made.key.key.id)).toBe(false);
  } finally { live.socket.disconnect(); }
});

it("caps each key at its issuer as well as the creator and revokes deleted issuers", async () => {
  const { user: owner, org } = await signUp(ctx);
  const o = owner.api(org);
  const issuer = await invite(ctx, owner, org, "issuer@delegation.test", "admin");
  const p = (await o.post("/api/projects").send({ key: "ISS", name: "Issuer", itemTypes: ["task"] })).body;
  await o.post("/api/spaces").send({ key: "ORG", name: "Standalone" }).expect(201);
  const agent = (await o.post("/api/agents").send({ name: "Owner bot", globalMode: true, docAccess: "write" })).body;
  await o.put(`/api/agents/${agent.agent.id}/grants`).send({ projectId: p.id, permissions: AGENT_PERMISSIONS }).expect(200);
  const issued = (await issuer.api(org).post(`/api/agents/${agent.agent.id}/keys`).send({ name: "Issuer key" }).expect(201)).body;
  expect((await db.select().from(apiKeys).where(eq(apiKeys.id, issued.key.id)))[0].userId).toBe(issuer.id);
  await o.patch(`/api/org/members/${issuer.id}`).send({ role: "guest" }).expect(204);
  await o.post(`/api/projects/${p.id}/access`).send({ principalType: "user", principalId: issuer.id, role: "viewer" }).expect(200);
  const bot = bearer(issued.secret);
  expect((await bot.get(`/api/projects/${p.id}`).expect(200)).body.access.role).toBe("viewer");
  await bot.post("/api/items").send({ projectId: p.id, type: "task", title: "Denied" }).expect(403);
  await bot.post("/api/projects").send({ key: "DEN", name: "Denied" }).expect(403);
  await bot.get("/api/spaces/ORG").expect(404);
  // The owner's separate key remains usable; delegation is per credential.
  await bearer(agent.key.secret).post("/api/items").send({ projectId: p.id, type: "task", title: "Owner allowed" }).expect(201);
  await db.delete(users).where(eq(users.id, issuer.id));
  await bot.get("/api/projects").expect(401);
  expect(await db.select().from(apiKeys).where(eq(apiKeys.id, issued.key.id))).toHaveLength(0);
});

it("disables an agent when its creator is deleted even if another account issued the key", async () => {
  const { user: owner, org } = await signUp(ctx);
  const creator = await invite(ctx, owner, org, "deleted-creator@delegation.test", "admin");
  const made = (await creator.api(org).post("/api/agents").send({ name: "Orphan test" })).body;
  const issued = (await owner.api(org).post(`/api/agents/${made.agent.id}/keys`).send({ name: "Owner-issued" })).body;
  await db.delete(users).where(eq(users.id, creator.id));
  await bearer(issued.secret).get("/api/projects").expect(401);
});

it("binds OAuth tokens to their approving account and follows later downgrades", async () => {
  const { user: owner, org } = await signUp(ctx);
  const approver = await invite(ctx, owner, org, "oauth-approver@delegation.test", "admin");
  const p = (await owner.api(org).post("/api/projects").send({ key: "OAC", name: "OAuth ceiling", itemTypes: ["task"] })).body;
  const made = (await owner.api(org).post("/api/agents").send({ name: "OAuth bot", projectId: p.id })).body;
  const redirect = "http://127.0.0.1:43123/callback";
  const client = (await ctx.http().post("/api/oauth/register").send({ client_name: "Delegation", redirect_uris: [redirect] })).body;
  const verifier = randomBytes(32).toString("base64url");
  const approved = (await approver.api(org).post("/api/oauth/authorize").send({ clientId: client.client_id, redirectUri: redirect, codeChallenge: createHash("sha256").update(verifier).digest("base64url"), agentId: made.agent.id }).expect(200)).body;
  const token = (await ctx.http().post("/api/oauth/token").type("form").send({ grant_type: "authorization_code", client_id: client.client_id, code: new URL(approved.redirect).searchParams.get("code"), code_verifier: verifier, redirect_uri: redirect }).expect(200)).body.access_token;
  await owner.api(org).patch(`/api/org/members/${approver.id}`).send({ role: "member" }).expect(204);
  await owner.api(org).post(`/api/projects/${p.id}/access`).send({ principalType: "user", principalId: approver.id, role: "viewer" }).expect(200);
  expect((await bearer(token).get(`/api/projects/${p.id}`).expect(200)).body.access.role).toBe("viewer");
  await bearer(token).post("/api/items").send({ projectId: p.id, type: "task", title: "Denied" }).expect(403);
  await owner.api(org).delete(`/api/org/members/${approver.id}`).expect(204);
  await bearer(token).get("/api/projects").expect(401);
});
