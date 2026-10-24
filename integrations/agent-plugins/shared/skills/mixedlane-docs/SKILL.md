---
name: mixedlane-docs
description: Write specs, designs, ADRs, runbooks and meeting notes into Mixedlane docs and link them to work items. Use when producing a document longer than a few paragraphs (PRD, tech spec, design, decision record) that the team should keep.
---

# Write docs in Mixedlane

1. `list_spaces` to find the right space (a project space for project-specific docs, otherwise an org-wide one).
   Pick the parent page from the returned page tree so the doc lands in the right place.
2. `search_docs` first — update an existing page (`get_page` → `update_page` with its `version`) instead of
   creating a near-duplicate.
3. `create_page` with Markdown content. Mention the related item keys (e.g. `APP-0012`) in the text: Mixedlane
   links the page and the items both ways.
4. If `update_page` reports a conflict, someone saved in between: `get_page` again, merge, and retry.
5. Reply with the page link.

For images or videos, use `upload_media` scoped to the document's `space` (up to 1 MB of base64 bytes), or `prepare_media_upload` plus a multipart POST for larger files. Embed the successful upload response's `markdown` in `create_page`/`update_page`; preserve the rest of the content and pass the version you read. `read_media` verifies stored bytes and returns complete small images for inspection. `get_page` verifies the saved embed. Do not paste data URLs/base64 into pages, require browser login, or claim visual success merely because text was saved. Reconnect the MCP server if these tools are missing.

Good structure for a spec: Summary · Background · Proposed design · Alternatives · Rollout · Open questions.
