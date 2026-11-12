/**
 * Default avatar parameters for a new agent.
 *
 * The UI renders DiceBear "Lorelei" avatars with the "Pastel Wall" preset from
 * a seed, so the stored params only carry the seed (the agent name). Old rows
 * may still hold legacy Avataaars/Avatartion params; the UI ignores unknown
 * shapes and derives the avatar from the name instead.
 */
export interface AvatarParams {
  dicebear: "lorelei";
  seed: string;
}

export function defaultAvatarParams(name: string): AvatarParams {
  return { dicebear: "lorelei", seed: name.trim() || "agent" };
}
