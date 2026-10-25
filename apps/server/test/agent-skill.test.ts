import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { bootApp, invite, listen, signUp, type TestApp, type TestUser } from "./harness";

let ctx: TestApp;
let org: string;
let owner: TestUser, admin: TestUser, member: TestUser, guest: TestUser;

beforeAll(async () => {
  ctx = await bootApp();
  ({ user: owner, org } = await signUp(ctx, { name: "Skill Owner", orgName: "Agent skills" }));
  admin = await invite(ctx, owner, org, "skill-admin@example.dev", "admin");
  member = await invite(ctx, owner, org, "skill-member@example.dev", "member");
  guest = await invite(ctx, owner, org, "skill-guest@example.dev", "guest");
});
afterAll(async () => { await ctx.app.close(); });

describe("organization agent skill", () => {
  it("provides full default title/body boilerplates, Markdown and media instructions", async () => {
    const skill = (await owner.api(org).get("/api/agents/skill").expect(200)).body;
    expect(skill).toMatchObject({ customized: false, version: 0, canEdit: true });
    expect(skill.content).toBe(skill.defaultContent);
    for (const heading of ["### Epic", "### Milestone", "### User story", "### Task", "### Subtask", "### Bug report", "### Basic Markdown"]) expect(skill.content).toContain(heading);
    for (const text of ["## Acceptance criteria", "upload_media", "prepare_media_upload", "read_media", "multipart field `file`", "same epic and milestone"]) expect(skill.content).toContain(text);
  });

  it("owners, admins and regular members can save the shared skill", async () => {
    for (const user of [owner, admin, member]) {
      const previous = (await user.api(org).get("/api/agents/skill").expect(200)).body;
      const updated = (await user.api(org).put("/api/agents/skill").send({ version: previous.version, content: `# Team skill\n\n## Ticket title\nUse an action verb.\n\nVersion ${previous.version + 1}` }).expect(200)).body;
      expect(updated).toMatchObject({ customized: true, version: previous.version + 1, canEdit: true });
      expect((await owner.api(org).get("/api/agents/skill")).body.content).toBe(updated.content);
    }
    // Members still cannot manage agents, keys or grants.
    await member.api(org).get("/api/agents").expect(403);
    await member.api(org).post("/api/agents").send({ name: "Forbidden" }).expect(403);
  });

  it("rejects stale versions without overwriting the saved content", async () => {
    const previous = (await owner.api(org).get("/api/agents/skill")).body;
    await admin.api(org).put("/api/agents/skill").send({ version: previous.version, content: "# Admin's latest instructions" }).expect(200);
    await member.api(org).put("/api/agents/skill").send({ version: previous.version, content: "# Stale draft" }).expect(409);
    expect((await owner.api(org).get("/api/agents/skill")).body.content).toBe("# Admin's latest instructions");
  });

  it("validates content, restricts guest edits, and requires authentication", async () => {
    const current = (await owner.api(org).get("/api/agents/skill")).body;
    for (const content of [" ", "x".repeat(100_001)]) await owner.api(org).put("/api/agents/skill").send({ version: current.version, content }).expect(400);
    expect((await guest.api(org).get("/api/agents/skill").expect(200)).body.canEdit).toBe(false);
    await guest.api(org).put("/api/agents/skill").send({ version: current.version, content: "# Guest instructions" }).expect(403);
    await ctx.http().get("/api/agents/skill").set("x-org", org).expect(401);
  });

  it("isolates custom skills between organizations", async () => {
    const other = await signUp(ctx, { name: "Other Owner", orgName: "Other skills" });
    const skill = (await other.user.api(other.org).get("/api/agents/skill").expect(200)).body;
    expect(skill).toMatchObject({ customized: false, version: 0 });
    expect(skill.content).not.toContain("Admin's latest instructions");
    await other.user.api(org).get("/api/agents/skill").expect(404);
    await other.user.api(org).put("/api/agents/skill").send({ version: 0, content: "# Cross-tenant edit" }).expect(404);
  });

  it("delivers current custom instructions to MCP and refreshes in an existing session", async () => {
    const created = (await owner.api(org).post("/api/agents").send({ name: "Skill reader" }).expect(201)).body;
    const c = new Client({ name: "skill-test", version: "1.0.0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${await listen(ctx)}/api/mcp`), { requestInit: { headers: { authorization: `Bearer ${created.key.secret}` } } }));
    expect(c.getInstructions()).toContain("Admin's latest instructions");
    const read = async () => {
      const result = await c.callTool({ name: "get_agent_skill", arguments: {} }) as { content: { type: string; text: string }[] };
      return JSON.parse(result.content[0].text);
    };
    expect((await read()).content).toBe("# Admin's latest instructions");
    const previous = (await member.api(org).get("/api/agents/skill")).body;
    await member.api(org).put("/api/agents/skill").send({ version: previous.version, content: "# New session-independent skill\nUse [API] in task titles." }).expect(200);
    expect((await read()).content).toContain("Use [API] in task titles.");
    await ctx.http().put("/api/agents/skill").set("authorization", `Bearer ${created.key.secret}`).send({ version: previous.version + 1, content: "# Agent self-edit" }).expect(403);
    await c.close();
  });

  it("restores the bundled default with a new version", async () => {
    const previous = (await member.api(org).get("/api/agents/skill")).body;
    const restored = (await member.api(org).put("/api/agents/skill").send({ version: previous.version, content: null }).expect(200)).body;
    expect(restored).toMatchObject({ customized: false, version: previous.version + 1 });
    expect(restored.content).toBe(restored.defaultContent);
  });
});
