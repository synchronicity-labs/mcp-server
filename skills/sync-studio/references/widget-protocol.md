# Widget protocol ownership

The widget owns these internal operations:

| Internal purpose | Tool |
| --- | --- |
| Register/acknowledge mounted view | `register-studio-view`, `ack-studio-view` |
| Save/acknowledge widget draft | `save-studio-draft`, `ack-studio-draft` |
| Widget creator-filter lookup | `get-asset-creators` |
| Private UI instrumentation | `track-chatgpt-event` |
| Widget-only saved-asset submission | `create-lipsync-from-assets` |

These are protocol support, not extra agent workflows. Do not invoke them from
conversation to manufacture a view, telemetry, a receipt, or a paid request.
A developer testing the widget may exercise them in its real protocol harness;
ordinary agent skills use the public app actions and actual published context.

Read the exact view/draft revision before a requested edit. Retain action identity
across uncertain delivery. Backend acceptance is separate from pending/applied/
blocked/failed display. Only widget acknowledgement can confirm application;
chat text and a successful API write cannot do that. Preserve stale/newer edits
and stop when a view is not mounted rather than guessing another viewId.
