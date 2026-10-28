import { Logger } from "@nestjs/common";
import { afterEach, expect, it, vi } from "vitest";
import { triage, type TriageInput } from "../src/modules/whatsapp/triage";

const input = { report: "PRIVATE CUSTOMER REPORT", project: { name: "Demo", orgId: "org-1", itemTypes: ["task"] }, items: [] } as unknown as TriageInput;
const proposal = { type: "task", title: "Fix report", description: "Reported issue", priority: "medium", category: "bug", parentId: null, duplicateId: null, reason: "Actionable" };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function capture() {
  const records: any[] = [];
  for (const method of ["log", "warn"] as const) vi.spyOn(Logger.prototype, method).mockImplementation((value) => { records.push(JSON.parse(value)); });
  return records;
}

it.each([
  [401, "credentials", "invalid_api_key"], [403, "credentials", undefined],
  [404, "model", undefined], [400, "model", "model_not_found"],
  [429, "rate_limit", "insufficient_quota"], [503, "provider_error", undefined], [504, "timeout", undefined],
])("records safe HTTP failure diagnostics for status %s", async (status, category, code) => {
  const records = capture();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: { code, message: `${input.report} SECRET-KEY Authorization: Bearer SECRET-KEY` } }, { status })));
  await expect(triage(input, { openai: { model: "model", apiKey: "SECRET-KEY" } }, { orgId: "org-1", draftId: "draft-1" })).rejects.toThrow(/Reference: /);
  const failure = records.find((r) => r.event === "ai.attempt_failed");
  expect(failure).toMatchObject({ category, status, provider: "openai", model: "model", orgId: "org-1", draftId: "draft-1" });
  expect(failure.durationMs).toBeGreaterThanOrEqual(0);
  expect(new Set(records.map((r) => r.reference)).size).toBe(1);
  expect(JSON.stringify(records)).not.toContain(input.report);
  expect(JSON.stringify(records)).not.toContain("SECRET-KEY");
});

it.each([["TimeoutError", "timeout"], ["TypeError", "network"]])("classifies %s without logging the raw exception", async (name, category) => {
  const records = capture();
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(Object.assign(new Error(input.report), { name })));
  await expect(triage(input, { openai: { model: "model", apiKey: "secret" } })).rejects.toThrow(/Reference: /);
  expect(records.find((r) => r.event === "ai.attempt_failed").category).toBe(category);
  expect(JSON.stringify(records)).not.toContain(input.report);
});

it("keeps a failed attempt correlated when a fallback succeeds", async () => {
  const records = capture();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json({ message: { content: input.report } }))
    .mockResolvedValueOnce(Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(proposal) }] } }] })));
  expect((await triage(input, { ollama: { model: "SECRET-KEY", apiKey: "SECRET-KEY" }, gemini: { model: "fallback", apiKey: "other-secret" } })).provider).toBe("gemini");
  expect(records.find((r) => r.event === "ai.attempt_failed").category).toBe("invalid_output");
  expect(records.some((r) => r.event === "ai.fallback")).toBe(true);
  expect(records.at(-1).event).toBe("ai.completed");
  expect(new Set(records.map((r) => r.reference)).size).toBe(1);
  expect(JSON.stringify(records)).not.toContain(input.report);
  expect(JSON.stringify(records)).not.toContain("SECRET-KEY");
});
