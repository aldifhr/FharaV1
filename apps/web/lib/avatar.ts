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

const FALLBACK_COLORS = [
  "bg-rose-500", "bg-amber-500", "bg-emerald-500", "bg-sky-500",
  "bg-violet-500", "bg-pink-500", "bg-teal-500",
];

export function avatarUrl(p: AvatarParams): string {
  const q = new URLSearchParams(p as unknown as Record<string, string>);
  return `https://avataaars.io/?${q.toString()}`;
}

export function fallbackColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return FALLBACK_COLORS[Math.abs(h) % FALLBACK_COLORS.length];
}

export function initials(name: string): string {
  return name.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase();
}
