import Link from "next/link";
import { requireCtx } from "@/lib/session";
import { searchPatients } from "@/modules/patients/service";
import { Button, Card, Input, NoAccess, PageHeader, Table } from "@/ui/kit";

export default async function PatientsPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const ctx = await requireCtx();
  const { q = "" } = await searchParams;
  if (!ctx.permissions.includes("patients:view")) return <NoAccess what="patient records" />;
  const hits = q.trim().length >= 2 ? await searchPatients(ctx, q) : [];
  return (
    <div className="space-y-4">
      <PageHeader title="Patients" sub="Search by name (English or Arabic), MRN or phone"
        actions={ctx.permissions.includes("patients:create") && <Link href="/patients/new"><Button>Register patient</Button></Link>} />
      <Card>
        <form className="flex gap-2" role="search">
          <Input name="q" defaultValue={q} placeholder="Search by name, MRN or phone" aria-label="Search patients" autoFocus />
          <Button>Search</Button>
        </form>
      </Card>
      {q.trim().length >= 2 && (
        <Card>
          <Table head={["MRN", "Name", "Date of birth", "Phone", ""]} empty={hits.length ? undefined : `No patients match “${q}”.`}>
            {hits.map((h) => (
              <tr key={h._id}>
                <td className="font-mono text-xs">{h.mrn}</td>
                <td><div>{h.fullName}</div>{h.fullNameAr && <div dir="rtl" className="text-xs text-muted">{h.fullNameAr}</div>}</td>
                <td>{h.dob}</td>
                <td dir="ltr" className="text-start">{h.phone}</td>
                <td className="text-end"><Link className="text-primary hover:underline" href={`/patients/${h._id}`}>Open</Link></td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
      {q.trim().length < 2 && <p className="text-sm text-muted">Type at least two characters to search.</p>}
    </div>
  );
}
