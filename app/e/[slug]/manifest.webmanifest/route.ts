import { cookies } from "next/headers";
import { eventBy } from "@/lib/http";
import { LANG_COOKIE, isLang } from "@/lib/i18n";

/** Per-event manifest: the installed icon opens straight into this wedding. */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const event = await eventBy("slug", slug).catch(() => null);
  const c = (await cookies()).get(LANG_COOKIE)?.value;
  const lang = isLang(c) ? c : "he";
  const name = event?.name ?? "GuestLens";
  const manifest = {
    id: `/e/${slug}`,
    name,
    short_name: name.length > 12 ? name.slice(0, 12) : name,
    description: lang === "he" ? "האלבום המשותף של האירוע" : "The event's shared album",
    lang,
    dir: lang === "he" ? "rtl" : "ltr",
    start_url: `/e/${slug}?source=pwa`,
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#fff8f3",
    theme_color: "#fff8f3",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
  return new Response(JSON.stringify(manifest), {
    headers: { "Content-Type": "application/manifest+json", "Cache-Control": "public, max-age=300" },
  });
}
