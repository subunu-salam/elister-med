"use client";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

export function RefreshEvery({ seconds }: { seconds: number }) {
  const router = useRouter();
  useEffect(() => {
    const h = setInterval(() => router.refresh(), seconds * 1000);
    return () => clearInterval(h);
  }, [router, seconds]);
  return null;
}
