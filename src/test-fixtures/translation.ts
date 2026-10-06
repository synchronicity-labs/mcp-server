export const translationSpec = {
  openapi: '3.0.0',
  paths: {
    '/v2/generate/estimate-cost': {
      post: {
        operationId: 'GenerateController_estimateCost',
        tags: ['Generate'],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['model', 'duration'],
                properties: {
                  model: { type: 'string' },
                  duration: { type: 'number', exclusiveMinimum: 0 },
                  fps: { type: 'number', exclusiveMinimum: 0 },
                  workflow: { type: 'string', enum: ['lipsync', 'translate-and-dub'] },
                },
              },
            },
          },
        },
      },
    },
    '/v2/generate': {
      post: {
        operationId: 'GenerateController_createGeneration',
        tags: ['Generate'],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  dubParams: { allOf: [{ $ref: '#/components/schemas/DubDto' }] },
                },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      DubDto: {
        type: 'object',
        required: ['targetLang'],
        properties: {
          targetLang: { type: 'string', enum: ['es', 'fr', 'ja'] },
          sourceLang: { type: 'string', enum: ['auto', 'en', 'es', 'fr', 'ja'] },
        },
      },
    },
  },
};
export const projectId = '00000000-0000-4000-8000-000000000001';
export const translationInput = {
  projectId,
  videoAssetId: '00000000-0000-4000-8000-000000000002',
  model: 'sync-3',
  targetLang: 'es',
  idempotencyKey: 'translation-test-1',
};
