import request from "supertest";
import { eq, sql } from "drizzle-orm";
import nodemailer from "nodemailer";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resetConfig } from "../src/core/config";
import { DB, type Db } from "../src/core/database/database";
import { authTokens } from "../src/core/database/schema";
import { JobsService } from "../src/core/jobs/jobs.service";
import { MailService } from "../src/core/mail";
import { PASSWORD, bootApp, signIn, signUp, type TestApp } from "./harness";

let ctx: TestApp;
let db: Db;
let mail: MailService;
let jobs: JobsService;
const mailHost = "smtp.example.test";
beforeAll(async () => {
  const transport = nodemailer.createTransport({ jsonTransport: true });
  vi.spyOn(nodemailer, "createTransport").mockReturnValue(transport);
  ctx = await bootApp({ MAIL_HOST: mailHost, MAIL_USERNAME: "", MAIL_PASSWORD: "" });
  db = ctx.app.get(DB);
  mail = ctx.app.get(MailService);
  jobs = ctx.app.get(JobsService);
});
afterAll(async () => {
  await ctx.app.close();
  vi.restoreAllMocks();
});

/** Delivers queued mail and returns the newest message for an address. */
async function lastMailTo(email: string) {
  await jobs.drain();
  const msg = [...mail.outbox].reverse().find((m) => m.to === email);
  if (!msg) throw new Error(`no mail to ${email}`);
  return msg;
}
const tokenFrom = (text: string) => text.match(/token=([\w-]+)/)?.[1] ?? text.match(/invite\/([\w-]+)/)?.[1] ?? "";
const refreshCookie = (res: request.Response) =>
  ([] as string[]).concat(res.headers["set-cookie"] ?? []).find((c) => c.startsWith("ml_rt="))?.split(";")[0] ?? "";

describe("register & login", () => {
  it("automatically verifies signup without SMTP and does not queue a verification email", async () => {
    resetConfig({ MAIL_HOST: "" });
    try {
      const { user } = await signUp(ctx);
      expect((await user.get("/api/auth/me")).body.user.emailVerified).toBe(true);
      expect((await ctx.http().post("/api/auth/login").send({ email: user.email, password: PASSWORD })).body.user.emailVerified).toBe(true);
      const tokens = await db.select().from(authTokens).where(eq(authTokens.userId, user.id));
      expect(tokens).toEqual([]);
      await user.post("/api/auth/resend-verification").expect(204);
      await jobs.drain();
      expect(mail.outbox.some((m) => m.to === user.email)).toBe(false);
    } finally {
      resetConfig({ MAIL_HOST: mailHost });
    }
  });

  it("registers a user with their own org and returns a working access token", async () => {
    const res = await ctx.http().post("/api/auth/register").send({ name: "Ann", email: "Ann@Example.com", password: PASSWORD, orgName: "Acme Inc" });
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email: "ann@example.com", name: "Ann", emailVerified: false });
    expect(res.body.orgs).toEqual([expect.objectContaining({ slug: "acme-inc", role: "owner" })]);
    const cookies = ([] as string[]).concat(res.headers["set-cookie"]);
    expect(cookies.find((c) => c.startsWith("ml_rt="))).toMatch(/HttpOnly/i);
    expect(cookies.find((c) => c.startsWith("ml_rt="))).toMatch(/Path=\/api\/auth/);

    const me = await ctx.http().get("/api/auth/me").set("authorization", `Bearer ${res.body.accessToken}`);
    expect(me.body.user.email).toBe("ann@example.com");
  });

  it("rejects duplicates, weak passwords and wrong credentials", async () => {
    const dup = await ctx.http().post("/api/auth/register").send({ name: "Ann", email: "ann@example.com", password: PASSWORD, orgName: "X" });
    expect(dup.status).toBe(409);
    const weak = await ctx.http().post("/api/auth/register").send({ name: "B", email: "b@example.com", password: "short", orgName: "X" });
    expect(weak.status).toBe(400);
    const wrong = await ctx.http().post("/api/auth/login").send({ email: "ann@example.com", password: "wrong-password1" });
    expect(wrong.status).toBe(401);
    const unknown = await ctx.http().post("/api/auth/login").send({ email: "nobody@example.com", password: PASSWORD });
    expect(unknown.status).toBe(401);
    expect(unknown.body.error).toBe(wrong.body.error); // no account enumeration
  });

  it("requires a token everywhere except public routes", async () => {
    expect((await ctx.http().get("/api/projects").set("x-org", "acme-inc")).status).toBe(401);
    expect((await ctx.http().get("/api/projects").set("authorization", "Bearer not-a-jwt").set("x-org", "acme-inc")).status).toBe(401);
    expect((await ctx.http().get("/api/health")).status).toBe(200);
  });
});

describe("refresh token rotation", () => {
  it("rotates, detects reuse and revokes the whole family", async () => {
    const { user } = await signUp(ctx);
    const login = await ctx.http().post("/api/auth/login").send({ email: user.email, password: PASSWORD });
    const first = refreshCookie(login);

    // Missing CSRF header is refused.
    expect((await ctx.http().post("/api/auth/refresh").set("cookie", first)).status).toBe(400);

    const r1 = await ctx.http().post("/api/auth/refresh").set("cookie", first).set("x-requested-with", "mixedlane");
    expect(r1.status).toBe(200);
    const second = refreshCookie(r1);
    expect(second).not.toBe(first);

    // Replaying the first token inside the grace window (parallel tabs) is tolerated…
    expect((await ctx.http().post("/api/auth/refresh").set("cookie", first).set("x-requested-with", "mixedlane")).status).toBe(200);
    // …but after it, it's treated as theft: the whole family is revoked.
    await db.execute(sql`UPDATE sessions SET revoked_at = now() - interval '1 hour' WHERE revoked_at IS NOT NULL`);
    expect((await ctx.http().post("/api/auth/refresh").set("cookie", first).set("x-requested-with", "mixedlane")).status).toBe(401);
    expect((await ctx.http().post("/api/auth/refresh").set("cookie", second).set("x-requested-with", "mixedlane")).status).toBe(401);
    // Access tokens of the revoked family stop working immediately.
    expect((await ctx.http().get("/api/auth/me").set("authorization", `Bearer ${r1.body.accessToken}`)).status).toBe(401);
  });

  it("logout ends the session immediately", async () => {
    const { user } = await signUp(ctx);
    const u = await signIn(ctx, user.email);
    expect((await u.get("/api/auth/me")).status).toBe(200);
    await u.agent.post("/api/auth/logout").set("authorization", `Bearer ${u.token}`).expect(204);
    expect((await u.get("/api/auth/me")).status).toBe(401);
  });
});

describe("email flows", () => {
  it("verifies email via the emailed link", async () => {
    const { user } = await signUp(ctx);
    expect((await user.get("/api/auth/me")).body.user.emailVerified).toBe(false);
    const msg = await lastMailTo(user.email);
    expect(msg.subject).toMatch(/Confirm your email/);
    await user.post("/api/auth/resend-verification").expect(204);
    const resent = await lastMailTo(user.email);
    expect(tokenFrom(resent.text)).not.toBe(tokenFrom(msg.text));
    await ctx.http().post("/api/auth/verify-email").send({ token: tokenFrom(resent.text) }).expect(204);
    expect((await user.get("/api/auth/me")).body.user.emailVerified).toBe(true);
    // Links are single-use.
    await ctx.http().post("/api/auth/verify-email").send({ token: tokenFrom(resent.text) }).expect(400);
  });

  it("resets a forgotten password and signs out other sessions", async () => {
    const { user } = await signUp(ctx);
    await ctx.http().post("/api/auth/forgot-password").send({ email: user.email }).expect(204);
    // Unknown emails look identical.
    await ctx.http().post("/api/auth/forgot-password").send({ email: "ghost@example.com" }).expect(204);
    const token = tokenFrom((await lastMailTo(user.email)).text);
    await ctx.http().post("/api/auth/reset-password").send({ token, password: "N3wPassword!" }).expect(204);
    expect((await user.get("/api/auth/me")).status).toBe(401);
    expect((await ctx.http().post("/api/auth/login").send({ email: user.email, password: PASSWORD })).status).toBe(401);
    expect((await ctx.http().post("/api/auth/login").send({ email: user.email, password: "N3wPassword!" })).status).toBe(200);
  });
});

describe("invites", () => {
  it("previews and accepts an invite, creating the account", async () => {
    const { user: owner, org } = await signUp(ctx, { orgName: "Invite Co" });
    const team = await owner.api(org).post("/api/org/teams").send({ name: "Design" });
    const inv = await owner.api(org).post("/api/org/invites").send({ email: "newbie@example.com", role: "member", teamIds: [team.body.id] });
    expect(inv.status).toBe(201);
    const token = tokenFrom((await lastMailTo("newbie@example.com")).text);
    expect(inv.body.url).toContain(token);

    const preview = await ctx.http().get(`/api/invites/${token}`);
    expect(preview.body).toMatchObject({ orgName: "Invite Co", email: "newbie@example.com", role: "member", accountExists: false });

    const acc = await ctx.http().post(`/api/invites/${token}/accept`).send({ name: "Newbie", password: PASSWORD });
    expect(acc.status).toBe(200);
    expect(acc.body.orgs.map((o: { slug: string }) => o.slug)).toContain(org);
    expect(acc.body.user.emailVerified).toBe(true);

    const members = await owner.api(org).get("/api/org/members");
    const newbie = members.body.find((m: { email: string }) => m.email === "newbie@example.com");
    expect(newbie).toMatchObject({ role: "member", teams: [{ id: team.body.id, name: "Design" }] });

    // Used invites can't be reused.
    expect((await ctx.http().get(`/api/invites/${token}`)).status).toBe(404);
  });

  it("existing accounts must accept while signed in as the invited email", async () => {
    const { user: owner, org } = await signUp(ctx);
    const { user: other } = await signUp(ctx);
    const { user: invitee } = await signUp(ctx);
    const inv = await owner.api(org).post("/api/org/invites").send({ email: invitee.email, role: "guest" });
    const token = new URL(inv.body.url).pathname.split("/").pop()!;

    expect((await ctx.http().post(`/api/invites/${token}/accept`).send({ name: "X", password: PASSWORD })).status).toBe(409);
    expect((await other.post(`/api/invites/${token}/accept`).send({})).status).toBe(403);
    const ok = await invitee.post(`/api/invites/${token}/accept`).send({});
    expect(ok.status).toBe(200);
    expect(ok.body.orgs.find((o: { slug: string }) => o.slug === org).role).toBe("guest");
  });
});

describe("session length", () => {
  it("defaults to 30 days, is configurable per user, and access tokens last 5 minutes", async () => {
    const { user } = await signUp(ctx);
    const cookieDays = (res: { headers: Record<string, unknown> }) => {
      const c = ([] as string[]).concat((res.headers["set-cookie"] as string[]) ?? []).find((x) => x.startsWith("ml_rt="))!;
      const expires = new Date(/Expires=([^;]+)/i.exec(c)![1]).getTime();
      return Math.round((expires - Date.now()) / 86_400_000);
    };
    const first = await user.agent.post("/api/auth/refresh").set("x-requested-with", "mixedlane");
    expect(first.body.expiresIn).toBe(300);
    expect(first.body.user.sessionDays).toBe(30);
    expect(cookieDays(first)).toBe(30);

    expect((await user.agent.patch("/api/auth/me").set("authorization", `Bearer ${first.body.accessToken}`).send({ sessionDays: 45 })).status).toBe(400);
    await user.agent.patch("/api/auth/me").set("authorization", `Bearer ${first.body.accessToken}`).send({ sessionDays: 90 }).expect(200);
    const next = await user.agent.post("/api/auth/refresh").set("x-requested-with", "mixedlane");
    expect(next.body.user.sessionDays).toBe(90);
    expect(cookieDays(next)).toBe(90);
  });
});
