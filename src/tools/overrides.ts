type ToolOverride = {
  description: string;
};

const TOOL_OVERRIDES: Record<string, ToolOverride> = {
  'generate_create-generation': {
    description:
      'Create a lipsync video. Provide video + audio inputs (URLs or asset IDs). Returns a generation ID — poll with get-generation until status is COMPLETED.',
  },
  'generate_get-generation': {
    description:
      'Get generation status/result by ID. Poll until status is COMPLETED. Result includes output video URL.',
  },
  'generations_get-generations': {
    description: 'List generations for the current organization. Supports pagination.',
  },
  generations_estimate: {
    description: 'Estimate the cost of a generation before creating it. Returns estimated credits.',
  },
  'assets_get-all': {
    description: 'List all assets (videos, audio files) in the current organization.',
  },
  assets_get: {
    description: 'Get a specific asset by ID. Returns asset details and URL.',
  },
  'models_get-public': {
    description:
      'List all available lipsync models. Use this to discover model IDs for generation.',
  },
  'generate_get-generations': {
    description: 'List recent generations. Use to find generation IDs or check batch status.',
  },
};

export function getOverride(toolName: string): ToolOverride | undefined {
  return TOOL_OVERRIDES[toolName];
}
