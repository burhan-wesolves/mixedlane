import { describe, expect, it } from "vitest";
import { htmlToMarkdown, markdownToHtml } from "../src/core/markdown";

describe("markdown <-> editor html", () => {
  it("preserves protected images and videos through agent edits without allowing raw HTML or unsafe video URLs", () => {
    const image = "/api/uploads/11111111-1111-4111-8111-111111111111.png";
    const video = "/api/uploads/22222222-2222-4222-8222-222222222222.mp4";
    const markdown = `![Screenshot](${image})\n\n[video](${video})`;
    const html = markdownToHtml(markdown);
    expect(html).toContain(`<img src="${image}"`);
    expect(html).toContain(`<video src="${video}" controls`);
    expect(htmlToMarkdown(html)).toBe(markdown);
    expect(markdownToHtml(htmlToMarkdown(html))).toBe(html);
    expect(markdownToHtml('[video](https://example.com/movie.mp4)')).not.toContain("<video");
    expect(markdownToHtml('[video](javascript:alert(1))')).not.toContain("<video");
    expect(markdownToHtml('<video src="/x" onerror="alert(1)"></video>')).not.toContain("<video");
  });

  it("preserves table structure and inline formatting across repeated agent edits", () => {
    const source = "## Results\n\n| Check | Result |\n| --- | --- |\n| **Lifecycle** | [Passed](https://example.com) |\n| Pipe \\| value | `done` |";
    const once = htmlToMarkdown(markdownToHtml(source));
    expect(once).toContain("| Check | Result |");
    expect(once).toContain("| --- | --- |");
    expect(once).toContain("| **Lifecycle** | [Passed](https://example.com) |");
    expect(once).toContain("| Pipe \\| value | `done` |");
    expect(htmlToMarkdown(markdownToHtml(once))).toBe(once);
  });

  it("reads editor tables with paragraph cells and missing cells without merging columns", () => {
    const md = htmlToMarkdown('<table><tbody><tr><th><p>Check</p></th><th><p>Result</p></th></tr><tr><td><p>Agent</p></td><td><p>Passed</p></td></tr><tr><td><p>Pending</p></td></tr></tbody></table>');
    expect(md).toBe("| Check | Result |\n| --- | --- |\n| Agent | Passed |\n| Pending |  |");
  });

  it("renders agent markdown, including task lists, and escapes raw html", () => {
    const html = markdownToHtml("## Plan\n\n- [ ] write tests\n- [x] ship\n\nSee **APP-12** <script>alert(1)</script>");
    expect(html).toContain("<h2>Plan</h2>");
    expect(html).toContain('<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>write tests</p></li>');
    expect(html).toContain('data-checked="true"><p>ship</p>');
    expect(html).not.toContain("<script>");
  });

  it("turns editor html back into markdown for agents", () => {
    const md = htmlToMarkdown(
      '<h2>Plan</h2><p>Ask <span data-type="mention" data-id="x" data-label="Priya">@Priya</span></p><ul data-type="taskList"><li data-type="taskItem" data-checked="true"><label><input type="checkbox" checked></label><div><p>ship</p></div></li></ul>',
    );
    expect(md).toContain("## Plan");
    expect(md).toContain("Ask @Priya");
    expect(md).toContain("- [x] ship");
  });
});
