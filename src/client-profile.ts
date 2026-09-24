export type ClientProfile = Readonly<{
  name: 'chatgpt' | 'claude' | 'generic';
  supportsUploads: boolean;
  defaultProjectName: string;
}>;

const GENERIC: ClientProfile = Object.freeze({
  name: 'generic',
  supportsUploads: false,
  defaultProjectName: 'Sync generations',
});
const CHATGPT: ClientProfile = Object.freeze({
  name: 'chatgpt',
  supportsUploads: true,
  defaultProjectName: 'ChatGPT generations',
});
const CLAUDE: ClientProfile = Object.freeze({
  name: 'claude',
  supportsUploads: false,
  defaultProjectName: 'Claude generations',
});

/** Presentation only. These untrusted handshake names never grant permissions. */
export function resolveClientProfile(name?: string): ClientProfile {
  switch (name?.toLowerCase()) {
    case 'chatgpt':
    case 'openai':
    case 'openai-chatgpt':
      return CHATGPT;
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
