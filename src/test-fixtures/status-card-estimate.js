/** A fallback completion estimate made at `serverNow`, finishing 125 seconds later. */
export const estimateFrom = (serverNow) => ({
  estimatedDurationSeconds: 125,
  estimatedAt: new Date(serverNow).toISOString(),
  calibrationAsOf: new Date(serverNow).toISOString(),
  supportAt: new Date(serverNow + 1200000).toISOString(),
  estimatorVersion: 'fixture',
  confidence: 'fallback',
  source: 'fallback',
  sampleCount: 0,
  scope: 'non_studio',
  durationBand: 'fixture',
  resolutionBand: 'fixture',
  resolutionSource: 'unknown',
  serverTime: new Date(serverNow).toISOString(),
  estimatedFinishAt: new Date(serverNow + 125000).toISOString(),
  delayedAt: new Date(serverNow + 600000).toISOString(),
});
