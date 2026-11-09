/**
 * Default avataaars parameters for a new agent, derived deterministically
 * from its name. Pure — shared by the backend seed (agents.ts) and the web
 * avatar helpers (apps/web/lib/avatar.ts).
 */
export interface AvatarParams {
  avatarStyle: string;
  topType: string;
  accessoriesType: string;
  hatColor: string;
  hairColor: string;
  facialHairType: string;
  facialHairColor: string;
  clotheType: string;
  clotheColor: string;
  eyeType: string;
  eyebrowType: string;
  mouthType: string;
  skinColor: string;
}

export function defaultAvatarParams(name: string): AvatarParams {
  const palettes = ["Black", "Brown", "Blonde", "Red", "PastelPink"];
  let hash = 0;
  for (const character of name) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return {
    avatarStyle: "Circle",
    topType: "ShortHairShortFlat",
    accessoriesType: "Blank",
    hatColor: "Black",
    hairColor: palettes[Math.abs(hash) % palettes.length],
    facialHairType: "Blank",
    facialHairColor: "Brown",
    clotheType: "ShirtCrewNeck",
    clotheColor: "Blue03",
    eyeType: "Default",
    eyebrowType: "Default",
    mouthType: "Smile",
    skinColor: "Light",
  };
}
