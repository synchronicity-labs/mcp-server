import { z } from 'zod';

const REFERRAL_PATTERN = '^[a-z][a-z0-9_-]{0,31}$';
const referralSource = z.string().trim().toLowerCase().regex(new RegExp(REFERRAL_PATTERN));

/** Optional, self-reported directory slug. Never infer it from the connecting client. */
export function telemetryReferralSource(value: unknown): string | undefined {
  const parsed = referralSource.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

const referralEventSchema = z.object({
  properties: z.object({
    event: z.object({ const: z.string() }),
    properties: z.object({
      properties: z.object({
        referral_source: z.object({
          type: z.literal('string'),
          pattern: z.literal(REFERRAL_PATTERN),
        }),
      }),
      required: z.array(z.string()).optional(),
    }),
  }),
});
const collectorSchema = z.object({
  properties: z.object({
    events: z.object({ items: z.object({ oneOf: z.array(referralEventSchema) }) }),
  }),
});

/** Older collectors reject entire batches containing an unknown property. */
export function collectorAcceptsReferral(schema: unknown): boolean {
  const parsed = collectorSchema.safeParse(schema);
  if (!parsed.success) return false;
  const variants = parsed.data.properties.events.items.oneOf;
  return ['mcp_session_initialized', 'mcp_tool_called'].every((event) =>
    variants.some(
      ({ properties }) =>
        properties.event.const === event &&
        !properties.properties.required?.includes('referral_source'),
    ),
  );
}
