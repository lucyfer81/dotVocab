import { SELF } from "cloudflare:test";
import { expect, it } from "vitest";

it.each([
  ["/", "/manifest.json"],
  ["/xct", "/manifest-xct.json"],
  ["/lcl", "/manifest-lcl.json"],
])("links the manifest for navigation to %s", async (path, manifestPath) => {
  const origin = "https://example.com";
  const page = await SELF.fetch(origin + path, {
    headers: { "Sec-Fetch-Mode": "navigate" },
    redirect: "manual",
  });
  expect(page.status).toBe(200);
  expect((await page.text()).match(/<link rel="manifest"[^>]*>/g))
    .toEqual([expect.stringContaining(`href="${manifestPath}"`)]);

  const manifest = await SELF.fetch(origin + manifestPath);
  expect(manifest.status).toBe(200);
  expect(await manifest.json()).toMatchObject({
    start_url: path,
    display: "standalone",
    ...(path === "/" ? {} : { id: path }),
  });
});
