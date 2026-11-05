import { nextEpisodePromptStart, type SkipBlock } from "./pulos/skip-segments";

interface UpdateContext {
  lowPower: boolean;
  visible: boolean;
  playing: boolean;
  skipBlocks: readonly SkipBlock[];
  hasNext: boolean;
  duration: number;
}

/** Mantém contagens e transições pontuais; reduz apenas as atualizações escondidas ociosas. */
export function shouldPublishPlayerPosition(previous: number, current: number, context: UpdateContext): boolean {
  if (!context.lowPower || context.visible || !context.playing || current < previous || current - previous >= 5) return true;
  if (context.skipBlocks.some((block) =>
    (current >= block.start - 1 && current <= block.end + 1) ||
    (previous < block.start && current > block.end))) return true;
  const promptStart = context.hasNext ? nextEpisodePromptStart(context.skipBlocks, context.duration) : null;
  return promptStart !== null && current >= promptStart - 1;
}
