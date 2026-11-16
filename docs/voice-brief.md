# Personal AI assistant and the super admin control centre

## The pitch
"You get your own personal AI assistant. Every evening it calls you, tells you how the clinic did, and answers your questions."

## How the call works
1. **The phone rings.** At the person's call time (default 20:00 Dubai), Elister sends a web push. The service worker (`public/sw.js`) shows a ringing notification: "📞 Incoming call · Elister AI", with **Answer** and **Decline**, a phone-style vibration, and the headline figure. If Elister is open, a full-screen incoming-call card also appears with Elister's caller tune (synthesised in the browser, no audio file).
2. **Answer** opens `/ai/call`, a full-screen call with a timer. Elister reads the day's report chapter by chapter, with live captions:
   - patients seen and appointments
   - revenue
   - receivables
   - tomorrow's bookings
   - cash
   - what needs attention
3. **"Is there anything else you'd like me to explain?"** From then on it's a two-way voice chat. Saying "no" or "that's all" ends the call. The full written report stays at `/ai/brief`.
4. **Malayalam:** set the language in settings, switch it during the call, or just ask in Malayalam.

Calls after 3 pm report on that day; earlier calls report on the day before.
"Call me now" on `/ai/brief` (and "Ring now" in the control centre) rings straight away. Use it for demos.

### Getting the ringing notification
- **Android, Windows, Mac (Chrome or Edge):** Personal assistant → **Turn on calls**.
- **iPhone/iPad:** Share → **Add to Home Screen**, open Elister from the new icon, then **Turn on calls**. Apple only lets home-screen web apps receive notifications (iOS 16.4+).
- **Ringtone limit:** a web app can't play its own ringtone through a system notification while it is closed. The phone plays its usual notification sound and vibrates. The custom caller tune plays when Elister is open and on the call screen.

## What the owner can change (Personal assistant page)
- whether the daily call is on, plus its time, days and language
- which parts the report covers

Parts outside the person's module access are left out automatically.

## Super admin control centre (`/admin`)
Only platform super admins and organisation admins can open it.
- **Who can see what:** a matrix of every person against every module.
- **Roles** say what someone may do. **Module access** says which parts of the business they can see at all:

  | Module | Covers |
  |---|---|
  | Clinical | patients, appointments, queue, medical records, wards |
  | Lab & radiology | lab orders and results, imaging |
  | Pharmacy | prescriptions, dispensing |
  | Billing & insurance | invoices, payments, claims |
  | Finance & reports | accounts, ledger, reports, AI CFO |
  | Inventory & purchasing | stock, suppliers, purchase orders |
  | HR & payroll | staff, leave, payroll, WPS |
  | CRM & messaging | leads, campaigns, patient messages |
  | Compliance & audit | policies, incidents, audit trail, integrations |
  | AI assistant | personal assistant, daily call |

  Module access is enforced in `loadCtx`, so every page and API refuses a closed module. It is not just hidden from the menu.
- **Add a person:** login, temporary password, roles and modules.
- **Assistant per person:** schedule, language and sections. You can lock the settings and ring the person now.
- **Guard rails:**
  - You can't remove your own admin access.
  - The organisation always keeps at least one active admin.
  - Only a platform super admin can grant platform super admin.
- Every change is recorded in the audit log.

## Privacy
- The report never contains patient names or clinical data.
- Pushes are empty: the push service learns nothing about the clinic. The device then asks Elister directly what to show.
- Speech uses the device's own voice unless the Gemini natural voice is switched on (`GEMINI_API_KEY` + `ELISTER_VOICE_EXTERNAL=1`).

## Setup (Vercel)
1. `CRON_SECRET` = a long random string. On the Hobby plan the cron in `vercel.json` runs **once a day at 20:00 Dubai** and rings everyone whose call time has passed. For exact per-person times, run it hourly: switch the schedule to `0 * * * *` on Vercel Pro, or call `/api/cron/daily-brief` hourly from any scheduler, with the header `Authorization: Bearer $CRON_SECRET`.
2. Run `npx tsx scripts/vapid-keys.ts` and set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT`.
3. Optional: `GEMINI_API_KEY` + `ELISTER_VOICE_EXTERNAL=1` for a natural Malayalam voice.
