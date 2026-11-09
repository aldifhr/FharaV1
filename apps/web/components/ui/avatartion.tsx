"use client";

export interface AvatartionAvatar {
  face: number;
  hair: number;
  eyes: number;
  mouth: number;
  outfit: number;
  accessory: number;
  facialHair: number;
  bg: string;
}

const BACKGROUNDS = [
  "#f6f3ee",
  "#fbe4e4",
  "#fdeed3",
  "#ddf0d5",
  "#d9eaf7",
  "#e7dcf9",
  "#f9e0ef",
];

function hashName(name: string): number {
  let hash = 0;
  for (const character of name) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return Math.abs(hash);
}

export function avatartionFor(name: string): AvatartionAvatar {
  const hash = hashName(name);
  const pick = (max: number, salt: number) => ((hash >> salt) % max) + 1;
  return {
    face: pick(8, 0),
    hair: pick(32, 3),
    eyes: pick(6, 6),
    mouth: pick(10, 9),
    outfit: pick(25, 12),
    accessory: pick(18, 15),
    facialHair: pick(9, 18),
    bg: BACKGROUNDS[hash % BACKGROUNDS.length],
  };
}

export function randomAvatartion(): AvatartionAvatar {
  const rand = (max: number) => Math.floor(Math.random() * max) + 1;
  return {
    face: rand(8),
    hair: rand(32),
    eyes: rand(6),
    mouth: rand(10),
    outfit: rand(25),
    accessory: rand(18),
    facialHair: rand(9),
    bg: BACKGROUNDS[Math.floor(Math.random() * BACKGROUNDS.length)],
  };
}

export function deserializeAvatartion(value: unknown): AvatartionAvatar | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const toNumber = (input: unknown): number | undefined => {
    const parsed = typeof input === "string" ? Number(input) : input;
    return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : undefined;
  };
  const face = toNumber(record.face);
  const hair = toNumber(record.hair);
  const eyes = toNumber(record.eyes);
  const mouth = toNumber(record.mouth);
  const outfit = toNumber(record.outfit);
  const accessory = toNumber(record.accessory);
  const facialHair = toNumber(record.facialHair);
  if (face === undefined || hair === undefined || eyes === undefined || mouth === undefined || outfit === undefined || accessory === undefined || facialHair === undefined) {
    return null;
  }
  const bg = typeof record.bg === "string" ? record.bg : undefined;
  return {
    face: Math.min(Math.max(1, face), 8),
    hair: Math.min(Math.max(1, hair), 32),
    eyes: Math.min(Math.max(1, eyes), 6),
    mouth: Math.min(Math.max(1, mouth), 10),
    outfit: Math.min(Math.max(1, outfit), 25),
    accessory: Math.min(Math.max(1, accessory), 18),
    facialHair: Math.min(Math.max(1, facialHair), 9),
    bg: typeof bg === "string" ? bg : BACKGROUNDS[0],
  };
}

function Part({
  src,
  className,
  style,
}: {
  src: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      aria-hidden="true"
      draggable={false}
      className={className}
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", ...style }}
    />
  );
}

export function AvatartionAvatarView({
  avatar,
  className,
  rounded = "rounded-full",
}: {
  avatar: AvatartionAvatar;
  className?: string;
  rounded?: string;
}) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    <div
      className={`relative overflow-hidden ${rounded} ${className ?? ""}`}
      style={{ aspectRatio: "1 / 1", backgroundColor: avatar.bg }}
      aria-hidden="true"
    >
      <Part src={`/avatars/parts/base/Body.svg`} />
      <Part src={`/avatars/parts/hairs/Hair${pad(avatar.hair)}.svg`} />
      <Part src={`/avatars/parts/eyes/Eye${pad(avatar.eyes)}.svg`} />
      <Part src={`/avatars/parts/mouths/Mouth${pad(avatar.mouth)}.svg`} />
      <Part src={`/avatars/parts/faces/Face${pad(avatar.face)}.svg`} />
      <Part src={`/avatars/parts/outfits/Outfit${pad(avatar.outfit)}.svg`} />
      <Part src={`/avatars/parts/accessories/Accessory${pad(avatar.accessory)}.svg`} />
      <Part src={`/avatars/parts/facial-hair/FacialHair${pad(avatar.facialHair)}.svg`} />
    </div>
  );
}
