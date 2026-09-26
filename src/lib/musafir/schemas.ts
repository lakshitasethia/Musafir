/**
 * Canonical Musafir contracts (CLAUDE.md §6).
 *
 * Deviations from the spec text, required by zod v4:
 *  - `z.record(z.any())` → `z.record(z.string(), z.unknown())` (v4 records need a key schema).
 *  - UUIDs use `z.uuid()`, which in v4 enforces RFC 9562 variant bits
 *    (crypto.randomUUID() output always passes).
 */
import { z } from "zod";

export const HHMM_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

export const GeoLocationSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  neighborhood: z.string().optional(),
  city: z.string(),
});

export const NodeCategorySchema = z.enum([
  "CULTURE",
  "DINING",
  "NATURE",
  "TRANSIT",
  "LEISURE",
  "ACCOMMODATION",
]);

export const NodeTypeSchema = z.enum(["HARD", "SOFT"]);

export const ItineraryNodeSchema = z.object({
  id: z.uuid(),
  type: NodeTypeSchema, // HARD = locked reservation; SOFT = elastic/swappable
  title: z.string(),
  nativeTitle: z.string().optional(),
  nativeAddress: z.string().optional(),
  category: NodeCategorySchema,
  location: GeoLocationSchema,
  timeSlot: z.object({
    start: z.string().regex(HHMM_REGEX), // "HH:MM"
    durationMinutes: z.number().int().positive(),
    bufferMinutes: z.number().int().nonnegative().default(15),
  }),
  isOutdoor: z.boolean().default(false),
  costEstimate: z.object({
    amount: z.number().nonnegative(),
    currency: z.string().default("USD"),
  }),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const TransitModeSchema = z.enum(["WALK", "SUBWAY", "BUS", "CAB"]);

export const TransitSegmentSchema = z.object({
  fromNodeId: z.uuid(),
  toNodeId: z.uuid(),
  mode: TransitModeSchema,
  durationMinutes: z.number().int().nonnegative(),
  distanceMeters: z.number().nonnegative(),
  fatigueScore: z.number().min(0).max(100), // Deterministically calculated
});

export const DayScheduleSchema = z.object({
  dayIndex: z.number().int().positive(),
  date: z.string(), // "YYYY-MM-DD"
  nodes: z.array(ItineraryNodeSchema),
  transitSegments: z.array(TransitSegmentSchema),
  dailyFatigueScore: z.number().min(0).max(100),
});

export const VibeConfigSchema = z.object({
  pacing: z.number().min(0).max(1), // 0: Slow, 1: Fast
  budget: z.number().min(0).max(1),
  culturalDepth: z.number().min(0).max(1),
  circadian: z.number().min(0).max(1), // 0: Morning, 1: Night
});

export const TripStateSchema = z.object({
  id: z.uuid(),
  userId: z.string(),
  destination: z.string(),
  dateRange: z.object({
    start: z.string(),
    end: z.string(),
  }),
  vibeConfig: VibeConfigSchema,
  dietaryRestrictions: z.array(z.string()).default([]),
  schedule: z.array(DayScheduleSchema),
  version: z.number().int().default(1),
});

// Atomic RFC 6902-style Patch Schema for Zero-Latency Mutations
export const TripPatchSchema = z.object({
  patchId: z.uuid(),
  targetDayIndex: z.number().int(),
  operation: z.enum(["REPLACE", "INSERT", "REMOVE", "SHIFT_TIME"]),
  nodeId: z.uuid().optional(),
  payload: ItineraryNodeSchema.optional(),
  shiftOffsetMinutes: z.number().int().optional(),
  reason: z.string(),
});

export const ActionCardPayloadSchema = z.object({
  id: z.uuid(),
  urgency: z.enum(["INFO", "RECOMMENDATION", "CRITICAL"]),
  headline: z.string(),
  contextSnippet: z.string(),
  proposedAction: z.string(),
  patch: TripPatchSchema,
  secondaryOption: TripPatchSchema.optional(),
});

export type GeoLocation = z.infer<typeof GeoLocationSchema>;
export type NodeCategory = z.infer<typeof NodeCategorySchema>;
export type ItineraryNode = z.infer<typeof ItineraryNodeSchema>;
export type ItineraryNodeInput = z.input<typeof ItineraryNodeSchema>;
export type TransitMode = z.infer<typeof TransitModeSchema>;
export type TransitSegment = z.infer<typeof TransitSegmentSchema>;
export type DaySchedule = z.infer<typeof DayScheduleSchema>;
export type DayScheduleInput = z.input<typeof DayScheduleSchema>;
export type VibeConfig = z.infer<typeof VibeConfigSchema>;
export type TripState = z.infer<typeof TripStateSchema>;
export type TripPatch = z.infer<typeof TripPatchSchema>;
export type ActionCardPayload = z.infer<typeof ActionCardPayloadSchema>;
