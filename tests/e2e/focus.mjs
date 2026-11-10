import { expect } from "@playwright/test";

/**
 * Hold a real metadata response between focus and keypress, so a toolbar rebuild
 * deterministically loses the action instead of depending on network timing.
 * @param {import("@playwright/test").Page} page
 * @param {import("../../src/shared/contracts.ts").ArtifactRevision} artifact
 * @param {Record<string, string>} original
 * @param {Record<string, string>} updated
 */
export async function metadataFocus(page, artifact, original, updated) {
  const select = page.getByRole("combobox", { name: "Revision" });
  const source = page.getByRole("button", { name: "Source", exact: true });
  const preview = page.getByRole("button", { name: "Preview", exact: true });
  const reload = page.getByRole("button", { name: "Reload", exact: true });
  const open = page.getByRole("link", { name: "Open preview", exact: true });
  const frame = page.frameLocator("iframe");
  const metadataUrl = new URL(`../api/artifacts/${artifact.id}`, artifact.previewUrl).href;
  /** @param {number} revision */
  const committed = async (revision) => {
    await expect(open).toHaveAttribute(
      "href",
      new URL(`../preview/${artifact.id}/${revision}/index.html`, artifact.previewUrl).href,
    );
    await expect(select).toHaveValue(String(revision));
  };
  /** @param {number} revision @param {import("@playwright/test").Locator} control */
  async function releaseWhileFocused(revision, control) {
    const identity = await control.elementHandle();
    if (!identity) throw Error("Missing focus regression control.");
    /** @type {() => void} */
    let release = () => {};
    const held = new Promise((resolve) => {
      release = () => resolve(undefined);
    });
    /** @type {() => void} */
    let received = () => {};
    const intercepted = new Promise((resolve) => {
      received = () => resolve(undefined);
    });
    /** @param {import("@playwright/test").Route} route */
    const delay = async (route) => {
      const response = await route.fetch();
      received();
      await held;
      await route.fulfill({ response });
    };
    await page.route(metadataUrl, delay);
    try {
      await select.selectOption(String(revision));
      await intercepted;
      await control.focus();
      await expect(control).toBeFocused();
      release();
      // The immutable preview link changes only when the held metadata is rendered.
      await committed(revision);
      expect(
        await identity.evaluate((node) => node.isConnected && document.activeElement === node),
        `same ${(await control.getAttribute("aria-label")) || (await control.textContent())} node retains focus`,
      ).toBe(true);
      await expect(control).toBeFocused();
    } finally {
      release();
      await page.unroute(metadataUrl, delay);
      await identity.dispose();
    }
  }

  await page.goto(artifact.previewUrl);
  await expect(frame.getByRole("heading", { name: "Updated", exact: true })).toBeVisible();
  await releaseWhileFocused(1, source);
  await page.keyboard.press("Enter");
  await expect(source).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("pre")).toHaveText(original["index.html"]);
  await expect(source).toBeFocused();

  await releaseWhileFocused(2, select);
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await committed(1);
  await expect(page.locator("pre")).toHaveText(original["index.html"]);
  await expect(select).toBeFocused();

  await releaseWhileFocused(2, preview);
  await page.keyboard.press("Enter");
  await expect(preview).toHaveAttribute("aria-pressed", "true");
  await expect(frame.getByRole("heading", { name: "Updated", exact: true })).toBeVisible();
  await expect(preview).toBeFocused();

  await releaseWhileFocused(1, reload);
  await expect(frame.getByRole("heading", { name: "Count", exact: true })).toBeVisible();
  // Exercise the counter without moving toolbar focus into the iframe.
  await frame.getByRole("button", { name: "0", exact: true }).evaluate((node) => {
    if (node instanceof HTMLButtonElement) node.click();
  });
  await expect(frame.getByRole("button", { name: "1", exact: true })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(frame.getByRole("button", { name: "0", exact: true })).toBeVisible();
  await expect(reload).toBeFocused();

  await source.click();
  const file = page.getByRole("button", { name: "style.css", exact: true });
  await releaseWhileFocused(2, file);
  await page.keyboard.press("Enter");
  await expect(file).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("pre")).toHaveText(updated["style.css"]);
  await expect(file).toBeFocused();

  const download = page.getByRole("link", { name: "Download original", exact: true });
  await releaseWhileFocused(1, download);
  const downloaded = page.waitForEvent("download");
  await page.keyboard.press("Enter");
  expect((await downloaded).suggestedFilename()).toBe("style.css");
  await expect(download).toBeFocused();
  await expect(page.locator("pre")).toHaveText(original["style.css"]);
}
