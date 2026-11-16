export type ClientProfile = Readonly<{
  name: 'chatgpt' | 'codex' | 'claude' | 'generic';
  supportsAppUi: boolean;
  /**
   * Renders the MCP Apps generation status card, which checks a running generation every
   * ten seconds while visible. Set without supportsAppUi, a client gets only the card,
   * never the Studio app, its bridge tools or the ChatGPT-only instructions.
   */
  supportsStatusCard: boolean;
  supportsUploads: boolean;
  defaultProjectName: string;
}>;

const GENERIC: ClientProfile = Object.freeze({
  name: 'generic',
  supportsAppUi: false,
  supportsStatusCard: false,
  supportsUploads: false,
  defaultProjectName: 'Sync generations',
});
const CHATGPT: ClientProfile = Object.freeze({
  name: 'chatgpt',
  supportsAppUi: true,
  supportsStatusCard: true,
  supportsUploads: true,
  defaultProjectName: 'ChatGPT generations',
});
const CODEX: ClientProfile = Object.freeze({
  name: 'codex',
  supportsAppUi: true,
  supportsStatusCard: true,
  // The hosted OpenAI connector supplies validated fileParams for this client too.
  // Keep its project default separate without rejecting those files by host name.
  supportsUploads: true,
  defaultProjectName: 'Sync generations',
});
const CLAUDE: ClientProfile = Object.freeze({
  name: 'claude',
  supportsAppUi: false,
  supportsStatusCard: true,
  supportsUploads: false,
  defaultProjectName: 'Claude generations',
});

// A client we do not know by name that says it renders MCP Apps UI: it gets the cards and
// the tools that open them, and nothing else that depends on who it is.
const GENERIC_WITH_CARDS: ClientProfile = Object.freeze({ ...GENERIC, supportsStatusCard: true });

/**
 * Whether the capabilities a client sent at initialize include the MCP Apps UI extension.
 * Its exact home has moved between drafts, so the name is looked for anywhere in them.
 */
export function declaresCards(capabilities: unknown): boolean {
  return (
    typeof capabilities === 'object' &&
    capabilities !== null &&
    JSON.stringify(capabilities).includes('io.modelcontextprotocol/ui')
  );
}

/**
 * Presentation only. These untrusted handshake names never grant permissions. `rendersCards`
 * is what the client declared (declaresCards); it matters only for a name we do not know.
 */
export function resolveClientProfile(name?: string, rendersCards = false): ClientProfile {
  switch ((name ?? '').toLowerCase()) {
    case 'chatgpt':
    case 'openai':
    case 'openai-chatgpt':
    case 'openai-mcp':
      return CHATGPT;
    case 'openai-mcp (codex)':
      return CODEX;
    case 'claude':
    case 'claude-ai':
    // Claude.ai's hosted connector, as production logs record it (2026-11-06).
    case 'anthropic/claudeai':
      return CLAUDE;
    // Muse remains generic until Meta documentation or a real handshake verifies its alias.
    default:
      return rendersCards ? GENERIC_WITH_CARDS : GENERIC;
  }
}

export const UNSUPPORTED_UPLOAD_MESSAGE =
  'This client does not support the ChatGPT file bridge or upload widget. For a local file, call assets_create-upload-url, PUT the file bytes to the returned uploadUrl with the same Content-Type, register the returned url with assets_create, and pass the asset id as imageAssetId, videoAssetId or audioAssetId. Public or Sync-hosted URLs and existing Sync asset IDs also work in lipsync_create.';
