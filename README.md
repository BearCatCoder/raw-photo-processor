# Raw Photo Processor

An OpenCode V2 plugin for AI-guided, non-recursive processing of one folder of RAW photos with Adobe Camera Raw and Adobe Photoshop on Windows.

## Use

Restart OpenCode after installation, then run:

```text
/raw-photo-processor C:\absolute\path\to\raws
```

The command defaults to `openai/gpt-6-luna` and falls back to `openai/gpt-5.6-terra` if Luna is unavailable. The model examines a temporary JPEG preview of each photo and selects restrained Camera Raw values, straightening, and a 3:2 or 2:3 crop. The plugin then creates:

After Camera Raw, straightening, and cropping, the still-open Photoshop document receives a required AI-selected finishing pass before either output is saved. For every image, the model visually assesses residual global exposure, final brightness and contrast, Levels midtone placement, and midtone color balance. It uses non-neutral values when they improve tonal separation, subject presence, or an unwanted color cast, while retaining neutral values for controls that do not improve the image. The guidance accounts for the combined Camera Raw and Photoshop result, preserves intentional atmosphere and highlight/shadow detail, and avoids clipping, crushed blacks, halos, excessive contrast, oversaturation, and obvious filtering. Safety limits remain narrow enough to preserve a natural, photorealistic result.

- `<source folder>\PSDs\<name>.psd`
- `<source folder>\JPEGs\<name>.jpg` (8 Bits/Channel, JPEG quality 12)

Existing outputs are skipped by default. The RAW file is never modified. A temporary `.xmp` sidecar is used to pass settings to Camera Raw; an existing sidecar is restored byte-for-byte after the RAW is opened.

On restart with overwrite disabled, the plugin inventories both output folders, finds the highest source image that has a matching PSD and JPEG, and resumes after that completed pair. For bracketed images, normal exposure-bias alignment advances from that point to the next `0 EV` bracket boundary. A lone PSD or JPEG is treated as an incomplete pair and reported instead of being silently skipped.

Processing uses a strict two-phase workflow. First, every temporary JPEG preview—including all five images in a bracket set—is queued as an actual image attachment in the active OpenCode session so the model can select exposure and adjustments without relying on pathnames. Photoshop then saves the PSD followed by the maximum-quality JPEG. Second, the plugin queues an attachment-safe rendering of that finished JPEG for visual identification. These session attachments bypass Code Mode's path-only tool serialization. Only after identification does the plugin reopen both saved outputs and write matching metadata to the PSD and JPEG.

Full-resolution quality-12 JPEGs can exceed OpenCode's 20 MB attachment limit. For identification only, the plugin therefore renders a temporary maximum-1600-pixel JPEG directly from the finished output. This attachment-safe copy preserves the final composition and appearance; it does not replace or modify the full-resolution JPEG. Metadata is still applied to the original PSD and quality-12 JPEG.

Queued attachments arrive on the next session turn. The immediate tool result therefore instructs the model to end its current turn and wait; it must not process, restart, or cancel the job before the queued image message arrives. Cancellation is reserved for an explicit user request.

If the model calls the wrong workflow tool for an attachment stage, the plugin keeps the job active and automatically requeues the correct attachment: RAW previews for `apply`, or the finished JPEG for `finalize_metadata`. This prevents a recoverable stage-classification mistake from stopping the batch or writing metadata to the wrong image.

Before processing, the plugin reads the Exposure Bias metadata up to five images ahead. A `0 EV` image followed by four non-zero-EV images is treated as one bracket set. The model compares all five previews, processes only the best exposure, and skips the other four. Non-zero frames encountered shortly before a new `0 EV` image are treated as an incomplete bracket run and skipped.

When GPS coordinates are present, they are shown to the model so it can research the general subject/location and write an objective IPTC Description plus relevant subject and location keywords. The model is explicitly prohibited from identifying individual people.

Without source GPS, a landmark fallback is permitted only when the model can identify a distinctive landmark with greater than 90% certainty. The model must verify the landmark's WGS-84 coordinates; the plugin then embeds those coordinates in the PSD/JPEG XMP metadata and writes the location-aware Description and keywords. Below that threshold, it writes visual-subject keywords only, does not guess a location, and leaves the generated Description empty.

Whenever a location is established from source GPS, a verified landmark, or an existing source Description, the plugin also writes City, State/Province, Country, and the IPTC three-letter ISO Country Code into both output formats.

Each selected photo is independently checked with image recognition for a named landmark, building, park, venue, neighborhood, or site. Its specific name is written to IPTC Sublocation only when confidence is strictly greater than 90%; otherwise Sublocation stays blank. Identifications are never carried from one photo to another. If the exact location cannot be verified, all generated location fields may remain blank. GPS coordinates are kept in metadata and are never written into Description.

Metadata finalization requires an explicit `locationDecision`. If the model identifies or names any place in its reasoning, Description, or Keywords, the decision must be `verified` and complete structured location fields are mandatory. With no source GPS or source Description, a visually verified place also requires `inferredLocation` above 90% confidence and verified coordinates. `unverified` is valid only when no place names are emitted. This prevents outputs that contain location keywords while leaving City/Country/Sublocation blank.

When source metadata contains a Creator, the plugin preserves any existing Copyright Notice or fills an empty notice with `Copyright (c) <Creator>. All rights reserved.` It marks the output as Copyrighted and writes XMP Rights and Usage Terms stating that the Creator retains all rights. These protections are embedded in both PSD and JPEG outputs.

Rights Usage Terms use the actual Creator name (for example, `All rights reserved. Bryan Smith retains all rights.`), never the generic phrase “The Creator.” When a matching official value can be verified, the model may also supply one or more six-digit IPTC Scene-NewsCodes; uncertain codes are omitted.

After each finalized photo, the plugin reports elapsed processing time and the OpenCode-recorded token delta (input, output, reasoning, and cache read/write). To avoid spending tokens on a summary after every image, it requests session compaction when the active context reaches 65% of the selected model's limit or after eight photos, whichever comes first. Set `RAW_PHOTO_PROCESSOR_COMPACT_AT`/plugin option `compactAt` from 0.4–0.9 and `RAW_PHOTO_PROCESSOR_COMPACT_EVERY`/`compactEvery` from 2–50 to tune those thresholds. Compaction replaces older conversation with a summary rather than deleting active plugin state.

If the embedded plugin session API does not expose compaction, the Windows plugin uses the authenticated OpenCode CLI associated with the running app version to submit the same request. Set `OPENCODE_CLI` to an explicit executable path for a nonstandard installation.

The model receives only the RAW workflow tool needed for the current stage: Start with no active job, Apply while reviewing previews, or Finalize Metadata after the finished JPEG. Cancel remains available during an active job. Five-shot preview sets are rendered in one Photoshop bridge call, and the attachment-safe identification JPEG is produced in the same bridge call as the PSD/JPEG save. This reduces a normal photo from five Photoshop launches to four and a bracket set from nine launches to four.

The complete official IPTC Scene-NewsCodes vocabulary is bundled locally, so selecting Scene codes does not require a web lookup. Location research remains photo-specific.

Every processed photo is independently analyzed and, when a location is available or confidently inferred, independently researched. Descriptions and complete keyword sets must be photo-specific. The plugin rejects an exactly reused Description or identical complete keyword set within the same batch, while allowing individual relevant terms such as a shared city or `landscape` to overlap.

## Select Terra instead

Set this environment variable before starting or restarting the OpenCode service:

```powershell
$env:RAW_PHOTO_PROCESSOR_MODEL = "openai/gpt-5.6-terra"
opencode service restart
```

No project configuration entry is required because OpenCode automatically discovers the plugin under `.opencode/plugins`.

## Notes

- Supported formats include ARW, CR2/CR3, DNG, NEF, RAF, ORF, RW2, and other common proprietary RAW extensions.
- Camera Raw must support the camera's file format and lens profile. `Remove Chromatic Aberration` and `Use Profile Corrections` are requested for every image; profile correction depends on an installed/matched Adobe lens profile.
- Photoshop remains visible while the COM automation runs. Do not interact with it during a batch.
- “Open as Copy” is implemented non-interactively by opening the RAW with its temporary XMP into a new, unsaved Photoshop document. The source RAW and prior sidecar remain unchanged.
