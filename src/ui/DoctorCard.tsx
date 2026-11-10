import Link from "next/link";
import { CalendarPlus, Clock } from "lucide-react";
import { Avatar } from "@/ui/avatar";
import { PhotoUpload } from "@/ui/PhotoUpload";
import { cn } from "@/ui/kit";

export type DoctorCardData = { _id: string; name: string; specialty?: string; userId?: string; workDays: number[]; workStart: string; workEnd: string; slotMinutes: number };
const DAYS = ["S", "M", "T", "W", "T", "F", "S"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** A doctor at a glance: picture, specialty, working days and hours, and a way to book. Photo upload shows only for people allowed to change it. */
export function DoctorCard({ doctor: d, photo, canEditPhoto, today, bookHref }: { doctor: DoctorCardData; photo?: number | null; canEditPhoto?: boolean; today: number; bookHref?: string }) {
  const name = d.name.replace(/\s*\(.*?\)\s*/g, "").trim();
  const onToday = d.workDays.includes(today);
  const key = d.userId ?? d._id; // doctors without a login still get a photo, keyed by their staff record
  return (
    <article className="panel flex w-[17rem] shrink-0 snap-start flex-col items-center rounded-[28px] p-5 text-center">
      <div className="relative">
        <Avatar name={d.name} userId={key} photo={photo} size={92} className="ring-4 ring-tint" />
        <span title={onToday ? "Working today" : "Not working today"} className={cn("absolute bottom-1 end-1 size-4 rounded-full ring-2 ring-surface", onToday ? "bg-ok" : "bg-muted/50")} />
        {canEditPhoto && <PhotoUpload userId={key} compact hasPhoto={!!photo} className="absolute -start-1 bottom-0" />}
      </div>
      <h3 className="mt-3 text-[15px] font-medium leading-tight">{name}</h3>
      <p className="text-sm text-muted">{d.specialty ?? "Doctor"}</p>
      <div className="mt-4 w-full rounded-2xl bg-tint px-3 py-2.5">
        <div className="flex items-center justify-center gap-1.5 text-sm font-medium"><Clock size={14} className="text-primary" />{d.workStart} to {d.workEnd}</div>
        <div className="mt-2 flex justify-center gap-1" aria-label={`Works ${d.workDays.map((x) => DAY_NAMES[x]).join(", ")}`}>
          {DAYS.map((l, i) => <span key={i} className={cn("grid size-6 place-items-center rounded-full text-[10px] font-medium", d.workDays.includes(i) ? "brand-grad text-white" : "bg-surface text-muted")}>{l}</span>)}
        </div>
        <div className="mt-2 text-xs text-muted">{d.slotMinutes}-minute visits</div>
      </div>
      {bookHref && <Link href={bookHref} className="btn-gloss mt-4 inline-flex items-center gap-2 rounded-full px-5 py-2 text-sm font-medium"><CalendarPlus size={15} />Book</Link>}
    </article>
  );
}
