import { redirect } from "next/navigation";

/** Chat now lives in the floating dock on every page. Old links and bookmarks land on the dashboard. */
export default function ChatPage() {
  redirect("/dashboard");
}
