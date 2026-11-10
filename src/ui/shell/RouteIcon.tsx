"use client";
import { usePathname } from "next/navigation";
import { ICONS, ROUTE_ICON } from "@/ui/shell/icons";

/** The icon of the module the visitor is in, so page headers and banners carry the same mark as the rail. */
export function RouteIcon({ size = 24, strokeWidth = 1.6, className }: { size?: number; strokeWidth?: number; className?: string }) {
  const key = ROUTE_ICON[usePathname().split("/")[1] ?? ""];
  if (!key) return null;
  const Icon = ICONS[key];
  return <Icon size={size} strokeWidth={strokeWidth} className={className} aria-hidden />;
}
