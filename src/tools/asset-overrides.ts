import type { z } from 'zod';

export type ToolOverride = {
  title?: string;
  /** Replaces the OpenAPI summary. */
  description?: string;
  outputSchema?: Record<string, z.ZodType>;
  /** Input descriptions by parameter name; they replace the spec's text. */
  params?: Record<string, string>;
};

const ASSET_METADATA = {
  durationSeconds: 'Media length in seconds, when known.',
  size: 'File size in bytes, when known.',
  format: 'File format or extension, such as mp4 or wav, when known.',
  width: 'Video or image width in pixels, when known.',
  height: 'Video or image height in pixels, when known.',
};

const PROJECT_FIELDS = {
  name: 'Project name shown in Studio.',
  description: 'Optional project notes.',
};

// Asset and project tools, keyed by generated tool name; getOverride in overrides.ts reads
// these after its own entries.
export const ASSET_PROJECT_OVERRIDES: Record<string, ToolOverride> = {
  // --- Assets (upload + manage reusable media) ---
  'assets_create-upload-url': {
    title: 'Get a media upload URL',
    description:
      "Get a presigned upload URL for a local audio, video or image file: step 1 of 2 for media that is not already at a public URL. PUT the raw bytes to the returned uploadUrl with exactly the declared Content-Type and byte size, then pass the returned url (not uploadUrl) to assets_create to register the asset; until then no asset exists. Not for a public https:// file or a social video link (pass those straight to assets_create), or for re-hosting an already saved video as an Edit Dialogue source (dialogue_upload-source, when available). Returns {uploadUrl, url, expiresIn}: expiresIn is the upload URL's lifetime in seconds; if it expires, request a new one. Spends no credits. Each call issues a new storage path behind a random prefix, so it never collides with an existing file; request a separate upload URL for each file. For example, it returns 422 when size exceeds your plan's upload limit, and assets_create returns 422 if nothing was uploaded.",
    params: {
      fileName:
        'Name of the local file with its extension, up to 255 characters. It only names the stored file: the extension is kept (lowercased), spaces become underscores and other special characters may be dropped.',
      contentType:
        'MIME type starting with audio/, video/ or image/, such as video/mp4; send the same value as the Content-Type header on the PUT.',
      size: "Exact file size as a whole number of bytes, up to 5GB; the PUT must send exactly this many bytes. Your plan's size limit is checked against it here, and again by assets_create on the uploaded file.",
    },
  },
  assets_create: {
    title: 'Register a media asset',
    description:
      'Register a media file at a URL as a reusable sync. asset, or import a YouTube, TikTok, Instagram or Facebook video link into a saved VIDEO asset. Use it for a public https:// file, the url assets_create-upload-url returned after your PUT, or a social link. Not for a local file (call assets_create-upload-url first), finding an existing asset (assets_list) or renaming one (assets_update). Returns the asset (id, type, name, url, visibility, thumbnailUrl, projectId); pass its id as an asset input to generation tools, or as videoAssetId in dubbing_create when available.' +
      '\n\n' +
      "Direct URL: the asset is saved at once and every call saves another one, so do not repeat a call that succeeded. A sync. upload must already hold the PUT bytes and fit the plan's size limit (422 otherwise)." +
      '\n\n' +
      'Social link: send type=VIDEO and the projectId for this request; the asset is named after the video, and name, visibility and the metadata fields are ignored. 409 import_in_progress means it is still downloading: wait retryAfterMs (15 seconds if absent) and repeat the identical request, which reuses the running import, or pass wait: true. The importJobId in the 409 is not an asset id. On import_failed, import_not_enabled, import_unavailable or an import limit (daily or concurrent), explain the error and stop; do not restart the import. Import first, then estimate and confirm translation.' +
      '\n\n' +
      'Projects: pass projectId only with projectIntent=explicit, when the user asked to work in that project, selected it in the interface, or it was just created for this request. A matching workflow/name or an already-open editor is never permission to modify it. Default new work to a new project.',
    params: {
      url: 'Media URL: a public https:// file, the url (not the uploadUrl) that assets_create-upload-url returned once the PUT finished, or a YouTube, TikTok, Instagram or Facebook video link.',
      type: 'Media type: VIDEO, AUDIO or IMAGE. Send VIDEO for a social video link; its import always saves a VIDEO asset.',
      name: 'Display name for the asset. Not used for a social link, which is named after the video.',
      projectId:
        'Project to attach the asset to; send it with projectIntent=explicit. Returns 422 if it is not a project you can use in this organization.',
      visibility:
        'USER (default) or ORGANIZATION, which shares the asset with everyone in the organization. A USER asset is still visible across the organization when attached to a project shared with the organization. Not used for a social link.',
      inputType: 'How the media was produced, such as UPLOAD or URL. Usually omitted.',
      thumbnailUrl: 'Optional preview image URL for the asset.',
      contentSha256: "Optional lowercase hex SHA-256 digest of the file's bytes.",
      ...ASSET_METADATA,
      size: "File size in bytes, when known. For a sync. upload the stored file's measured size is used instead.",
      // withImportWait in generated-adapters.ts reads wait from here.
      wait: 'Social link only: the server repeats the identical request every retryAfterMs (15 seconds if absent) until an attempt returns the saved asset or about 50 seconds pass. If no attempt got the asset, even when the import finished just after the last attempt, the call returns the 409 import_in_progress; call again with wait: true.',
    },
  },
  assets_list: {
    title: 'List assets',
    description:
      'List the media assets (VIDEO, AUDIO, IMAGE) you can access in the current organization, one page at a time, to find an asset id by name, type, creator or project. Not for an id you already hold (use assets_get), a total alone (use assets_count) or generation results (use generations_list, or projects_list-generations when available). Filters combine, so an asset must match all of them; deleted assets never appear. Returns {items, nextCursor, totalCount}: each item includes id, name, type, url, durationSeconds, size, format, width, height, visibility, createdAt, thumbnailUrl and proxyPath; totalCount counts every match across pages, and nextCursor is absent on the last page. Previews: show only each item\'s own exact thumbnailUrl, query string intact. Never search the web, generate an image, guess or construct a URL, or substitute another asset, a stock image, a voice portrait, or the asset\'s url or proxyPath. If thumbnailUrl is missing or fails to load, show https://mcp.sync.so/asset-placeholder.svg labeled "Thumbnail unavailable" and say it is a placeholder, not a frame from the asset; if the host cannot display it, say "Thumbnail unavailable" without substituting an image. Playback still uses the asset\'s media url.',
    params: {
      limit:
        'Page size, an integer from 1 to 100 (default 10); other values fail validation. Keep it small and page with cursor.',
      cursor:
        'The nextCursor from the previous page; send the same filters and sortBy with it. Omit for the first page.',
      searchQuery: 'Case-insensitive text matched anywhere in the asset name.',
      types:
        'Only these media types: VIDEO, AUDIO or IMAGE, as one value or a list; an asset of any listed type matches.',
      sortBy:
        'Sort order (default nameAsc). dateAsc and dateDesc sort by creation time, kindAsc and kindDesc by file format; duration, size and kind sorts put missing values last.',
      projectId:
        'Only assets attached to this project: a project UUID from projects_list or projects_create.',
      userId: 'Only assets created by this user: a user UUID.',
    },
  },
  assets_get: {
    title: 'Get an asset',
    description:
      "Get one asset you can access in the current organization by its id: type, name, media url, durationSeconds, size in bytes, format, width, height, visibility, createdAt, thumbnailUrl and proxyPath (a browser playback proxy, null unless one was generated). Use it when you already hold an id; to find one by name, type or project use assets_list, for a signed download link use assets_get-download-url, and for fps, frame count or codec use assets_get-playback-metadata. Returns 404 asset not found for a deleted id, another organization's asset or one you cannot see. Previews: show only that asset's exact thumbnailUrl (query string intact), never a searched, generated or guessed image, another asset, a stock image, a voice portrait, or the asset's url or proxyPath. If thumbnailUrl is missing or fails to load, show https://mcp.sync.so/asset-placeholder.svg labeled \"Thumbnail unavailable\" (a placeholder, not a frame from the asset), or only that label if the host cannot display it. Playback still uses the media url.",
    params: {
      id: 'Asset id (UUID) from assets_list, or the id assets_create returned; a generation or project id returns 404.',
    },
  },
  assets_update: {
    title: 'Update an asset',
    description:
      "Change an existing asset's name or visibility, or correct its stored media metadata (durationSeconds, size, format, width, height), by id. Send only the fields the user asked to change: omitted fields keep their values and sent ones overwrite the stored values, so read the asset with assets_get first if the old values may be needed. Metadata fields rewrite the asset record, not the media file, and sync. reads the stored durationSeconds in later checks, such as the plan length limit for a link-imported video and dubbing review intervals, so send metadata only with a value you know is right. Not for adding new media (use assets_create) or renaming a project (use projects_rename when available). Every update acts as a user, so an API key with no owner gets 422. Name or visibility changes need the asset's creator or a signed-in organization admin or owner; an API key acts as a plain member, so only on assets its owner created. A metadata-only request works on any asset the caller can read, including other members' assets, so change those only on the user's explicit request. 403 means you can read the asset but may not change it; 404 means it does not exist, was deleted or is not visible to you. Returns the updated asset record, including id, name, visibility, url, the media fields, thumbnailUrl, userId, createdAt and updatedAt, but not proxyPath; use assets_get for that.",
    params: {
      id: 'Asset id (UUID) from assets_list or assets_get.',
      name: 'New display name; must not be empty.',
      visibility:
        'USER: visible to its creator, to everyone in the organization when the asset is attached to an ORGANIZATION-visible project, and to organization API keys with no owner. ORGANIZATION: visible to everyone in the organization.',
      durationSeconds:
        'Corrected media length in seconds, greater than 0. Later duration checks read this value, so send only a length you have verified.',
      size: 'Corrected file size in bytes, a positive whole number. Send only a verified correction.',
      format:
        'Corrected file format or extension, such as mp4 or wav; must not be empty. Send only a verified correction.',
      width: 'Corrected width in pixels, a positive whole number. Send only a verified correction.',
      height:
        'Corrected height in pixels, a positive whole number. Send only a verified correction.',
    },
  },
  assets_delete: {
    title: 'Delete an asset',
    description:
      'Delete an asset by id. Use only on an explicit user request, after confirming which asset.',
    params: { id: 'Asset id from assets_list.' },
  },
  assets_count: {
    title: 'Count assets',
    description:
      'Count the assets you can access in the current organization that match projectId, userId, searchQuery and types, the same filters as assets_list; filters combine, and deleted assets are not counted. Use it when you only need how many; use assets_list to see, pick or page through assets. Returns a bare number, not asset records. Omit sortBy, limit and cursor: they do not change the count, but they are still validated, so a limit outside 1 to 100 fails the call.',
    params: {
      projectId:
        'Only assets attached to this project: a project UUID from projects_list or projects_create.',
      userId: 'Only assets created by this user: a user UUID.',
      searchQuery: 'Case-insensitive text matched anywhere in the asset name.',
      types:
        'Only these media types: VIDEO, AUDIO or IMAGE, as one value or a list; an asset of any listed type matches.',
      sortBy: 'No effect on the count; omit it.',
      limit:
        'No effect on the count; omit it. If sent, it must be an integer from 1 to 100 or the call fails validation.',
      cursor: 'No effect on the count; omit it.',
    },
  },
  'assets_get-download-url': {
    title: 'Get an asset download URL',
    description:
      "Get a download link for one asset's original media file, by id. Use it when the user wants to download or save the file; use assets_get for the asset's details and media url, and assets_get-playback-metadata for frame timing. For files in sync. storage the link is signed, valid for up to 7 days and downloads under the asset's name; an asset registered from an outside URL returns that URL unchanged. Returns the URL as a plain string, or 404 when the asset does not exist, was deleted or you cannot see it. Return the URL exactly as given, query string included, and request a fresh one instead of reusing an old link.",
    params: {
      id: "Asset id (UUID) from assets_list or assets_get, not a generation id; for a generation's output use its outputMediaUrl from generations_get.",
    },
  },
  // --- Projects (group generations + assets) ---
  projects_create: {
    title: 'Create a project',
    description:
      'Create a new, empty sync. project in the current organization to group the assets and generations of one workflow request; you own it (for an API key, its owner) and creating it is not billed. Use it by default for every new workflow request, even when a project with the same name exists, then pass the returned id as projectId with projectIntent=explicit to assets_create and the other tools that take projectId, so the work appears together in Studio. Skip it for a new lipsync_create or dubbing_create with saved assets: omit projectId there and pass a fresh projectCreationKey. Not for continuing a project the user explicitly named; find that one with projects_list. Each call without id makes another project, so supply a fresh UUID as id and reuse it only to retry this same creation. Returns the project, including id, name, visibility, mode and defaultWorkflow.',
    params: {
      ...PROJECT_FIELDS,
      id: 'Fresh random UUID you generate for this creation; reuse it only when retrying this same creation. Re-sending it returns the existing project and ignores the other fields. An id already used by another user or organization, or by a deleted project, fails with 409.',
      visibility:
        'USER (default) keeps the project visible only to you; ORGANIZATION makes it visible to every member of the organization.',
      defaultWorkflow:
        'The workflow the user asked for, such as translate_and_dub for translation, lipsync for lip sync or edit_dialogue for Edit Dialogue. Omitted, the project has no default workflow.',
    },
  },
  projects_list: {
    title: 'List projects',
    description:
      "List the sync. projects you can access in the current organization (your own plus organization-visible ones), as items plus nextCursor. Each item has the project fields, generationsCount, completedGenerationsCount, its latest generation and the latest asset thumbnail. Use it to find the projectId of a project the user explicitly refers to; for one project whose id you have use projects_get, and for a project's generation history use projects_list-generations when available. Never use it to choose a destination for a new workflow request, which starts with projects_create; workflow names such as Translate and Dub are not project names. Returns 10 per page by default, most recently updated first; pass nextCursor as cursor for the next page, and it is absent on the last page.",
    params: {
      limit: 'Projects per page, 1 to 100; defaults to 10. Keep it small and page with cursor.',
      searchQuery:
        'Case-insensitive text matched within project names and descriptions. Use only when the user names an existing project, and ask which one when several match instead of taking the first.',
      sortBy: 'updatedAt (default) lists the most recently updated first; name sorts A to Z.',
    },
  },
  projects_get: {
    title: 'Get a project',
    description:
      "Read one sync. project you can access by its id: name, description, visibility, mode, defaultWorkflow, owner userId, organizationId and timestamps. Use it to check a project the user explicitly named or selected before working in it. To find a project id use projects_list; it does not include the project's generations, so for its history use projects_list-generations when available. A project that does not exist, was deleted, or is another user's USER-visibility project returns a 404 error. Pass projectId; id is a deprecated alias, and passing both with different values fails.",
    // withProjectIdAlias in generated-adapters.ts reads projectId from here.
    params: {
      projectId:
        'Project id (UUID) from projects_list, projects_create or a tool result that names the project.',
    },
  },
  projects_update: {
    description: "Update a project's name, description, visibility, or mode.",
    params: {
      ...PROJECT_FIELDS,
      visibility: 'USER keeps it private to you; ORGANIZATION shares it with your team.',
      mode: 'CREATOR or DEVELOPER.',
    },
  },
  'projects_attach-asset': {
    params: { assetId: 'Asset id from assets_list to attach to the project.' },
  },
  'assets_get-many': {
    params: { ids: 'Asset ids from assets_list.' },
  },
  projects_delete: {
    description:
      'Delete a project. Generations and assets attached to it are not deleted; they just stop being grouped under it.',
  },
};
