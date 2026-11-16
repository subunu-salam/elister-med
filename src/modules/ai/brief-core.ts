/**
 * Owner's daily voice brief ("Elister Brief"): pure composition logic, no database and no I/O, so it is unit-tested directly.
 * brief.ts gathers the figures from the clinic's own data; this file turns them into a spoken brief in English or Malayalam,
 * works out what deserves the owner's attention, and answers follow-up questions from the same figures.
 * Every sentence is built from a figure in BriefFacts: nothing is invented, so the brief can always be traced back to the books.
 */

export type Lang = "en" | "ml";
export const LANGS: Lang[] = ["en", "ml"];

export type BriefFacts = {
  /** Dubai calendar date the brief is for (it reports on the day before). */
  ymd: string;
  /** 0 = Sunday. */
  dow: number;
  recipient: string;
  org: string;
  /** Yesterday. revenuePrev = the day before; revenueLastWeek = same weekday a week earlier. */
  y: { appts: number; seen: number; newPatients: number; noShows: number; cancelled: number; revenue: number; revenuePrev: number | null; revenueLastWeek: number | null };
  /** Month to date, compared with the same number of days of last month. */
  mtd: { revenue: number; revenuePrev: number | null; netProfit: number; appts: number; topDoctor?: { name: string; amount: number } };
  /** Patient (billing) receivables aged by invoice date, plus corporate/insurer receivables from the books when visible. */
  ar: { patient: number; over30: number; over90: number; trade: number; tradeOverdue: number; chase: { name: string; amount: number; days: number }[] };
  today: { booked: number; expected: number | null; firstAt?: string; busiest?: { name: string; count: number }; tomorrow: number };
  /** Present only for users who can see the books. */
  cash?: { balance: number; score: number; grade: string; runwayMonths: number | null; breachWeek: number | null; lowest: number; anomalies: number; duplicates: number; duplicateAmount: number };
};

export type AlertLevel = "critical" | "warn" | "good";
export type BriefAlert = { key: string; level: AlertLevel; text: string; href: string };
export type BriefSection = { key: "intro" | "patients" | "revenue" | "receivables" | "today" | "cash" | "attention" | "close"; title: string; text: string };
export type Kpi = { key: string; label: string; value: string; deltaPct: number | null; goodWhen: "up" | "down" };
export type Brief = { lang: Lang; ymd: string; title: string; sections: BriefSection[]; alerts: BriefAlert[]; kpis: Kpi[]; suggestions: string[]; text: string; words: number; seconds: number };

// ---------------------------------------------------------------- formatting

const round = (v: number) => Math.round(v);
export const pct = (cur: number, prev: number | null | undefined): number | null => (prev === null || prev === undefined || prev === 0 ? null : ((cur - prev) / Math.abs(prev)) * 100);

/** Spoken money. English: thousands/millions. Malayalam: lakh/crore, which is how Malayali investors talk about money. */
export function money(v: number, lang: Lang): string {
  const a = Math.abs(v), sign = v < 0 ? (lang === "ml" ? "മൈനസ് " : "minus ") : "";
  if (lang === "ml") {
    if (a >= 1e7) return `${sign}${trim(a / 1e7, 2)} കോടി ദിർഹം`;
    if (a >= 1e5) return `${sign}${trim(a / 1e5, 2)} ലക്ഷം ദിർഹം`;
    return `${sign}${round(a).toLocaleString("en-IN")} ദിർഹം`;
  }
  if (a >= 1e6) return `${sign}${trim(a / 1e6, 2)} million dirhams`;
  return `${sign}${round(a).toLocaleString("en-US")} dirhams`;
}
/** Compact money for cards: "AED 12.4K", "AED 2.5M". */
export function moneyShort(v: number): string {
  const a = Math.abs(v), s = v < 0 ? "−" : "";
  if (a >= 1e6) return `${s}AED ${trim(a / 1e6, 2)}M`;
  if (a >= 1e4) return `${s}AED ${trim(a / 1e3, 1)}K`;
  return `${s}AED ${round(a).toLocaleString("en-US")}`;
}
const trim = (v: number, dp: number) => String(Number(v.toFixed(dp)));

function change(p: number | null, lang: Lang): string {
  if (p === null) return "";
  const n = Math.round(Math.abs(p));
  if (lang === "ml") return n === 0 ? "ഏകദേശം മാറ്റമില്ല" : `${n} ശതമാനം ${p > 0 ? "കൂടുതൽ" : "കുറവ്"}`;
  return n === 0 ? "about the same" : `${p > 0 ? "up" : "down"} ${n} percent`;
}

const EN_DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const ML_DOW = ["ഞായറാഴ്ച", "തിങ്കളാഴ്ച", "ചൊവ്വാഴ്ച", "ബുധനാഴ്ച", "വ്യാഴാഴ്ച", "വെള്ളിയാഴ്ച", "ശനിയാഴ്ച"];
const EN_MON = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const ML_MON = ["ജനുവരി", "ഫെബ്രുവരി", "മാർച്ച്", "ഏപ്രിൽ", "മേയ്", "ജൂൺ", "ജൂലൈ", "ഓഗസ്റ്റ്", "സെപ്റ്റംബർ", "ഒക്ടോബർ", "നവംബർ", "ഡിസംബർ"];
export function spokenDate(ymd: string, dow: number, lang: Lang): string {
  const [, m, d] = ymd.split("-").map(Number);
  return lang === "ml" ? `${ML_DOW[dow]}, ${ML_MON[m - 1]} ${d}` : `${EN_DOW[dow]}, ${d} ${EN_MON[m - 1]}`;
}
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------- attention items

/** What deserves the owner's attention today, most serious first. Thresholds are deliberately simple and explained in the text. */
export function attention(f: BriefFacts, lang: Lang): BriefAlert[] {
  const ml = lang === "ml";
  const out: BriefAlert[] = [];
  const add = (key: string, level: AlertLevel, en: string, mal: string, href: string) => out.push({ key, level, text: ml ? mal : en, href });

  if (f.cash?.breachWeek) add("cash_breach", "critical",
    `Cash is forecast to fall below the safety buffer in week ${f.cash.breachWeek}, to about ${money(f.cash.lowest, lang)}.`,
    `${f.cash.breachWeek}-ാം ആഴ്ചയോടെ ക്യാഷ് സുരക്ഷിത പരിധിക്ക് താഴെ, ഏകദേശം ${money(f.cash.lowest, lang)} ആയി കുറയുമെന്നാണ് പ്രവചനം.`, "/accounts/ai");
  if (f.ar.over90 > 0) add("ar_90", "critical",
    `${money(f.ar.over90, lang)} of patient bills has been unpaid for more than 90 days. The older it gets, the less likely it is to be collected.`,
    `${money(f.ar.over90, lang)} രോഗികളുടെ ബില്ലുകൾ 90 ദിവസത്തിലേറെയായി അടയ്ക്കാതെ കിടക്കുന്നു. വൈകുന്തോറും ഇത് പിരിച്ചെടുക്കാനുള്ള സാധ്യത കുറയും.`, "/billing");
  const lw = pct(f.y.revenue, f.y.revenueLastWeek);
  if (lw !== null && lw <= -30) add("rev_drop", "warn",
    `Yesterday's revenue was ${Math.round(-lw)} percent below the same day last week.`,
    `ഇന്നലത്തെ വരുമാനം കഴിഞ്ഞ ആഴ്ചയിലെ ഇതേ ദിവസത്തേക്കാൾ ${Math.round(-lw)} ശതമാനം കുറവാണ്.`, "/finance");
  const noShowRate = f.y.appts ? f.y.noShows / f.y.appts : 0;
  if (f.y.noShows >= 2 && noShowRate >= 0.15) add("no_show", "warn",
    `${plural(f.y.noShows, "patient", "patients")} did not turn up yesterday, ${Math.round(noShowRate * 100)} percent of bookings. Reminder calls the day before usually help.`,
    `ഇന്നലെ ${f.y.noShows} രോഗികൾ ബുക്ക് ചെയ്തിട്ടും വന്നില്ല, ആകെ ബുക്കിംഗിന്റെ ${Math.round(noShowRate * 100)} ശതമാനം. തലേദിവസം ഓർമ്മപ്പെടുത്തൽ കോൾ ചെയ്യുന്നത് സഹായിക്കും.`, "/appointments");
  if (f.cash && f.cash.duplicates > 0) add("duplicates", "warn",
    `${plural(f.cash.duplicates, "supplier bill looks", "supplier bills look")} like a possible duplicate, worth ${money(f.cash.duplicateAmount, lang)}. Please check before paying.`,
    `${f.cash.duplicates} സപ്ലയർ ബില്ലുകൾ ഇരട്ടിപ്പായി തോന്നുന്നു, ആകെ ${money(f.cash.duplicateAmount, lang)}. പണം നൽകുന്നതിന് മുമ്പ് പരിശോധിക്കുക.`, "/accounts/ai");
  if (f.cash && f.cash.anomalies > 0) add("anomalies", "warn",
    `${plural(f.cash.anomalies, "expense is", "expenses are")} unusually high compared with the clinic's normal pattern.`,
    `${f.cash.anomalies} ചെലവുകൾ ക്ലിനിക്കിന്റെ സാധാരണ രീതിയേക്കാൾ അസാധാരണമായി കൂടുതലാണ്.`, "/accounts/ai");
  if (f.today.expected && f.today.expected >= 4 && f.today.booked < f.today.expected * 0.6) add("quiet_day", "warn",
    `Today looks quiet: ${f.today.booked} booked against about ${Math.round(f.today.expected)} on a normal ${EN_DOW[f.dow]}. A good day for recall calls or a WhatsApp offer.`,
    `ഇന്ന് തിരക്ക് കുറവാണ്: സാധാരണ ${ML_DOW[f.dow]} ഏകദേശം ${Math.round(f.today.expected)} ആണെങ്കിൽ ഇന്ന് ${f.today.booked} ബുക്കിംഗ് മാത്രം. ഫോളോ-അപ്പ് കോളുകൾക്കോ വാട്ട്സ്ആപ്പ് ഓഫറിനോ നല്ല ദിവസം.`, "/crm");

  const mtd = pct(f.mtd.revenue, f.mtd.revenuePrev);
  if (mtd !== null && mtd >= 10) add("mtd_up", "good",
    `Good news: this month's revenue is ${Math.round(mtd)} percent ahead of last month at the same point.`,
    `സന്തോഷവാർത്ത: ഈ മാസത്തെ വരുമാനം കഴിഞ്ഞ മാസം ഇതേ സമയത്തേക്കാൾ ${Math.round(mtd)} ശതമാനം മുന്നിലാണ്.`, "/finance");
  if (f.y.newPatients >= 3) add("new_patients", "good",
    `${f.y.newPatients} new patients registered yesterday.`,
    `ഇന്നലെ ${f.y.newPatients} പുതിയ രോഗികൾ രജിസ്റ്റർ ചെയ്തു.`, "/patients");

  const rank: Record<AlertLevel, number> = { critical: 0, warn: 1, good: 2 };
  return out.sort((a, b) => rank[a.level] - rank[b.level]);
}

// ---------------------------------------------------------------- brief

export function composeBrief(f: BriefFacts, lang: Lang): Brief {
  const ml = lang === "ml";
  const first = f.recipient.replace(/\(.*?\)/g, "").trim().split(/\s+/).find((w) => !/^(dr|mr|mrs|ms|prof)\.?$/i.test(w)) ?? "";
  const date = spokenDate(f.ymd, f.dow, lang);
  const s: BriefSection[] = [];
  const push = (key: BriefSection["key"], en: string, mal: string, text: string) => { if (text.trim()) s.push({ key, title: ml ? mal : en, text: text.replace(/\s+/g, " ").trim() }); };

  // intro
  push("intro", "Good morning", "സുപ്രഭാതം", ml
    ? `സുപ്രഭാതം${first ? ` ${first}` : ""}. ${f.org}-ന്റെ ഇന്നത്തെ എലിസ്റ്റർ ബ്രീഫ്, ${date}. ഇന്നലത്തെ പ്രകടനവും ഇന്ന് ശ്രദ്ധിക്കേണ്ട കാര്യങ്ങളും ഇതാ.`
    : `Good morning${first ? `, ${first}` : ""}. This is your Elister brief for ${f.org}, ${date}. Here is how yesterday went and what needs your attention today.`);

  // patients
  {
    const y = f.y;
    const en = y.appts === 0 ? "There were no appointments yesterday." :
      `Yesterday the clinic saw ${plural(y.seen, "patient", "patients")} from ${plural(y.appts, "appointment", "appointments")}` +
      `${y.newPatients ? `, and ${y.newPatients} ${y.newPatients === 1 ? "was" : "were"} new to the clinic` : ""}.` +
      `${y.noShows ? ` ${plural(y.noShows, "patient", "patients")} did not show up` : ""}${y.noShows && y.cancelled ? ` and ${y.cancelled} cancelled.` : y.noShows ? "." : y.cancelled ? ` ${y.cancelled} cancelled.` : ""}`;
    const mal = y.appts === 0 ? "ഇന്നലെ അപ്പോയിന്റ്മെന്റുകൾ ഒന്നും ഉണ്ടായിരുന്നില്ല." :
      `ഇന്നലെ ${y.appts} അപ്പോയിന്റ്മെന്റുകളിൽ നിന്ന് ${y.seen} രോഗികളെ ക്ലിനിക്കിൽ കണ്ടു.` +
      `${y.newPatients ? ` ഇതിൽ ${y.newPatients} പേർ പുതിയ രോഗികളാണ്.` : ""}` +
      `${y.noShows ? ` ${y.noShows} പേർ ബുക്ക് ചെയ്തിട്ടും വന്നില്ല.` : ""}${y.cancelled ? ` ${y.cancelled} ബുക്കിംഗുകൾ റദ്ദാക്കി.` : ""}`;
    push("patients", "Patients", "രോഗികൾ", ml ? mal : en);
  }

  // revenue
  {
    const d = pct(f.y.revenue, f.y.revenuePrev), w = pct(f.y.revenue, f.y.revenueLastWeek), m = pct(f.mtd.revenue, f.mtd.revenuePrev);
    const td = f.mtd.topDoctor;
    const en = `Revenue yesterday was ${money(f.y.revenue, lang)}` +
      `${d !== null ? `, ${change(d, lang)} on the day before` : ""}${w !== null ? ` and ${change(w, lang)} on the same day last week` : ""}. ` +
      `Month to date, revenue is ${money(f.mtd.revenue, lang)}${m !== null ? `, ${change(m, lang)} on last month at this point` : ""}, ` +
      `with net profit of ${money(f.mtd.netProfit, lang)}. ` +
      `${td ? `${td.name} leads this month with ${money(td.amount, lang)}.` : ""}`;
    const mal = `ഇന്നലത്തെ വരുമാനം ${money(f.y.revenue, lang)} ആണ്` +
      `${d !== null ? `, തലേദിവസത്തേക്കാൾ ${change(d, lang)}` : ""}${w !== null ? `, കഴിഞ്ഞ ആഴ്ചയിലെ ഇതേ ദിവസത്തേക്കാൾ ${change(w, lang)}` : ""}. ` +
      `ഈ മാസം ഇതുവരെ വരുമാനം ${money(f.mtd.revenue, lang)}${m !== null ? `, കഴിഞ്ഞ മാസം ഇതേ സമയത്തേക്കാൾ ${change(m, lang)}` : ""}. ` +
      `ഈ മാസത്തെ അറ്റാദായം ${money(f.mtd.netProfit, lang)}. ` +
      `${td ? `ഈ മാസം ഏറ്റവും കൂടുതൽ വരുമാനം ${td.name}-ൽ നിന്നാണ്, ${money(td.amount, lang)}.` : ""}`;
    push("revenue", "Revenue", "വരുമാനം", ml ? mal : en);
  }

  // receivables
  {
    const a = f.ar, total = a.patient + a.trade;
    const chase = a.chase.slice(0, 3);
    const en = total <= 0 ? "Nothing is outstanding: every bill has been collected." :
      `Money still to collect is ${money(total, lang)}` +
      `${a.trade > 0 ? `: ${money(a.patient, lang)} from patients and ${money(a.trade, lang)} from insurers and corporate clients` : ""}. ` +
      `${a.over30 > 0 ? `${money(a.over30, lang)} of patient bills is more than 30 days old. ` : ""}` +
      `${chase.length ? `The first ${chase.length === 1 ? "account" : `${chase.length} accounts`} to chase: ${chase.map((c) => `${c.name}, ${money(c.amount, lang)}${c.days > 0 ? `, ${c.days} days overdue` : ""}`).join("; ")}.` : ""}`;
    const mal = total <= 0 ? "കിട്ടാനുള്ള തുക ഒന്നുമില്ല, എല്ലാ ബില്ലുകളും പിരിച്ചെടുത്തു." :
      `ഇനി പിരിച്ചെടുക്കാനുള്ളത് ആകെ ${money(total, lang)}` +
      `${a.trade > 0 ? `: രോഗികളിൽ നിന്ന് ${money(a.patient, lang)}, ഇൻഷുറൻസ്, കോർപ്പറേറ്റ് ക്ലയന്റുകളിൽ നിന്ന് ${money(a.trade, lang)}` : ""}. ` +
      `${a.over30 > 0 ? `ഇതിൽ ${money(a.over30, lang)} 30 ദിവസത്തിലേറെ പഴക്കമുള്ളതാണ്. ` : ""}` +
      `${chase.length ? `ആദ്യം പിന്തുടരേണ്ടത്: ${chase.map((c) => `${c.name}, ${money(c.amount, lang)}${c.days > 0 ? `, ${c.days} ദിവസം വൈകി` : ""}`).join("; ")}.` : ""}`;
    push("receivables", "Receivables", "കിട്ടാനുള്ള തുക", ml ? mal : en);
  }

  // today
  {
    const t = f.today;
    const en = `Today there ${t.booked === 1 ? "is 1 appointment" : `are ${t.booked} appointments`} booked` +
      `${t.expected ? `, against about ${Math.round(t.expected)} on a normal ${EN_DOW[f.dow]}` : ""}.` +
      `${t.firstAt ? ` The first patient is at ${t.firstAt}.` : ""}` +
      `${t.busiest ? ` ${t.busiest.name} has the busiest list, with ${t.busiest.count}.` : ""}` +
      ` Tomorrow has ${t.tomorrow} booked so far.`;
    const mal = `ഇന്ന് ${t.booked} അപ്പോയിന്റ്മെന്റുകൾ ബുക്ക് ചെയ്തിട്ടുണ്ട്` +
      `${t.expected ? `; സാധാരണ ${ML_DOW[f.dow]} ഏകദേശം ${Math.round(t.expected)} ആണ് ഉണ്ടാകാറുള്ളത്` : ""}.` +
      `${t.firstAt ? ` ആദ്യ രോഗി ${t.firstAt}-ന്.` : ""}` +
      `${t.busiest ? ` ഏറ്റവും തിരക്ക് ${t.busiest.name}-ക്കാണ്, ${t.busiest.count} പേർ.` : ""}` +
      ` നാളത്തേക്ക് ഇതുവരെ ${t.tomorrow} ബുക്കിംഗ്.`;
    push("today", "Today", "ഇന്ന്", ml ? mal : en);
  }

  // cash
  if (f.cash) {
    const c = f.cash;
    const en = `Cash in the bank is ${money(c.balance, lang)}. The financial health score is ${c.score} out of 100, rated ${c.grade}. ` +
      (c.runwayMonths === null ? "Cash has been growing on average over recent months." : `At the recent spending rate, cash lasts about ${trim(c.runwayMonths, 1)} months.`);
    const mal = `ബാങ്കിലുള്ള ക്യാഷ് ${money(c.balance, lang)}. സാമ്പത്തിക ആരോഗ്യ സ്കോർ 100-ൽ ${c.score} ആണ്. ` +
      (c.runwayMonths === null ? "കഴിഞ്ഞ മാസങ്ങളിൽ ക്യാഷ് ശരാശരി വർദ്ധിച്ചുകൊണ്ടിരിക്കുന്നു." : `ഇപ്പോഴത്തെ ചെലവ് നിരക്കിൽ ക്യാഷ് ഏകദേശം ${trim(c.runwayMonths, 1)} മാസം തികയും.`);
    push("cash", "Cash", "ക്യാഷ്", ml ? mal : en);
  }

  // attention
  const alerts = attention(f, lang);
  const issues = alerts.filter((a) => a.level !== "good").slice(0, 3), wins = alerts.filter((a) => a.level === "good").slice(0, 1);
  push("attention", "Needs attention", "ശ്രദ്ധിക്കേണ്ടവ", issues.length
    ? (ml ? `ഇന്ന് ശ്രദ്ധിക്കേണ്ട ${issues.length === 1 ? "കാര്യം" : `${issues.length} കാര്യങ്ങൾ`}. ` : `${issues.length === 1 ? "One thing" : `${issues.length} things`} need your attention. `) +
      issues.map((a, i) => (ml ? `${i + 1}. ${a.text}` : `${["First", "Second", "Third"][i]}, ${a.text.charAt(0).toLowerCase()}${a.text.slice(1)}`)).join(" ") + (wins.length ? ` ${wins[0].text}` : "")
    : (ml ? "ഇന്ന് അടിയന്തരമായി ശ്രദ്ധിക്കേണ്ടതൊന്നുമില്ല. " : "Nothing urgent needs your attention today. ") + (wins.length ? wins[0].text : ""));

  push("close", "Ask me anything", "എന്തും ചോദിക്കാം", ml
    ? "ഇതാണ് ഇന്നത്തെ ബ്രീഫ്. കൂടുതൽ അറിയാൻ മൈക്ക് ബട്ടൺ അമർത്തി ചോദിക്കൂ, ഉദാഹരണത്തിന്, ആരിൽ നിന്നാണ് പണം കിട്ടാനുള്ളത്."
    : "That's your brief. Tap the microphone and ask me anything, for example, who owes us the most, or how today is looking.");

  const text = s.map((x) => x.text).join("\n\n");
  const words = text.split(/\s+/).filter(Boolean).length;
  const kpis: Kpi[] = [
    { key: "patients", label: ml ? "ഇന്നലെ കണ്ട രോഗികൾ" : "Patients seen yesterday", value: String(f.y.seen), deltaPct: null, goodWhen: "up" },
    { key: "revenue", label: ml ? "ഇന്നലത്തെ വരുമാനം" : "Revenue yesterday", value: moneyShort(f.y.revenue), deltaPct: pct(f.y.revenue, f.y.revenueLastWeek), goodWhen: "up" },
    { key: "mtd", label: ml ? "ഈ മാസം ഇതുവരെ" : "Revenue this month", value: moneyShort(f.mtd.revenue), deltaPct: pct(f.mtd.revenue, f.mtd.revenuePrev), goodWhen: "up" },
    { key: "receivables", label: ml ? "കിട്ടാനുള്ളത്" : "Receivables", value: moneyShort(f.ar.patient + f.ar.trade), deltaPct: null, goodWhen: "down" },
    { key: "today", label: ml ? "ഇന്നത്തെ ബുക്കിംഗ്" : "Booked today", value: String(f.today.booked), deltaPct: f.today.expected ? pct(f.today.booked, f.today.expected) : null, goodWhen: "up" },
  ];
  if (f.cash) kpis.push({ key: "health", label: ml ? "ആരോഗ്യ സ്കോർ" : "Health score", value: `${f.cash.score}/100`, deltaPct: null, goodWhen: "up" });

  return {
    lang, ymd: f.ymd, title: ml ? "എലിസ്റ്റർ ദൈനംദിന ബ്രീഫ്" : "Elister daily brief", sections: s, alerts, kpis, text, words,
    // Malayalam TTS runs slower per word (long agglutinated words); ~1.6 words/s vs ~2.5 for English.
    seconds: Math.round(words / (ml ? 1.6 : 2.5)),
    suggestions: suggestions(lang, f),
  };
}

export function suggestions(lang: Lang, f?: BriefFacts): string[] {
  const en = ["Who owes us the most?", "How is today looking?", "How does this month compare?", "Which doctor brought the most revenue?", "Why did patients not show up?"];
  const ml = ["ആരിൽ നിന്നാണ് കൂടുതൽ പണം കിട്ടാനുള്ളത്?", "ഇന്നത്തെ ദിവസം എങ്ങനെയുണ്ട്?", "ഈ മാസം എങ്ങനെയുണ്ട്?", "ഏത് ഡോക്ടറാണ് കൂടുതൽ വരുമാനം കൊണ്ടുവന്നത്?", "എന്താണ് ശ്രദ്ധിക്കേണ്ടത്?"];
  const base = lang === "ml" ? ml : en;
  if (f?.cash) base.splice(3, 0, lang === "ml" ? "ക്യാഷ് എത്ര കാലം തികയും?" : "How long will our cash last?");
  return base.slice(0, 5);
}

/** One-message text version for WhatsApp / email. */
export function shareText(b: Brief): string {
  const head = `*${b.title}* · ${b.ymd}`;
  const k = b.kpis.map((x) => `• ${x.label}: ${x.value}${x.deltaPct !== null ? ` (${x.deltaPct >= 0 ? "+" : "−"}${Math.abs(Math.round(x.deltaPct))}%)` : ""}`).join("\n");
  const a = b.alerts.filter((x) => x.level !== "good").slice(0, 3).map((x) => `⚠ ${x.text}`).join("\n");
  return [head, k, a].filter(Boolean).join("\n\n");
}

// ---------------------------------------------------------------- follow-up questions

export type Intent = "revenue" | "patients" | "today" | "tomorrow" | "receivables" | "profit" | "cash" | "doctor" | "noshow" | "attention" | "month" | "repeat" | "help" | "lang_en" | "lang_ml" | "greeting" | "thanks" | "unknown";

/** English and Malayalam (script and common Manglish) cue words. Order matters: more specific intents first. */
const CUES: [Intent, RegExp][] = [
  ["lang_ml", /\b(in )?malayalam\b|മലയാളത്തിൽ|മലയാളം/i],
  ["lang_en", /\b(in )?english\b|ഇംഗ്ലീഷ്/i],
  ["repeat", /\b(repeat|again|say that again|replay|summary|summari[sz]e)\b|വീണ്ടും|ആവർത്തി|ഒന്നുകൂടി|സംഗ്രഹം/i],
  ["thanks", /\b(thanks|thank you|great|perfect|ok(ay)? bye|bye)\b|നന്ദി|ശരി മതി/i],
  ["help", /\b(what can you|help|what do you know|options)\b|എന്തൊക്കെ ചോദിക്കാം|സഹായം/i],
  ["tomorrow", /\btomorrow\b|നാളെ|naale/i],
  ["noshow", /no[- ]?show|did(n't| not) (come|turn up|show)|missed|വന്നില്ല|നോ ഷോ/i],
  ["cash", /\b(cash|bank|runway|burn|liquid|health score)\b|ക്യാഷ്|ബാങ്ക്|പണം എത്ര|തികയും|ആരോഗ്യ സ്കോർ/i],
  ["receivables", /\b(owe|owes|owed|outstanding|receivable|unpaid|pending|collect|due|chase|debt)\b|കിട്ടാനുള്ള|കുടിശ്ശിക|ബാക്കി|പിരിച്ചെടുക്ക|kittanulla/i],
  ["profit", /\b(profit|margin|net|loss|earning)\b|ലാഭം|നഷ്ടം|labham/i],
  ["doctor", /\b(doctor|dr\.?|physician|top performer|best)\b|ഡോക്ടർ/i],
  ["attention", /\b(attention|worry|problem|issue|risk|alert|concern|wrong)\b|ശ്രദ്ധിക്കേണ്ട|പ്രശ്നം|അപകട/i],
  ["month", /\b(month|mtd|this month|compare|comparison|trend)\b|മാസം/i],
  ["today", /\b(today|now|this morning|schedule|booked|appointments?)\b|ഇന്ന്|ഇന്നത്തെ|അപ്പോയിന്റ്മെന്റ്|innu/i],
  ["patients", /\b(patients?|footfall|visits?|new patients?)\b|രോഗി|പേഷ്യന്റ്|rogi/i],
  ["revenue", /\b(revenue|income|sales|money|earn|collection|turnover|billing)\b|വരുമാനം|കളക്ഷൻ|വിറ്റുവരവ്|varumanam/i],
  ["greeting", /^\s*(hi|hello|hey|good (morning|afternoon|evening)|salaam|namaskaram)\b|നമസ്കാരം|ഹലോ/i],
];
export function detectIntent(q: string): Intent {
  for (const [k, re] of CUES) if (re.test(q)) return k;
  return "unknown";
}

export const MALAYALAM = /[\u0D00-\u0D7F]/;
export type VoiceAnswer = { intent: Intent; answer: string; switchLang?: Lang; href?: string; followUps: string[]; handled: boolean };

/** Answers a follow-up from the brief's own figures. Unknown questions return handled:false so the server can try the books (askBooks). */
export function answerFromFacts(q: string, f: BriefFacts, asked: Lang): VoiceAnswer {
  // A question typed or spoken in Malayalam script gets a Malayalam answer, whatever the current setting.
  const lang: Lang = MALAYALAM.test(q) ? "ml" : asked;
  const ml = lang === "ml";
  const intent = detectIntent(q);
  const say = (en: string, mal: string) => (ml ? mal : en);
  const brief = composeBrief(f, lang);
  const sec = (k: BriefSection["key"]) => brief.sections.find((x) => x.key === k)?.text ?? "";
  const r = (answer: string, href?: string, extra: Partial<VoiceAnswer> = {}): VoiceAnswer => ({ intent, answer, href, followUps: suggestions(lang, f).filter((x) => x !== q).slice(0, 3), handled: true, ...extra });

  switch (intent) {
    case "lang_ml": return r("ശരി, ഇനി മലയാളത്തിൽ സംസാരിക്കാം. എന്താണ് അറിയേണ്ടത്?", undefined, { switchLang: "ml", followUps: suggestions("ml", f).slice(0, 3) });
    case "lang_en": return r("Sure, switching to English. What would you like to know?", undefined, { switchLang: "en", followUps: suggestions("en", f).slice(0, 3) });
    case "repeat": return r(brief.sections.filter((x) => ["patients", "revenue", "receivables"].includes(x.key)).map((x) => x.text).join(" "));
    case "thanks": return r(say("You're welcome. I'll have tomorrow's brief ready at 8 in the morning.", "സന്തോഷം. നാളെ രാവിലെ 8 മണിക്ക് അടുത്ത ബ്രീഫ് തയ്യാറായിരിക്കും."));
    case "greeting": return r(say("Hello! Ask me about revenue, patients, today's bookings, money to collect or cash.", "നമസ്കാരം! വരുമാനം, രോഗികൾ, ഇന്നത്തെ ബുക്കിംഗ്, കിട്ടാനുള്ള പണം, ക്യാഷ് എന്നിവയെക്കുറിച്ച് ചോദിക്കാം."));
    case "help": return r(say("I can tell you about revenue, profit, patients, today's and tomorrow's bookings, money owed to the clinic, cash, the top doctor and anything that needs attention. I can also answer questions about the books, like how much was spent on rent last month.",
      "വരുമാനം, ലാഭം, രോഗികൾ, ഇന്നത്തെയും നാളത്തെയും ബുക്കിംഗ്, കിട്ടാനുള്ള പണം, ക്യാഷ്, മികച്ച ഡോക്ടർ, ശ്രദ്ധിക്കേണ്ട കാര്യങ്ങൾ എന്നിവയെക്കുറിച്ച് പറയാം."));
    case "revenue": return r(sec("revenue"), "/finance");
    case "patients": return r(sec("patients"), "/patients");
    case "today": return r(sec("today"), "/appointments");
    case "tomorrow": return r(say(`Tomorrow has ${f.today.tomorrow} appointments booked so far.`, `നാളത്തേക്ക് ഇതുവരെ ${f.today.tomorrow} അപ്പോയിന്റ്മെന്റുകൾ ബുക്ക് ചെയ്തിട്ടുണ്ട്.`), "/appointments");
    case "receivables": return r(sec("receivables"), "/billing");
    case "profit": {
      const margin = f.mtd.revenue ? Math.round((f.mtd.netProfit / f.mtd.revenue) * 100) : null;
      return r(say(`Net profit this month so far is ${money(f.mtd.netProfit, lang)} on revenue of ${money(f.mtd.revenue, lang)}${margin !== null ? `, a margin of ${margin} percent` : ""}.`,
        `ഈ മാസം ഇതുവരെ ${money(f.mtd.revenue, lang)} വരുമാനത്തിൽ അറ്റാദായം ${money(f.mtd.netProfit, lang)}${margin !== null ? `, അതായത് ${margin} ശതമാനം മാർജിൻ` : ""}.`), "/finance");
    }
    case "cash": return f.cash ? r(sec("cash") + (f.cash.breachWeek ? " " + attention(f, lang).find((a) => a.key === "cash_breach")!.text : ""), "/accounts/ai")
      : r(say("Cash figures come from the books, and your role does not include access to them.", "ക്യാഷ് വിവരങ്ങൾ അക്കൗണ്ട്സിൽ നിന്നാണ്; നിങ്ങളുടെ റോളിന് അതിലേക്ക് പ്രവേശനമില്ല."));
    case "doctor": {
      const d = f.mtd.topDoctor;
      return r(d ? say(`${d.name} has brought in the most revenue this month, ${money(d.amount, lang)}.${f.today.busiest ? ` Today, ${f.today.busiest.name} has the busiest list with ${f.today.busiest.count} patients.` : ""}`,
        `ഈ മാസം ഏറ്റവും കൂടുതൽ വരുമാനം ${d.name}-ൽ നിന്നാണ്, ${money(d.amount, lang)}.${f.today.busiest ? ` ഇന്ന് ഏറ്റവും തിരക്ക് ${f.today.busiest.name}-ക്കാണ്, ${f.today.busiest.count} പേർ.` : ""}`)
        : say("No doctor revenue has been recorded this month yet.", "ഈ മാസം ഡോക്ടർമാരുടെ വരുമാനം ഇതുവരെ രേഖപ്പെടുത്തിയിട്ടില്ല."), "/finance");
    }
    case "noshow": {
      const rate = f.y.appts ? Math.round((f.y.noShows / f.y.appts) * 100) : 0;
      return r(say(`${plural(f.y.noShows, "patient", "patients")} did not show up yesterday, ${rate} percent of bookings. The system does not record why; the usual causes are long booking lead times and no reminder the day before. The Assistants page scores each upcoming booking for no-show risk so reception can call the riskiest first.`,
        `ഇന്നലെ ${f.y.noShows} രോഗികൾ വന്നില്ല, ബുക്കിംഗിന്റെ ${rate} ശതമാനം. കാരണം സിസ്റ്റം രേഖപ്പെടുത്തുന്നില്ല; സാധാരണയായി ദൂരെയുള്ള ബുക്കിംഗും ഓർമ്മപ്പെടുത്തൽ ഇല്ലാത്തതുമാണ് കാരണങ്ങൾ.`), "/appointments");
    }
    case "attention": return r(sec("attention"));
    case "month": return r(say(
      `Month to date, revenue is ${money(f.mtd.revenue, lang)}${f.mtd.revenuePrev !== null ? ` against ${money(f.mtd.revenuePrev, lang)} at the same point last month, ${change(pct(f.mtd.revenue, f.mtd.revenuePrev), lang)}` : ""}, from ${f.mtd.appts} appointments. Net profit is ${money(f.mtd.netProfit, lang)}.`,
      `ഈ മാസം ഇതുവരെ ${f.mtd.appts} അപ്പോയിന്റ്മെന്റുകളിൽ നിന്ന് വരുമാനം ${money(f.mtd.revenue, lang)}${f.mtd.revenuePrev !== null ? `; കഴിഞ്ഞ മാസം ഇതേ സമയം ${money(f.mtd.revenuePrev, lang)} ആയിരുന്നു, ${change(pct(f.mtd.revenue, f.mtd.revenuePrev), lang)}` : ""}. അറ്റാദായം ${money(f.mtd.netProfit, lang)}.`), "/finance");
    default: return { intent, answer: "", followUps: suggestions(lang, f).slice(0, 3), handled: false };
  }
}
