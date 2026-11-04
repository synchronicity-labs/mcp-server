# Raw dialogue jobs over stdio

The guided workflow in SKILL.md is preferred. Raw jobs are available only when
actually advertised by a local stdio server; they do not replace the hosted
preview/quote/final workflow or unlock whole-script and multi-speaker edits.

| Operation | Tool |
| --- | --- |
| Submit a timed dialogue edit | `dialogue-edits_create-dialogue-edit` |
| Recover its existing job | `dialogue-edits_get-dialogue-edit-job` |

Use the live input schema, a verified saved source and transcript, and only the
user's approved edits. Obtain original-voice permission and spending approval
under the same rules as the guided workflow. Persist the API admission key and
unchanged request before creation. The generated tool forwards idempotencyKey
in the API's Idempotency-Key header; it is not part of the JSON body.

Retain the returned job ID and poll that job. Do not confuse this raw job ID,
the completed dialogue edit ID and a final video generation ID. Follow the
returned status and errors; a pending or partial edit is not a completed video.
For uncertain delivery, reconcile the known job first and reuse the same key
only when permitted. Stop after one uncertain reconciliation attempt.
