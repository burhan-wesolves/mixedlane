import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubClient, GitHubError } from "../src/modules/github/client";

afterEach(() => vi.unstubAllGlobals());

describe("GitHub REST integration", () => {
  it("authenticates requests and sends JSON bodies using the configured API host", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 42 }), { status: 201 }));
    vi.stubGlobal("fetch", fetch);
    const client = new GitHubClient("test-only-token", "https://github.example/api/v3/");
    expect(await client.post("/repos/team/app/hooks", { active: true })).toEqual({ id: 42 });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://github.example/api/v3/repos/team/app/hooks");
    expect(init.headers).toMatchObject({ authorization: "Bearer test-only-token", "content-type": "application/json" });
    expect(JSON.parse(init.body)).toEqual({ active: true });
  });

  it("reports invalid credentials without including the token in the error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 })));
    const result = new GitHubClient("test-only-token").get("/user");
    await expect(result).rejects.toBeInstanceOf(GitHubError);
    await expect(result).rejects.toMatchObject({ status: 401, message: "GitHub 401: Bad credentials — the token is invalid or expired" });
  });

  it("explains missing repository permissions", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: "Resource not accessible" }), { status: 403 })));
    await expect(new GitHubClient("test-only-token").get("/user/repos")).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining("check the token's repository access and permissions"),
    });
  });

  it("follows GitHub pagination links when searching repositories", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([{ full_name: "team/one" }]), { headers: { link: '<https://api.github.com/user/repos?page=2>; rel="next"' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ full_name: "team/two" }])));
    vi.stubGlobal("fetch", fetch);
    expect(await new GitHubClient("test-only-token").paginate("/user/repos")).toEqual([{ full_name: "team/one" }, { full_name: "team/two" }]);
    expect(fetch.mock.calls[1][0]).toBe("https://api.github.com/user/repos?page=2");
  });

  it("bounds repository pagination to the requested maximum", async () => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response("[]", { headers: { link: '<https://api.github.com/user/repos?page=2>; rel="next"' } })));
    vi.stubGlobal("fetch", fetch);
    expect(await new GitHubClient("test-only-token").paginate("/user/repos", 2)).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("accepts GitHub's empty success responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    await expect(new GitHubClient("test-only-token").delete("/repos/team/app/hooks/42")).resolves.toBeUndefined();
  });
});
