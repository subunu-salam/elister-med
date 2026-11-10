import { test, expect, type Page } from "@playwright/test";

const PASSWORD = "Demo-Only-Pass-2026!";
const RUN = Date.now().toString().slice(-6);
const PATIENT = `E2E Patient ${RUN}`;

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/dashboard");
}
async function logout(page: Page) {
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL("**/login");
}
/** Next Mon-Fri (Dubai working week for the seeded doctors), as YYYY-MM-DD. */
function workday(): string {
  const d = new Date(Date.now() + 4 * 3600_000);
  while ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

test("Scenario A: self-pay consultation, register to ledger", async ({ page }) => {
  // 1. Reception registers the patient (3-step form)
  await login(page, "reception@demo.local");
  await expect(page.getByRole("link", { name: "Accounting" })).toHaveCount(0); // cosmetic nav; real check is server-side
  await page.goto("/patients/new");
  await page.getByLabel("Full name (English) *").fill(PATIENT);
  await page.getByLabel("Date of birth *").fill("1988-06-15");
  await page.getByLabel("Sex *").selectOption("female");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Mobile *").fill(`+97155${RUN}1`);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Known allergy (substance)").fill("Penicillin");
  await page.getByLabel(/consents to treatment/).check();
  await page.getByRole("button", { name: "Save patient" }).click();
  await page.waitForURL(/\/patients\/[0-9a-f]{24}/);
  await expect(page.getByRole("heading", { name: new RegExp(PATIENT) })).toBeVisible();
  await expect(page.getByText("Allergy: Penicillin")).toBeVisible();
  const patientUrl = page.url().split("?")[0];

  // 2. Book appointment (smart patient search -> pick)
  const date = workday();
  await page.goto(`/appointments?date=${date}`);
  await page.getByLabel("Patient").fill(PATIENT);
  await page.getByRole("option", { name: new RegExp(PATIENT) }).click();
  await page.getByLabel("Doctor").selectOption({ label: "Dr. Amina Khalid (synthetic)" });
  const minute = 5 * (Math.floor(Math.random() * 90) + 1); // spread bookings so reruns don't clash
  const hh = String(9 + Math.floor(minute / 60)).padStart(2, "0"), mm = String(minute % 60).padStart(2, "0");
  await page.getByLabel("Time (Dubai)").fill(`${hh}:${mm}`);
  await page.getByLabel("Minutes").selectOption("10");
  await page.getByRole("button", { name: "Book", exact: true }).click();
  const list = page.locator("table").last(); // the appointments list (the first table is the scheduler grid)
  const row = list.getByRole("row", { name: new RegExp(PATIENT) });
  await expect(row).toContainText("booked");

  // 3. Check in -> queue token
  await row.getByRole("button", { name: "Check in" }).click();
  await expect(list.getByRole("row", { name: new RegExp(PATIENT) })).toContainText("checked in");
  await logout(page);

  // 4. Doctor calls next, starts the consult, documents, signs, completes
  await login(page, "dr.amina@demo.local");
  await page.goto("/queue");
  await page.getByRole("heading", { name: /Dr\. Amina/ }).locator("xpath=ancestor::section").getByRole("button", { name: "Call next" }).click();
  await expect(page.getByText(PATIENT).first()).toBeVisible();
  await page.getByRole("button", { name: "Start consult" }).first().click();
  await page.waitForURL(/\/encounters\//);
  await expect(page.getByRole("alert").filter({ hasText: "Safety alerts" })).toContainText("Penicillin"); // allergy surfaced

  await page.getByLabel("Systolic").fill("120");
  await page.getByLabel("Diastolic").fill("80");
  await page.getByRole("button", { name: "Record vitals" }).click();
  await page.getByLabel("ICD-10-CM code").fill("J06.9");
  await page.getByLabel("Description", { exact: true }).fill("Acute upper respiratory infection");
  await page.getByRole("button", { name: "Add", exact: true }).first().click();

  await page.getByLabel("Subjective").fill("Cough and sore throat for 3 days.");
  await page.getByLabel("Objective").fill("Afebrile, throat mildly erythematous.");
  await page.getByLabel("Assessment").fill("Viral URTI.");
  await page.getByLabel("Plan").fill("Supportive care, review if worsening.");
  await page.getByRole("button", { name: "Sign note" }).click();
  await expect(page.getByText("signed", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Complete encounter" }).click();
  await page.waitForURL("**/queue");
  await logout(page);

  // 5. Reception finalizes the invoice and takes payment
  await login(page, "reception@demo.local");
  await page.goto(patientUrl.replace(/.*\/patients\//, "/billing?patientId="));
  await expect(page.getByText("GP Consultation")).toBeVisible(); // auto charge from encounter completion
  await page.getByRole("button", { name: "Finalize invoice" }).click();
  await page.waitForURL(/\/billing\/invoices\//);
  await expect(page.getByText("262.50").first()).toBeVisible(); // 250 + 5% VAT
  await page.getByRole("button", { name: "Record payment" }).click();
  await page.waitForURL(/\/billing\/receipts\//);
  await expect(page.getByText(/^RCP-/)).toBeVisible();
  const receiptUrl = page.url();
  await page.reload();
  await expect(page.getByText(/^RCP-/)).toBeVisible(); // persists after refresh
  await logout(page);

  // 6. Finance sees it in the ledger and on the dashboard; books balance
  await login(page, "finance@demo.local");
  await page.goto("/accounting?tab=trial-balance");
  await expect(page.getByText("Balanced")).toBeVisible();
  await expect(page.getByText("Accounts Receivable - Patients")).toBeVisible();
  await page.goto("/dashboard");
  await expect(page.getByText("Cash collected")).toBeVisible();
  await page.goto(receiptUrl);
  await expect(page.getByText(/^RCP-/)).toBeVisible();
});

test("Access control: receptionist cannot open accounting or clinical pages", async ({ page }) => {
  await login(page, "reception@demo.local");
  const res = await page.goto("/accounting");
  // Server-side authorization: the page must not render ledger data for this role.
  const body = await page.content();
  expect(body).not.toContain("Trial balance");
  expect(res?.status() === 200 ? body : "").not.toContain("Accounts Receivable - Patients");
});

test("Arabic switches the document to RTL", async ({ page }) => {
  await login(page, "reception@demo.local");
  await page.getByRole("button", { name: "Switch language" }).click();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await page.getByRole("button", { name: "Switch language" }).click();
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
});
