import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { RequestContext } from "../../core/context";
import { config } from "../../core/config";
import { DB, type Db } from "../../core/database/database";
import { uploads } from "../../core/database/schema";
import { AppError } from "../../core/http";
import { StorageDriver } from "../../core/storage";
import { AccessService } from "../access/access.service";
import { AgentsService } from "../agents/agents.service";
import { signMediaUploadToken, verifyMediaUploadToken } from "../auth/crypto";
import { DocsService } from "../docs/docs.service";

const MB = 1024 * 1024;
export const INLINE_MEDIA_MAX = MB;
export const MEDIA_TYPES: Record<string, { ext: string; kind: "image" | "video"; max: number }> = {
  "image/png": { ext: "png", kind: "image", max: 20 * MB },
  "image/jpeg": { ext: "jpg", kind: "image", max: 20 * MB },
  "image/gif": { ext: "gif", kind: "image", max: 20 * MB },
  "image/webp": { ext: "webp", kind: "image", max: 20 * MB },
  "image/avif": { ext: "avif", kind: "image", max: 20 * MB },
  "video/mp4": { ext: "mp4", kind: "video", max: 200 * MB },
  "video/webm": { ext: "webm", kind: "video", max: 200 * MB },
  "video/ogg": { ext: "ogv", kind: "video", max: 200 * MB },
  "video/quicktime": { ext: "mov", kind: "video", max: 200 * MB },
};
type UploadRow = typeof uploads.$inferSelect;
export type UploadScope = { project?: string; space?: string };

@Injectable()
export class UploadsService {
  constructor(@Inject(DB) private readonly db: Db, readonly storage: StorageDriver,
    private readonly access: AccessService, private readonly docs: DocsService, private readonly agents: AgentsService) {}

  private validate(name: string, mime: string, size: number) {
    if (!name.trim() || name.length > 255) throw new AppError(400, "Use a filename between 1 and 255 characters");
    const type = MEDIA_TYPES[mime];
    if (!type) throw new AppError(415, "Unsupported file type. Use PNG, JPG, GIF, WebP, AVIF, MP4, WebM, OGG or MOV; SVG is not supported.");
    if (!Number.isInteger(size) || size <= 0 || size > type.max) throw new AppError(413, `${type.kind === "image" ? "Images" : "Videos"} must be nonempty and at most ${type.max / MB} MB`);
    return type;
  }

  private async scope(ctx: RequestContext, input: UploadScope) {
    if (input.project && input.space) throw new AppError(400, "Choose either a project or a space, not both");
    if (input.space) return { projectId: null, spaceId: (await this.docs.space(ctx, input.space, "write")).space.id };
    if (input.project) {
      const { project, access } = await this.access.project(ctx, input.project);
      if (!access.permissions.some((p) => p === "item.create" || p === "item.update" || p === "comment.create")) throw new AppError(403, "Uploading media needs item.create, item.update, or comment.create in this project");
      return { projectId: project.id, spaceId: null };
    }
    if (ctx.agent) throw new AppError(400, "Agent uploads require a project or document space");
    return { projectId: null, spaceId: null };
  }

  info(row: UploadRow) {
    const url = `/api/uploads/${row.storageKey}`;
    const label = row.name.replace(/[\\\[\]<>\r\n]/g, "_");
    const kind = MEDIA_TYPES[row.mime].kind;
    return { url, absoluteUrl: `${config().APP_URL.replace(/\/+$/, "")}${url}`, kind, name: row.name, size: row.size, mime: row.mime,
      markdown: kind === "image" ? `![${label}](${url})` : `[video](${url})` };
  }

  async store(ctx: RequestContext, file: { name: string; mime: string; data: Buffer }, input: UploadScope = {}) {
    const type = this.validate(file.name, file.mime, file.data.length);
    const scope = await this.scope(ctx, input);
    const key = `${randomUUID()}.${type.ext}`;
    await this.storage.put(key, file.data, file.mime);
    const [row] = await this.db.insert(uploads).values({ orgId: ctx.orgId, storageKey: key, mime: file.mime,
      size: file.data.length, name: file.name, uploadedBy: ctx.actor.id, ...scope }).returning();
    return this.info(row);
  }

  async inline(ctx: RequestContext, input: UploadScope & { name: string; mime: string; dataBase64: string }) {
    if (!input.dataBase64 || input.dataBase64.length % 4 !== 0 || input.dataBase64.length > Math.ceil(INLINE_MEDIA_MAX / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.dataBase64)) {
      throw new AppError(400, "Send canonical base64 file bytes (no data: prefix), up to 1 MB. For larger files use prepare_media_upload.");
    }
    const data = Buffer.from(input.dataBase64, "base64");
    if (data.length > INLINE_MEDIA_MAX || data.toString("base64") !== input.dataBase64) throw new AppError(400, "Invalid base64 or file exceeds 1 MB; use prepare_media_upload for larger files");
    return this.store(ctx, { name: input.name, mime: input.mime, data }, input);
  }

  async prepare(ctx: RequestContext, input: UploadScope & { name: string; mime: string; size: number }) {
    if (!ctx.agent) throw new AppError(403, "Upload tickets are for agents");
    const type = this.validate(input.name, input.mime, input.size);
    const scope = await this.scope(ctx, input);
    const storageKey = `${randomUUID()}.${type.ext}`;
    await this.db.insert(uploads).values({ orgId: ctx.orgId, storageKey, mime: input.mime, size: input.size,
      name: input.name, uploadedBy: ctx.actor.id, uploadState: "pending", ...scope });
    const token = await signMediaUploadToken(ctx.agent.keyId, storageKey);
    return { uploadUrl: `${config().APP_URL.replace(/\/+$/, "")}/api/uploads/agent/${token}`, method: "POST", field: "file",
      expiresInSeconds: 600, url: `/api/uploads/${storageKey}`,
      instructions: "POST the local file as multipart field 'file', with the declared MIME type and exact byte size. This URL is a single-use capability; no browser session or extra Authorization header is needed. Only embed the returned markdown after HTTP 201, then read_media to verify the stored file." };
  }

  async authorizeTicket(token: string) {
    const claims = await verifyMediaUploadToken(token);
    const ctx = claims ? await this.agents.contextForKey(claims.keyId) : null;
    if (!ctx || !claims) throw new AppError(401, "Invalid, expired, or revoked media upload ticket");
    const [row] = await this.db.select().from(uploads).where(and(eq(uploads.orgId, ctx.orgId), eq(uploads.storageKey, claims.storageKey), eq(uploads.uploadState, "pending")));
    if (!row || row.uploadedBy !== ctx.actor.id) throw new AppError(409, "Upload ticket was already used or is no longer available");
    await this.scope(ctx, { project: row.projectId ?? undefined, space: row.spaceId ?? undefined });
    return { ctx, row };
  }

  async completeTicket(row: UploadRow, file?: Express.Multer.File) {
    if (!file) throw new AppError(400, "Send the file as multipart field 'file'");
    this.validate(row.name, file.mimetype, file.size);
    if (file.size !== row.size || file.mimetype !== row.mime) throw new AppError(400, "File size and MIME type must match the upload ticket");
    const claimed = await this.db.update(uploads).set({ uploadState: "uploading" }).where(and(eq(uploads.id, row.id), eq(uploads.uploadState, "pending"))).returning();
    if (!claimed.length) throw new AppError(409, "Upload ticket was already used");
    try { await this.storage.put(row.storageKey, file.buffer, row.mime); }
    catch {
      // Keep a partial/failed write unreadable and allow retry with the same unexpired ticket.
      await this.db.update(uploads).set({ uploadState: "pending" }).where(eq(uploads.id, row.id));
      throw new AppError(503, "Media storage failed; retry the upload before the ticket expires");
    }
    await this.db.update(uploads).set({ uploadState: "ready" }).where(eq(uploads.id, row.id));
    return this.info(row);
  }

  async find(key: string) {
    if (!/^[0-9a-f-]{36}\.[a-z0-9]+$/.test(key)) throw new AppError(404, "Upload not found");
    const [row] = await this.db.select().from(uploads).where(and(eq(uploads.storageKey, key), eq(uploads.uploadState, "ready")));
    if (!row) throw new AppError(404, "Upload not found");
    return row;
  }

  async assertRead(ctx: RequestContext, row: UploadRow) {
    if (ctx.orgId !== row.orgId) throw new AppError(404, "Upload not found");
    if (ctx.agent && row.uploadedBy !== ctx.agent.id &&
      (row.spaceId ? ctx.agent.pageScope !== "all" : ctx.agent.itemScope !== "all")) throw new AppError(404, "Upload not found");
    if (row.projectId) await this.access.project(ctx, row.projectId);
    else if (row.spaceId) await this.docs.space(ctx, row.spaceId);
    else if (ctx.agent && row.uploadedBy !== ctx.actor.id) throw new AppError(404, "Upload not found");
  }

  async read(ctx: RequestContext, url: string, offset: number, maxBytes: number) {
    const key = url.startsWith("/api/uploads/") ? url.slice("/api/uploads/".length) : url;
    const row = await this.find(key);
    await this.assertRead(ctx, row);
    if (offset >= row.size) throw new AppError(400, "Offset is outside the file");
    const length = Math.min(maxBytes, row.size - offset);
    const chunks: Buffer[] = [];
    for await (const chunk of await this.storage.stream(key, { start: offset, end: offset + length - 1 })) chunks.push(Buffer.from(chunk));
    const data = Buffer.concat(chunks);
    if (data.length !== length) throw new AppError(503, "Stored media is incomplete");
    return { ...this.info(row), offset, bytes: data.length, nextOffset: offset + data.length < row.size ? offset + data.length : null,
      dataBase64: data.toString("base64") };
  }
}
