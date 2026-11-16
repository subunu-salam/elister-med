# AI personal assistant: daily voice brief

**Where:** `/ai/brief` (sidebar "Daily brief", dashboard button "Play my 3-minute brief"). Owners and managers only (`dashboard:view` + `reports:view`).

## What it does
- **3-minute spoken brief** in chapters: patients seen, revenue (vs the day before, the same day last week and last month to date), money to collect (aged, with the first insurers/corporates to chase), today's and tomorrow's bookings, cash and health score, and up to three things that need attention.
- **English and Malayalam.** Malayalam uses lakh/crore for amounts. A question asked in Malayalam is answered in Malayalam automatically; saying "speak in Malayalam/English" switches language.
- **Two-way voice chat.** Tap the mic (or type). Answers come first from the brief's figures, then from the books ("how much did we spend on rent last quarter?"), then, only if the natural voice is approved, from Gemini using the same aggregate figures. *Hands-free* keeps the mic open after each answer.
- **Morning notification.** Vercel Cron builds every eligible user's brief at 08:00 Dubai and posts an in-app notification ("Your 2-minute brief is ready · revenue yesterday … · 3 to look at").
- **Extras:** attention cards with deep links, 14-day history (dot = listened), WhatsApp/copy summary for partners, chapter skip, 0.9×/1×/1.2× speed, rebuild with latest figures.

## Privacy
The brief never contains patient names or clinical data. Receivables are named only for insurers and corporate clients.
By default speech uses the device (Web Speech API) and **nothing leaves Elister**. The natural voice sends brief text to Google and is off unless both `GEMINI_API_KEY` and `ELISTER_VOICE_EXTERNAL=1` are set; record the owner's approval before turning it on.

## Setup (Vercel)
1. `CRON_SECRET` = any long random string (Vercel attaches it to cron calls automatically).
2. Optional natural voice: `GEMINI_API_KEY` + `ELISTER_VOICE_EXTERNAL=1`. Recommended for Malayalam, because Chrome on desktop has no Malayalam voice (Edge and Android do).
3. Deploy. `vercel.json` registers the cron.

## Code
| File | Role |
|---|---|
| `src/modules/ai/brief-core.ts` | Pure: composes the brief (EN/ML), attention rules, follow-up intents. Unit-tested. |
| `src/modules/ai/brief.ts` | Gathers figures with the user's permissions, daily snapshot (`ai_briefs`), Q&A, cron publisher. |
| `src/modules/ai/voice-provider.ts` | Optional Gemini TTS + grounded answers. |
| `src/ui/voice/*` | Player, orb, mic, chat. |
| `src/app/api/ai/brief/*`, `src/app/api/cron/daily-brief` | Routes. |
