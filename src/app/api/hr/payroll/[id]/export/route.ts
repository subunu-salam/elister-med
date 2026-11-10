import "@/core/auth"; // registers the session -> ctx resolver
import { authorize } from "@/core/rbac/authorize";
import { AppError } from "@/core/errors";
import { wpsExport } from "@/modules/hr/service";

/** Bank-transfer CSV for an approved payroll run. Generic layout (see notice header), permission hr:export. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await authorize("hr:export");
    const { id } = await params;
    const f = await wpsExport(ctx, id);
    return new Response(f.csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${f.filename}"`, "X-Export-Notice": f.notice } });
  } catch (e) {
    if (e instanceof AppError) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
