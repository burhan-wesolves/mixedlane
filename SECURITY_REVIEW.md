# Security review — 27 October 2026

## Implemented

- **Agent ownership isolation:** new and existing agents default to `itemScope: own` and `pageScope: own`. Stories, tasks and other work items share the item scope. Organization owners/admins can widen each scope independently under **Settings → AI agents → Content access**. Existing project grants, action permissions and document-space permissions still apply when scope is `all`.
- **Server enforcement:** REST and MCP detail, mutations, comments, activity, versions, restores, search, boards, planning, trees, statistics and backlinks filter or check ownership. Knowing another item's key or a page UUID does not grant access. Parent references require access; foreign ancestors and children are omitted from read models.
- **Cascade protection:** creator-only agents cannot delete a work-item/page tree containing descendants created by somebody else.
- **Media isolation:** creator-only agents cannot download another principal's uploads through a readable project or space, including the MCP byte-reading tool.
- **Realtime isolation:** agent event deliveries reauthenticate and check access to the event's resource. Agent configuration changes, disablement, key revocation and removal trigger room/presence resynchronization.
- **File-cookie revocation:** downloads now require a live issuing session. Replaying a file cookie after logout no longer bypasses session revocation. Downloads use `private, no-store` to avoid retaining protected content in browser caches.
- **Compatible dependency updates:** patched `body-parser`, `fast-uri`, `hono`, `ip-address`, `markdown-it` (including nested copies) and `nodemailer`, plus their compatible dependencies. Production npm audit package findings fell from **11 (5 high, 6 moderate)** to **5 (3 high, 2 moderate)**.

## Migration and behavior

`apps/server/drizzle/0011_agent_content_scope.sql` runs through the existing startup migration mechanism. It adds agent scopes and immutable creator identifiers. Work-item ownership is backfilled from typed creation audit records.

Historical agent-created pages have no trustworthy agent identifier: their author identifiers are null and display names do not establish identity. They remain hidden in creator-only mode. A human administrator can still access them and can explicitly permit `all` page access if needed. Do not infer ownership by matching names or the last editor.

The scopes limit item/page content. Agents still receive metadata for explicitly allowed projects/spaces and organization instructions necessary to operate. `docAccess` continues to control standalone spaces; project-space read/write toggles remain separate. Wider content access never grants access to another organization or an ungranted project.

Old file cookies lack a session identifier and are rejected. Refreshing the browser session or signing in issues a replacement cookie.

## Remaining findings, in priority order

### High — dependency advisories requiring coordinated upgrades

The production audit after compatible updates reports these five affected package entries. Parent and transitive entries can describe the same underlying advisory; this is not five independently demonstrated application exploits.

| Package entries | Advisory | Next action |
| --- | --- | --- |
| `multer`, `@nestjs/platform-express` — high | [Multipart teardown denial of service](https://github.com/advisories/GHSA-q7qp-rjg7-q26m) | Upgrade to a Nest adapter with patched Multer, or validate a targeted patched Multer override. Exercise aborted multipart uploads and upload tickets. npm's automatic adapter fix requires a Nest major upgrade. |
| `zod` — high | [Oversized collection validation can exhaust memory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) | Migrate to a patched Zod release, coordinating MCP SDK and `zod-to-json-schema` integration. Existing body-size/rate limits reduce exposure but do not fix the library. |
| `js-yaml`, `@nestjs/swagger` — moderate | [Unbounded CPU use for YAML merge sources](https://github.com/advisories/GHSA-r3ph-w7gj-g6xm) | Upgrade Swagger or validate a patched YAML override. Determine whether untrusted YAML reaches the affected parser; the audit alone does not establish reachability. |

These upgrades remain open. A forced automatic major-version update was not applied because it spans framework, validation and MCP compatibility.

### High when development is network-accessible — unauthenticated reset

`apps/server/src/modules/dev/demo.seeder.ts` exposes `POST /api/dev/reset-demo` with `@Public()`. It checks development mode but does not authenticate the caller. The default host listens on `0.0.0.0`. A reachable development instance can therefore have its demo data reset by another caller. The production module excludes this route.

**Next action:** require an explicit reset opt-in and a local/admin authorization mechanism. Run shared deployments with `NODE_ENV=production`; avoid exposing development servers with real data.

### Medium — production email fallback does not establish identity

`apps/server/src/modules/auth/auth.service.ts` marks newly registered accounts verified when `MAIL_HOST` is absent. `apps/server/src/core/mail.ts` logs email bodies, including capability links, in the same fallback mode. Production configuration does not require SMTP.

**Next action:** make production startup require a configured mail delivery policy or an explicit administrative opt-out. Keep verification/reset/invitation links out of production logs. Verify log access and retention for existing deployments.

### Medium — integration URLs permit server-side network requests

The GitHub and OpenWA clients accept organization-admin configured destinations and make authenticated requests from the server (`modules/github/client.ts`, `modules/whatsapp/client.ts`, `modules/whatsapp/whatsapp.service.ts`). This is a network-boundary concern in multi-tenant hosting: an organization integration administrator is not necessarily trusted to contact the host's internal services.

**Next action:** introduce a deployment-managed destination policy, including redirects and resolved addresses. Preserve explicitly approved private GitHub/OpenWA installations rather than indiscriminately blocking private networks. This review identified the request capability; it did not demonstrate an infrastructure exploit.

### Medium — organization instructions can be changed by ordinary members

`AgentsService.updateSkill` deliberately allows organization members to edit the skill delivered to all connected agents. Access-control checks prevent those instructions from granting database permissions, but malicious instructions can still influence an agent operating with access to external tools or files.

**Next action:** consider restricting organization-wide skill changes to owners/admins, or introduce a distinct permission and an auditable approval/version history. Treat story text, documents, comments and shared instructions as untrusted input in consuming agents.

### Medium — unscoped uploads and organization directory exposure

Legacy/unscoped browser uploads are readable by any organization member who knows the upload URL. They have no project/space identifier against which private-project permissions can be checked. Organization member/team directory endpoints are also readable by authenticated agents/guests, independently of item ownership.

**Next action:** require scopes on new browser uploads and define a migration/access policy for old files. Introduce explicit agent directory-read controls or return the minimum assignee information needed by permitted workflows.

## Verification

- Full API suite: **18 files, 151 tests passed**, including new two-agent/human isolation tests and replayed file-cookie tests.
- Final verification after dependency updates: **8 files, 74 security/authentication/media/planning/realtime tests passed**. TypeScript checks and the production web/server build passed. The web build retains its existing large-chunk warning.
- Current production dependency audit: **5 package findings remain** as listed above.
- This is a source review, integration regression run and dependency audit, not a complete penetration test or a guarantee that every deployment path is secure.
