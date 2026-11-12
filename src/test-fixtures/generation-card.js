const assetId = '00000000-0000-4000-8000-000000000004';
export const thumbnailUrl = 'https://fixture.invalid/thumbnail.svg?Signature=a%2Fb';
export const cardSource = {
  model: 'sync-3',
  input: [{ type: 'video', assetId }],
  // Older progress responses omit stage. The packaged card must still show
  // their measured percentage, just as jobs_wait has always done.
  progress: { percent: 40, completedTasks: 2, runningTasks: 1, waitingTasks: 2 },
};
export const thumbnailResponse = {
  contentType: 'image/svg+xml',
  body: '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="steelblue"/></svg>',
};
export function cardContextResponse(path, projectId, generationId) {
  const value = {
    [`/v2/projects/${projectId}`]: { id: projectId, name: 'Product launch' },
    [`/v2/assets/${assetId}`]: {
      id: assetId,
      name: 'launch.mp4',
      thumbnailUrl,
      durationSeconds: 47,
    },
    [`/v2/generations/${generationId}/dubbing`]: {
      dubbing: { sourceLang: 'en', targetLang: 'de', startedWithGeneration: true },
    },
  }[path];
  return value ? Response.json(value) : undefined;
}
