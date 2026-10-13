// Cost per turn from usage × prices in docs/API-NOTES.md. T7 fills in the usage parsing.
import type { RunConfig } from "../shared/config.ts";
import type { Usage } from "../shared/protocol.ts";

export function computeCost(_config: RunConfig, _usage: Usage): number {
  return 0;
}
