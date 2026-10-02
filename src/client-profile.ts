export type ClientProfile = Readonly<{
  name: 'chatgpt' | 'codex' | 'claude' | 'generic';
  supportsAppUi: boolean;
  supportsUploads: boolean;
  defaultProjectName: string;
}>;

const GENERIC: ClientProfile = Object.freeze({
  name: 'generic',
  supportsAppUi: false,
  supportsUploads: false,
  defaultProjectName: 'Sync generations',
});
const CHATGPT: ClientProfile = Object.freeze({
  name: 'chatgpt',
  supportsAppUi: true,
  supportsUploads: true,
  defaultProjectName: 'ChatGPT generations',
});
const CODEX: ClientProfile = Object.freeze({
  name: 'codex',
  supportsAppUi: true,
  // The hosted OpenAI connector supplies validated fileParams for this client too.
  // Keep its project default separate without rejecting those files by host name.
  supportsUploads: true,
  defaultProjectName: 'Sync generations',
});
const CLAUDE: ClientProfile = Object.freeze({
  name: 'claude',
  supportsAppUi: false,
  supportsUploads: false,
  defaultProjectName: 'Claude generations',
});

/** Presentation only. These untrusted handshake names never grant permissions. */
export function resolveClientProfile(name?: string): ClientProfile {
  switch (name?.toLowerCase()) {
    case 'chatgpt':
    case 'openai':
    case 'openai-chatgpt':
    case 'openai-mcp':
      return CHATGPT;
    case 'openai-mcp (codex)':
      return CODEX;
    case 'claude':
    case 'claude-ai':
      return CLAUDE;
    // Muse remains generic until Meta documentation or a real handshake verifies its alias.
    default:
      return GENERIC;
  }
}

export const UNSUPPORTED_UPLOAD_MESSAGE =
  'This client does not support the ChatGPT file bridge or upload widget. Upload in authenticated Sync, use Copy ID as imageAssetId, videoAssetId or audioAssetId in the same organization, or pass a public/Sync-hosted URL to create-lipsync.';
