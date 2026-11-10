"use client";
import { useRef, useState } from "react";
import { Button, Card, Field, Input, Select, cn } from "@/ui/kit";

const STEPS = ["Identity", "Contact & ID", "Clinical & consent"] as const;

/** One real <form> so every field posts together; steps only toggle visibility. */
export function RegistrationForm({ action }: { action: (fd: FormData) => Promise<void> }) {
  const [step, setStep] = useState(0);
  const ref = useRef<HTMLFormElement>(null);

  const next = () => {
    const panel = ref.current?.querySelector<HTMLElement>(`[data-step="${step}"]`);
    const inputs = panel?.querySelectorAll<HTMLInputElement>("input,select,textarea") ?? [];
    for (const i of inputs) if (!i.reportValidity()) return;
    setStep((s) => s + 1);
  };

  return (
    <form ref={ref} action={action} className="space-y-4">
      <ol className="flex gap-2 text-xs" aria-label="Progress">
        {STEPS.map((s, i) => (
          <li key={s} aria-current={i === step ? "step" : undefined} className={cn("flex-1 rounded-ui border px-3 py-2", i === step ? "border-primary bg-primary/10 text-primary" : "border-border text-muted")}>
            {i + 1}. {s}
          </li>
        ))}
      </ol>

      <Card>
        <div data-step="0" hidden={step !== 0} className="grid gap-3 sm:grid-cols-2">
          <Field label="Full name (English) *"><Input name="fullName" required minLength={2} /></Field>
          <Field label="Full name (Arabic)"><Input name="fullNameAr" dir="rtl" lang="ar" /></Field>
          <Field label="Date of birth *"><Input name="dob" type="date" required max={new Date().toISOString().slice(0, 10)} /></Field>
          <Field label="Sex *">
            <Select name="sex" required defaultValue="">
              <option value="" disabled>Select…</option><option value="female">Female</option><option value="male">Male</option><option value="other">Other</option><option value="unknown">Not stated</option>
            </Select>
          </Field>
          <Field label="Nationality"><Input name="nationality" /></Field>
          <Field label="Preferred language">
            <Select name="preferredLanguage" defaultValue="en"><option value="en">English</option><option value="ar">العربية</option></Select>
          </Field>
        </div>

        <div data-step="1" hidden={step !== 1} className="grid gap-3 sm:grid-cols-2">
          <Field label="Mobile *"><Input name="phone" type="tel" required placeholder="+9715XXXXXXXX" pattern="\+?[0-9 ()\-]{7,20}" /></Field>
          <Field label="Email"><Input name="email" type="email" /></Field>
          <Field label="Emirates ID" hint="Stored encrypted. Only collect where lawfully necessary."><Input name="emiratesId" placeholder="784-YYYY-NNNNNNN-N" pattern="784-?\d{4}-?\d{7}-?\d" /></Field>
          <Field label="Address"><Input name="address" /></Field>
          <Field label="Emergency contact name"><Input name="ecName" /></Field>
          <Field label="Emergency contact phone"><Input name="ecPhone" type="tel" /></Field>
        </div>

        <div data-step="2" hidden={step !== 2} className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Known allergy (substance)"><Input name="allergy" /></Field>
            <Field label="Reaction"><Input name="allergyReaction" /></Field>
            <Field label="Severity"><Select name="allergySeverity" defaultValue="moderate"><option value="mild">Mild</option><option value="moderate">Moderate</option><option value="severe">Severe</option></Select></Field>
          </div>
          <fieldset className="space-y-2">
            <legend className="text-xs font-medium text-muted">Communication preferences</legend>
            {[["sms", "SMS reminders", true], ["emailPref", "Email", true], ["whatsapp", "WhatsApp", false], ["marketing", "Marketing messages (explicit opt-in)", false]].map(([n, l, d]) => (
              <label key={String(n)} className="flex items-center gap-2 text-sm"><input type="checkbox" name={String(n)} defaultChecked={Boolean(d)} /> {l}</label>
            ))}
          </fieldset>
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="consentTreatment" className="mt-0.5" /> Patient consents to treatment and to the processing of their health data for care.</label>
        </div>
      </Card>

      <div className="flex justify-between">
        <Button type="button" variant="outline" onClick={() => setStep((s) => s - 1)} disabled={step === 0}>Back</Button>
        {/* distinct keys force a remount: otherwise the click that reaches the last step also submits the form */}
        {step < STEPS.length - 1 ? <Button key="next" type="button" onClick={next}>Continue</Button> : <Button key="save" type="submit">Save patient</Button>}
      </div>
    </form>
  );
}
