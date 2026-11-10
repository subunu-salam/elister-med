import "@/core/auth"; // registers the session -> ctx resolver
import { authorize } from "@/core/rbac/authorize";
import { AppError } from "@/core/errors";
import { searchPatients } from "@/modules/patients/service";


export async function GET(req: Request) {
  try {
    const ctx = await authorize("patients:view");
    const q = new URL(req.url).searchParams.get("q") ?? "";
    return Response.json(await searchPatients(ctx, q));
  } catch (e) {
    if (e instanceof AppError) return Response.json({ error: e.code }, { status: e.status });
    throw e;
  }
}
