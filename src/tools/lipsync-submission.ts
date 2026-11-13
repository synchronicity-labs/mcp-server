// Picks the source the way resolveMedia does. A ChatGPT file is named by its file_id;
// its download_url changes on every call.
function mediaIdentity(url: unknown, assetId: unknown, file: unknown): unknown {
  if (assetId) return ['asset', assetId];
  if (url) return ['url', url];
  if (file && typeof file === 'object' && 'file_id' in file) return ['file', file.file_id];
  return file;
}

/**
 * What makes two lipsync_create calls the same request, ignoring keys and new-project
 * names. The client is part of it because each client has its own default project.
 */
export function lipsyncSubmission(
  args: Record<string, unknown>,
  model: string,
  options: unknown,
  client: string,
): unknown[] {
  return [
    client,
    mediaIdentity(args.videoUrl, args.videoAssetId, args.video),
    mediaIdentity(args.imageUrl, args.imageAssetId, args.image),
    mediaIdentity(args.audioUrl, args.audioAssetId, args.audio),
    args.script,
    args.voiceId,
    args.provider,
    args.stability,
    args.similarityBoost,
    model,
    options,
    args.projectId,
    args.continuation,
    args.speakers,
    args.allowOverlappingFaces,
  ];
}
