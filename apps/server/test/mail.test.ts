import nodemailer from "nodemailer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config, resetConfig } from "../src/core/config";
import { JobsService } from "../src/core/jobs/jobs.service";
import { MailService } from "../src/core/mail";

beforeEach(() => {
  for (const key of ["MAIL_HOST", "MAIL_PORT", "MAIL_USERNAME", "MAIL_PASSWORD", "MAIL_SSL", "MAIL_FROM"]) vi.stubEnv(key, "");
  vi.stubEnv("NODE_ENV", "test");
  resetConfig();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetConfig();
});

function setupMail() {
  const transport = nodemailer.createTransport({ jsonTransport: true });
  const create = vi.spyOn(nodemailer, "createTransport").mockReturnValue(transport);
  const register = vi.fn();
  const mail = new MailService({ register } as unknown as JobsService);
  mail.onModuleInit();
  return { create, register, transport };
}

describe("mail environment configuration", () => {
  it("does not create an SMTP transport without a host", () => {
    expect(setupMail().create).not.toHaveBeenCalled();
  });

  it("uses the requested port 465 and SSL false defaults with an unauthenticated relay", () => {
    resetConfig({ MAIL_HOST: "smtp.example.test" });
    expect(setupMail().create).toHaveBeenCalledWith({ host: "smtp.example.test", port: 465, secure: false });
  });

  it.each([["true", "465", true], ["false", "587", false]] as const)(
    "maps MAIL_SSL=%s and MAIL_PORT=%s to SMTP options and sends from MAIL_FROM",
    async (ssl, port, secure) => {
      resetConfig({
        MAIL_HOST: "smtp.example.test", MAIL_PORT: port, MAIL_SSL: ssl,
        MAIL_USERNAME: "support@wesolves.in", MAIL_PASSWORD: "literal:p@ss/word",
        MAIL_FROM: "Mixedlane <support@wesolves.in>",
      });
      const { create, register, transport } = setupMail();
      expect(create).toHaveBeenCalledWith({
        host: "smtp.example.test", port: Number(port), secure,
        auth: { user: "support@wesolves.in", pass: "literal:p@ss/word" },
      });
      const send = vi.spyOn(transport, "sendMail");
      const message = { to: "recipient@example.test", subject: "Test", text: "Hello", html: "<p>Hello</p>" };
      await register.mock.calls[0][1](message);
      expect(send).toHaveBeenCalledWith({ from: "Mixedlane <support@wesolves.in>", ...message });
    },
  );

  it.each<Record<string, string>>([
    { MAIL_PORT: "0" }, { MAIL_PORT: "65536" }, { MAIL_SSL: "not-a-boolean" },
    { MAIL_HOST: "smtp.example.test", MAIL_USERNAME: "support@wesolves.in" },
    { MAIL_HOST: "smtp.example.test", MAIL_PASSWORD: "password" },
  ])("rejects invalid or incomplete SMTP settings: %j", (overrides) => {
    resetConfig(overrides);
    expect(() => config()).toThrow("Invalid environment");
  });
});
