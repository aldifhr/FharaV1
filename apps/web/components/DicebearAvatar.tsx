"use client";

import { useEffect, useState } from "react";
import { avatarInitial, dicebearBackgroundFor, memoizeUntilFailure } from "@/lib/dicebearAvatar";

/**
 * Renders a DiceBear "Lorelei" avatar (Pastel Wall preset) from a seed.
 * Lorelei is by Lisa Wischofsky, CC0 1.0 (THIRD_PARTY_NOTICES.md, ## DiceBear).
 *
 * The style definition is ~120 KB, so it is imported on demand and cached per
 * seed; the avatar stands on its pastel background from the first paint, with
 * the agent's initial (from `name`, not the seed) until the SVG is ready.
 */
type Renderer = (seed: string, background: string) => string;

const uriCache = new Map<string, string>();

const loadRenderer = memoizeUntilFailure(defaultRenderer);

async function defaultRenderer(): Promise<Renderer> {
  const [{ Avatar, Style }, { default: definition }] = await Promise.all([
    import("@dicebear/core"),
    import("@dicebear/styles/lorelei.json"),
  ]);
  const style = new Style(definition);
  return (seed, background) => new Avatar(style, { seed, backgroundColor: [background] }).toDataUri();
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
  name,
}: {
  seed: string;
  /** The agent's name: its first letter is the fallback (a shuffled seed is random text). */
  name?: string;
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

  const initial = avatarInitial(name, seed);

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
