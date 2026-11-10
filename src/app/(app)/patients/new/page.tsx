import { requireCtx } from "@/lib/session";
import { PageHeader, Alert, NoAccess } from "@/ui/kit";
import { createPatientAction } from "../actions";
import { RegistrationForm } from "./RegistrationForm";

export default async function NewPatientPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const ctx = await requireCtx();
  if (!ctx.permissions.includes("patients:create")) return <NoAccess what="patient registration" />;
  const { error } = await searchParams;
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageHeader title="Register patient" sub="Three short steps. A medical record number is assigned on save." />
      {error && <Alert>{error}</Alert>}
      <RegistrationForm action={createPatientAction} />
    </div>
  );
}
