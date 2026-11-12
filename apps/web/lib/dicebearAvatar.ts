/**
 * DiceBear "Lorelei" avatars with the "Pastel Wall" preset: five soft
 * backgrounds, the drawing untouched. Pure helpers shared by the avatar
 * components and the agent configure form.
 *
 * Only the seed is persisted (`avatarParams: { dicebear: "lorelei", seed }`),
 * so the SVG is rendered in the browser and stays in sync with the library.
 */
export const DICEBEAR_STYLE = "lorelei";

/** Backgrounds of the Lorelei "Pastel Wall" preset (dicebear 10.x). */
export const PASTEL_WALL_BACKGROUNDS = ["ffe3ea", "e3edff", "e2f5e9", "fdf1d4", "efe6ff"] as const;

/** What `agents.avatarParams` holds for a DiceBear-rendered agent. */
export type DicebearAvatarParams = { dicebear: typeof DICEBEAR_STYLE; seed: string };

export function isDicebearAvatarParams(value: unknown): value is DicebearAvatarParams {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.dicebear === DICEBEAR_STYLE && typeof record.seed === "string" && record.seed.trim().length > 0;
}

/** Seed for an agent without saved params: its name, so the avatar is stable. */
export function dicebearSeedFor(name: string): string {
  return name.trim() || "agent";
}

/** Seed for the shuffle button: short, readable, and different on every click. */
export function randomDicebearSeed(): string {
  return Math.random().toString(36).slice(2, 12) || "agent";
}

/** Mutation args for a shuffled seed; empty when the avatar was not changed. */
export function dicebearAvatarArgs(seed: string | null): { avatarParams?: DicebearAvatarParams } {
  return seed ? { avatarParams: { dicebear: DICEBEAR_STYLE, seed } } : {};
}

/**
 * One of the five preset walls for a seed, so the placeholder painted before
 * the SVG loads matches the rendered background instead of flickering.
 */
export function dicebearBackgroundFor(seed: string): string {
  let hash = 0;
  for (const character of seed) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return PASTEL_WALL_BACKGROUNDS[Math.abs(hash) % PASTEL_WALL_BACKGROUNDS.length];
}

/** Fallback letter: the agent's name first, the seed only when there is no name. */
export function avatarInitial(name: string | undefined, seed: string): string {
  return ((name?.trim() || seed.trim()).charAt(0) || "•").toUpperCase();
}

/**
 * One shared in-flight load (the ~120 KB style chunk), kept once it
 * succeeds. A failed load is dropped, so the next avatar tries again instead
 * of every avatar staying on its initial until a reload.
 */
export function memoizeUntilFailure<T>(load: () => Promise<T>): () => Promise<T> {
  let promise: Promise<T> | null = null;
  return () => {
    if (!promise) {
      const pending = load();
      promise = pending;
      pending.catch(() => {
        if (promise === pending) promise = null;
      });
    }
    return promise;
  };
}
