import type { MediaType } from "@cebola/contracts";

export interface LibraryItem {
  readonly id: string;
  readonly householdId: string;
  readonly profileId: string;
  readonly addonId: string;
  readonly mediaId: string;
  readonly mediaType: MediaType;
  readonly name: string;
  readonly posterUrl: string | null;
  readonly backgroundUrl: string | null;
  readonly description: string | null;
  readonly releaseInfo: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export class LibraryDomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidLibraryItemError extends LibraryDomainError {}

export class LibraryItemNotFoundError extends LibraryDomainError {
  constructor(mediaType: MediaType, mediaId: string) {
    super(`Library item ${mediaType}/${mediaId} was not found`);
  }
}

export function normalizedLibraryText(
  value: string,
  field: string,
  maximumLength: number
): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximumLength) {
    throw new InvalidLibraryItemError(`${field} is invalid`);
  }
  return normalized;
}

export function normalizedLibraryMediaId(value: string): string {
  const normalized = normalizedLibraryText(value, "mediaId", 255);
  if (/[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new InvalidLibraryItemError("mediaId is invalid");
  }
  return normalized;
}

export function libraryOptionalText(
  value: string | null,
  field: string,
  maximumLength: number
): string | null {
  if (value === null) return null;
  if (value.length > maximumLength) {
    throw new InvalidLibraryItemError(`${field} is invalid`);
  }
  return value;
}

export function libraryHttpsUrl(value: string | null, field: string): string | null {
  if (value === null) return null;
  if (value.length > 2_048) throw new InvalidLibraryItemError(`${field} is invalid`);
  try {
    if (new URL(value).protocol !== "https:") {
      throw new InvalidLibraryItemError(`${field} is invalid`);
    }
  } catch (error) {
    if (error instanceof InvalidLibraryItemError) throw error;
    throw new InvalidLibraryItemError(`${field} is invalid`);
  }
  return value;
}
