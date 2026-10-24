import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config, SERVER_ROOT } from "../../core/config";
import { decrypt } from "../github/crypto";
import type { ProviderConfig } from "./triage";

/** Optional encrypted defaults for this local installation; never exposed as plaintext to the browser. */
export function whatsappBootstrap(): { baseUrl: string; apiKey: string; providers: ProviderConfig } | null {
  if (config().NODE_ENV === "test") return null;
  const path = join(SERVER_ROOT, "data", "whatsapp-bootstrap.json");
  if (!existsSync(path)) return null;
  const stored = JSON.parse(readFileSync(path, "utf8"));
  return { baseUrl: stored.baseUrl, apiKey: decrypt(stored.apiKeyEnc), providers: JSON.parse(decrypt(stored.providersEnc)) };
}
