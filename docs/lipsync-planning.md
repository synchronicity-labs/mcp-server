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
| `lipsync_create` and `lipsync_create-timeline` `shots` input | `options.shots` on `POST /v2/generate` | `lipsync_planning` |

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
  tools is exclusive, `shots` included. `scenes_detect` scenes and
  `lipsync_create-timeline` clips use an inclusive `endFrame`, so a clip ends at the
  timeline's `endFrame - 1`.
- Boxes are `[x1, y1, x2, y2]` in source pixels of the upright (displayed) frame.
- To select a face, pass a point (the center of its box at a frame) as
  `options.active_speaker_detection.frame_number` and `coordinates`, never the boxes.
  In a segment override (a timeline clip's `speaker`), the frame counts from the
  segment's first frame.

There is no tool for face boxes as a generation input: boxes passed to a generation
lower its quality.

## `shots` on lipsync_create and lipsync_create-timeline

`shots` takes camelCase `{ startFrame, endFrame }` like the timeline's (the timeline's
own shots plus the jump cuts it missed) and sends `options.shots` with `start_frame`
and `end_frame`. It replaces the pipeline's own shot detection, which misses jump cuts.
Pipeline tests set two rules:

- Every shot boundary must be a real cut. A boundary in mid-shot makes the mouth jump,
  and a shot that starts a few frames before a real cut gets the wrong face there.
- The shot list counts frames from 0 at the video's first frame, also when the request
  has clips, and its `endFrame` is exclusive. A timeline clip's `endFrame` is
  inclusive, so a clip that ends where a shot ends has `endFrame` one less than the
  shot's. The timeline tool's `shots` description says so in capitals.

On `lipsync_create-timeline` the shots travel with the clips (`segments`). An agent
sends both because one clip can then cover a speaker's whole turn across several cuts,
which means fewer clip ends.

The tools refuse, before creating a project, an empty list, more than 2000 shots, a
first shot not starting at 0, a gap or overlap, an empty shot and, on
`lipsync_create`, an image input. The API decides the rest, such as the model. It
also refuses `shots` together with studio-1 tuning settings
(`extra_services_options`), because the pipeline ignored the shot list when both were
sent; the MCP tools do not check this, and their `options` do not offer those
settings.

`PARAMETER_FEATURES` in `src/account-features.ts` hides a gated input from
`tools/list` for organizations without the feature, by name and by a renamed tool's
old name (app profiles list `create-lipsync` too). The ChatGPT descriptors drop
gated inputs for every account, so its reviewed listing does not change and ChatGPT
listings never read features. A gated input must be optional.
