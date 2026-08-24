// ui-round5: Autenrieth Homeric dictionary wiring
import { expect, test } from "@playwright/test";

const HOMER = "#/tlg0012/iliad";
const PLATO = "#/tlg0059/ion";

let homerReqs = 0;

test.describe("Autenrieth wiring", () => {
  test("Iliad side panel renders Autenrieth section for μῆνιν", async ({ page }) => {
    await page.route("**/data/dicts/homer/**", (route) => route.continue());
    await page.goto(HOMER);
    await page.waitForSelector(".line .w");
    // μῆνιν (1.1) — best lemma μῖνις has an Autenrieth entry
    const w = page.locator(".greek-line .w", { hasText: "μῆνιν" }).first();
    await w.click();
    await page.waitForSelector(".side-panel:not(.hidden)");
    await expect(page.locator(".side-panel h2")).toHaveText("μῆνιν");
    await page.waitForSelector(".autenrieth-entry", { timeout: 8000 });
    // two Homeric dictionaries, ordered Autenrieth then Cunliffe
    await page.waitForFunction(() =>
      document.querySelectorAll(".autenrieth-head").length === 2,
      null, { timeout: 8000 });
    const heads = await page.locator(".autenrieth-head").allTextContents();
    expect(heads).toEqual(["Autenrieth (Homeric)", "Cunliffe (Homeric)"]);
    const glosses = await page
      .locator(".autenrieth-entry .dict-gloss")
      .allTextContents();
    expect(glosses[0]).toContain("wrath");
    expect(glosses[1]).toContain("Il. 1.1");
    expect(glosses[1]).toContain("Wrath, ire");
  });

  test("Plato fires zero dicts/homer requests", async ({ page }) => {
    let count = 0;
    await page.route("**/data/dicts/homer/**", (route) => {
      count += 1;
      return route.continue();
    });
    await page.goto(PLATO);
    await page.waitForSelector(".greek-line .w");
    // open several words' panels (Ion ships as prose units)
    for (const i of [0, 3, 6]) {
      await page.locator(".greek-line .w:not(.speaker)").nth(i + 1).click();
      await page.waitForSelector(".side-panel:not(.hidden)");
      await page.waitForTimeout(250);
      await page.keyboard.press("Escape");
    }
    // also open the lexicon drawer and search
    await page.click("button:has-text('Lexicon')");
    await page.waitForSelector(".lex-search");
    await page.fill(".lex-search", "λόγος");
    await page.waitForTimeout(1200);
    expect(count).toBe(0);
    // Homeric source option must be hidden on non-Homer works
    const hidden = await page.evaluate(() => {
      const b = document.querySelector(".lex-src-homeric");
      return !b || b.classList.contains("hidden");
    });
    expect(hidden).toBeTruthy();
  });

  test("drawer Homeric filter searches dict shards on Iliad", async ({ page }) => {
    await page.goto(HOMER);
    await page.waitForSelector(".line .w");
    await page.click("button:has-text('Lexicon')");
    await page.waitForSelector(".lex-search");
    await page.waitForFunction(() => {
      const b = document.querySelector(".lex-src-homeric");
      return b && !b.classList.contains("hidden");
    }, null, { timeout: 8000 });
    await page.click(".lex-src-homeric");
    await page.fill(".lex-search", "μῆνις");
    await page.waitForFunction(() =>
      [...document.querySelectorAll(".lex-card")]
        .some((c) => c.textContent?.includes("wrath")), null,
      { timeout: 8000 });
    const src = await page.evaluate(() =>
      document.querySelector(".lex-card .lex-src")?.textContent);
    expect(src).toBe("Homeric");
  });
});
