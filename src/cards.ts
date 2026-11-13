import type { ResourceMetadata } from '@modelcontextprotocol/server';
import type { SyncMcpConfig } from './config.js';
import { GENERATION_STATUS_HTML } from './generation-status-html.js';
import { GENERATION_STATUS_URI, generationStatusMetadata } from './generation-status.js';
import type { McpToolDefinition } from './tools/generator.js';

/**
 * The cards a chat shows inline, apart from the Studio app. Every card is the one packaged
 * bundle (deploy/generation-status); a card other than the generation status card is
 * named to the bundle in a meta tag. A card opens from the result of the tools listed for
 * it, and reads again through the tools its view calls.
 */
const CARDS = [
  {
    card: 'quote',
    title: 'Sync price check',
    description:
      'What a Sync generation will cost before anything is charged, what is left afterwards, and a Create button the person presses to go ahead with the quoted job.',
    tools: ['generations_estimate-cost'],
  },
  {
    card: 'shots',
    title: 'Sync shot review',
    description:
      'A finished generation cut into its shots: the person flags the shots that look wrong, renders only those again, compares each new take with the first render and builds the final video.',
    tools: ['shots_review'],
  },
  {
    card: 'jobs',
    title: 'Sync jobs',
    description:
      'Progress of a set of Sync jobs started together: how many are ready, each job’s state, and a read-only Check status action.',
    tools: ['jobs_create-many'],
  },
  {
    card: 'translation',
    title: 'Sync translated audio preview',
    description:
      'Status of one translated-audio preview and, once it is ready, playback of the translated audio beside the original.',
    tools: ['translation-previews_create'],
  },
  {
    card: 'usage',
    title: 'Sync usage and balance',
    description:
      'What the Sync organization has left to spend: credits, free allowances or the period’s metered spend, with a read-only Refresh action.',
    tools: ['account_show-usage'],
  },
  {
    card: 'voices',
    title: 'Sync voices',
    description:
      'The voices this Sync organization can use, each with a sample to play, for the person to pick one.',
    tools: ['voices_show'],
  },
  {
    card: 'recent',
    title: 'Sync recent videos',
    description:
      'The organization’s most recent Sync generations as a grid of previews, each opening in Sync.',
    tools: ['generations_show-recent'],
  },
] as const;

type Card = (typeof CARDS)[number];

const uri = (card: Card) => `ui://sync/card-${card.card}-v1.html`;
const byTool = new Map<string, Card>(
  CARDS.flatMap((card) => card.tools.map((tool) => [tool, card] as const)),
);
const CARD_URIS = new Set<string>([GENERATION_STATUS_URI, ...CARDS.map(uri)]);

/** Attaches a card to the tools whose result opens it. */
export function withCard(tool: McpToolDefinition): McpToolDefinition {
  const card = byTool.get(tool.name);
  if (!card) return tool;
  return {
    ...tool,
    meta: {
      ...tool.meta,
      ui: { ...(tool.meta?.ui as Record<string, unknown> | undefined), resourceUri: uri(card) },
      'openai/outputTemplate': uri(card),
    },
  };
}

/** Tools a card's view calls itself, beyond the read that opened it. */
const CARD_CALLED_TOOLS = new Set([
  'generations_get-costs',
  'account_get-usage',
  'jobs_get-many',
  'translation-previews_get',
  'dubbing_create',
  'lipsync_create',
  'shots_regenerate',
  'shots_splice',
]);

/**
 * A tool's card metadata for clients that render only cards: the standard MCP Apps
 * resourceUri of the card it opens, and app visibility when a card calls it, without
 * ChatGPT's openai/* keys or any other ui setting.
 */
export function cardMeta(name: string, meta: Record<string, unknown> | undefined) {
  const resourceUri = (meta?.ui as { resourceUri?: unknown } | undefined)?.resourceUri;
  const ui = {
    ...(typeof resourceUri === 'string' && CARD_URIS.has(resourceUri) ? { resourceUri } : {}),
    ...(CARD_CALLED_TOOLS.has(name) ? { visibility: ['model', 'app'] } : {}),
  };
  return Object.keys(ui).length > 0 ? { ui } : {};
}

/** Resource names of every card, the generation status card included. */
export const CARD_RESOURCE_NAMES = new Set<string>([
  'sync-generation-status',
  ...CARDS.map((card) => `sync-card-${card.card}`),
]);

/** The cards served beside the generation status card, each ready to register. */
export function cardResources(app: SyncMcpConfig['chatgptApp']) {
  const shared = generationStatusMetadata(app);
  return CARDS.map((card) => {
    const metadata: ResourceMetadata = {
      ...shared,
      title: card.title,
      description: card.description,
      _meta: { ...shared._meta, 'openai/widgetDescription': card.description },
    };
    return {
      name: `sync-card-${card.card}`,
      uri: uri(card),
      metadata,
      html: GENERATION_STATUS_HTML.replace(
        '<head>',
        `<head><meta name="sync-card" content="${card.card}">`,
      ),
    };
  });
}

const SHOWN = [
  {
    from: 'account_get-usage',
    name: 'account_show-usage',
    list: undefined,
    defaults: {},
    title: 'Show Sync usage and balance',
    description:
      'Show the person what their sync. organization has left to spend, as a card in the chat: credits, free allowances or the period’s metered spend. Use it only when the person asks to see their balance, usage, credits or plan. For your own checks before paid work, use account_get-usage, which returns the same fields without showing anything. Read-only: buys no credits, changes no plan and starts no generation.',
  },
  {
    from: 'voices_list',
    name: 'voices_show',
    list: 'voices',
    defaults: {},
    title: 'Show Sync voices',
    description:
      'Show the person the voices this organization can use, as a card where they can play each sample and pick one. Use it only when the person asks to see, hear, browse or choose a voice. To look a voice up yourself, use voices_list, which returns the same list without showing anything. When the person picks a voice, the card sends its name and id as their next message; pass that id as voiceId. Read-only.',
  },
  {
    from: 'generations_list',
    name: 'generations_show-recent',
    list: 'generations',
    defaults: { limit: 12 },
    title: 'Show recent Sync videos',
    description:
      'Show the person the organization’s most recent generations as a card of previews that open in Sync. Use it only when the person asks to see their recent videos, generations or history. To find a generation id or check what is running yourself, use generations_list, which returns the same entries without showing anything. Returns the newest 12 unless limit says otherwise. Read-only.',
  },
] as const;

/** Names of the tools that exist only to show a card. */
export const CARD_TOOL_NAMES = new Set<string>([
  ...SHOWN.map((shown) => shown.name),
  'shots_review',
]);

/**
 * Tools that show a card: each reads exactly what its source tool reads, under a name the
 * model calls only when the person asks to see it, so the source tool the model calls for
 * its own checks never puts a card in the chat.
 */
export function createCardTools(tools: McpToolDefinition[]): McpToolDefinition[] {
  return SHOWN.flatMap((shown) => {
    const source = tools.find((tool) => tool.name === shown.from);
    if (!source || source.resultFormat === 'mcp') return [];
    const { handler } = source;
    const { list, defaults } = shown;
    return [
      {
        ...source,
        name: shown.name,
        title: shown.title,
        description: shown.description,
        handler: async (args, context) => {
          const result = await handler({ ...defaults, ...args }, context);
          // A bare list has no structured content, which is all some hosts hand a card.
          return list && Array.isArray(result) ? { [list]: result } : result;
        },
      },
    ];
  });
}
