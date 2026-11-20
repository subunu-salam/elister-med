# Elister AI Assistant: scheduled report call, test plan

## Flow under test
1. **Notification** at the scheduled time (default 6:00 PM, per-user time zone) → web push → ringing notification with Answer / Decline (desktop, Android, installed iPhone app).
2. **Greeting** by first name ("Hi Subinu, how are you doing? This is Elister…").
3. **Choice**: carry on · call back in 30 min · in 1 h · in 2 h · at a chosen time · decline.
4. **Briefing**: patients, revenue, receivables, tomorrow, cash, attention (only the parts the user's access allows).
5. **Q&A**: two-way voice (Gemini Live when `GEMINI_API_KEY` is set, otherwise browser speech + typed fallback).

## Setup
```bash
npm install
npm run dev:local          # in-memory MongoDB + seeded demo org on :3000
npm run seed:year          # a full year of demo activity so every question has data
npx tsx scripts/vapid-keys.ts   # put the keys in .env (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY) for push
```
Set a test user's name to "Subinu" to check the greeting.

## Device matrix
| Device | Install / bookmark | Expected |
|---|---|---|
| Windows / macOS: Chrome, Edge | "Install Elister" button or address-bar icon | Ringing notification with Answer/Decline even with the window closed (browser running) |
| macOS Safari 17+ | File → Add to Dock | Notification banner; opens call screen |
| Firefox desktop | Bookmark (Ctrl/⌘+D) | Notification while Firefox runs |
| Android Chrome | Install prompt / ⋮ → Install app | Heads-up notification, vibration pattern, Answer/Decline |
| iPhone / iPad (iOS 16.4+) | Safari → Share → Add to Home Screen | Notification only after opening from Home Screen and tapping "Turn on calls" |

The **Scheduled calls** page (`/ai/schedule`) now always shows a "Keep Elister on this device" card with the steps for the current browser and the notification status.

## Scenarios
| # | Action | Expected |
|---|---|---|
| S1 | Set time 2 min ahead on /ai/schedule, close the tab | Push rings at that time |
| S2 | Answer → "yes, carry on" | Full report, then "Anything you'd like to ask me?" |
| S3 | Answer → "Call me back in 30 min" button | Call ends; /ai/schedule shows the call-back; rings again in 30 min |
| S4 | Answer → "In 1 hour" / "In 2 hours" / pick 5:45 PM | Call-back booked for that time |
| S5 | Say "call me back at 5 pm" mid-report | Call-back booked, polite goodbye |
| S6 | Say "**call me every day at 7 pm**" / "move my daily call to 19:30" | Daily time changed (visible on /ai/schedule), assistant confirms and continues |
| S7 | Same as S6 with the settings locked by the super admin | Assistant says the time is managed by the administrator; nothing changes |
| S8 | Decline from the notification | No call; next one is tomorrow's |
| S9 | Malayalam: "നാളെ എങ്ങനെയുണ്ട്?" | Answer in Malayalam |
| S10 | Offline, open the installed app | "You are offline" screen with Try again |

## Question bank (demo data must answer each)
Revenue today · How does this month compare? · How many patients / new patients? · Any cancellations or no-shows? · How does tomorrow look? · When is the first appointment? · Who owes us the most? · What's overdue more than 90 days? · Profit this month? · How long will our cash last? · Which doctor brought the most revenue? · How was this week? · What needs my attention? · How much did we spend on rent last month? (books) · Repeat that · Switch to Malayalam · That's all, bye.

Unit tests: `npm test -- brief-core` (call-back and daily-time parsing, intent routing).
