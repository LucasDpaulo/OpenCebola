export function retrySourceAfterFailure<T extends { readonly id: string }>(
  streams: readonly T[],
  failedIds: ReadonlySet<string>,
  selection: "manual" | "requested" | "automatic",
  alreadyRetried: boolean,
  choose: (remaining: readonly T[]) => T | null
): T | null {
  if (selection === "manual" || alreadyRetried) return null;
  return choose(streams.filter((stream) => !failedIds.has(stream.id)));
}

/** Grupo do release no nome da fonte: "[SubsPlease] …" (anime) ou "…-GRUPO" no fim do nome. */
export function releaseGroupOf(label: string): string | null {
  const line = label.split("\n").find((part) => part.trim().length > 0)?.trim() ?? "";
  const bracket = /^\[([^\]]{2,40})\]/.exec(line);
  if (bracket) return bracket[1]!.toLowerCase();
  const suffix = /-([A-Za-z0-9]{2,20})(?:\.(?:mkv|mp4|avi))?\s*$/.exec(line);
  return suffix ? suffix[1]!.toLowerCase() : null;
}
