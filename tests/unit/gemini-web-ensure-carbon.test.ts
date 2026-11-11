import test from "node:test";
import assert from "node:assert/strict";

const { ensureAdvancedModel } = await import("../../open-sse/executors/gemini-web.ts");

test("ensureAdvancedModel: returns immediately if active model is already Carbon", async () => {
  let switchClicked = false;
  const mockPage = {
    locator: () => ({}),
    waitForSelector: async (selector: string) => {
      if (selector.includes("switch")) {
        return {
          innerText: async () => "Carbon",
          getAttribute: async () => "mode picker",
          click: async () => { switchClicked = true; },
        };
      }
      return null;
    },
    $: async () => ({
      innerText: async () => "Carbon",
      getAttribute: async () => "mode picker",
    }),
    waitForTimeout: async () => {},
  } as unknown as import("playwright").Page;

  await ensureAdvancedModel(mockPage);
  assert.equal(switchClicked, false, "should not click switch button when already on Carbon");
});

test("ensureAdvancedModel: switches from Flash-Lite to 4 Carbon and verifies label", async () => {
  let currentLabel = "Flash-Lite";
  let switchClicked = false;
  let carbonClicked = false;

  const mockPage = {
    waitForSelector: async (selector: string) => {
      if (selector.includes("switch")) {
        return {
          innerText: async () => currentLabel,
          getAttribute: async () => "mode picker",
          click: async () => { switchClicked = true; },
        };
      }
      return {};
    },
    $: async (selector: string) => {
      if (selector.includes("switch")) {
        return {
          innerText: async () => currentLabel,
          getAttribute: async () => "mode picker",
        };
      }
      return null;
    },
    locator: (selector: string) => {
      if (selector.includes("gem-menu") || selector.includes("overlay")) {
        return {
          first: () => ({
            innerText: async () => "Available models:\n3.5 Flash-Lite\n4 Carbon",
          }),
          count: async () => 2,
          nth: (i: number) => ({
            innerText: async () => (i === 0 ? "3.5 Flash-Lite" : "Most complex work"),
            evaluate: async () => false, // not disabled
            click: async () => {
              carbonClicked = true;
              currentLabel = "Carbon";
            },
            dispatchEvent: async () => {
              carbonClicked = true;
              currentLabel = "Carbon";
            },
          }),
        };
      }
      return {
        first: () => ({ innerText: async () => "" }),
        count: async () => 0,
      };
    },
    waitForTimeout: async () => {},
  } as unknown as import("playwright").Page;

  await ensureAdvancedModel(mockPage);
  assert.equal(switchClicked, true, "should click switch button to open dropdown");
  assert.equal(carbonClicked, true, "should click 4 Carbon menu item");
  assert.equal(currentLabel, "Carbon", "model label should be updated to Carbon");
});

test("ensureAdvancedModel: throws strict error when 4 Carbon is disabled on the account", async () => {
  const mockPage = {
    waitForSelector: async (selector: string) => {
      if (selector.includes("switch")) {
        return {
          innerText: async () => "Flash-Lite",
          getAttribute: async () => "mode picker",
          click: async () => {},
        };
      }
      return {};
    },
    $: async () => ({
      innerText: async () => "Flash-Lite",
      getAttribute: async () => "mode picker",
    }),
    locator: (selector: string) => {
      if (selector.includes("gem-menu") || selector.includes("overlay")) {
        return {
          first: () => ({
            innerText: async () => "Available models:\n3.5 Flash-Lite\n4 Carbon",
          }),
          count: async () => 2,
          nth: (i: number) => ({
            innerText: async () => (i === 0 ? "3.5 Flash-Lite" : "Most complex work"),
            evaluate: async (fn: (el: HTMLElement) => boolean) => {
              // Return true indicating element has aria-disabled="true"
              return fn({
                classList: { contains: () => false },
                getAttribute: (attr: string) => (attr === "aria-disabled" ? "true" : null),
                querySelector: () => null,
              } as unknown as HTMLElement);
            },
            click: async () => {},
          }),
        };
      }
      return {
        first: () => ({ innerText: async () => "" }),
        count: async () => 0,
      };
    },
    waitForTimeout: async () => {},
  } as unknown as import("playwright").Page;

  await assert.rejects(
    ensureAdvancedModel(mockPage),
    /Strict 4 Carbon requirement failed: 4 Carbon menu option is disabled/
  );
});

test("ensureAdvancedModel: throws strict error when session is guest / unauthenticated ('Sign in for all models')", async () => {
  const mockPage = {
    waitForSelector: async (selector: string) => {
      if (selector.includes("switch")) {
        return {
          innerText: async () => "Flash-Lite",
          getAttribute: async () => "mode picker",
          click: async () => {},
        };
      }
      return {};
    },
    $: async () => ({
      innerText: async () => "Flash-Lite",
      getAttribute: async () => "mode picker",
    }),
    locator: (selector: string) => {
      if (selector.includes("gem-menu") || selector.includes("overlay")) {
        return {
          first: () => ({
            innerText: async () => "Sign in for all models\nTry the latest Flash",
          }),
          count: async () => 1,
        };
      }
      return {
        first: () => ({ innerText: async () => "" }),
        count: async () => 0,
      };
    },
    waitForTimeout: async () => {},
  } as unknown as import("playwright").Page;

  await assert.rejects(
    ensureAdvancedModel(mockPage),
    /Strict 4 Carbon requirement failed: Account session is unauthenticated \/ guest mode/
  );
});

test("ensureAdvancedModel: returns immediately if active model is already 3.8 Flash", async () => {
  let switchClicked = false;
  const mockPage = {
    locator: () => ({}),
    waitForSelector: async (selector: string) => {
      if (selector.includes("switch")) {
        return {
          innerText: async () => "3.8 Flash",
          getAttribute: async () => "mode picker",
          click: async () => { switchClicked = true; },
        };
      }
      return null;
    },
    $: async () => ({
      innerText: async () => "3.8 Flash",
      getAttribute: async () => "mode picker",
    }),
    waitForTimeout: async () => {},
  } as unknown as import("playwright").Page;

  await ensureAdvancedModel(mockPage, "gemini-3.8-flash");
  assert.equal(switchClicked, false, "should not click switch button when already on 3.8 Flash");
});

test("ensureAdvancedModel: switches from 4 Carbon to 3.8 Flash when requested", async () => {
  let currentLabel = "4 Carbon";
  let switchClicked = false;
  let flashClicked = false;

  const mockPage = {
    waitForSelector: async (selector: string) => {
      if (selector.includes("switch")) {
        return {
          innerText: async () => currentLabel,
          getAttribute: async () => "mode picker",
          click: async () => { switchClicked = true; },
        };
      }
      return {};
    },
    $: async (selector: string) => {
      if (selector.includes("switch")) {
        return {
          innerText: async () => currentLabel,
          getAttribute: async () => "mode picker",
        };
      }
      return null;
    },
    locator: (selector: string) => {
      if (selector.includes("gem-menu") || selector.includes("overlay")) {
        return {
          first: () => ({
            innerText: async () => "Available models:\n3.8 Flash\n4 Carbon",
          }),
          count: async () => 2,
          nth: (i: number) => ({
            innerText: async () => (i === 0 ? "3.8 Flash" : "Most complex work"),
            evaluate: async () => false,
            click: async () => {
              flashClicked = true;
              currentLabel = "3.8 Flash";
            },
            dispatchEvent: async () => {
              flashClicked = true;
              currentLabel = "3.8 Flash";
            },
          }),
        };
      }
      return {
        first: () => ({ innerText: async () => "" }),
        count: async () => 0,
      };
    },
    waitForTimeout: async () => {},
  } as unknown as import("playwright").Page;

  await ensureAdvancedModel(mockPage, "gemini-3.8-flash");
  assert.equal(switchClicked, true, "should click switch button to open dropdown");
  assert.equal(flashClicked, true, "should click 3.8 Flash menu item");
  assert.equal(currentLabel, "3.8 Flash", "model label should be updated to 3.8 Flash");
});
