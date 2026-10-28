import { afterAll, beforeAll, expect, it } from "vitest";
import { bootApp, connectSocket, invite, settle, signUp, type TestApp } from "./harness";

let ctx: TestApp;
beforeAll(async () => { ctx = await bootApp(); });
afterAll(async () => { await ctx.app.close(); });

it("limits selected invitations, composes team grants, and preserves revocations across membership refreshes", async () => {
  const { user: owner, org } = await signUp(ctx);
  const o = owner.api(org);
  const first = (await o.post("/api/projects").send({ key: "ONE", name: "One", itemTypes: ["task"] }).expect(201)).body;
  const second = (await o.post("/api/projects").send({ key: "TWO", name: "Two", itemTypes: ["task"] }).expect(201)).body;
  const item = (await o.post("/api/items").send({ projectId: second.id, type: "task", title: "Hidden" }).expect(201)).body;
  const member = await invite(ctx, owner, org, "restricted@tests.dev", "member", [], [first.id]);
  const m = member.api(org);
  expect((await m.get("/api/projects")).body.map((p: { key: string }) => p.key)).toEqual(["ONE"]);
  await m.get(`/api/items/${item.id}`).expect(404);
  const empty = await invite(ctx, owner, org, "empty@tests.dev", "member", [], []);
  expect((await empty.api(org).get("/api/projects")).body).toEqual([]);
  const a = (await o.post("/api/org/teams").send({ name: "A" })).body.id;
  const b = (await o.post("/api/org/teams").send({ name: "B" })).body.id;
  const grant = async (teamId: string) => (await o.post(`/api/projects/${second.id}/access`).send({ principalType: "team", principalId: teamId, role: "viewer" }).expect(200)).body.grants.find((g: { principalId: string }) => g.principalId === teamId).id;
  const grantA = await grant(a);
  const grantB = await grant(b);
  for (const id of [a, b]) await o.post(`/api/org/teams/${id}/members`).send({ userId: member.id }).expect(204);
  await m.get(`/api/items/${item.id}`).expect(200);
  await m.patch(`/api/projects/${second.id}/revocations`).send({ userId: member.id, revoked: true }).expect(403);
  await o.patch(`/api/projects/${second.id}/revocations`).send({ userId: member.id, revoked: true }).expect(200);
  await o.delete(`/api/org/teams/${a}/members/${member.id}`).expect(204);
  await o.post(`/api/org/teams/${a}/members`).send({ userId: member.id }).expect(204);
  await m.get(`/api/projects/${second.id}`).expect(404);
  await m.get(`/api/items/${item.id}`).expect(404);
  const effective = (await o.get(`/api/projects/${second.id}/access`)).body.members.find((u: { userId: string }) => u.userId === member.id);
  expect(effective.revoked).toBe(true);
  expect(effective.sources).toContain("Team: A");
  await o.patch(`/api/projects/${second.id}/revocations`).send({ userId: member.id, revoked: false }).expect(200);
  await o.delete(`/api/projects/${second.id}/access/${grantA}`).expect(200);
  await m.get(`/api/items/${item.id}`).expect(200);
  await o.delete(`/api/projects/${second.id}/access/${grantB}`).expect(200);
  await m.get(`/api/items/${item.id}`).expect(404);
  // A future organization-visible project also stays hidden from restricted invitees.
  const future = (await o.post("/api/projects").send({ key: "NEW", name: "Future", itemTypes: ["task"] })).body;
  await m.get(`/api/projects/${future.id}`).expect(404);
});

it("rejects invitations selecting another organization's project", async () => {
  const { user: owner, org } = await signUp(ctx);
  const { user: other, org: otherOrg } = await signUp(ctx);
  const foreign = (await other.api(otherOrg).post("/api/projects").send({ key: "FOR", name: "Foreign", itemTypes: ["task"] })).body;
  await owner.api(org).post("/api/org/invites").send({ email: "bad@tests.dev", projectIds: [foreign.id] }).expect(400);
});

it("refreshes live subscriptions after team removal and explicit revocation", async () => {
  const { user: owner, org } = await signUp(ctx);
  const o = owner.api(org);
  const project = (await o.post("/api/projects").send({ key: "LIVE", name: "Live", itemTypes: ["task"] })).body;
  const team = (await o.post("/api/org/teams").send({ name: "Live team" })).body;
  await o.post(`/api/projects/${project.id}/access`).send({ principalType: "team", principalId: team.id, role: "viewer" }).expect(200);
  const member = await invite(ctx, owner, org, "live-exception@tests.dev", "member", [team.id], []);
  const live = await connectSocket(ctx, member, org);
  const create = async (title: string) => { await o.post("/api/items").send({ projectId: project.id, type: "task", title }).expect(201); await settle(ctx); };
  try {
    await create("visible");
    expect(live.events.some((e) => e.title === "visible")).toBe(true);
    await o.delete(`/api/org/teams/${team.id}/members/${member.id}`).expect(204);
    await settle(ctx);
    live.events.length = 0;
    await create("hidden after removal");
    expect(live.events.filter((e) => e.type === "item")).toEqual([]);
    await o.post(`/api/org/teams/${team.id}/members`).send({ userId: member.id }).expect(204);
    await settle(ctx);
    await create("visible again");
    expect(live.events.some((e) => e.title === "visible again")).toBe(true);
    await o.patch(`/api/projects/${project.id}/revocations`).send({ userId: member.id, revoked: true }).expect(200);
    await settle(ctx);
    live.events.length = 0;
    await create("hidden after revocation");
    expect(live.events.filter((e) => e.type === "item")).toEqual([]);
  } finally { live.socket.disconnect(); }
});
