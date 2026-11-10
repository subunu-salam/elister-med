// Dev helper: screenshots of key screens for visual review. Usage: node scripts/shots.mjs <outDir>
import { chromium } from "@playwright/test";
import fs from "node:fs";

const out = process.argv[2];
fs.mkdirSync(out, { recursive: true });
const base = "http://localhost:3100";
const browser = await chromium.launch();

async function session(email, shots, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: opts.dark ? "dark" : "light" });
  const page = await ctx.newPage();
  await page.goto(`${base}/login`);
  if (opts.dark) await page.evaluate(() => { localStorage.setItem("theme", "dark"); });
  if (email) {
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill("Demo-Only-Pass-2026!");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/\/(dashboard|portal)/);
  }
  for (const [name, path] of shots) {
    await page.goto(`${base}${path}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(700);
    await page.screenshot({ path: `${out}/${name}.png`, fullPage: false });
  }
  await ctx.close();
}

// login (logged out)
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${base}/login`, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${out}/01-login.png` });
  await ctx.close();
}
await session("admin@demo.local", [["02-dashboard", "/dashboard"], ["03-patients", "/patients?q=ab"], ["04-appointments", "/appointments"], ["05-insurance", "/insurance?tab=setup"], ["06-finance", "/finance?tab=statements"]]);
await session("admin@demo.local", [["07-dashboard-dark", "/dashboard"], ["08-pharmacy-dark", "/pharmacy"]], { dark: true });
await browser.close();
console.log("done");
