import { NextResponse, type NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

// Optimistic redirect only. Real authorization happens server-side in every action and page.
export function proxy(req: NextRequest) {
  if (!getSessionCookie(req)) return NextResponse.redirect(new URL("/login", req.url));
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!login|kiosk|api/auth|display|brand|icon\.png|_next/static|_next/image|favicon.ico).*)"],
};
