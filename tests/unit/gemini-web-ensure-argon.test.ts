import test from "node:test";
import assert from "node:assert/strict";

const { ensureAdvancedModel } = await import("../../open-sse/executors/gemini-web.ts");

test("ensureAdvancedModel: returns immediately if active model is already Argon", async () => {
  let switchClicked = false;
  const mockPage = {
    locator: () => ({}),
    waitForSelector: async (selector: string) => {
      if (selector.includes("switch")) {
        return {
          innerText: async () => "Argon",
          getAttribute: async () => "mode picker",
          click: async () => { switchClicked = true; },
        };
      }
      return null;
    },
    $: async () => ({
      innerText: async () => "Argon",
      getAttribute: async () => "mode picker",
    }),
    waitForTimeout: async () => {},
  } as unknown as import("playwright").Page;

  await ensureAdvancedModel(mockPage);
  assert.equal(switchClicked, false, "should not click switch button when already on Argon");
});

test("ensureAdvancedModel: switches from Flash-Lite to 4 Argon and verifies label", async () => {
  let currentLabel = "Flash-Lite";
  let switchClicked = false;
  let argonClicked = false;

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
            innerText: async () => "Available models:\n3.5 Flash-Lite\n4 Argon",
          }),
          count: async () => 2,
          nth: (i: number) => ({
            innerText: async () => (i === 0 ? "3.5 Flash-Lite" : "4 Argon Complex tasks"),
            evaluate: async () => false, // not disabled
            click: async () => {
              argonClicked = true;
              currentLabel = "Argon";
            },
            dispatchEvent: async () => {
              argonClicked = true;
              currentLabel = "Argon";
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
  assert.equal(argonClicked, true, "should click 4 Argon menu item");
  assert.equal(currentLabel, "Argon", "model label should be updated to Argon");
});

test("ensureAdvancedModel: throws strict error when 4 Argon is disabled on the account", async () => {
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
            innerText: async () => "Available models:\n3.5 Flash-Lite\n4 Argon",
          }),
          count: async () => 2,
          nth: (i: number) => ({
            innerText: async () => (i === 0 ? "3.5 Flash-Lite" : "4 Argon Complex tasks"),
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
    /Strict 4 Argon requirement failed: 4 Argon menu option is disabled/
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
    /Strict 4 Argon requirement failed: Account session is unauthenticated \/ guest mode/
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

test("ensureAdvancedModel: switches from 4 Argon to 3.8 Flash when requested", async () => {
  let currentLabel = "4 Argon";
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
            innerText: async () => "Available models:\n3.8 Flash\n4 Argon",
          }),
          count: async () => 2,
          nth: (i: number) => ({
            innerText: async () => (i === 0 ? "3.8 Flash" : "4 Argon Complex tasks"),
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
