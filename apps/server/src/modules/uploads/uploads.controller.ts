import { Body, Controller, Get, Injectable, Module, Param, Post, Req, Res, UploadedFile, UseGuards, UseInterceptors, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Request, Response } from "express";
import { z } from "zod";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Ctx, Public, type RequestContext } from "../../core/context";
import { AppError } from "../../core/http";
import { FILE_COOKIE } from "../auth/auth.controller";
import { verifyFileToken } from "../auth/crypto";
import { AccessService } from "../access/access.service";
import { AgentsService, isApiKey } from "../agents/agents.service";
import { DocsModule } from "../docs/docs.controller";
import { UploadsService } from "./uploads.service";

const MB = 1024 * 1024;

type TicketRequest = Request & { mediaTicket?: Awaited<ReturnType<UploadsService["authorizeTicket"]>> };

/** Reject expired/revoked tickets before buffering a multipart body. */
@Injectable()
export class MediaUploadGuard implements CanActivate {
  constructor(private readonly media: UploadsService) {}
  async canActivate(host: ExecutionContext) {
    const req = host.switchToHttp().getRequest<TicketRequest>();
    req.mediaTicket = await this.media.authorizeTicket(String(req.params.token));
    return true;
  }
}

@ApiTags("Uploads")
@ApiBearerAuth()
@Controller("uploads")
export class UploadsController {
  constructor(
    private readonly media: UploadsService,
    private readonly access: AccessService,
    private readonly agents: AgentsService,
  ) {}

  @Post()
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 200 * MB } }))
  async upload(@Ctx() ctx: RequestContext, @Body() body: unknown, @UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new AppError(400, "Send the file as multipart field 'file'");
    const scope = z.object({ project: z.string().min(1).optional(), space: z.string().min(1).optional() }).safeParse(body ?? {});
    if (!scope.success) throw new AppError(400, "Project and space must be nonempty strings");
    return this.media.store(ctx, { name: file.originalname, mime: file.mimetype, data: file.buffer }, scope.data);
  }

  @Public()
  @Post("agent/:token")
  @UseGuards(MediaUploadGuard)
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 200 * MB } }))
  async uploadWithTicket(@Req() req: TicketRequest, @UploadedFile() file?: Express.Multer.File) {
    return this.media.completeTicket(req.mediaTicket!.row, file);
  }

  /**
   * <img>/<video> can't send an Authorization header, so files are authorized with the httpOnly
   * ml_file cookie (set at sign-in, scoped to this path). Agents may also use their API key.
   */
  @Public()
  @Get(":name")
  async serve(@Param("name") name: string, @Req() req: Request, @Res() res: Response) {
    const row = await this.media.find(name);
    const authorization = req.header("authorization");
    const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : null;
    const userId = bearer ? null : await verifyFileToken(req.cookies?.[FILE_COOKIE]);
    const ctx = bearer ? (isApiKey(bearer) ? await this.agents.authenticate(bearer) : null)
      : userId ? await this.access.contextFor(row.orgId, userId) : null;
    if (!ctx) return res.status(404).json({ error: "Not found" });
    try { await this.media.assertRead(ctx, row); }
    catch (error) { if (error instanceof AppError) return res.status(404).json({ error: "Not found" }); throw error; }
    const size = await this.media.storage.size(name);
    if (size === null) return res.status(404).json({ error: "Not found" });

    res.set({
      "content-type": row.mime,
      "accept-ranges": "bytes",
      "cache-control": row.projectId || row.spaceId ? "private, no-cache" : "private, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    });
    // Range requests let browsers seek in videos without downloading the whole file.
    const range = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
    if (range) {
      let start = range[1] ? Number(range[1]) : size - Number(range[2]);
      let end = range[1] && range[2] ? Number(range[2]) : size - 1;
      start = Math.max(0, start);
      end = Math.min(end, size - 1);
      if (start > end) return res.status(416).set("content-range", `bytes */${size}`).end();
      res.status(206).set({ "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) });
      return (await this.media.storage.stream(name, { start, end })).pipe(res);
    }
    res.set("content-length", String(size));
    return (await this.media.storage.stream(name)).pipe(res);
  }
}

@Module({ imports: [DocsModule], controllers: [UploadsController], providers: [UploadsService, MediaUploadGuard], exports: [UploadsService] })
export class UploadsModule {}
