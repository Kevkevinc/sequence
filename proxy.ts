import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// Page routes that require a signed-in user. API routes are not listed here:
// each one already checks `auth()` itself and returns 401, which is the
// correct behaviour for a fetch (a middleware redirect to a sign-in HTML page
// would be useless to a JSON client).
const isProtectedRoute = createRouteMatcher(["/profile(.*)", "/jobs(.*)"]);

export default clerkMiddleware(async (auth, req) => {
  if (isProtectedRoute(req)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
