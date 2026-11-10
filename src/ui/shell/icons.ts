import { BedDouble, Bell, BookMarked, Bot, Boxes, Calculator, CalendarDays, ClipboardCheck, FlaskConical, HeartHandshake, HeartPulse, Landmark, LayoutDashboard, ListOrdered, MessageSquare, MessagesSquare, Percent, Pill, Receipt, ScanLine, Settings2, ShieldPlus, Truck, UserCog, Users } from "lucide-react";

/** One icon per module, used by the rail, the page headers and the banners so a module always looks the same. */
export const ICONS = {
  dash: LayoutDashboard, users: Users, cal: CalendarDays, queue: ListOrdered, bill: Receipt, calc: Calculator, ins: ShieldPlus, med: Pill, box: Boxes, truck: Truck,
  flask: FlaskConical, scan: ScanLine, bank: Landmark, book: BookMarked, tax: Percent, people: UserCog, crm: HeartHandshake, chat: MessageSquare, bed: BedDouble,
  check: ClipboardCheck, ai: Bot, portal: HeartPulse, settings: Settings2, bell: Bell, team: MessagesSquare,
} as const;
export type IconKey = keyof typeof ICONS;

export const ROUTE_ICON: Record<string, IconKey> = {
  dashboard: "dash", patients: "users", appointments: "cal", queue: "queue", billing: "bill", accounts: "calc", accounting: "calc", insurance: "ins", pharmacy: "med", inventory: "box",
  procurement: "truck", laboratory: "flask", radiology: "scan", finance: "bank", books: "book", tax: "tax", hr: "people", crm: "crm", communications: "chat", chat: "team",
  hospital: "bed", compliance: "check", ai: "ai", portal: "portal", settings: "settings", encounters: "portal", notifications: "bell",
};
