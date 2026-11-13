import { Camera } from "lucide-react";

export default function Home() {
  return (
    <main className="grid min-h-dvh place-items-center p-8 text-center">
      <div>
        <Camera className="mx-auto size-12 text-rose-deep" aria-hidden />
        <h1 className="mt-4 font-display text-3xl">GuestLens</h1>
        <p className="mt-2 text-muted">סרקו את קוד ה‑QR באירוע · Scan the QR code at the event</p>
      </div>
    </main>
  );
}
