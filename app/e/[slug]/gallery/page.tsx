import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { eventBy } from "@/lib/http";
import { EventApp } from "@/components/EventApp";

type P = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: P): Promise<Metadata> {
  const { slug } = await params;
  const e = await eventBy("slug", slug).catch(() => null);
  return {
    title: e?.name ?? "GuestLens",
    manifest: `/e/${slug}/manifest.webmanifest`,
    appleWebApp: { capable: true, title: e?.name ?? "GuestLens", statusBarStyle: "default" },
  };
}

export default async function Page({ params }: P) {
  const { slug } = await params;
  const e = await eventBy("slug", slug);
  if (!e) notFound();
  return <EventApp slug={e.slug} eventName={e.name} uploadOpen={e.uploadOpen} view="gallery" />;
}
