"use client";

import { useEffect, useState } from "react";
import { dicebearBackgroundFor } from "@/lib/dicebearAvatar";

/**
 * Renders a DiceBear "Lorelei" avatar (Pastel Wall preset) from a seed.
 *
 * The style definition is ~120 KB, so it is imported on demand and cached per
 * seed; the avatar stands on its pastel background from the first paint, with
 * the initial as a fallback until the SVG is ready.
 */
type Renderer = (seed: string, background: string) => string;

const uriCache = new Map<string, string>();
let rendererPromise: Promise<Renderer> | null = null;

function loadRenderer(): Promise<Renderer> {
  rendererPromise ??= (async () => {
    const [{ Avatar, Style }, { default: definition }] = await Promise.all([
      import("@dicebear/core"),
      import("@dicebear/styles/lorelei.json"),
    ]);
    const style = new Style(definition);
    return (seed, background) => new Avatar(style, { seed, backgroundColor: [background] }).toDataUri();
  })();
  return rendererPromise;
}

async function avatarUri(seed: string): Promise<string> {
  const cached = uriCache.get(seed);
  if (cached) return cached;
  const render = await loadRenderer();
  const uri = render(seed, dicebearBackgroundFor(seed));
  uriCache.set(seed, uri);
  return uri;
}

export default function DicebearAvatar({
  seed,
  size = 32,
  className = "",
  rounded = "rounded-full",
  label,
}: {
  seed: string;
  size?: number;
  className?: string;
  rounded?: string;
  /** Accessible name; omit when the avatar is decorative next to a name. */
  label?: string;
}) {
  const [uri, setUri] = useState<string | null>(() => uriCache.get(seed) ?? null);

  useEffect(() => {
    let active = true;
    const cached = uriCache.get(seed);
    if (cached) {
      setUri(cached);
      return;
    }
    setUri(null);
    avatarUri(seed).then(
      (next) => {
        if (active) setUri(next);
      },
      () => {
        // Style chunk failed to load: keep the pastel circle with the initial.
      },
    );
    return () => {
      active = false;
    };
  }, [seed]);

  const initial = (seed.trim().charAt(0) || "•").toUpperCase();

  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={`relative inline-flex shrink-0 items-center justify-center overflow-hidden ${rounded} ${className}`}
      style={{ width: size, height: size, backgroundColor: `#${dicebearBackgroundFor(seed)}` }}
    >
      {uri ? (
        // eslint-disable-next-line @next/next/no-img-element -- inline SVG data URI, next/image cannot optimize it
        <img
          src={uri}
          alt=""
          aria-hidden="true"
          draggable={false}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          className="h-full w-full object-cover"
        />
      ) : (
        <span aria-hidden="true" className="select-none font-semibold text-ink-3" style={{ fontSize: Math.round(size * 0.4) }}>
          {initial}
        </span>
      )}
    </span>
  );
}
