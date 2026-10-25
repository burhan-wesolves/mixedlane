---
name: mixedlane-planning
description: Record plans and requirements as Mixedlane work items (epic → milestone → user story → task → subtask). Use whenever you create an implementation plan, break down a feature, bug list, spec or requirements, or the user asks to plan, scope or build something non-trivial.
---

# Plan work in Mixedlane

Turn the plan you just made — or the requirements you were given — into a clean Mixedlane breakdown that the
team can see on the board. Use the `mixedlane` MCP tools.

Before each new planning or ticket-writing request, call `get_agent_skill` to load this organization's current saved skill. Follow its customized templates and rules alongside the user's request and your granted permissions. Fetch once per request, not recursively when this instruction appears in the returned skill. If the tool is missing, reconnect MCP; use this bundled skill as the fallback and tell the user that organization customizations could not be loaded.

## 1. Find the project
- Call `whoami` and respect the connection's granted project scope. Project mode cannot create projects; global mode may create multiple projects, so choose an existing project when it fits.
- If the repo has a `.mixedlane.json`, use its `project` key.
- Otherwise call `list_projects`. If there is exactly one sensible project, use it; if it's unclear, ask the user
  which one (and offer to link the repo with the `mixedlane-init` skill).
- **New initiative with no fitting project?** Create it with `create_project` (a short 2–5 letter key like `MKA`,
  enable only the levels it needs, e.g. `["epic","story","task"]`). If the tool says you aren't allowed, tell the
  user the exact setting it names (Settings → AI agents → your agent → "Can create projects") instead of stopping
  silently — and offer to plan into an existing project meanwhile.
- Call `get_project` to learn the **enabled item types** and **statuses**. Only use enabled types.

## 2. Don't duplicate
- Before **every** `create_item` or `create_plan`, use `search_items` with the selected project and meaningful keywords, then `get_item` for plausible matches and their ancestors. Compare purpose and acceptance criteria, not only exact titles.
- Match only the same item type inside the **same epic and milestone**, when those levels exist. A similar task in another epic or milestone is separate work. If neither level exists, use the same project and parent. Reuse an active epic or milestone in its own parent scope before searching its children.
- Never reuse, update, or reopen an item whose status category is `done` or whose status name/id is Done, Release or Released. Ignore those as matches and create a new ticket for new work.
- If a similar active ticket exists in scope, read it and `update_item` that ticket, merging new requirements while preserving useful notes, acceptance criteria and relationships. Use its key as the parent of new children. If several tickets are plausible, clarify which to update; do not merge unrelated work.
- If no matching active ticket exists in scope, create a new one. Report which tickets were updated versus created.

## 3. Shape the breakdown
| Level | Use it for | Title style |
| --- | --- | --- |
| **Epic** | A user-facing outcome or theme | "Password reset" |
| **Milestone** | A release/phase inside an epic (only if the project enables milestones and the work spans phases) | "M1 · Email flow" |
| **User story** | Value for a user; put acceptance criteria in the description as `- [ ]` items | "As a user I can request a reset link" |
| **Task** | One concrete implementation step (roughly ≤ 1 day) | "Add reset token table + migration" |
| **Subtask** | Only when a task clearly splits further | "Write migration test" |

- Descriptions are Markdown: the why, notes, links to docs/files. Keep titles short.
- Set `priority` when it's obvious (bugs blocking users → high/urgent). Add `estimate` only if you estimated.
- Keep it proportionate: a small change may be a single task (under an existing story if one fits).

## 4. Create it
Call `create_plan` once with the whole tree. Give every item a `ref` (e.g. `e1`, `s1`, `t1`) and point children at
their parent's `ref` (or at an existing key such as `APP-0012`).

- **Planning mode AUTO** (default): pass `confirmed: true` and create it right away — don't ask for permission.
- **Planning mode PROPOSE**: call without `confirmed`, show the preview to the user, and call again with the same
  items and `confirmed: true` only after they approve.
- `create_plan` reuses active items with the same title/type under the same parent and updates explicitly supplied description, priority, labels and estimate (omitted fields stay unchanged). Descriptions replace the current text: merge useful existing content first. Done/released items are excluded. Semantic matches or matches under different stories in the same epic/milestone require the search-and-update step above. If it reports a hierarchy problem, fix the tree and call it again.

## 5. Report
Reply with the created/reused keys as a short indented tree (key — title), and the board link for the epic.
Then continue with the work, using the `mixedlane-work-tracking` skill.

## 6. Ticket title and body boilerplates

Use the applicable template below for every newly created ticket. Replace placeholders with known facts; do not leave sample content or invent requirements, dates, test results, owners or estimates. Omit optional sections when they add nothing, and record unresolved facts under Open questions. For an existing active ticket, merge the new content rather than erasing its useful notes or completed checklist entries. Scale detail to the work.

The title is a separate plain-text field, not a heading inside the body. Keep it specific and concise (aim for under 100 characters; maximum 300). Use the project hierarchy's parent field instead of repeating parent titles. Set priority, labels, assignee, estimate and due date as structured tool fields when known; use `update_item` for fields not accepted by `create_plan`.

### Epic
Title: `<User or business outcome>` — for example, `Enable self-service account recovery`.

```markdown
## Outcome
<Who benefits, the problem, and the desired result.>
## Scope
- <Capability included in this epic>
## Out of scope
- <Explicit boundary, if known>
## Success criteria
- [ ] <Observable outcome that makes this epic complete>
## Dependencies and risks
- <Dependency or risk and how it affects delivery>
## References
- [Specification](<URL or Mixedlane doc link>)
## Open questions
- <Decision still needed, if any>
```

### Milestone
Title: `<Phase or deliverable>` — for example, `M1 · Recovery email flow`.

```markdown
## Goal
<What this phase delivers toward its parent epic.>
## Deliverables
- <Concrete deliverable>
## Exit criteria
- [ ] <Verifiable condition before moving to the next phase>
## Dependencies
- <Blocking ticket key or external dependency>
## Target and rollout
<Known target date, rollout or release notes; omit unknown dates.>
```

### User story
Title: `As a <role>, I can <capability>` — for example, `As a user, I can request a password reset link`.

```markdown
## User value
As a <role>, I want <capability>, so that <benefit>.
## Acceptance criteria
- [ ] Given <context>, when <action>, then <observable result>.
- [ ] <Relevant error case or permission boundary>
## Scope and behavior
<Expected behavior and constraints; link designs when available.>
## Dependencies
- <Related ticket key or dependency>
## Verification
- <How acceptance criteria will be checked>
## Open questions
- <Unresolved product decision, if any>
```

### Task
Title: `<Action verb> <specific deliverable>` — for example, `Add expiring reset-token storage`.

```markdown
## Purpose
<What this implements and why it is needed.>
## Implementation scope
- <Concrete change; name files, endpoints or components only when known>
## Acceptance criteria
- [ ] <Observable completion condition>
## Verification
- <Relevant automated test or manual check to run>
## Dependencies and notes
- <Blocking key, technical constraint or useful reference>
```

### Subtask
Title: `<Action verb> <one bounded step>` — for example, `Test reset-token expiry`.

```markdown
## Step
<One focused step toward the parent task.>
## Completion criteria
- [ ] <Specific expected result>
## Verification
- <Check that proves this step is complete>
```

### Bug report (use the project's enabled task or story type)
Title: `Fix <observable failure> when <trigger>` — for example, `Fix expired reset links opening the password form`.

```markdown
## Problem
<User-visible failure and impact.>
## Steps to reproduce
1. <Starting context>
2. <Trigger action>
## Expected behavior
<Correct observable behavior.>
## Actual behavior
<Observed behavior; distinguish reports from independently verified results.>
## Environment
<Known app version, browser or device; omit unknown details.>
## Acceptance criteria
- [ ] <Failure no longer occurs under the reproduction steps>
## Verification
- <Regression test or manual check to run>
## Evidence
<Uploaded screenshot/video Markdown, relevant logs or links, if available.>
```

### Basic Markdown
Bodies and comments accept Markdown. Use `## Heading`, `**bold**`, `*emphasis*`, backticks for `code`, `-` bullet lists, numbered steps, `- [ ]` / `- [x]` checklists, `[label](https://example.com)` links, tables, and fenced code blocks with a language such as `ts` or `text`. Avoid using raw HTML for layout. Use short paragraphs and descriptive link labels. Reference existing ticket keys such as `APP-0012` and link long specifications in Mixedlane docs rather than duplicating them in every ticket.

## 7. Upload and embed media

Use this for screenshots or videos on any epic, milestone, story, task, subtask or comment. Never paste a local filesystem path, `data:` URL or raw base64 into a ticket body.

1. Determine the target project's key (or the document's space) and the real file name, MIME type and exact byte size. Use a supported raster image or video type; SVG is unsupported. Project uploads require create, edit or comment permission; document-space uploads require write access.
2. For files **up to 1 MB**, call `upload_media` with `{ project: "APP", name: "reset-error.png", mime: "image/png", dataBase64: "<base64 of actual file bytes, without a data: prefix>" }`. For documents, replace `project` with `space`; do not pass both.
3. For larger files, call `prepare_media_upload` with `{ project: "APP", name: "reset-flow.mp4", mime: "video/mp4", size: <exact bytes> }`. Image limit is 20 MB and video limit is 200 MB. POST the local file as multipart field `file` to the returned single-use upload URL within 10 minutes. No browser login or extracted session cookie is needed. Treat a failed or expired upload as incomplete; obtain a new URL before retrying.
4. Only after upload succeeds, copy the response's **exact `markdown`** into the ticket's Evidence or References section using `create_item`, `update_item` or `add_comment`. For documents use `create_page`/`update_page`. Preserve the rest of the existing body and pass the document version when updating a page. Do not construct a guessed media URL or video embed yourself.
5. Call `read_media` on the returned URL to verify stored bytes (and inspect small complete images), then `get_item` or `get_page` to verify the saved embed. Report upload and saved-content verification accurately; a saved text field alone does not prove visual rendering. If media tools are missing, reconnect MCP to refresh the tool list.
