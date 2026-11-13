"use client";
import { m } from "motion/react";
import { Camera, Check, CloudUpload, Heart, Images, Play, Video, Wifi } from "lucide-react";

const loop = { repeat: Infinity, ease: "easeInOut" } as const;

/** Phone outline shared by the illustrations. */
export function Phone({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`relative h-[260px] w-[148px] overflow-hidden rounded-[28px] border-[6px] border-ink bg-white shadow-xl ${className}`}>
      <div className="absolute left-1/2 top-1.5 z-20 h-3.5 w-12 -translate-x-1/2 rounded-full bg-ink" />
      {children}
    </div>
  );
}

export function WelcomeArt() {
  return (
    <div className="relative grid h-[200px] w-full place-items-center">
      <svg viewBox="0 0 200 120" className="w-52" aria-hidden>
        {[{ cx: 78, c: "var(--color-gold)", d: 0 }, { cx: 122, c: "var(--color-rose)", d: 0.35 }].map((r) => (
          <m.circle
            key={r.cx} cx={r.cx} cy={64} r={36} fill="none" stroke={r.c} strokeWidth={7} strokeLinecap="round"
            initial={{ pathLength: 0, rotate: -90 }} animate={{ pathLength: 1, rotate: 0 }}
            transition={{ duration: 1.3, delay: r.d, ease: "easeOut" }}
          />
        ))}
        <m.path
          d="M100 14 l4 8 9 1 -7 6 2 9 -8 -5 -8 5 2 -9 -7 -6 9 -1z" fill="var(--color-gold)"
          initial={{ scale: 0, opacity: 0 }} animate={{ scale: [0, 1.3, 1], opacity: 1 }}
          transition={{ delay: 1.4, duration: 0.6 }} style={{ transformOrigin: "100px 26px" }}
        />
      </svg>
      {[...Array(7)].map((_, i) => (
        <m.span
          key={i} className="absolute bottom-6 text-rose" style={{ insetInlineStart: `${12 + i * 12}%` }}
          initial={{ y: 0, opacity: 0, scale: 0.6 }}
          animate={{ y: -150, opacity: [0, 1, 0], scale: [0.6, 1, 0.8], x: [0, i % 2 ? 12 : -12, 0] }}
          transition={{ ...loop, duration: 4 + (i % 3), delay: 1 + i * 0.55 }}
        >
          <Heart className="size-4 fill-current" aria-hidden />
        </m.span>
      ))}
    </div>
  );
}

export function ShootArt() {
  const T = 3.2;
  return (
    <div className="relative grid h-[260px] w-full place-items-center">
      <Phone>
        <div className="absolute inset-0 bg-gradient-to-b from-[#f6c6a8] via-[#e9a0a8] to-[#8d6c9e]" />
        {/* two little figures */}
        <div className="absolute bottom-24 left-1/2 flex -translate-x-1/2 items-end gap-2">
          <div className="h-14 w-6 rounded-t-full bg-ink/70" />
          <div className="h-12 w-7 rounded-t-full bg-white/90" />
        </div>
        {/* focus brackets */}
        <m.div
          className="absolute left-1/2 top-[34%] size-20 -translate-x-1/2 rounded-lg border-2 border-white/90"
          animate={{ scale: [1.25, 1, 1, 1.25] }} transition={{ ...loop, duration: T, times: [0, 0.25, 0.9, 1] }}
        />
        {/* flash */}
        <m.div className="absolute inset-0 z-10 bg-white" animate={{ opacity: [0, 0, 0.95, 0, 0] }}
          transition={{ ...loop, duration: T, times: [0, 0.38, 0.42, 0.55, 1] }} />
        {/* shutter */}
        <div className="absolute inset-x-0 bottom-0 flex h-20 items-center justify-center gap-6 bg-black/35">
          <Images className="size-5 text-white/90" aria-hidden />
          <m.div className="grid size-12 place-items-center rounded-full border-4 border-white"
            animate={{ scale: [1, 1, 0.82, 1, 1] }} transition={{ ...loop, duration: T, times: [0, 0.3, 0.4, 0.5, 1] }}>
            <div className="size-8 rounded-full bg-rose" />
          </m.div>
          <Video className="size-5 text-white/90" aria-hidden />
        </div>
      </Phone>
      {/* the snapped photo flies off into the album */}
      <m.div
        className="absolute z-30 h-16 w-14 rounded-md border-4 border-white bg-gradient-to-b from-[#f6c6a8] to-[#8d6c9e] shadow-lg"
        animate={{ opacity: [0, 0, 1, 1, 0], scale: [0.4, 0.4, 1, 0.7, 0.4], x: [0, 0, 0, 90, 110], y: [0, 0, -10, -90, -110], rotate: [0, 0, -6, 10, 14] }}
        transition={{ ...loop, duration: T, times: [0, 0.45, 0.55, 0.85, 1] }}
      />
    </div>
  );
}

export function UploadArt() {
  const R = 46, C = 2 * Math.PI * R;
  return (
    <div className="relative grid h-[260px] w-full place-items-center">
      <div className="relative grid size-40 place-items-center">
        <svg viewBox="0 0 110 110" className="absolute inset-0 -rotate-90" aria-hidden>
          <circle cx="55" cy="55" r={R} fill="none" stroke="var(--color-blush)" strokeWidth="8" />
          <m.circle cx="55" cy="55" r={R} fill="none" stroke="var(--color-rose)" strokeWidth="8" strokeLinecap="round"
            strokeDasharray={C} animate={{ strokeDashoffset: [C, 0, 0] }} transition={{ ...loop, duration: 3.6, times: [0, 0.8, 1] }} />
        </svg>
        <m.div animate={{ y: [0, -4, 0] }} transition={{ ...loop, duration: 1.8 }}>
          <CloudUpload className="size-14 text-rose-deep" aria-hidden />
        </m.div>
        <m.div className="absolute -bottom-1 grid size-9 place-items-center rounded-full bg-emerald-500 text-white shadow"
          animate={{ scale: [0, 0, 1.2, 1, 0] }} transition={{ ...loop, duration: 3.6, times: [0, 0.78, 0.86, 0.95, 1] }}>
          <Check className="size-5" aria-hidden />
        </m.div>
      </div>
      {/* files rising into the cloud */}
      {[0, 1, 2].map((i) => (
        <m.div key={i} className="absolute bottom-2 h-10 w-8 rounded-md border-2 border-white bg-gradient-to-br from-gold/70 to-rose shadow"
          style={{ insetInlineStart: `${30 + i * 18}%` }}
          animate={{ y: [30, -70], opacity: [0, 1, 0], scale: [1, 0.5] }}
          transition={{ ...loop, duration: 1.8, delay: i * 0.6, ease: "easeIn" }} />
      ))}
      {/* flaky wifi still works */}
      <m.div className="absolute end-6 top-4 text-muted" animate={{ opacity: [1, 0.25, 1, 0.5, 1] }} transition={{ ...loop, duration: 2.2 }}>
        <Wifi className="size-6" aria-hidden />
      </m.div>
    </div>
  );
}

const TILE_COLORS = ["#f6c6a8", "#e9a0a8", "#c9a35c", "#8d6c9e", "#f8e1dc", "#d9798a", "#b8516a", "#f2d7a8", "#a88bb5"];

export function GalleryArt() {
  return (
    <div className="relative grid h-[260px] w-full place-items-center">
      <Phone>
        <div className="grid grid-cols-3 gap-1 p-2 pt-7">
          {TILE_COLORS.map((c, i) => (
            <m.div key={i} className="relative aspect-square rounded-[4px]" style={{ background: c }}
              initial={{ scale: 0, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
              transition={{ delay: 0.15 + i * 0.08, type: "spring", stiffness: 300, damping: 20 }}>
              {i === 4 && <Play className="absolute inset-0 m-auto size-4 fill-white text-white" aria-hidden />}
            </m.div>
          ))}
          {/* a "new" tile slides in on top */}
          <m.div className="col-span-3 mt-1 rounded bg-rose/90 py-1 text-center text-[9px] font-bold text-white"
            animate={{ opacity: [0, 1, 1, 0], y: [-6, 0, 0, -6] }} transition={{ ...loop, duration: 4, delay: 1.5, times: [0, 0.1, 0.6, 0.7] }}>
            +3 ✨
          </m.div>
        </div>
        {/* tap → fullscreen */}
        <m.div className="absolute z-10 rounded-[4px]" style={{ background: TILE_COLORS[1] }}
          animate={{ opacity: [0, 0, 1, 1, 0], top: ["31%", "31%", "0%", "0%", "31%"], left: ["36%", "36%", "0%", "0%", "36%"], width: ["28%", "28%", "100%", "100%", "28%"], height: ["16%", "16%", "100%", "100%", "16%"] }}
          transition={{ ...loop, duration: 4.5, delay: 1.6, times: [0, 0.2, 0.35, 0.8, 1] }} />
        <m.div className="absolute z-20 size-8 rounded-full border-2 border-white bg-white/40"
          style={{ top: "34%", left: "42%" }}
          animate={{ scale: [0, 0, 1, 1.6], opacity: [0, 0, 1, 0] }}
          transition={{ ...loop, duration: 4.5, delay: 1.6, times: [0, 0.12, 0.2, 0.34] }} />
      </Phone>
    </div>
  );
}

export function CameraBadge() {
  return (
    <m.span className="inline-grid size-7 place-items-center rounded-full bg-rose text-white"
      animate={{ scale: [1, 1.15, 1] }} transition={{ ...loop, duration: 1.6 }}>
      <Camera className="size-4" aria-hidden />
    </m.span>
  );
}
