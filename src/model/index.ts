export * from "./evidence.ts";
export * from "./sources.ts";
export * from "./infrastructure.ts";
export * from "./signalling.ts";
export * from "./timetable.ts";
export * from "./control.ts";
export * from "./signalEvidence.ts";
export * from "./playableArea.ts";

import { z } from "zod";
import { Infrastructure } from "./infrastructure.ts";
import { Signalling } from "./signalling.ts";
import { Control } from "./control.ts";
import { TimetableSnapshot, TimingPointMapping } from "./timetable.ts";

/** Everything needed to validate or run one area. Layers stay in separate files on disk. */
export const Dataset = z.object({
  infrastructure: Infrastructure,
  signalling: Signalling,
  control: Control,
  timingPoints: z.array(TimingPointMapping),
  timetables: z.array(TimetableSnapshot),
});
export type Dataset = z.infer<typeof Dataset>;
