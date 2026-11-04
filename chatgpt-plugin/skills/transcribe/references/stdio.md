# Local stdio transcription

| Operation | Tool |
| --- | --- |
| Create timed transcript | `transcriptions_create-transcription` |
| Read job | `transcriptions_get-transcription-job` |

Use a saved AUDIO/VIDEO asset via the exposed assetId adapter, or exactly one
supported Sync-hosted sourceAudioUrl/sourceVideoUrl. A public webpage or local
path is not a hosted media source. Resolve storage errors through a proper
upload/registration path.

Honor startMs/endMs/maxSourceSeconds and endpoint ceilings from the live schema.
Do not silently shorten the requested window, fabricate word IDs, or assume
speaker analysis exists merely because transcription does. When additional
speaker-analysis tools actually appear, check their schemas and account limits
before use; missing capabilities require a clear explanation.

Read the original job, with wait:true if exposed, until terminal or session
handoff. Return actual text/timed-word data. Standalone transcription does not
authorize synthesis, Edit Dialogue, or final video generation.
