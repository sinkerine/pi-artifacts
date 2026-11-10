import { cp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { digestTree, journey } from "../fixtures/journey.mjs";

const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="red"/></svg>';
/** @returns {Record<string, string>} */
const html = (label = "Count") => ({
  "index.html": `<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><h1>${label}</h1><button id="counter">0</button><img alt="Local image" src="image.svg"><script src="app.js"></script></body></html>`,
  "style.css": "h1{color:rgb(120, 30, 40)}",
  "app.js":
    "document.querySelector('#counter').onclick=e=>e.target.textContent=String(Number(e.target.textContent)+1)",
  "image.svg": svg,
});
const react = (
  body = "<><h1 className='text-red-500'>React counter</h1><button onClick={()=>setCount(count+1)}>Count {count}</button><Heart aria-label='Heart icon'/><BarChart width={220} height={100} data={[{name:'a',value:3},{name:'b',value:5}]}><Bar dataKey='value'/></BarChart><img src={image} alt='React local image'/></>",
) => ({
  "main.tsx": `import React,{useState} from 'react';import {Heart} from 'lucide-react';import {BarChart,Bar} from 'recharts';import image from './image.svg';import './style.css';export default function App(){const [count,setCount]=useState(0);return ${body}}`,
  "style.css": "button{padding:12px}",
  "image.svg": svg,
});
/** @param {string} path @returns {Promise<string[]>} */
async function files(path) {
  const out = [];
  for (const e of await readdir(path, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...(await files(join(path, e.name))));
    else out.push(join(path, e.name));
  }
  return out;
}
/** @template {import("../fixtures/journey-types.ts").ToolName} N
 * @param {import("../fixtures/journey-types.ts").PiRecord[]} records @param {N} name
 * @returns {import("../fixtures/journey-types.ts").ToolEvent<N>} */
function tool(records, name) {
  const event = records.findLast((r) => r.type === "tool_execution_end" && r.toolName === name);
  expect(event, `actual ${name} tool event`).toBeTruthy();
  if (!event?.result) throw Error(`Missing ${name} result`);
  return /** @type {import("../fixtures/journey-types.ts").ToolEvent<N>} */ (event);
}
test("E1–E10 / V1 packaged Pi artifacts journey", async ({ browser }) => {
  /** @type {Awaited<ReturnType<typeof journey>>} */
  let harness;
  /** @type {{harness?: Awaited<ReturnType<typeof journey>>, context?: import("@playwright/test").BrowserContext}} */
  const resources = {};
  /** @type {{id: string, expected: string, actual: string, durationMs: number}[]} */
  const steps = [];
  /** @type {{url: string, resource: string, allowed: boolean}[]} */
  const network = [];
  /** @type {{type: string, text: string}[]} */
  const consoleLog = [];
  /** @param {string} id @param {string} expected @param {() => Promise<void>} fn */
  const step = async (id, expected, fn) =>
    test.step(id, async () => {
      const start = Date.now();
      try {
        await fn();
        steps.push({ id, expected, actual: "Assertions passed", durationMs: Date.now() - start });
      } catch (e) {
        steps.push({
          id,
          expected,
          actual: e instanceof Error ? e.message : String(e),
          durationMs: Date.now() - start,
        });
        throw e;
      } finally {
        if (harness) await writeFile(join(harness.root, "steps.json"), JSON.stringify(steps, null, 2));
      }
    });
  /** @type {import("@playwright/test").BrowserContext} */
  let context;
  /** @type {import("@playwright/test").Page} */
  let page;
  /** @type {import("@playwright/test").Page} */
  let pinned;
  /** @type {import("../../src/shared/contracts.ts").ArtifactRevision} */
  let htmlArtifact;
  /** @type {import("../../src/shared/contracts.ts").ArtifactRevision} */
  let reactArtifact;
  /** @type {import("../../src/shared/contracts.ts").ArtifactRevision} */
  let markdownArtifact;
  let sessionSnapshot = "";
  /** @type {Record<string, string>} */
  const knownDigests = {};
  /** @param {import("@playwright/test").Page} target */
  const frame = (target) => target.frameLocator("iframe");
  async function saved() {
    return digestTree(join(harness.config.dataDir, "artifacts"));
  }
  /** @param {Record<string, string>} previous */
  async function unchanged(previous) {
    const next = await saved();
    for (const [path, hash] of Object.entries(previous)) expect(next[path], path).toBe(hash);
  }
  try {
    await step("E1", "Isolated packaged service health and actual Pi extension loaded", async () => {
      harness = await journey();
      resources.harness = harness;
      context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "light" });
      resources.context = context;
      await context.route("**/*", (route) => {
        const u = new URL(route.request().url());
        network.push({
          url: u.href,
          resource: route.request().resourceType(),
          allowed: u.hostname === "127.0.0.1",
        });
        if (u.hostname !== "127.0.0.1") return route.abort();
        return route.continue();
      });
      page = await context.newPage();
      context.on("page", (p) => p.on("console", (m) => consoleLog.push({ type: m.type(), text: m.text() })));
      page.on("console", (m) => consoleLog.push({ type: m.type(), text: m.text() }));
      expect((await (await fetch(`${harness.internal}health`)).json()).status).toBe("ok");
      const result = await harness.pi([{ name: "artifact_list", args: {} }]);
      expect(tool(result, "artifact_list").result.details).toEqual({ artifacts: [] });
    });
    await step("E2", "Empty/missing states and /artifacts command opens configured gallery", async () => {
      await page.goto(harness.publicUrl);
      await expect(
        page.getByText("No artifacts yet. Publish an artifact from Pi to get started."),
      ).toBeVisible();
      const command = await harness.pi([], { prompt: "/artifacts" });
      expect(JSON.stringify(command)).toContain(harness.publicUrl);
      await page.goto(`${harness.publicUrl}a/00000000-0000-0000-0000-000000000000?revision=99`);
      await expect(page.getByRole("status").filter({ hasText: "not found" })).toBeVisible();
      await page.screenshot({ path: join(harness.root, "E2-missing.png") });
    });
    await step(
      "E3",
      "Real Pi write/publish yields immutable HTML, local styles/assets and interaction",
      async () => {
        const result = await harness.publish("html", "HTML counter", html());
        expect(result.isError).toBe(false);
        htmlArtifact = result.artifact;
        expect(htmlArtifact.revision).toBe(1);
        expect(tool(result.records, "write").isError).toBe(false);
        expect(
          result.records.some(
            (r) => r.type === "entry_appended" && r.entry?.customType === "pi-artifacts.ref.v1",
          ),
        ).toBe(true);
        await page.goto(htmlArtifact.previewUrl);
        await expect(frame(page).getByRole("heading", { name: "Count" })).toBeVisible();
        await frame(page).getByRole("button", { name: "0", exact: true }).click();
        await expect(frame(page).getByRole("button", { name: "1", exact: true })).toBeVisible();
        expect(
          await frame(page)
            .getByRole("img")
            .evaluate((img) => img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0),
        ).toBe(true);
        await expect(frame(page).getByRole("heading")).toHaveCSS("color", "rgb(120, 30, 40)");
        await page.getByRole("button", { name: "Source", exact: true }).click();
        for (const file of ["index.html", "style.css", "app.js"]) {
          await page.getByRole("button", { name: file, exact: true }).click();
          await expect(page.locator("pre")).toHaveText(html()[file]);
        }
        await page.screenshot({ path: join(harness.root, "E3-source.png") });
        const source = (await files(join(harness.root, "state/sessions"))).find((p) =>
          p.endsWith("journey-A.jsonl"),
        );
        expect(source).toBeTruthy();
        if (!source) throw Error("Missing Pi session snapshot.");
        sessionSnapshot = join(harness.root, "session-at-revision-1.jsonl");
        await cp(source, sessionSnapshot);
        Object.assign(knownDigests, await saved());
      },
    );
    await step(
      "E4",
      "Latest refresh retains Source; pinned stays old; unpublished edits preserve saved bytes",
      async () => {
        pinned = await context.newPage();
        await pinned.goto(htmlArtifact.revisionUrl);
        await expect(frame(pinned).getByRole("heading", { name: "Count" })).toBeVisible();
        const start = Date.now();
        const result = await harness.publish("html", "HTML counter", html("Updated"), htmlArtifact.id);
        expect(result.isError).toBe(false);
        expect(result.artifact.revision).toBe(2);
        await page.getByRole("button", { name: "index.html", exact: true }).click();
        await expect(page.locator("pre")).toContainText("Updated");
        expect(Date.now() - start).toBeLessThan(5000);
        await expect(page.getByRole("button", { name: "Source", exact: true })).toHaveAttribute(
          "aria-pressed",
          "true",
        );
        await expect(pinned.getByText("New revision available")).toBeVisible();
        await expect(frame(pinned).getByRole("heading", { name: "Count" })).toBeVisible();
        await harness.pi([
          { name: "write", args: { path: join(result.work, "index.html"), content: "unpublished mutation" } },
        ]);
        await rm(join(result.work, "app.js"));
        await unchanged(knownDigests);
        await pinned.reload();
        await expect(frame(pinned).getByRole("heading", { name: "Count" })).toBeVisible();
        await page.getByRole("button", { name: "Preview", exact: true }).click();
        await expect(frame(page).getByRole("heading", { name: "Updated" })).toBeVisible();
        await page.screenshot({ path: join(harness.root, "E4-latest.png") });
      },
    );
    await step("E5", "Bundled React/lucide/recharts/Tailwind/local CSS and image work offline", async () => {
      const result = await harness.publish("react", "React libraries", react());
      expect(result.isError, JSON.stringify(result.result)).toBe(false);
      reactArtifact = result.artifact;
      await page.goto(reactArtifact.revisionUrl);
      await expect(frame(page).getByRole("heading", { name: "React counter" })).toBeVisible();
      await frame(page).getByRole("button", { name: "Count 0", exact: true }).click();
      await expect(frame(page).getByRole("button", { name: "Count 1", exact: true })).toBeVisible();
      await expect(frame(page).locator("svg.lucide-heart")).toBeVisible();
      await expect(frame(page).locator(".recharts-bar-rectangle").first()).toBeVisible();
      await expect
        .poll(() =>
          frame(page)
            .getByRole("heading")
            .evaluate((e) => getComputedStyle(e).color),
        )
        .not.toBe("rgb(0, 0, 0)");
      expect(
        await frame(page)
          .locator("img")
          .evaluate((e) => e instanceof HTMLImageElement && e.complete && e.naturalWidth > 0),
      ).toBe(true);
      await page.getByRole("button", { name: "Source", exact: true }).click();
      await expect(page.locator("pre")).toHaveText(react()["main.tsx"]);
      await page.screenshot({ path: join(harness.root, "E5-react.png") });
    });
    await step("E6", "Markdown headings/list/code/image render and source remains text", async () => {
      const markdown =
        "# Markdown title\n\n- one\n- two\n\n```html\n<button>Source only</button>\n```\n\n![Markdown local](image.svg)";
      const result = await harness.publish("markdown", "Markdown example", {
        "index.md": markdown,
        "image.svg": svg,
      });
      expect(result.isError).toBe(false);
      markdownArtifact = result.artifact;
      await page.goto(markdownArtifact.previewUrl);
      await expect(frame(page).getByRole("heading", { name: "Markdown title" })).toBeVisible();
      await expect(frame(page).locator("li")).toHaveCount(2);
      await expect(frame(page).locator("pre code")).toContainText("<button>Source only</button>");
      expect(
        await frame(page)
          .locator("img")
          .evaluate((e) => e instanceof HTMLImageElement && e.complete && e.naturalWidth > 0),
      ).toBe(true);
      await page.getByRole("button", { name: "Source", exact: true }).click();
      await expect(page.locator("pre")).toHaveText(markdown);
      await expect(page.getByRole("button", { name: "Source only" })).toHaveCount(0);
      await page.goto(harness.publicUrl);
      await expect(page.locator(".card")).toHaveCount(3);
      await page.screenshot({ path: join(harness.root, "E6-gallery.png") });
    });
    await step(
      "E7",
      "Restart/reconnect, real Pi resume/fork/restore preserve original refs and bytes",
      async () => {
        const before = await saved();
        await harness.stopService();
        await harness.start();
        await unchanged(before);
        await pinned.reload();
        await expect(frame(pinned).getByRole("heading", { name: "Count" })).toBeVisible();
        await page.goto(reactArtifact.revisionUrl);
        await expect(frame(page).getByRole("heading", { name: "React counter" })).toBeVisible();
        await frame(page).getByRole("button", { name: "Count 0", exact: true }).click();
        await expect(frame(page).getByRole("button", { name: "Count 1", exact: true })).toBeVisible();
        const resumed = await harness.pi([{ name: "artifact_get", args: { id: htmlArtifact.id } }]);
        expect(tool(resumed, "artifact_get").result.details.artifact.revision).toBe(2);
        const destination = join(harness.config.workDir, "fork-restored");
        const fork = await harness.pi(
          [
            { name: "artifact_get", args: { id: htmlArtifact.id, revision: 1, restoreTo: destination } },
            {
              name: "write",
              args: { path: join(destination, "index.html"), content: html("Fork child")["index.html"] },
            },
            {
              name: "artifact_publish",
              args: {
                id: htmlArtifact.id,
                title: "Fork child",
                kind: "html",
                entrypoint: join(destination, "index.html"),
                files: Object.keys(html()).map((p) => join(destination, p)),
              },
            },
          ],
          { session: "journey-fork", fork: sessionSnapshot },
        );
        const child = tool(fork, "artifact_publish").result.details;
        expect(child.parentRevision).toBe(1);
        expect(tool(fork, "artifact_get").result.details.restoredTo).toBe(destination);
        for (const [path, content] of Object.entries(html()).filter(([p]) => p !== "index.html"))
          expect(await readFile(join(destination, path), "utf8")).toBe(content);
        const original = await harness.pi([
          { name: "artifact_list", args: {} },
          { name: "artifact_get", args: { id: htmlArtifact.id } },
        ]);
        expect(tool(original, "artifact_get").result.details.artifact.revision).toBe(2);
        const reject = await harness.pi([
          { name: "artifact_get", args: { id: htmlArtifact.id, restoreTo: destination } },
        ]);
        expect(tool(reject, "artifact_get").isError).toBe(true);
        await unchanged(before);
        // Miss a publish while offline, then reconcile from current state after reconnect.
        await page.goto(htmlArtifact.previewUrl);
        await context.setOffline(true);
        await harness.publish("html", "HTML counter", html("After reconnect"), htmlArtifact.id);
        const start = Date.now();
        await context.setOffline(false);
        await expect(frame(page).getByRole("heading", { name: "After reconnect" })).toBeVisible({
          timeout: 10000,
        });
        expect(Date.now() - start).toBeLessThan(10000);
        await writeFile(
          join(harness.root, "source-preview-digests.json"),
          JSON.stringify(await saved(), null, 2),
        );
      },
    );
    await step(
      "E8",
      "Failed tool publications preserve Latest; corrected builds and visible runtime errors recover",
      async () => {
        const before = await saved();
        const invalid = await harness.publish(
          "react",
          "React libraries",
          { "main.tsx": "import x from 'not-allowed';export default x" },
          reactArtifact.id,
        );
        expect(invalid.isError).toBe(true);
        await unchanged(before);
        const corrected = await harness.publish("react", "React libraries", react(), reactArtifact.id);
        expect(corrected.isError).toBe(false);
        const runtime = await harness.publish(
          "react",
          "React libraries",
          {
            "main.tsx":
              "export default function App(){throw new Error('Intentional journey runtime exception')}",
          },
          reactArtifact.id,
        );
        expect(runtime.isError).toBe(false);
        await page.goto(runtime.artifact.previewUrl);
        await expect(
          frame(page).getByText("Preview error: Intentional journey runtime exception"),
        ).toBeVisible();
        await frame(page).getByRole("button", { name: "Reload", exact: true }).click();
        await expect(
          frame(page).getByText("Preview error: Intentional journey runtime exception"),
        ).toBeVisible();
        await page.getByRole("button", { name: "Source", exact: true }).click();
        await expect(page.locator("pre")).toContainText("Intentional journey");
        await harness.stopService();
        const unavailable = await harness.pi([
          { name: "artifact_get", args: { id: reactArtifact.id } },
          {
            name: "artifact_publish",
            args: {
              id: reactArtifact.id,
              title: "Unavailable",
              kind: "react",
              entrypoint: join(runtime.work, "main.tsx"),
              files: [join(runtime.work, "main.tsx")],
            },
          },
        ]);
        expect(tool(unavailable, "artifact_get").isError).toBe(true);
        expect(tool(unavailable, "artifact_publish").isError).toBe(true);
        await harness.start();
        await page.screenshot({ path: join(harness.root, "E8-runtime-source.png") });
      },
    );
    await step(
      "E9",
      "Second fixture provider/model and unrelated project/session have independent refs",
      async () => {
        const beforeA = await digestTree(harness.projectA),
          beforeB = await digestTree(harness.projectB);
        const empty = await harness.pi([{ name: "artifact_list", args: {} }], {
          session: "journey-B",
          provider: "fixture-b",
          project: harness.projectB,
        });
        expect(tool(empty, "artifact_list").result.details).toEqual({ artifacts: [] });
        await page.goto(harness.publicUrl);
        const galleryHome = page.getByRole("link", { name: "Artifacts", exact: true });
        await galleryHome.focus();
        const result = await harness.publish("html", "Provider B", html("Provider B"), undefined, {
          session: "journey-B",
          provider: "fixture-b",
          project: harness.projectB,
        });
        expect(result.isError).toBe(false);
        await expect(page.getByRole("link", { name: "Provider B", exact: true })).toBeVisible();
        await expect(galleryHome).toBeFocused();
        const read = await harness.pi([{ name: "artifact_get", args: { id: result.artifact.id } }], {
          session: "journey-B",
          provider: "fixture-b",
          project: harness.projectB,
        });
        expect(tool(read, "artifact_get").result.details.artifact.id).toBe(result.artifact.id);
        expect(await digestTree(harness.projectA)).toEqual(beforeA);
        expect(await digestTree(harness.projectB)).toEqual(beforeB);
        await writeFile(
          join(harness.root, "project-inventories.json"),
          JSON.stringify(
            {
              beforeA,
              beforeB,
              afterA: await digestTree(harness.projectA),
              afterB: await digestTree(harness.projectB),
            },
            null,
            2,
          ),
        );
      },
    );
    await step(
      "E10 / V1",
      "Public prefix links/assets/SSE, unauthorized writes, keyboard controls at both viewports/themes and token exclusion",
      async () => {
        const denied = await fetch(`${harness.internal}api/artifacts/publish`, {
          method: "POST",
          body: "{}",
        });
        expect(denied.status).toBe(401);
        for (const viewport of [
          { width: 1440, height: 900 },
          { width: 390, height: 844 },
        ])
          for (const colorScheme of /** @type {const} */ (["light", "dark"])) {
            await page.setViewportSize(viewport);
            await page.emulateMedia({ colorScheme });
            await page.goto(harness.publicUrl);
            await expect(page.getByRole("heading", { name: "Artifact gallery" })).toBeVisible();
            await page.keyboard.press("Tab");
            await expect(page.getByRole("link", { name: "Artifacts", exact: true })).toBeFocused();
            await page.getByRole("link", { name: "HTML counter", exact: true }).click();
            await expect(frame(page).getByRole("heading", { name: "After reconnect" })).toBeVisible();
            const select = page.getByRole("combobox", { name: "Revision" });
            await select.focus();
            await page.keyboard.press("ArrowDown");
            await page.keyboard.press("Enter");
            await expect(select).not.toHaveValue("latest");
            await page.getByRole("button", { name: "Source", exact: true }).focus();
            await page.keyboard.press("Enter");
            await expect(page.locator("pre")).toContainText("<html>");
            await page.getByRole("button", { name: "Preview", exact: true }).focus();
            await page.keyboard.press("Enter");
            await page.getByRole("button", { name: "Reload", exact: true }).focus();
            await page.keyboard.press("Enter");
            await expect(frame(page).getByRole("heading", { name: "Count", exact: true })).toBeVisible();
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
            await page.screenshot({ path: join(harness.root, `V1-${viewport.width}-${colorScheme}.png`) });
          }
        const token = (await readFile(join(harness.config.dataDir, "publish-token"), "utf8")).trim();
        for (const artifact of [htmlArtifact, reactArtifact, markdownArtifact]) {
          expect(artifact.previewUrl.startsWith(harness.publicUrl)).toBe(true);
          const response = await fetch(
            `${harness.publicUrl}api/artifacts/${artifact.id}/revisions/1/source/${artifact.entrypoint}?download=1`,
          );
          expect(response.status).toBe(200);
          expect(response.headers.get("Content-Disposition")).toContain("attachment");
          expect(await response.text()).not.toContain(token);
        }
        for (const path of await files(join(harness.root, "logs")))
          expect(await readFile(path, "utf8")).not.toContain(token);
        expect(JSON.stringify(network)).not.toContain(token);
        expect(network.filter((r) => !r.allowed)).toEqual([]);
        await writeFile(
          join(harness.root, "visual-findings.md"),
          "Automated checks: keyboard activation and revision selection passed at 1440×900 and 390×844 in light/dark; no horizontal page overflow. Initial screenshots saved for human inspection; no baseline comparison claimed. Human visual review remains required.\n",
        );
      },
    );
  } finally {
    if (resources.harness) {
      await writeFile(join(resources.harness.root, "network.json"), JSON.stringify(network, null, 2));
      await writeFile(
        join(resources.harness.root, "browser-console.json"),
        JSON.stringify(consoleLog, null, 2),
      );
      await resources.context?.close();
      await resources.harness.close();
    }
  }
});
