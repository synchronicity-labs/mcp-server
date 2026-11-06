import { translationSpec } from './translation.js';

// An API spec that turns on every feature-gated tool, for descriptor tests. Its
// parameters carry no descriptions, as most of the public API's do, so the server's
// own text is what gets tested. The public API does describe the estimate's fps and
// workflow and the generation's dubParams, and this spec keeps that.
type Json = Record<string, unknown>;

const json = (properties: Json, required?: string[]) => ({
  content: {
    'application/json': {
      schema: { type: 'object', properties, ...(required && { required }) },
    },
  },
});
const pathParams = (...names: string[]) =>
  names.map((name) => ({ name, in: 'path', required: true, schema: { type: 'string' } }));
const queryParams = (...names: string[]) =>
  names.map((name) => ({ name, in: 'query', schema: { type: 'string' } }));
const idempotencyHeader = (required: boolean) => ({
  name: 'Idempotency-Key',
  in: 'header',
  required,
  schema: { type: 'string' },
});
const strings = (...names: string[]) =>
  Object.fromEntries(names.map((name) => [name, { type: 'string' }]));
const uuid = { type: 'string', format: 'uuid' };

// The parser keeps only operations under the API's public tags.
const TAGS: Record<string, string> = {
  Generate: 'Generate',
  Models: 'Models',
  Assets: 'Assets',
  Projects: 'Projects',
  Voices: 'Voices',
  Tts: 'Text-to-Speech',
  transcriptions: 'Transcriptions',
  'dialogue-edits': 'Dialogue Edits',
  Dubbing: 'Dubbing',
  AudioTrims: 'Audio trims',
  Batch: 'Batch',
  StudioViews: 'Projects',
  StudioDrafts: 'Projects',
  agentFeedback: 'Feedback',
};

function op(operationId: string, extra: Json = {}): Json {
  const resource = operationId.replace(/Controller_.*|_.*/, '');
  return { operationId, tags: [TAGS[resource] ?? resource], parameters: [], ...extra };
}

const assetFilters = queryParams(
  'projectId',
  'userId',
  'limit',
  'cursor',
  'searchQuery',
  'sortBy',
  'types',
);

const estimate = structuredClone(translationSpec.paths['/v2/generate/estimate-cost']);
const estimateBody: Record<string, Json> =
  estimate.post.requestBody.content['application/json'].schema.properties;
estimateBody.fps = { ...estimateBody.fps, description: 'Source video frame rate.' };
estimateBody.workflow = { ...estimateBody.workflow, description: 'Omit for lip-sync only.' };

const dialogue = (resource: 'transcriptions' | 'dialogue-edits', properties: Json) => ({
  [`/v2/${resource}`]: { post: op(`${resource}_create`, { requestBody: json(properties) }) },
  [`/v2/${resource}/{id}`]: { get: op(`${resource}_get`, { parameters: pathParams('id') }) },
});

const savedAssetDubbing = { 'x-sync-saved-asset-dubbing': 1 };
const studioView = (operationId: string) =>
  op(operationId, { parameters: pathParams('viewId'), 'x-sync-studio-views': 1 });
const studioDraft = (operationId: string, properties?: Json) =>
  op(operationId, {
    parameters: pathParams('projectId', 'draftId'),
    'x-sync-studio-drafts': 1,
    ...(properties && { requestBody: json(properties) }),
  });

const generate = structuredClone(translationSpec.paths['/v2/generate']);
const generateBody: Record<string, Json> =
  generate.post.requestBody.content['application/json'].schema.properties;
generateBody.dubParams = { ...generateBody.dubParams, description: 'Dubbing parameters.' };

export const descriptorSpec = {
  openapi: '3.0.0',
  components: translationSpec.components,
  paths: {
    '/v2/generate/estimate-cost': estimate,
    '/v2/generate': {
      ...generate,
      // A projectId filter turns on projects_list-generations.
      get: op('GenerateController_getGenerations', {
        parameters: queryParams('limit', 'projectId'),
      }),
    },
    '/v2/generate/{id}': {
      get: op('GenerateController_getGeneration', { parameters: pathParams('id') }),
    },
    '/v2/generate/{id}/costs': {
      get: op('GenerateController_getGenerationCosts', { parameters: pathParams('id') }),
    },
    '/v2/models': { get: op('ModelsController_get') },
    '/v2/voices': {
      get: op('VoicesController_getVoices', { parameters: queryParams('provider') }),
    },
    '/v2/assets': {
      get: op('AssetsController_getAll', { parameters: assetFilters }),
      post: op('AssetsController_create', {
        requestBody: json(strings('url', 'type', 'name', 'projectId', 'visibility', 'format')),
      }),
    },
    '/v2/assets/count': { get: op('AssetsController_count', { parameters: assetFilters }) },
    '/v2/assets/upload': {
      post: op('AssetsController_createUploadUrl', {
        requestBody: json(strings('fileName', 'contentType', 'size')),
      }),
    },
    '/v2/assets/{id}': {
      get: op('AssetsController_get', { parameters: pathParams('id') }),
      patch: op('AssetsController_update', {
        parameters: pathParams('id'),
        requestBody: json(strings('name', 'visibility')),
      }),
      delete: op('AssetsController_delete', { parameters: pathParams('id') }),
    },
    '/v2/assets/{id}/download': {
      get: op('AssetsController_getDownloadUrl', { parameters: pathParams('id') }),
    },
    '/v2/projects': {
      get: op('ProjectsController_getAll', {
        parameters: queryParams('limit', 'cursor', 'searchQuery', 'sortBy'),
      }),
      post: op('ProjectsController_create', { requestBody: json(strings('name', 'description')) }),
    },
    '/v2/projects/{id}': { get: op('ProjectsController_get', { parameters: pathParams('id') }) },
    ...dialogue('transcriptions', strings('sourceVideoUrl', 'projectId')),
    ...dialogue('dialogue-edits', {
      ...strings('sourceVideoUrl', 'projectId', 'voiceId'),
      transcript: { type: 'object' },
      edits: { type: 'array', items: { type: 'object' } },
    }),
    '/v2/tts/jobs': { post: op('Tts_createJob') },
    '/v2/tts/jobs/{id}': { get: op('Tts_getJob', { parameters: pathParams('id') }) },
    '/v2/audio-trims': {
      post: op('AudioTrimsController_create', {
        parameters: [idempotencyHeader(true)],
        requestBody: json({ assetId: uuid, durationSeconds: { type: 'number' } }),
      }),
    },
    '/v2/audio-trims/{id}': {
      get: op('AudioTrimsController_get', { parameters: pathParams('id') }),
    },
    '/v2/batch': { post: op('BatchController_create'), get: op('BatchController_list') },
    '/v2/batch/{id}': { get: op('BatchController_get', { parameters: pathParams('id') }) },
    '/v2/integrations/dubbing': {
      post: op('DubbingController_createDubbing', {
        ...savedAssetDubbing,
        parameters: [idempotencyHeader(false)],
        requestBody: json({
          targetLang: { type: 'string', enum: ['es', 'fr'] },
          audioAssetId: uuid,
          projectId: uuid,
        }),
      }),
    },
    '/v2/integrations/dubbing/estimate': {
      post: op('DubbingController_estimateDubbingCost', {
        ...savedAssetDubbing,
        requestBody: json({ audioAssetId: uuid, projectId: uuid }),
      }),
    },
    '/v2/integrations/dubbing/{id}': {
      get: op('DubbingController_getDubbing', {
        ...savedAssetDubbing,
        parameters: [
          ...pathParams('id'),
          { name: 'projectId', in: 'query', required: true, schema: uuid },
        ],
      }),
    },
    '/v2/studio-views/{viewId}': {
      get: studioView('StudioViewsController_get'),
      put: studioView('StudioViewsController_register'),
    },
    '/v2/studio-views/{viewId}/actions': { post: studioView('StudioViewsController_request') },
    '/v2/studio-views/{viewId}/acknowledgement': {
      post: studioView('StudioViewsController_acknowledge'),
    },
    '/v2/projects/{projectId}/studio-drafts/{draftId}': {
      get: studioDraft('StudioDraftsController_get'),
      put: studioDraft('StudioDraftsController_save', {
        expectedRevision: { type: 'integer' },
        state: { type: 'object' },
        editable: { type: 'boolean' },
      }),
    },
    '/v2/projects/{projectId}/studio-drafts/{draftId}/acknowledgement': {
      post: studioDraft('StudioDraftsController_acknowledge', { revision: { type: 'integer' } }),
    },
    '/v2/feedback': {
      post: op('agentFeedback_submit', { requestBody: json(strings('kind', 'message')) }),
    },
  },
};
