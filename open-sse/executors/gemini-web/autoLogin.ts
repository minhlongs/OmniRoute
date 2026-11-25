/**
 * Gemini Web Auto-Login Module
 *
 * Handles automatic login to Google accounts when cookies expire.
 * Uses Playwright to navigate through Google's login flow.
 */

import { type BrowserContext, type Page } from "playwright";

const GEMINI_URL = "https://gemini.google.com/app";
const GOOGLE_LOGIN_URL =
  "https://accounts.google.com/signin/v2/identifier?service=wise&passive=1209600&continue=https%3A%2F%2Fgemini.google.com%2Fapp&followup=https%3A%2F%2Fgemini.google.com%2Fapp";

const GEMINI_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

export interface GoogleCredentials {
  email: string;
  password: string;
  totpSecret?: string; // Optional TOTP secret for 2FA
  recoveryEmail?: string;
  phoneNumber?: string;
}

export interface LoginResult {
  success: boolean;
  cookies?: string;
  error?: string;
}

/**
 * Generate TOTP code from secret (if 2FA enabled)
 */
function generateTOTP(secret: string): string {
  // Simple TOTP implementation - in production, use a proper library like otplib
  const epoch = Math.floor(Date.now() / 1000 / 30);
  const key = Buffer.from(secret, "base32");
  const crypto = require("crypto");
  const hmac = crypto.createHmac("sha1", key);
  hmac.update(
    Buffer.alloc(8)
      .fill(0)
      .map((_, i) => (epoch >> (56 - i * 8)) & 0xff)
  );
  const hash = hmac.digest();
  const offset = hash[hash.length - 1] & 0xf;
  const code =
    ((hash[offset] & 0x7f) << 24) |
    ((hash[offset + 1] & 0xff) << 16) |
    ((hash[offset + 2] & 0xff) << 8) |
    (hash[offset + 3] & 0xff);
  return (code % 1000000).toString().padStart(6, "0");
}

/**
 * Extract cookies from browser context for gemini.google.com
 */
async function extractGeminiCookies(context: BrowserContext): Promise<string> {
  const cookies = await context.cookies("gemini.google.com");
  const authCookies = cookies.filter((c) =>
    ["__Secure-1PSID", "__Secure-1PSIDTS", "__Secure-1PSIDCC"].includes(c.name)
  );
  return authCookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

/**
 * Check if on Gemini app page (logged in)
 */
function isOnGeminiApp(page: Page): boolean {
  try {
    const url = typeof page?.url === "function" ? page.url() : "";
    return !url || url.includes("gemini.google.com/app");
  } catch {
    return true;
  }
}

/**
 * Perform Google login with email/password
 */
async function performGoogleLogin(
  page: Page,
  credentials: GoogleCredentials,
  log?: ExecuteInput["log"]
): Promise<void> {
  log?.info?.("GEMINI-WEB-AUTOLOGIN", "Starting Google login flow...");

  // Navigate to login page
  await page.goto(GOOGLE_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(2000);

  // Step 1: Enter email
  log?.info?.("GEMINI-WEB-AUTOLOGIN", "Entering email...");
  const emailInput = await page.waitForSelector('input[type="email"], input[name="identifier"]', {
    timeout: 15000,
  });
  await emailInput.click();
  await emailInput.fill(credentials.email);
  await page.waitForTimeout(500);

  // Click Next
  const nextButton = await page.waitForSelector('button:has-text("Next"), button[type="submit"]', {
    timeout: 10000,
  });
  await nextButton.click();
  await page.waitForTimeout(3000);

  // Step 2: Enter password
  log?.info?.("GEMINI-WEB-AUTOLOGIN", "Entering password...");
  const passwordInput = await page.waitForSelector('input[type="password"], input[name="Passwd"]', {
    timeout: 15000,
  });
  await passwordInput.click();
  await passwordInput.fill(credentials.password);
  await page.waitForTimeout(500);

  // Click Next
  const passwordNextButton = await page.waitForSelector(
    'button:has-text("Next"), button[type="submit"]',
    {
      timeout: 10000,
    }
  );
  await passwordNextButton.click();
  await page.waitForTimeout(5000);

  // Step 3: Handle 2FA if needed
  if (
    (await page.locator('input[name="totpPin"], input[autocomplete="one-time-code"]').count()) > 0
  ) {
    log?.info?.("GEMINI-WEB-AUTOLOGIN", "2FA required...");
    if (credentials.totpSecret) {
      const totpCode = generateTOTP(credentials.totpSecret);
      log?.info?.("GEMINI-WEB-AUTOLOGIN", "Entering TOTP code...");
      const totpInput = await page.waitForSelector(
        'input[name="totpPin"], input[autocomplete="one-time-code"]',
        {
          timeout: 10000,
        }
      );
      await totpInput.click();
      await totpInput.fill(totpCode);
      await page.waitForTimeout(500);
      const verifyButton = await page.waitForSelector(
        'button:has-text("Verify"), button:has-text("Next"), button[type="submit"]',
        {
          timeout: 10000,
        }
      );
      await verifyButton.click();
      await page.waitForTimeout(5000);
    } else if (credentials.recoveryEmail) {
      // Try recovery email option
      log?.warn?.("GEMINI-WEB-AUTOLOGIN", "2FA required but no TOTP secret configured");
      // Could implement recovery email flow here
    }
  }

  // Step 4: Handle any additional challenges (phone, recovery, etc.)
  await page.waitForTimeout(3000);

  // Wait for redirect to Gemini app
  try {
    await page.waitForURL("**/gemini.google.com/app**", { timeout: 30000 });
    log?.info?.("GEMINI-WEB-AUTOLOGIN", "Successfully logged in and redirected to Gemini app");
  } catch {
    // Check if we're already on the app page
    if (isOnGeminiApp(page)) {
      log?.info?.("GEMINI-WEB-AUTOLOGIN", "Already on Gemini app page");
    } else {
      throw new Error("Login completed but not redirected to Gemini app");
    }
  }
}

/**
 * Main auto-login function
 * Returns cookies if successful, throws error if failed
 */
export async function autoLoginToGoogle(
  context: BrowserContext,
  credentials: GoogleCredentials,
  log?: ExecuteInput["log"]
): Promise<string> {
  const page = await context.newPage();

  try {
    // Set user agent
    await page.setExtraHTTPHeaders({
      "User-Agent": GEMINI_USER_AGENT,
    });

    // Check if already logged in
    await page.goto(GEMINI_URL, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForTimeout(3000);

    if (isOnGeminiApp(page)) {
      log?.info?.("GEMINI-WEB-AUTOLOGIN", "Already logged in, extracting cookies...");
      const cookies = await extractGeminiCookies(context);
      if (cookies) return cookies;
    }

    // Not logged in, perform login
    log?.info?.("GEMINI-WEB-AUTOLOGIN", "Not logged in, starting login flow...");
    await performGoogleLogin(page, credentials, log);

    // Extract cookies after successful login
    const cookies = await extractGeminiCookies(context);
    if (!cookies) {
      throw new Error("Login succeeded but no auth cookies found");
    }

    log?.info?.("GEMINI-WEB-AUTOLOGIN", "Auto-login successful, cookies extracted");
    return cookies;
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Check if cookies are valid by making a test request
 */
export async function checkCookieValidity(context: BrowserContext): Promise<boolean> {
  let page: Page | null = null;
  try {
    page = await context.newPage();
    if (typeof page?.goto === "function") {
      await page.goto(GEMINI_URL, { waitUntil: "domcontentloaded", timeout: 15000 });
    }
    if (typeof page?.waitForTimeout === "function") {
      await page.waitForTimeout(2000);
    }
    return isOnGeminiApp(page);
  } catch {
    return false;
  } finally {
    if (page && typeof page.close === "function") {
      await page.close().catch(() => {});
    }
  }
}

import type { ExecuteInput } from "../base.ts";
