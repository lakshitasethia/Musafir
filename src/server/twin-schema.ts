import { z } from "zod";
import { BASELINE } from "@/lib/musafir/twin.ts";

/** What-if knobs, bounded to physically meaningful ranges. */
export const ScenarioSchema = z
  .object({
    precipScale: z.number().min(0).max(5).default(BASELINE.precipScale),
    precipAddMm: z.number().min(0).max(80).default(BASELINE.precipAddMm),
    durationExtendH: z.number().int().min(0).max(12).default(BASELINE.durationExtendH),
    tempOffsetC: z.number().min(-15).max(15).default(BASELINE.tempOffsetC),
    gustScale: z.number().min(0).max(4).default(BASELINE.gustScale),
    flood: z.boolean().default(BASELINE.flood),
  })
  .default(BASELINE);
