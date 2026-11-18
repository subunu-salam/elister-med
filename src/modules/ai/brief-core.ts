/**
 * Personal AI assistant ("Elister Brief"): pure composition logic, no database and no I/O, so it is unit-tested directly.
 * brief.ts gathers the figures from the clinic's own data; this file turns them into a spoken report in English or Malayalam,
 * works out what deserves the owner's attention, and answers follow-up questions from the same figures.
 * Every sentence is built from a figure in BriefFacts: nothing is invented, so the report can always be traced back to the books.
 */

export type Lang = "en" | "ml";
export const LANGS: Lang[] = ["en", "ml"];

/** Chapters the owner can switch on or off ("which details do I want in my call"). Intro and the closing question are always there. */
export const SECTION_KEYS = ["patients", "revenue", "receivables", "upcoming", "cash", "attention"] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];
export const SECTION_LABEL: Record<SectionKey, { en: string; ml: string; needs: "clinical" | "finance" | "books" | "any"; hint: string }> = {
  patients: { en: "Patients & appointments", ml: "രോഗികളും അപ്പോയിന്റ്മെന്റുകളും", needs: "clinical", hint: "Patients seen, new patients, no-shows, cancellations" },
  revenue: { en: "Revenue & profit", ml: "വരുമാനവും ലാഭവും", needs: "finance", hint: "Revenue vs the day before and last week, month to date, net profit, top doctor" },
  receivables: { en: "Receivables", ml: "കിട്ടാനുള്ള തുക", needs: "finance", hint: "Money still to collect, ageing, insurers and companies to chase" },
  upcoming: { en: "Next day's schedule", ml: "അടുത്ത ദിവസത്തെ ബുക്കിംഗ്", needs: "clinical", hint: "Bookings for the next day against a normal day, first patient, busiest doctor" },
  cash: { en: "Cash & financial health", ml: "ക്യാഷും സാമ്പത്തിക ആരോഗ്യവും", needs: "books", hint: "Bank balance, health score, runway" },
  attention: { en: "Things needing attention", ml: "ശ്രദ്ധിക്കേണ്ടവ", needs: "any", hint: "Up to three alerts, most serious first, plus one piece of good news" },
};

export type BriefFacts = {
  /** Dubai calendar date of the day being reported on, and its weekday (0 = Sunday). */
  ymd: string;
  dow: number;
  /** "today" for an end-of-day report (call after 3 pm), "yesterday" for a morning one. */
  period: "today" | "yesterday";
  /** Dubai hour the report was built, for the greeting. */
  hour: number;
  recipient: string;
  org: string;
  /** What this person's access lets the report talk about (set by the super admin's module access). */
  scope: { clinical: boolean; finance: boolean };
  day: { appts: number; seen: number; newPatients: number; noShows: number; cancelled: number; revenue: number; revenuePrev: number | null; revenueLastWeek: number | null };
  /** Month to date, compared with the same number of days of last month. */
  mtd: { revenue: number; revenuePrev: number | null; netProfit: number; appts: number; topDoctor?: { name: string; amount: number } };
  /** Patient (billing) receivables aged by invoice date, plus insurer/corporate receivables from the books when visible. */
  ar: { patient: number; over30: number; over90: number; trade: number; tradeOverdue: number; chase: { name: string; amount: number; days: number }[] };
  /** The next working day's book: "tomorrow" for an end-of-day report, "today" for a morning one. after = the day after that. */
  next: { when: "today" | "tomorrow"; dow: number; booked: number; expected: number | null; firstAt?: string; busiest?: { name: string; count: number }; after: number };
  /** Present only for users who can see the books. */
  cash?: { balance: number; score: number; grade: string; runwayMonths: number | null; breachWeek: number | null; lowest: number; anomalies: number; duplicates: number; duplicateAmount: number };
  /** Last 7 days (ending with the reported day) against the 7 before; for "how was this week" questions. */
  week?: { visits: number; prevVisits: number; revenue: number; prevRevenue: number; newPatients: number; busiest?: { ymd: string; dow: number; visits: number } };
};

export type AlertLevel = "critical" | "warn" | "good";
export type BriefAlert = { key: string; level: AlertLevel; text: string; href: string };
export type BriefSection = { key: "intro" | SectionKey | "close"; title: string; text: string };
export type Kpi = { key: string; label: string; value: string; deltaPct: number | null; goodWhen: "up" | "down" };
export type Brief = { lang: Lang; ymd: string; period: BriefFacts["period"]; title: string; sections: BriefSection[]; alerts: BriefAlert[]; kpis: Kpi[]; suggestions: string[]; text: string; words: number; seconds: number };

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
const greet = (hour: number, lang: Lang) => lang === "ml"
  ? (hour < 12 ? "സുപ്രഭാതം" : hour < 17 ? "നമസ്കാരം" : "ശുഭസന്ധ്യ")
  : (hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening");
export const firstName = (n: string) => n.replace(/\(.*?\)/g, "").trim().split(/\s+/).find((w) => w && !/^(dr|mr|mrs|ms|prof)\.?$/i.test(w)) ?? "";

/** Which chapters this person may hear: their own choice, limited by what their access allows. */
export function allowedSections(f: Pick<BriefFacts, "scope" | "cash">, chosen?: readonly SectionKey[]): SectionKey[] {
  const ok = (k: SectionKey) => {
    const n = SECTION_LABEL[k].needs;
    return n === "any" || (n === "clinical" && f.scope.clinical) || (n === "finance" && f.scope.finance) || (n === "books" && !!f.cash);
  };
  return (chosen?.length ? chosen : SECTION_KEYS).filter(ok);
}

// ---------------------------------------------------------------- attention items

/** What deserves the owner's attention, most serious first. Thresholds are deliberately simple and explained in the text. */
export function attention(f: BriefFacts, lang: Lang): BriefAlert[] {
  const ml = lang === "ml";
  const out: BriefAlert[] = [];
  const add = (key: string, level: AlertLevel, en: string, mal: string, href: string) => out.push({ key, level, text: ml ? mal : en, href });
  const dayEn = f.period === "today" ? "Today's" : "Yesterday's", dayMl = f.period === "today" ? "ഇന്നത്തെ" : "ഇന്നലത്തെ";
  const whenEn = f.period === "today" ? "today" : "yesterday", whenMl = f.period === "today" ? "ഇന്ന്" : "ഇന്നലെ";

  if (f.cash?.breachWeek) add("cash_breach", "critical",
    `Cash is forecast to fall below the safety buffer in week ${f.cash.breachWeek}, to about ${money(f.cash.lowest, lang)}.`,
    `${f.cash.breachWeek}-ാം ആഴ്ചയോടെ ക്യാഷ് സുരക്ഷിത പരിധിക്ക് താഴെ, ഏകദേശം ${money(f.cash.lowest, lang)} ആയി കുറയുമെന്നാണ് പ്രവചനം.`, "/accounts/ai");
  if (f.scope.finance && f.ar.over90 > 0) add("ar_90", "critical",
    `${money(f.ar.over90, lang)} of patient bills has been unpaid for more than 90 days. The older it gets, the less likely it is to be collected.`,
    `${money(f.ar.over90, lang)} രോഗികളുടെ ബില്ലുകൾ 90 ദിവസത്തിലേറെയായി അടയ്ക്കാതെ കിടക്കുന്നു. വൈകുന്തോറും ഇത് പിരിച്ചെടുക്കാനുള്ള സാധ്യത കുറയും.`, "/billing");
  const lw = pct(f.day.revenue, f.day.revenueLastWeek);
  if (f.scope.finance && lw !== null && lw <= -30) add("rev_drop", "warn",
    `${dayEn} revenue was ${Math.round(-lw)} percent below the same day last week.`,
    `${dayMl} വരുമാനം കഴിഞ്ഞ ആഴ്ചയിലെ ഇതേ ദിവസത്തേക്കാൾ ${Math.round(-lw)} ശതമാനം കുറവാണ്.`, "/finance");
  const noShowRate = f.day.appts ? f.day.noShows / f.day.appts : 0;
  if (f.scope.clinical && f.day.noShows >= 2 && noShowRate >= 0.15) add("no_show", "warn",
    `${plural(f.day.noShows, "patient", "patients")} did not turn up ${whenEn}, ${Math.round(noShowRate * 100)} percent of bookings. Reminder calls the day before usually help.`,
    `${whenMl} ${f.day.noShows} രോഗികൾ ബുക്ക് ചെയ്തിട്ടും വന്നില്ല, ആകെ ബുക്കിംഗിന്റെ ${Math.round(noShowRate * 100)} ശതമാനം. തലേദിവസം ഓർമ്മപ്പെടുത്തൽ കോൾ ചെയ്യുന്നത് സഹായിക്കും.`, "/appointments");
  if (f.cash && f.cash.duplicates > 0) add("duplicates", "warn",
    `${plural(f.cash.duplicates, "supplier bill looks", "supplier bills look")} like a possible duplicate, worth ${money(f.cash.duplicateAmount, lang)}. Please check before paying.`,
    `${f.cash.duplicates} സപ്ലയർ ബില്ലുകൾ ഇരട്ടിപ്പായി തോന്നുന്നു, ആകെ ${money(f.cash.duplicateAmount, lang)}. പണം നൽകുന്നതിന് മുമ്പ് പരിശോധിക്കുക.`, "/accounts/ai");
  if (f.cash && f.cash.anomalies > 0) add("anomalies", "warn",
    `${plural(f.cash.anomalies, "expense is", "expenses are")} unusually high compared with the clinic's normal pattern.`,
    `${f.cash.anomalies} ചെലവുകൾ ക്ലിനിക്കിന്റെ സാധാരണ രീതിയേക്കാൾ അസാധാരണമായി കൂടുതലാണ്.`, "/accounts/ai");
  const n = f.next;
  if (f.scope.clinical && n.expected && n.expected >= 4 && n.booked < n.expected * 0.6) add("quiet_day", "warn",
    `${n.when === "tomorrow" ? "Tomorrow" : "Today"} looks quiet: ${n.booked} booked against about ${Math.round(n.expected)} on a normal ${EN_DOW[n.dow]}. A good time for recall calls or a WhatsApp offer.`,
    `${n.when === "tomorrow" ? "നാളെ" : "ഇന്ന്"} തിരക്ക് കുറവാണ്: സാധാരണ ${ML_DOW[n.dow]} ഏകദേശം ${Math.round(n.expected)} ആണെങ്കിൽ ${n.booked} ബുക്കിംഗ് മാത്രം. ഫോളോ-അപ്പ് കോളുകൾക്കോ വാട്ട്സ്ആപ്പ് ഓഫറിനോ നല്ല സമയം.`, "/crm");

  const mtd = pct(f.mtd.revenue, f.mtd.revenuePrev);
  if (f.scope.finance && mtd !== null && mtd >= 10) add("mtd_up", "good",
    `Good news: this month's revenue is ${Math.round(mtd)} percent ahead of last month at the same point.`,
    `സന്തോഷവാർത്ത: ഈ മാസത്തെ വരുമാനം കഴിഞ്ഞ മാസം ഇതേ സമയത്തേക്കാൾ ${Math.round(mtd)} ശതമാനം മുന്നിലാണ്.`, "/finance");
  if (f.scope.clinical && f.day.newPatients >= 3) add("new_patients", "good",
    `${f.day.newPatients} new patients registered ${whenEn}.`,
    `${whenMl} ${f.day.newPatients} പുതിയ രോഗികൾ രജിസ്റ്റർ ചെയ്തു.`, "/patients");

  const rank: Record<AlertLevel, number> = { critical: 0, warn: 1, good: 2 };
  return out.sort((a, b) => rank[a.level] - rank[b.level]);
}

// ---------------------------------------------------------------- report

export const CLOSING_QUESTION: Record<Lang, string> = {
  en: "That's your summary. Is there anything else you'd like me to explain?",
  ml: "ഇതാണ് ഇന്നത്തെ സംഗ്രഹം. ഇനി എന്തെങ്കിലും കൂടുതൽ വിശദീകരിക്കണോ?",
};
const closing = (name: string, lang: Lang) => lang === "ml"
  ? `ഇതാണ് ${name ? `${name}, ` : ""}ഇന്നത്തെ പൂർണ്ണ റിപ്പോർട്ട്. എന്തെങ്കിലും ചോദിക്കാനുണ്ടോ?`
  : `That's the full picture${name ? `, ${name}` : ""}. Is there anything you'd like to ask me?`;

/** First thing the assistant says when the call is answered: a personal hello, then "shall I carry on, or call you back in 30 minutes?" */
export function callOpening(f: Pick<BriefFacts, "recipient" | "org" | "period" | "hour">, lang: Lang, snoozeMinutes = 30): string {
  const n = firstName(f.recipient);
  const T = f.period === "today";
  return lang === "ml"
    ? `ഹായ് ${n || ""}, സുഖമാണോ? ഞാൻ നിങ്ങളുടെ പേഴ്സണൽ അസിസ്റ്റന്റ് എലിസ്റ്റർ ആണ്. ${f.org}-ൽ ${T ? "ഇന്ന്" : "ഇന്നലെ"} എന്തൊക്കെ നടന്നു എന്നതിന്റെ ഒരു ചെറിയ അപ്ഡേറ്റ് തരാനാണ് വിളിച്ചത്. തുടരട്ടെ, അതോ ${snoozeMinutes} മിനിറ്റ് കഴിഞ്ഞ് തിരികെ വിളിക്കണോ?`
    : `Hi${n ? ` ${n}` : ""}, how are you doing? This is Elister, your personal assistant. I just wanted to give you a quick update on what happened ${T ? "today" : "yesterday"} at ${f.org}. Shall I carry on, or would you like me to call you back in ${snoozeMinutes} minutes?`;
}

/** The owner's answer to the opening question: carry on, call back later, or not clear yet. */
export function parseOpeningReply(q: string): "continue" | "later" | "unclear" {
  const t = q.toLowerCase();
  if (CALLBACK_RE.test(t)) return "later";
  if (/\b(later|call (me )?back|ring (me )?back|busy|not now|in (half an hour|30|thirty)|after (30|thirty|half)|snooze|remind)\b|പിന്നെ|തിരികെ വിളി|തിരിച്ചു വിളി|തിരക്ക്|പിന്നീട്/.test(t)) return "later";
  if (/\b(yes|yeah|yep|sure|ok(ay)?|go ahead|go on|carry on|continue|please do|tell me|start|fine|good|great|doing well|i'?m (good|fine|well))\b|അതെ|ശരി|തുടര|പറയൂ|പറഞ്ഞോ|സുഖം|ഓക്കെ/.test(t)) return "continue";
  return "unclear";
}

export function composeBrief(f: BriefFacts, lang: Lang, opts: { sections?: readonly SectionKey[] } = {}): Brief {
  const ml = lang === "ml";
  const want = new Set(allowedSections(f, opts.sections));
  const first = firstName(f.recipient);
  const date = spokenDate(f.ymd, f.dow, lang);
  const T = f.period === "today";
  const s: BriefSection[] = [];
  const push = (key: BriefSection["key"], en: string, mal: string, text: string) => {
    if ((key === "intro" || key === "close" || want.has(key as SectionKey)) && text.trim()) s.push({ key, title: ml ? mal : en, text: text.replace(/\s+/g, " ").trim() });
  };

  push("intro", "Hello", "നമസ്കാരം", ml
    ? `${greet(f.hour, lang)}${first ? ` ${first}` : ""}. ഞാൻ നിങ്ങളുടെ പേഴ്സണൽ അസിസ്റ്റന്റ് എലിസ്റ്റർ ആണ്. ${f.org}-ന്റെ ${T ? "ഇന്നത്തെ" : "ഇന്നലത്തെ"} റിപ്പോർട്ട്, ${date}.`
    : `${greet(f.hour, lang)}${first ? `, ${first}` : ""}. This is Elister, your personal assistant, with ${T ? "today's" : "yesterday's"} report for ${f.org}, ${date}.`);

  // patients
  {
    const y = f.day, W = T ? "Today" : "Yesterday", Wm = T ? "ഇന്ന്" : "ഇന്നലെ";
    const en = y.appts === 0 ? `There were no appointments ${W.toLowerCase()}.` :
      `${W} the clinic saw ${plural(y.seen, "patient", "patients")} from ${plural(y.appts, "appointment", "appointments")}` +
      `${y.newPatients ? `, and ${y.newPatients} ${y.newPatients === 1 ? "was" : "were"} new to the clinic` : ""}.` +
      `${y.noShows ? ` ${plural(y.noShows, "patient", "patients")} did not show up` : ""}${y.noShows && y.cancelled ? ` and ${y.cancelled} cancelled.` : y.noShows ? "." : y.cancelled ? ` ${y.cancelled} cancelled.` : ""}`;
    const mal = y.appts === 0 ? `${Wm} അപ്പോയിന്റ്മെന്റുകൾ ഒന്നും ഉണ്ടായിരുന്നില്ല.` :
      `${Wm} ${y.appts} അപ്പോയിന്റ്മെന്റുകളിൽ നിന്ന് ${y.seen} രോഗികളെ ക്ലിനിക്കിൽ കണ്ടു.` +
      `${y.newPatients ? ` ഇതിൽ ${y.newPatients} പേർ പുതിയ രോഗികളാണ്.` : ""}` +
      `${y.noShows ? ` ${y.noShows} പേർ ബുക്ക് ചെയ്തിട്ടും വന്നില്ല.` : ""}${y.cancelled ? ` ${y.cancelled} ബുക്കിംഗ് റദ്ദാക്കി.` : ""}`;
    push("patients", "Patients", "രോഗികൾ", ml ? mal : en);
  }

  // revenue
  {
    const d = pct(f.day.revenue, f.day.revenuePrev), w = pct(f.day.revenue, f.day.revenueLastWeek), m = pct(f.mtd.revenue, f.mtd.revenuePrev);
    const td = f.mtd.topDoctor;
    const en = `Revenue ${T ? "today" : "yesterday"} was ${money(f.day.revenue, lang)}` +
      `${d !== null ? `, ${change(d, lang)} on the day before` : ""}${w !== null ? ` and ${change(w, lang)} on the same day last week` : ""}. ` +
      `Month to date, revenue is ${money(f.mtd.revenue, lang)}${m !== null ? `, ${change(m, lang)} on last month at this point` : ""}, ` +
      `with net profit of ${money(f.mtd.netProfit, lang)}. ` +
      `${td ? `${td.name} leads this month with ${money(td.amount, lang)}.` : ""}`;
    const mal = `${T ? "ഇന്നത്തെ" : "ഇന്നലത്തെ"} വരുമാനം ${money(f.day.revenue, lang)} ആണ്` +
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

  // next day's book
  {
    const n = f.next, tm = n.when === "tomorrow";
    const en = `${tm ? "Tomorrow" : "Today"} there ${n.booked === 1 ? "is 1 appointment" : `are ${n.booked} appointments`} booked` +
      `${n.expected ? `, against about ${Math.round(n.expected)} on a normal ${EN_DOW[n.dow]}` : ""}.` +
      `${n.firstAt ? ` The first patient is at ${n.firstAt}.` : ""}` +
      `${n.busiest ? ` ${n.busiest.name} has the busiest list, with ${n.busiest.count}.` : ""}` +
      ` ${tm ? "The day after" : "Tomorrow"} has ${n.after} booked so far.`;
    const mal = `${tm ? "നാളെ" : "ഇന്ന്"} ${n.booked} അപ്പോയിന്റ്മെന്റുകൾ ബുക്ക് ചെയ്തിട്ടുണ്ട്` +
      `${n.expected ? `; സാധാരണ ${ML_DOW[n.dow]} ഏകദേശം ${Math.round(n.expected)} ആണ് ഉണ്ടാകാറുള്ളത്` : ""}.` +
      `${n.firstAt ? ` ആദ്യ രോഗി ${n.firstAt}-ന്.` : ""}` +
      `${n.busiest ? ` ഏറ്റവും തിരക്ക് ${n.busiest.name}-ക്കാണ്, ${n.busiest.count} പേർ.` : ""}` +
      ` ${tm ? "മറ്റന്നാളത്തേക്ക്" : "നാളത്തേക്ക്"} ഇതുവരെ ${n.after} ബുക്കിംഗ്.`;
    push("upcoming", tm ? "Tomorrow" : "Today", tm ? "നാളെ" : "ഇന്ന്", ml ? mal : en);
  }

  if (f.cash) {
    const c = f.cash;
    const en = `Cash in the bank is ${money(c.balance, lang)}. The financial health score is ${c.score} out of 100, rated ${c.grade}. ` +
      (c.runwayMonths === null ? "Cash has been growing on average over recent months." : `At the recent spending rate, cash lasts about ${trim(c.runwayMonths, 1)} months.`);
    const mal = `ബാങ്കിലുള്ള ക്യാഷ് ${money(c.balance, lang)}. സാമ്പത്തിക ആരോഗ്യ സ്കോർ 100-ൽ ${c.score} ആണ്. ` +
      (c.runwayMonths === null ? "കഴിഞ്ഞ മാസങ്ങളിൽ ക്യാഷ് ശരാശരി വർദ്ധിച്ചുകൊണ്ടിരിക്കുന്നു." : `ഇപ്പോഴത്തെ ചെലവ് നിരക്കിൽ ക്യാഷ് ഏകദേശം ${trim(c.runwayMonths, 1)} മാസം തികയും.`);
    push("cash", "Cash", "ക്യാഷ്", ml ? mal : en);
  }

  const alerts = attention(f, lang);
  const issues = alerts.filter((a) => a.level !== "good").slice(0, 3), wins = alerts.filter((a) => a.level === "good").slice(0, 1);
  push("attention", "Needs attention", "ശ്രദ്ധിക്കേണ്ടവ", issues.length
    ? (ml ? `ശ്രദ്ധിക്കേണ്ട ${issues.length === 1 ? "കാര്യം" : `${issues.length} കാര്യങ്ങൾ`}. ` : `${issues.length === 1 ? "One thing needs" : `${issues.length} things need`} your attention. `) +
      issues.map((a, i) => (ml ? `${i + 1}. ${a.text}` : `${["First", "Second", "Third"][i]}, ${a.text.charAt(0).toLowerCase()}${a.text.slice(1)}`)).join(" ") + (wins.length ? ` ${wins[0].text}` : "")
    : (ml ? "അടിയന്തരമായി ശ്രദ്ധിക്കേണ്ടതൊന്നുമില്ല. " : "Nothing urgent needs your attention. ") + (wins.length ? wins[0].text : ""));

  push("close", "Anything else?", "മറ്റെന്തെങ്കിലും?", closing(first, lang));

  const text = s.map((x) => x.text).join("\n\n");
  const words = text.split(/\s+/).filter(Boolean).length;
  const W = T ? (ml ? "ഇന്ന്" : "today") : (ml ? "ഇന്നലെ" : "yesterday");
  const kpis: Kpi[] = [];
  if (want.has("patients")) kpis.push({ key: "patients", label: ml ? `${W} കണ്ട രോഗികൾ` : `Patients seen ${W}`, value: String(f.day.seen), deltaPct: null, goodWhen: "up" });
  if (want.has("revenue")) kpis.push(
    { key: "revenue", label: ml ? `${W} വരുമാനം` : `Revenue ${W}`, value: moneyShort(f.day.revenue), deltaPct: pct(f.day.revenue, f.day.revenueLastWeek), goodWhen: "up" },
    { key: "mtd", label: ml ? "ഈ മാസം ഇതുവരെ" : "Revenue this month", value: moneyShort(f.mtd.revenue), deltaPct: pct(f.mtd.revenue, f.mtd.revenuePrev), goodWhen: "up" });
  if (want.has("receivables")) kpis.push({ key: "receivables", label: ml ? "കിട്ടാനുള്ളത്" : "Receivables", value: moneyShort(f.ar.patient + f.ar.trade), deltaPct: null, goodWhen: "down" });
  if (want.has("upcoming")) kpis.push({ key: "next", label: ml ? `${f.next.when === "tomorrow" ? "നാളത്തെ" : "ഇന്നത്തെ"} ബുക്കിംഗ്` : `Booked ${f.next.when}`, value: String(f.next.booked), deltaPct: f.next.expected ? pct(f.next.booked, f.next.expected) : null, goodWhen: "up" });
  if (want.has("cash") && f.cash) kpis.push({ key: "health", label: ml ? "ആരോഗ്യ സ്കോർ" : "Health score", value: `${f.cash.score}/100`, deltaPct: null, goodWhen: "up" });

  return {
    lang, ymd: f.ymd, period: f.period, title: ml ? (T ? "ഇന്നത്തെ റിപ്പോർട്ട്" : "ഇന്നലത്തെ റിപ്പോർട്ട്") : (T ? "Today's report" : "Yesterday's report"),
    sections: s, alerts, kpis, text, words,
    // Malayalam speech runs slower per word (long agglutinated words): ~1.6 words/s against ~2.5 for English.
    seconds: Math.round(words / (ml ? 1.6 : 2.5)),
    suggestions: suggestions(lang, f),
  };
}

export function suggestions(lang: Lang, f?: Pick<BriefFacts, "cash" | "scope">): string[] {
  const fin = f?.scope.finance ?? true, cli = f?.scope.clinical ?? true;
  const en = [fin && "Who owes us the most?", cli && "How does tomorrow look?", fin && "How does this month compare?", f?.cash && "How long will our cash last?", fin && "Which doctor brought the most revenue?", "What needs my attention?"];
  const ml = [fin && "ആരിൽ നിന്നാണ് കൂടുതൽ പണം കിട്ടാനുള്ളത്?", cli && "നാളെ എങ്ങനെയുണ്ട്?", fin && "ഈ മാസം എങ്ങനെയുണ്ട്?", f?.cash && "ക്യാഷ് എത്ര കാലം തികയും?", fin && "ഏത് ഡോക്ടറാണ് കൂടുതൽ വരുമാനം കൊണ്ടുവന്നത്?", "എന്താണ് ശ്രദ്ധിക്കേണ്ടത്?"];
  return (lang === "ml" ? ml : en).filter((x): x is string => typeof x === "string").slice(0, 5);
}

/** One-message text version for WhatsApp / email. */
export function shareText(b: Brief): string {
  const head = `*${b.title}* · ${b.ymd}`;
  const k = b.kpis.map((x) => `• ${x.label}: ${x.value}${x.deltaPct !== null ? ` (${x.deltaPct >= 0 ? "+" : "−"}${Math.abs(Math.round(x.deltaPct))}%)` : ""}`).join("\n");
  const a = b.alerts.filter((x) => x.level !== "good").slice(0, 3).map((x) => `⚠ ${x.text}`).join("\n");
  return [head, k, a].filter(Boolean).join("\n\n");
}

// ---------------------------------------------------------------- follow-up questions

export type Intent = "callback" | "week" | "revenue" | "patients" | "today" | "tomorrow" | "receivables" | "profit" | "cash" | "doctor" | "noshow" | "attention" | "month" | "repeat" | "help" | "lang_en" | "lang_ml" | "greeting" | "done" | "unknown";

const CALLBACK_RE = /\b(call|ring|phone) (me )?(back|again|later|in|at|after)\b|\bcall ?back\b|\b(remind|ring) me\b|\bcall me\b.*\b(\d{1,2}(:\d{2})?\s*(am|pm)?|minutes?|mins?|hours?|hrs?|later|tomorrow)\b|തിരികെ വിളി|തിരിച്ചു വിളി|പിന്നെ വിളി|പിന്നീട് വിളി/i;

/**
 * When to call back, in minutes from now, from things like "call me back at 12:37", "at 5 pm", "in 10 minutes", "in an hour", "later".
 * Clock times are Dubai time (the clinic's time zone); a time that has already passed today means tomorrow. Null when no call-back is asked.
 */
export function parseCallback(q: string, now: Date): number | null {
  if (!CALLBACK_RE.test(q) && !/\b(later|busy|not now)\b|പിന്നെ|തിരക്ക്/i.test(q)) return null;
  const t = q.toLowerCase().replace(/\./g, ":");
  const rel = /\b(?:in|after)\s+(an?|one|half an?|\d+(?:[.,]\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m)\b/.exec(t) ?? /(\d+)\s*(മിനിറ്റ്|മണിക്കൂർ)/.exec(t);
  if (rel) {
    const n = /^half/.test(rel[1]) ? 0.5 : /^(an?|one)$/.test(rel[1]) ? 1 : Number(rel[1].replace(",", "."));
    const hours = /^h|മണിക്കൂർ/.test(rel[2]);
    return Math.max(1, Math.round(hours ? n * 60 : n));
  }
  if (/half an hour|half hour|അര മണിക്കൂർ/.test(t)) return 30;
  const at = /\b(?:at|by|around)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/.exec(t.replace(/\b(in|after)\s+\d+\s*\w+/, ""));
  if (at && (at[2] || at[3] || /\b(at|by|around)\s*\d/.test(t))) {
    let h = Number(at[1]); const m = Number(at[2] ?? 0);
    if (h > 23 || m > 59) return 30;
    const local = new Date(now.getTime() + 4 * 3600_000); // Dubai wall clock
    const nowMin = local.getUTCHours() * 60 + local.getUTCMinutes();
    const cands: number[] = [];
    if (at[3]) cands.push(((h % 12) + (at[3] === "pm" ? 12 : 0)) * 60 + m);
    else if (h >= 13) cands.push(h * 60 + m);
    else cands.push(h * 60 + m, ((h % 12) + 12) * 60 + m); // "5:30" → the next 5:30, morning or evening
    const diffs = cands.map((c) => (c - nowMin + 1440) % 1440 || 1440);
    return Math.max(1, Math.min(...diffs));
  }
  return 30;
}

/** English and Malayalam (script and common Manglish) cue words. Order matters: more specific intents first. */
const CUES: [Intent, RegExp][] = [
  // "call me back at 12:37 / in 10 minutes / later" works at any point in the call
  ["callback", CALLBACK_RE],
  // spending questions belong to the books (askBooks), not to the report's revenue figures
  ["unknown", /\b(spen[dt]|spending|expenses?|costs?|rent|salar(y|ies)|utilit(y|ies)|suppliers?|vendors?|bills? paid|paid (to|for))\b|ചെലവ്|വാടക|ശമ്പളം/i],
  ["lang_ml", /\b(in )?malayalam\b|മലയാളത്തിൽ|മലയാളം/i],
  ["lang_en", /\b(in )?english\b|ഇംഗ്ലീഷ്/i],
  ["done", /^\s*(no|nope|nothing|no thanks?|that'?s (all|it)|i'?m good|all good|thanks?|thank you|bye|goodbye|ok(ay)?( bye)?|done)\b[\s.!]*$|^\s*(ഇല്ല|വേണ്ട|മതി|നന്ദി|ശരി)[\s.!]*$|ഒന്നും വേണ്ട|അത്ര മതി/i],
  ["repeat", /\b(repeat|again|say that again|replay|summary|summari[sz]e)\b|വീണ്ടും|ആവർത്തി|ഒന്നുകൂടി|സംഗ്രഹം/i],
  ["help", /\b(what can you|help|what do you know|options)\b|എന്തൊക്കെ ചോദിക്കാം|സഹായം/i],
  ["tomorrow", /\btomorrow\b|നാളെ|naale/i],
  ["noshow", /no[- ]?show|did(n't| not) (come|turn up|show)|missed|വന്നില്ല|നോ ഷോ/i],
  ["cash", /\b(cash|bank|runway|burn|liquid|health score)\b|ക്യാഷ്|ബാങ്ക്|പണം എത്ര|തികയും|ആരോഗ്യ സ്കോർ/i],
  ["receivables", /\b(owe|owes|owed|outstanding|receivable|unpaid|pending|collect|due|chase|debt)\b|കിട്ടാനുള്ള|കുടിശ്ശിക|ബാക്കി|പിരിച്ചെടുക്ക|kittanulla/i],
  ["profit", /\b(profit|margin|net|loss|earning)\b|ലാഭം|നഷ്ടം|labham/i],
  ["doctor", /\b(doctor|dr\.?|physician|top performer|best)\b|ഡോക്ടർ/i],
  ["attention", /\b(attention|worry|problem|issue|risk|alert|concern|wrong)\b|ശ്രദ്ധിക്കേണ്ട|പ്രശ്നം|അപകട/i],
  ["week", /\b(this week|last 7 days|past week|weekly|the week|busiest day)\b|ഈ ആഴ്ച|ആഴ്ച/i],
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

export const MALAYALAM = /[ഀ-ൿ]/;
/** end = the owner said they are done; the call can hang up after speaking the answer. */
/** callbackMinutes: the owner asked to be called back that many minutes from now (the call then ends). */
export type VoiceAnswer = { intent: Intent; answer: string; switchLang?: Lang; href?: string; followUps: string[]; handled: boolean; end?: boolean; callbackMinutes?: number };

/** Answers a follow-up from the report's own figures. Unknown questions return handled:false so the server can try the books. */
export function answerFromFacts(q: string, f: BriefFacts, asked: Lang, now: Date = new Date()): VoiceAnswer {
  // A question asked in Malayalam script gets a Malayalam answer, whatever the current setting.
  const lang: Lang = MALAYALAM.test(q) ? "ml" : asked;
  const ml = lang === "ml";
  const intent = detectIntent(q);
  const say = (en: string, mal: string) => (ml ? mal : en);
  const brief = composeBrief(f, lang);
  const sec = (k: BriefSection["key"]) => brief.sections.find((x) => x.key === k)?.text ?? "";
  const more = say(" Anything else?", " മറ്റെന്തെങ്കിലും?");
  const r = (answer: string, href?: string, extra: Partial<VoiceAnswer> = {}): VoiceAnswer => ({ intent, answer, href, followUps: suggestions(lang, f).filter((x) => x !== q).slice(0, 3), handled: true, ...extra });
  const noAccess = say("Your access does not include that part of the business. The super admin can enable it.", "നിങ്ങളുടെ ആക്സസിൽ ആ വിഭാഗം ഉൾപ്പെടുന്നില്ല. സൂപ്പർ അഡ്മിന് അത് അനുവദിക്കാം.");
  const fin = (t: string) => (f.scope.finance ? t : noAccess), cli = (t: string) => (f.scope.clinical ? t : noAccess);

  switch (intent) {
    case "lang_ml": return r("ശരി, ഇനി മലയാളത്തിൽ സംസാരിക്കാം. എന്താണ് അറിയേണ്ടത്?", undefined, { switchLang: "ml", followUps: suggestions("ml", f).slice(0, 3) });
    case "lang_en": return r("Sure, switching to English. What would you like to know?", undefined, { switchLang: "en", followUps: suggestions("en", f).slice(0, 3) });
    case "callback": {
      const mins = parseCallback(q, now) ?? 30;
      const at = new Date(now.getTime() + mins * 60_000).toLocaleTimeString("en-GB", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Asia/Dubai" });
      const name = firstName(f.recipient);
      return r(say(`Sure${name ? `, ${name}` : ""}. I'll call you back at ${at}${mins < 120 ? `, in ${mins < 60 ? `${mins} minute${mins === 1 ? "" : "s"}` : `${Math.round(mins / 6) / 10} hour${mins === 60 ? "" : "s"}`}` : ""}. Talk soon!`,
        `ശരി${name ? ` ${name}` : ""}. ${at}-ന് തിരികെ വിളിക്കാം.`), undefined, { end: true, callbackMinutes: mins });
    }
    case "done": return r(say(`Alright. Your full report is saved in Elister. Have a good ${f.hour < 17 ? "day" : "evening"}.`, `ശരി. പൂർണ്ണ റിപ്പോർട്ട് എലിസ്റ്ററിൽ സേവ് ചെയ്തിട്ടുണ്ട്. ${f.hour < 17 ? "നല്ലൊരു ദിവസം ആശംസിക്കുന്നു." : "ശുഭരാത്രി."}`), undefined, { end: true });
    case "repeat": return r(brief.sections.filter((x) => !["intro", "close"].includes(x.key)).map((x) => x.text).join(" ") + more);
    case "greeting": return r(say("Hello! Ask me about revenue, patients, bookings, money to collect or cash.", "നമസ്കാരം! വരുമാനം, രോഗികൾ, ബുക്കിംഗ്, കിട്ടാനുള്ള പണം, ക്യാഷ് എന്നിവയെക്കുറിച്ച് ചോദിക്കാം."));
    case "help": return r(say("I can tell you about revenue, profit, patients, bookings for today and tomorrow, money owed to the clinic, cash, the top doctor and anything that needs attention. I can also answer questions about the books, like how much was spent on rent last month.",
      "വരുമാനം, ലാഭം, രോഗികൾ, ഇന്നത്തെയും നാളത്തെയും ബുക്കിംഗ്, കിട്ടാനുള്ള പണം, ക്യാഷ്, മികച്ച ഡോക്ടർ, ശ്രദ്ധിക്കേണ്ട കാര്യങ്ങൾ എന്നിവയെക്കുറിച്ച് പറയാം."));
    case "revenue": return r(fin(sec("revenue") || composeBrief(f, lang, { sections: ["revenue"] }).sections.find((x) => x.key === "revenue")?.text || "") + more, "/finance");
    case "patients": return r(cli(composeBrief(f, lang, { sections: ["patients"] }).sections.find((x) => x.key === "patients")?.text ?? "") + more, "/patients");
    case "today": case "tomorrow": {
      const n = f.next;
      const asksNext = intent === n.when || (intent === "today" && n.when === "today");
      if (asksNext) return r(cli(composeBrief(f, lang, { sections: ["upcoming"] }).sections.find((x) => x.key === "upcoming")?.text ?? "") + more, "/appointments");
      if (intent === "today" && f.period === "today") return r(cli(composeBrief(f, lang, { sections: ["patients"] }).sections.find((x) => x.key === "patients")?.text ?? "") + more, "/appointments");
      return r(cli(say(`${intent === "tomorrow" ? "Tomorrow" : "That day"} has ${n.after} appointments booked so far.`, `${intent === "tomorrow" ? "നാളത്തേക്ക്" : "ആ ദിവസത്തേക്ക്"} ഇതുവരെ ${n.after} അപ്പോയിന്റ്മെന്റുകൾ.`)) + more, "/appointments");
    }
    case "receivables": return r(fin(composeBrief(f, lang, { sections: ["receivables"] }).sections.find((x) => x.key === "receivables")?.text ?? "") + more, "/billing");
    case "profit": {
      const margin = f.mtd.revenue ? Math.round((f.mtd.netProfit / f.mtd.revenue) * 100) : null;
      return r(fin(say(`Net profit this month so far is ${money(f.mtd.netProfit, lang)} on revenue of ${money(f.mtd.revenue, lang)}${margin !== null ? `, a margin of ${margin} percent` : ""}.`,
        `ഈ മാസം ഇതുവരെ ${money(f.mtd.revenue, lang)} വരുമാനത്തിൽ അറ്റാദായം ${money(f.mtd.netProfit, lang)}${margin !== null ? `, അതായത് ${margin} ശതമാനം മാർജിൻ` : ""}.`)) + more, "/finance");
    }
    case "cash": return f.cash ? r(composeBrief(f, lang, { sections: ["cash"] }).sections.find((x) => x.key === "cash")!.text + (f.cash.breachWeek ? " " + attention(f, lang).find((a) => a.key === "cash_breach")!.text : "") + more, "/accounts/ai") : r(noAccess);
    case "doctor": {
      const d = f.mtd.topDoctor;
      return r(fin(d ? say(`${d.name} has brought in the most revenue this month, ${money(d.amount, lang)}.${f.next.busiest ? ` ${f.next.when === "tomorrow" ? "Tomorrow" : "Today"}, ${f.next.busiest.name} has the busiest list with ${f.next.busiest.count} patients.` : ""}`,
        `ഈ മാസം ഏറ്റവും കൂടുതൽ വരുമാനം ${d.name}-ൽ നിന്നാണ്, ${money(d.amount, lang)}.${f.next.busiest ? ` ${f.next.when === "tomorrow" ? "നാളെ" : "ഇന്ന്"} ഏറ്റവും തിരക്ക് ${f.next.busiest.name}-ക്കാണ്, ${f.next.busiest.count} പേർ.` : ""}`)
        : say("No doctor revenue has been recorded this month yet.", "ഈ മാസം ഡോക്ടർമാരുടെ വരുമാനം ഇതുവരെ രേഖപ്പെടുത്തിയിട്ടില്ല.")) + more, "/finance");
    }
    case "noshow": {
      const rate = f.day.appts ? Math.round((f.day.noShows / f.day.appts) * 100) : 0;
      return r(cli(say(`${plural(f.day.noShows, "patient", "patients")} did not show up, ${rate} percent of bookings. The system does not record why; the usual causes are bookings made far ahead and no reminder the day before. The Assistants page scores each upcoming booking for no-show risk so reception can call the riskiest first.`,
        `${f.day.noShows} രോഗികൾ വന്നില്ല, ബുക്കിംഗിന്റെ ${rate} ശതമാനം. കാരണം സിസ്റ്റം രേഖപ്പെടുത്തുന്നില്ല; സാധാരണയായി ദൂരെയുള്ള ബുക്കിംഗും ഓർമ്മപ്പെടുത്തൽ ഇല്ലാത്തതുമാണ് കാരണങ്ങൾ.`)) + more, "/appointments");
    }
    case "attention": return r((composeBrief(f, lang, { sections: ["attention"] }).sections.find((x) => x.key === "attention")?.text ?? "") + more);
    case "week": {
      const w = f.week;
      if (!w) return r(say("I don't have the weekly figures yet.", "ആഴ്ചയിലെ കണക്കുകൾ ഇപ്പോൾ ലഭ്യമല്ല."));
      const EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"], ML = ["ഞായറാഴ്ച", "തിങ്കളാഴ്ച", "ചൊവ്വാഴ്ച", "ബുധനാഴ്ച", "വ്യാഴാഴ്ച", "വെള്ളിയാഴ്ച", "ശനിയാഴ്ച"];
      const parts: string[] = [];
      if (f.scope.clinical) parts.push(say(`Over the last 7 days the clinic saw ${w.visits} patients${w.prevVisits ? `, ${change(pct(w.visits, w.prevVisits), lang)} on the week before` : ""}, and ${w.newPatients} were new.${w.busiest ? ` The busiest day was ${EN[w.busiest.dow]}, with ${w.busiest.visits} visits.` : ""}`,
        `കഴിഞ്ഞ 7 ദിവസത്തിൽ ${w.visits} രോഗികളെ കണ്ടു${w.prevVisits ? `, അതിന് മുമ്പുള്ള ആഴ്ചയേക്കാൾ ${change(pct(w.visits, w.prevVisits), lang)}` : ""}; ${w.newPatients} പേർ പുതിയവരാണ്.${w.busiest ? ` ഏറ്റവും തിരക്കുള്ള ദിവസം ${ML[w.busiest.dow]} ആയിരുന്നു, ${w.busiest.visits} പേർ.` : ""}`));
      if (f.scope.finance) parts.push(say(`Revenue for the week was ${money(w.revenue, lang)}${w.prevRevenue ? `, ${change(pct(w.revenue, w.prevRevenue), lang)}` : ""}.`, `ആഴ്ചയിലെ വരുമാനം ${money(w.revenue, lang)}${w.prevRevenue ? `, ${change(pct(w.revenue, w.prevRevenue), lang)}` : ""}.`));
      return r((parts.join(" ") || noAccess) + more, "/dashboard");
    }
    case "month": return r(fin(say(
      `Month to date, revenue is ${money(f.mtd.revenue, lang)}${f.mtd.revenuePrev !== null ? ` against ${money(f.mtd.revenuePrev, lang)} at the same point last month, ${change(pct(f.mtd.revenue, f.mtd.revenuePrev), lang)}` : ""}, from ${f.mtd.appts} appointments. Net profit is ${money(f.mtd.netProfit, lang)}.`,
      `ഈ മാസം ഇതുവരെ ${f.mtd.appts} അപ്പോയിന്റ്മെന്റുകളിൽ നിന്ന് വരുമാനം ${money(f.mtd.revenue, lang)}${f.mtd.revenuePrev !== null ? `; കഴിഞ്ഞ മാസം ഇതേ സമയം ${money(f.mtd.revenuePrev, lang)} ആയിരുന്നു, ${change(pct(f.mtd.revenue, f.mtd.revenuePrev), lang)}` : ""}. അറ്റാദായം ${money(f.mtd.netProfit, lang)}.`)) + more, "/finance");
    default: return { intent, answer: "", followUps: suggestions(lang, f).slice(0, 3), handled: false };
  }
}
