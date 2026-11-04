# Local stdio speech

Discover the actual local tools. Prefer `create-speech-preview` and
`get-speech-preview` when they support the request. Additional generated tools:

| Operation | Tool |
| --- | --- |
| Immediate supported TTS | `tts_create` |
| Durable speech job | `tts_create-job`, `tts_get-job` |

Use the live schema's provider, script, voice and project fields. For a durable
job requiring Idempotency-Key, persist the exposed idempotencyKey before calling;
the MCP must forward it as a header, not leave it in JSON. Reuse unchanged input
and that key only as the contract permits. Prefer durable synthesis over a
non-idempotent immediate operation when recovery matters. Never automatically
retry an uncertain immediate TTS response. Job status may use SUCCESS rather
than COMPLETED. The output format/URL must come from the response; do not promise
MP3 if the tool does not expose that format. Save existing output separately.
