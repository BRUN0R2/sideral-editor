import type { OutputChannelView } from "./contracts";

export type OutputChannelObservation =
  | { readonly kind: "stale"; readonly sequences: ReadonlyMap<string, number> }
  | {
      readonly kind: "update";
      readonly revealRequested: boolean;
      readonly sequences: ReadonlyMap<string, number>;
    };

export function observeOutputChannel(
  sequences: ReadonlyMap<string, number>,
  channel: OutputChannelView,
): OutputChannelObservation {
  const previousSequence = sequences.get(channel.resourceId) ?? 0;
  if (channel.revealSequence < previousSequence) {
    return { kind: "stale", sequences };
  }
  if (channel.revealSequence === previousSequence) {
    return { kind: "update", revealRequested: false, sequences };
  }
  const nextSequences = new Map(sequences);
  nextSequences.set(channel.resourceId, channel.revealSequence);
  return { kind: "update", revealRequested: true, sequences: nextSequences };
}
