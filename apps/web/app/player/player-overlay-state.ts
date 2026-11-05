export interface PlayerOverlayState {
  readonly controlsVisible: boolean;
  readonly locked: boolean;
  readonly lockVisible: boolean;
}

export type PlayerOverlayEvent =
  | { readonly type: "backgroundTap" }
  | { readonly type: "lock" }
  | { readonly type: "unlock" }
  | { readonly type: "lockIdle" };

export function reducePlayerOverlay(state: PlayerOverlayState, event: PlayerOverlayEvent): PlayerOverlayState {
  if (event.type === "lock") return { controlsVisible: false, locked: true, lockVisible: true };
  if (event.type === "unlock") return { controlsVisible: true, locked: false, lockVisible: false };
  if (event.type === "lockIdle") return { ...state, lockVisible: false };
  if (state.locked) return { ...state, lockVisible: !state.lockVisible };
  return { ...state, controlsVisible: !state.controlsVisible };
}
