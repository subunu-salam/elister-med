"use client";
import { Button } from "@/ui/kit";

export function PrintButton() {
  return <Button variant="outline" onClick={() => window.print()}>Print receipt</Button>;
}
