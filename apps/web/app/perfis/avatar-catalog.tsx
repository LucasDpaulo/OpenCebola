import React from "react";

export type AvatarPresetId =
  | "popcorn"
  | "film"
  | "clapper"
  | "gamepad"
  | "rocket"
  | "robot"
  | "cat"
  | "ghost"
  | "alien"
  | "crown"
  | "star"
  | "heart"
  | "headphones"
  | "sunglasses"
  | "pizza"
  | "sparkles";

export interface AvatarPreset {
  id: AvatarPresetId;
  label: string;
  renderIcon: (props: { size?: number }) => React.ReactElement;
}

export const AVATAR_PRESETS: readonly AvatarPreset[] = [
  {
    id: "popcorn",
    label: "Pipoca",
    renderIcon: ({ size = 24 }) => (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M18 8a3 3 0 0 0-3-3 3 3 0 0 0-6 0 3 3 0 0 0-3 3" />
        <path d="M6 8v11a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8" />
        <line x1="10" y1="12" x2="10" y2="17" />
        <line x1="14" y1="12" x2="14" y2="17" />
      </svg>
    )
  },
  {
    id: "film",
    label: "Cinema",
    renderIcon: ({ size = 24 }) => (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18" />
        <line x1="7" y1="2" x2="7" y2="22" />
        <line x1="17" y1="2" x2="17" y2="22" />
        <line x1="2" y1="12" x2="22" y2="12" />
        <line x1="2" y1="7" x2="7" y2="7" />
        <line x1="2" y1="17" x2="7" y2="17" />
        <line x1="17" y1="17" x2="22" y2="17" />
        <line x1="17" y1="7" x2="22" y2="7" />
      </svg>
    )
  },
  {
    id: "clapper",
    label: "Claquete",
    renderIcon: ({ size = 24 }) => (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 11v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8H4z" />
        <path d="m4 11 16-6v2L4 13v-2z" />
        <path d="m8 5 3 4" />
        <path d="m14 3 3 4" />
      </svg>
    )
  },
  {
    id: "gamepad",
    label: "Gamer",
    renderIcon: ({ size = 24 }) => (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="6" y1="12" x2="10" y2="12" />
        <line x1="8" y1="10" x2="8" y2="14" />
        <line x1="15" y1="13" x2="15.01" y2="13" />
        <line x1="18" y1="11" x2="18.01" y2="11" />
        <rect x="2" y="6" width="20" height="12" rx="6" />
      </svg>
    )
  },
  {
    id: "rocket",
    label: "Foguete",
    renderIcon: ({ size = 24 }) => (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
        <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
        <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
        <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
      </svg>
    )
  },
  {
    id: "robot",
    label: "Robô",
    renderIcon: ({ size = 24 }) => (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="11" width="18" height="10" rx="2" />
        <circle cx="12" cy="5" r="2" />
        <path d="M12 7v4" />
        <line x1="8" y1="16" x2="8.01" y2="16" strokeWidth="3" />
        <line x1="16" y1="16" x2="16.01" y2="16" strokeWidth="3" />
      </svg>
    )
  },
  {
    id: "cat",
    label: "Gatinho",
    renderIcon: ({ size = 24 }) => (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 5c-4.4 0-8 3.6-8 8a8 8 0 0 0 16 0c0-4.4-3.6-8-8-8z" />
        <path d="m5 6 3 3" />
        <path d="m19 6-3 3" />
        <circle cx="9" cy="13" r="1" fill="currentColor" />
        <circle cx="15" cy="13" r="1" fill="currentColor" />
        <path d="m12 15 .5.5.5-.5" />
      </svg>
    )
  },
  {
    id: "ghost",
    label: "Fantasma",
    renderIcon: ({ size = 24 }) => (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 10h.01" />
        <path d="M15 10h.01" />
        <path d="M12 2a8 8 0 0 0-8 8v12l3-3 2.5 2.5L12 19l2.5 2.5L17 19l3 3V10a8 8 0 0 0-8-8z" />
      </svg>
    )
  },
  {
    id: "alien",
    label: "Alien",
    renderIcon: ({ size = 24 }) => (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2C6.5 2 2 6.5 2 12c0 4.5 4 9.5 10 10s10-5.5 10-10c0-5.5-4.5-10-10-10z" />
        <ellipse cx="8" cy="11" rx="2" ry="3" fill="currentColor" />
        <ellipse cx="16" cy="11" rx="2" ry="3" fill="currentColor" />
        <path d="M11 17h2" />
      </svg>
    )
  },
  {
    id: "crown",
    label: "Coroa",
    renderIcon: ({ size = 24 }) => (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="m2 4 3 12h14l3-12-6 7-4-7-4 7-6-7zm3 16h14" />
      </svg>
    )
  },
  {
    id: "star",
    label: "Estrela",
    renderIcon: ({ size = 24 }) => (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
      </svg>
    )
  },
  {
    id: "heart",
    label: "Coração",
    renderIcon: ({ size = 24 }) => (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
      </svg>
    )
  },
  {
    id: "headphones",
    label: "Fones",
    renderIcon: ({ size = 24 }) => (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3" />
      </svg>
    )
  },
  {
    id: "sunglasses",
    label: "Estiloso",
    renderIcon: ({ size = 24 }) => (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2 10h20" />
        <path d="M3 10c0 4 2 6 5 6s5-2 5-6" />
        <path d="M11 10c0 4 2 6 5 6s5-2 5-6" />
        <path d="M4 10V6" />
        <path d="M20 10V6" />
      </svg>
    )
  },
  {
    id: "pizza",
    label: "Pizza",
    renderIcon: ({ size = 24 }) => (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M15 11h.01" />
        <path d="M11 15h.01" />
        <path d="M16 16h.01" />
        <path d="m2 16 20 6-6-20A20 20 0 0 0 2 16Z" />
      </svg>
    )
  },
  {
    id: "sparkles",
    label: "Brilho",
    renderIcon: ({ size = 24 }) => (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z" />
      </svg>
    )
  }
];

export function getPresetById(id: string | null | undefined): AvatarPreset | null {
  if (!id) return null;
  const normalized = id.startsWith("preset:") ? id.slice(7) : id;
  return AVATAR_PRESETS.find((p) => p.id === normalized) ?? null;
}

export function formatPresetKey(id: AvatarPresetId): string {
  return `preset:${id}`;
}

export function parseAvatarKey(avatarUrl: string | null | undefined): {
  isPreset: boolean;
  presetId: AvatarPresetId | null;
  url: string | null;
} {
  if (!avatarUrl) return { isPreset: false, presetId: null, url: null };
  if (avatarUrl.startsWith("preset:")) {
    const presetId = avatarUrl.slice(7) as AvatarPresetId;
    const preset = getPresetById(presetId);
    if (preset) return { isPreset: true, presetId: preset.id, url: null };
  }
  const preset = getPresetById(avatarUrl);
  if (preset) return { isPreset: true, presetId: preset.id, url: null };

  return { isPreset: false, presetId: null, url: avatarUrl };
}
