# Lipsync planning

Tools for an agent that plans a lipsync from Sync's own face and speaker analysis of
a video: which faces are where, the camera shots, and who talks when. Like
`scenes_detect` and `stems_separate` ([Tool workflows](tool-workflows.md#scenes-and-stems-organizations-with-the-feature)),
they call internal API routes behind server flags, are listed only to organizations
whose `GET /v2/account` `features` name the feature, and never in the ChatGPT app
listing. A call is not refused when the tool is hidden; a disabled flag's bare 404
comes back as `feature_not_enabled`.

| Tool | API | Feature |
| --- | --- | --- |
| `faces_detect` | `GET /v2/assets/{id}/faces?frame=0`, then `POST /v2/assets/{id}/faces` | `face_validation` |
| `faces_get` | `GET /v2/assets/{id}/faces` | `face_validation` |
| `faces_get-timeline` | `GET /v2/assets/{id}/faces/timeline` | `lipsync_planning` |
| `lipsync_create` `shots` input | `options.shots` on `POST /v2/generate` | `lipsync_planning` |

`faces_detect` reads the status first and starts an analysis only when there is none
or the last one failed, because the start route allows 20 calls in 10 minutes; it
waits by reading. A status read must name frames, so it reads frame 0 and returns
the status without it. An organization runs at most two analyses at a time (429).

`faces_get` reads one `frame`, or `startFrame` and exclusive `endFrame` at most 250
frames apart. `faces_get-timeline` returns `shots`, `tracks`, `talking` and `voices`
as the API stores them. Each `talking` range carries a `point` that selects its face
(null when no visible face talks), so a plan needs `faces_get` only for other frames.

## Conventions the descriptions teach

- Frames count from 0 at the video's first frame, and every `endFrame` of these
  tools is exclusive. `scenes_detect` scenes and `lipsync_create-timeline` clips use
  an inclusive `endFrame`, so a clip ends at the timeline's `endFrame - 1`.
- Boxes are `[x1, y1, x2, y2]` in source pixels of the upright (displayed) frame.
- To select a face, pass a point (the center of its box at a frame) as
  `options.active_speaker_detection.frame_number` and `coordinates`, never the boxes.
  In a segment override (a timeline clip's `speaker`), the frame counts from the
  segment's first frame.

There is no tool for face boxes as a generation input: boxes passed to a generation
lower its quality.

## `shots` on lipsync_create

`shots` takes camelCase `{ startFrame, endFrame }` like the timeline's (the timeline's
own shots plus the jump cuts it missed; every boundary a real cut) and sends
`options.shots` with `start_frame` and `end_frame`. It replaces the pipeline's own
shot detection, which misses jump cuts. The tool refuses, before creating a project,
an empty list, more than 2000 shots, a first shot not starting at 0, a gap or
overlap, an empty shot and an image input; the API decides the rest (model, and
`segments`, which `lipsync_create` never sends). `lipsync_create-timeline` has no
`shots`, since its clips are `segments`.

`PARAMETER_FEATURES` in `src/account-features.ts` hides a gated input from
`tools/list` for organizations without the feature, by name and by a renamed tool's
old name (app profiles list `create-lipsync` too). The ChatGPT descriptors drop
gated inputs for every account, so its reviewed listing does not change and ChatGPT
listings never read features. A gated input must be optional.
