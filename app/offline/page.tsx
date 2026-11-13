export const dynamic = "force-static";
export default function Offline() {
  return (
    <main className="grid min-h-dvh place-items-center p-8 text-center">
      <div><p className="text-5xl">📶</p><p className="mt-4 text-lg">אין חיבור כרגע. התמונות שלכם שמורות ויעלו כשהרשת תחזור.</p><p className="text-muted">You&apos;re offline. Your photos are saved and will upload when you&apos;re back online.</p></div>
    </main>
  );
}
