import { errorText } from "../lib/errors";
import type { Profiles } from "../types/ui";
import { useInputProfiles } from "./useInputProfiles";
import { useOutputProfiles } from "./useOutputProfiles";

/** The lists while they load: one frozen array, so memoized components fed from them don't re-render meanwhile. */
const NONE: readonly never[] = Object.freeze([]);

export function useProfiles(): Profiles {
  const inputs = useInputProfiles();
  const outputs = useOutputProfiles();
  const failed = inputs.error ?? outputs.error;
  return {
    inputs: inputs.data ?? NONE,
    outputs: outputs.data ?? NONE,
    loaded: !inputs.isPending && !outputs.isPending,
    error: failed ? errorText(failed) : undefined,
  };
}
