// Run from apps/server through the SWC loader. Credentials arrive through environment variables.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encrypt } from "../apps/server/src/modules/github/crypto.ts";
import { SERVER_ROOT } from "../apps/server/src/core/config.ts";

if (!process.env.OPENWA_API_KEY || !process.env.OLLAMA_API_KEY) throw new Error("Set OPENWA_API_KEY and OLLAMA_API_KEY in the process environment");
const providers = {
  ollama: { model: process.env.OLLAMA_MODEL ?? "gemma4:31b", apiKey: process.env.OLLAMA_API_KEY },
  gemini: { model: "", apiKey: "" }, grok: { model: "", apiKey: "" },
};
const dir = join(SERVER_ROOT, "data");
mkdirSync(dir, { recursive: true, mode: 0o700 });
writeFileSync(join(dir, "whatsapp-bootstrap.json"), JSON.stringify({ baseUrl: process.env.OPENWA_URL ?? "http://192.168.0.6:2785", apiKeyEnc: encrypt(process.env.OPENWA_API_KEY), providersEnc: encrypt(JSON.stringify(providers)) }), { mode: 0o600 });
console.log("Encrypted WhatsApp and Ollama defaults saved for this installation.");
