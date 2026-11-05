import React from "react";
import { parseAvatarKey, getPresetById } from "./avatar-catalog";
import styles from "./page.module.css";

interface ProfileAvatarProps {
  name: string;
  avatarUrl?: string | null;
  toneClass?: string;
  size?: "sm" | "md" | "lg" | "xl";
  className?: string;
  showInitialFallback?: boolean;
}

export function ProfileAvatar({
  name,
  avatarUrl,
  toneClass = styles.toneBlue,
  size = "md",
  className = "",
  showInitialFallback = true
}: ProfileAvatarProps) {
  const { isPreset, presetId, url } = parseAvatarKey(avatarUrl);
  const initial = name.trim().charAt(0).toLocaleUpperCase("pt-BR") || "?";
  const preset = isPreset ? getPresetById(presetId) : null;

  const iconSizes = {
    sm: 20,
    md: 44,
    lg: 60,
    xl: 76
  };

  const iconSize = iconSizes[size];

  if (preset) {
    return (
      <span className={`${styles.avatar} ${toneClass} ${className}`} aria-hidden="true">
        <span className={styles.avatarIconWrapper}>
          {preset.renderIcon({ size: iconSize })}
        </span>
      </span>
    );
  }

  if (url) {
    return (
      <span className={`${styles.avatar} ${toneClass} ${className}`} aria-hidden="true">
        <img
          src={url}
          alt={name}
          className={styles.avatarImage}
          onError={(e) => {
            // fallback if image fails
            e.currentTarget.style.display = "none";
          }}
        />
      </span>
    );
  }

  return (
    <span className={`${styles.avatar} ${toneClass} ${className}`} aria-hidden="true">
      {showInitialFallback && <strong className={styles.avatarLetter}>{initial}</strong>}
    </span>
  );
}
