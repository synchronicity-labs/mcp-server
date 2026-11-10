import type { JsonSchema } from '../openapi/types.js';

export function referralCollectorSchema(
  events = ['mcp_session_initialized', 'mcp_tool_called'],
  referral: JsonSchema = { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,31}$' },
  required?: string[],
) {
  return {
    type: 'object',
    properties: {
      events: {
        type: 'array',
        items: {
          oneOf: events.map((event) => ({
            type: 'object',
            properties: {
              event: { const: event },
              properties: {
                type: 'object',
                properties: { referral_source: referral },
                ...(required && { required }),
              },
            },
          })),
        },
      },
    },
  };
}
