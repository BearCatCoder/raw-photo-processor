import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const RAW_EXTENSIONS = new Set([
  ".3fr", ".arw", ".cr2", ".cr3", ".dng", ".erf", ".iiq", ".kdc", ".mos",
  ".mrw", ".nef", ".nrw", ".orf", ".pef", ".raf", ".raw", ".rw2", ".rwl",
  ".srw", ".x3f",
])

const IPTC_SCENES = {
  "010100": "headshot", "010200": "half-length", "010300": "full-length", "010400": "profile",
  "010500": "rear view", "010600": "single", "010700": "couple", "010800": "two",
  "010900": "group", "011000": "general view", "011100": "panoramic view", "011200": "aerial view",
  "011300": "under-water", "011400": "night scene", "011500": "satellite", "011600": "exterior view",
  "011700": "interior view", "011800": "close-up", "011900": "action", "012000": "performing",
  "012100": "posing", "012200": "symbolic", "012300": "off-beat", "012400": "movie scene",
} as const
const IPTC_SCENE_CODES = new Set<string>(Object.keys(IPTC_SCENES))
const IPTC_SCENE_CATALOG = Object.entries(IPTC_SCENES).map(([code, name]) => `${code} ${name}`).join("; ")

const number = (minimum: number, maximum: number, description: string) => ({
  type: "number",
  minimum,
  maximum,
  description,
})

const EDIT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    temperature: number(2000, 50000, "Camera Raw color temperature in kelvin."),
    tint: number(-150, 150, "Camera Raw green/magenta tint."),
    exposure: number(-5, 5, "Exposure in stops. Keep realistic edits near zero."),
    contrast: number(-100, 100, "Light panel contrast."),
    highlights: number(-100, 100, "Light panel highlights."),
    shadows: number(-100, 100, "Light panel shadows."),
    whites: number(-100, 100, "Light panel whites."),
    blacks: number(-100, 100, "Light panel blacks."),
    texture: number(-100, 100, "Effects panel texture."),
    clarity: number(-100, 100, "Effects panel clarity."),
    dehaze: number(-100, 100, "Effects panel dehaze."),
    vibrance: number(-100, 100, "Color panel vibrance."),
    saturation: number(-100, 100, "Color panel saturation."),
    mixer: {
      type: "object",
      additionalProperties: false,
      description: "Color Mixer HSL adjustments. Omitted channels remain neutral.",
      properties: Object.fromEntries(
        ["red", "orange", "yellow", "green", "aqua", "blue", "purple", "magenta"].flatMap((color) =>
          ["Hue", "Saturation", "Luminance"].map((dimension) => [
            `${color}${dimension}`,
            number(-100, 100, `${color} ${dimension.toLowerCase()}.`),
          ]),
        ),
      ),
    },
    straightenDegrees: number(-45, 45, "Clockwise rotation needed to straighten the image."),
    orientation: {
      type: "string",
      enum: ["auto", "landscape", "portrait"],
      description: "Final 3:2 (6x4) or 2:3 (4x6) crop orientation.",
    },
    cropCenterX: number(0, 1, "Horizontal crop focal point, normalized from left to right."),
    cropCenterY: number(0, 1, "Vertical crop focal point, normalized from top to bottom."),
    cropScale: number(0.5, 1, "Fraction of the largest safe 3:2 crop to retain."),
    photoshopFinish: {
      type: "object",
      additionalProperties: false,
      description: "Subtle photorealistic finishing applied to the open Photoshop document after crop and before PSD/JPEG saves. Correct only residual issues left after Camera Raw; use neutral values when no further correction is needed.",
      properties: {
        exposure: number(-2, 2, "Residual Photoshop exposure correction in stops. Keep close to zero."),
        brightness: number(-50, 50, "Residual Photoshop brightness correction."),
        contrast: number(-50, 50, "Residual Photoshop contrast correction."),
        toneGamma: number(0.5, 1.5, "Photoshop Levels midtone gamma. Use 1 for neutral; below 1 brightens midtones and above 1 darkens them."),
        cyanRed: number(-30, 30, "Midtone color balance: negative adds cyan, positive adds red."),
        magentaGreen: number(-30, 30, "Midtone color balance: negative adds magenta, positive adds green."),
        yellowBlue: number(-30, 30, "Midtone color balance: negative adds yellow, positive adds blue."),
      },
      required: ["exposure", "brightness", "contrast", "toneGamma", "cyanRed", "magentaGreen", "yellowBlue"],
    },
    description: {
      type: "string",
      maxLength: 2000,
      description: "Objective IPTC Description based on the finished JPEG and a verified location. Never include coordinates or identify individual people. Omit when exact location is unverified.",
    },
    keywords: {
      type: "array",
      minItems: 1,
      maxItems: 30,
      uniqueItems: true,
      items: { type: "string", minLength: 1, maxLength: 64 },
      description: "Concise IPTC keywords describing the finished JPEG. If any keyword names a landmark, city, region, country, venue, park, building, or other place, locationDecision must be verified and complete location metadata is required. Never include names of individual people.",
    },
    locationDecision: {
      type: "string",
      enum: ["verified", "unverified"],
      description: "Required explicit decision for this photo. Use verified whenever any place is identified or named in Description/Keywords; use unverified only when no exact place can be established and no place names are emitted.",
    },
    iptcSceneCodes: {
      type: "array",
      maxItems: 20,
      uniqueItems: true,
      items: { type: "string", enum: Object.keys(IPTC_SCENES) },
      description: "Applicable official IPTC Scene-NewsCodes from the supplied local catalog. Omit or use an empty array when uncertain.",
    },
    inferredLocation: {
      type: "object",
      additionalProperties: false,
      description: "Use only when the source has no GPS and a visually distinctive landmark is identified with greater than 90% certainty. Verify the landmark and coordinates before supplying this object.",
      properties: {
        landmark: { type: "string", minLength: 1, maxLength: 200 },
        confidence: number(0.900001, 1, "Landmark-identification confidence. Must be strictly greater than 0.90."),
        latitude: number(-90, 90, "Verified WGS-84 latitude of the landmark."),
        longitude: number(-180, 180, "Verified WGS-84 longitude of the landmark."),
      },
      required: ["landmark", "confidence", "latitude", "longitude"],
    },
    location: {
      type: "object",
      additionalProperties: false,
      description: "Verified structured location metadata. Omit the entire object when an exact location cannot be ascertained, even if source GPS exists.",
      properties: {
        sublocation: { type: "string", minLength: 1, maxLength: 200, description: "Verified specific landmark, building, park, venue, site, neighborhood, or other named sublocation visible in this individual photo. Omit when no specific place is correctly identified." },
        sublocationConfidence: number(0.900001, 1, "Image-recognition confidence for Sublocation. Required with Sublocation and must be strictly greater than 0.90."),
        city: { type: "string", minLength: 1, maxLength: 200 },
        stateProvince: { type: "string", minLength: 1, maxLength: 200 },
        country: { type: "string", minLength: 1, maxLength: 200 },
        isoCountryCode: { type: "string", pattern: "^[A-Za-z]{3}$", description: "ISO 3166-1 alpha-3 country code used by IPTC, such as USA, CAN, GBR, or FRA." },
      },
      required: ["city", "stateProvince", "country", "isoCountryCode"],
    },
  },
} as const

const ADJUSTMENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: Object.fromEntries(
    Object.entries(EDIT_SCHEMA.properties).filter(([name]) => !["description", "keywords", "locationDecision", "iptcSceneCodes", "inferredLocation", "location"].includes(name)),
  ),
  required: ["photoshopFinish"],
} as const

const METADATA_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    description: EDIT_SCHEMA.properties.description,
    keywords: EDIT_SCHEMA.properties.keywords,
    locationDecision: EDIT_SCHEMA.properties.locationDecision,
    iptcSceneCodes: EDIT_SCHEMA.properties.iptcSceneCodes,
    inferredLocation: EDIT_SCHEMA.properties.inferredLocation,
    location: EDIT_SCHEMA.properties.location,
  },
  required: ["keywords", "locationDecision"],
} as const

type Edit = {
  temperature?: number
  tint?: number
  exposure?: number
  contrast?: number
  highlights?: number
  shadows?: number
  whites?: number
  blacks?: number
  texture?: number
  clarity?: number
  dehaze?: number
  vibrance?: number
  saturation?: number
  mixer?: Record<string, number>
  straightenDegrees?: number
  orientation?: "auto" | "landscape" | "portrait"
  cropCenterX?: number
  cropCenterY?: number
  cropScale?: number
  photoshopFinish?: {
    exposure: number
    brightness: number
    contrast: number
    toneGamma: number
    cyanRed: number
    magentaGreen: number
    yellowBlue: number
  }
  description?: string
  keywords?: string[]
  locationDecision?: "verified" | "unverified"
  iptcSceneCodes?: string[]
  inferredLocation?: {
    landmark: string
    confidence: number
    latitude: number
    longitude: number
  }
  location?: {
    sublocation?: string
    sublocationConfidence?: number
    city: string
    stateProvince: string
    country: string
    isoCountryCode: string
  }
}

type JobEntry = {
  raw: string
  psd: string
  jpeg: string
  preview: string
  identificationPreview: string
  exposureBias?: number | null
  gps?: { latitude: number; longitude: number } | null
  sourceDescription?: string | null
  creator?: string | null
}

type Job = {
  id: string
  sessionID: string
  folder: string
  work: string
  entries: JobEntry[]
  index: number
  overwrite: boolean
  completed: Array<{ raw: string; psd: string; jpeg: string }>
  skipped: Array<{ raw: string; reason: string }>
  group?: { type: "single" | "bracket"; indices: number[] }
  descriptions: Set<string>
  keywordSets: Set<string>
  pending?: { group: { type: "single" | "bracket"; indices: number[] }; selectedIndex: number }
  photoStartedAt: number
  tokenBaseline: TokenTotals
  photosSinceCompaction: number
}

type TokenTotals = {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

function tokenDelta(current: TokenTotals, previous: TokenTotals): TokenTotals {
  return {
    input: Math.max(0, current.input - previous.input),
    output: Math.max(0, current.output - previous.output),
    reasoning: Math.max(0, current.reasoning - previous.reasoning),
    cacheRead: Math.max(0, current.cacheRead - previous.cacheRead),
    cacheWrite: Math.max(0, current.cacheWrite - previous.cacheWrite),
  }
}

function formatDuration(milliseconds: number) {
  const seconds = Math.max(0, Math.round(milliseconds / 1000))
  const minutes = Math.floor(seconds / 60)
  return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`
}

const jobs = new Map<string, Job>()
const sessionJobs = new Map<string, string>()

// @opencode/plugin's Plugin.define is an identity helper. Keeping that tiny
// helper local lets this project plugin load without a separate package install.
const definePlugin = <T>(plugin: T) => plugin

function clamp(value: unknown, fallback: number, min: number, max: number) {
  const parsed = typeof value === "number" && Number.isFinite(value) ? value : fallback
  return Math.min(max, Math.max(min, parsed))
}

function xml(value: string | number) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll('"', "&quot;")
}

function cameraRawXmp(edit: Edit) {
  const values: Record<string, string | number> = {
    Version: "17.0",
    ProcessVersion: "15.4",
    WhiteBalance: edit.temperature || edit.tint ? "Custom" : "As Shot",
    Exposure2012: clamp(edit.exposure, 0, -5, 5),
    Contrast2012: clamp(edit.contrast, 0, -100, 100),
    Highlights2012: clamp(edit.highlights, 0, -100, 100),
    Shadows2012: clamp(edit.shadows, 0, -100, 100),
    Whites2012: clamp(edit.whites, 0, -100, 100),
    Blacks2012: clamp(edit.blacks, 0, -100, 100),
    Texture: clamp(edit.texture, 0, -100, 100),
    Clarity2012: clamp(edit.clarity, 0, -100, 100),
    Dehaze: clamp(edit.dehaze, 0, -100, 100),
    Vibrance: clamp(edit.vibrance, 0, -100, 100),
    Saturation: clamp(edit.saturation, 0, -100, 100),
    RemoveChromaticAberration: 1,
    AutoLateralCA: 1,
    LensProfileEnable: 1,
    LensManualDistortionAmount: 0,
  }
  if (edit.temperature !== undefined) values.Temperature = clamp(edit.temperature, 5500, 2000, 50000)
  if (edit.tint !== undefined) values.Tint = clamp(edit.tint, 0, -150, 150)

  const colorNames: Record<string, string> = {
    red: "Red", orange: "Orange", yellow: "Yellow", green: "Green",
    aqua: "Aqua", blue: "Blue", purple: "Purple", magenta: "Magenta",
  }
  for (const [key, value] of Object.entries(edit.mixer ?? {})) {
    const match = key.match(/^(red|orange|yellow|green|aqua|blue|purple|magenta)(Hue|Saturation|Luminance)$/)
    if (!match) continue
    values[`${match[2]}Adjustment${colorNames[match[1]]}`] = clamp(value, 0, -100, 100)
  }

  const attributes = Object.entries(values)
    .map(([key, value]) => `      crs:${key}="${xml(value)}"`)
    .join("\n")

  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
${attributes}/>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`
}

async function runPhotoshop(pluginDirectory: string, script: string, config: unknown, signal: AbortSignal) {
  const runner = path.join(pluginDirectory, "scripts", "invoke-photoshop.ps1")
  const scriptPath = path.join(pluginDirectory, "scripts", script)
  const encoded = Buffer.from(JSON.stringify(config), "utf8").toString("base64")
  await new Promise<void>((resolve, reject) => {
    const child = spawn("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", runner, "-ScriptPath", scriptPath, "-ConfigBase64", encoded,
    ], { windowsHide: true })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => { stdout += chunk })
    child.stderr.on("data", (chunk) => { stderr += chunk })
    const abort = () => child.kill()
    signal.addEventListener("abort", abort, { once: true })
    child.once("error", reject)
    child.once("close", (code) => {
      signal.removeEventListener("abort", abort)
      if (signal.aborted) return reject(new Error("Photo processing was cancelled."))
      if (code === 0) return resolve()
      reject(new Error((stderr || stdout || `Photoshop exited with code ${code}`).trim()))
    })
  })
}

async function makePreviews(pluginDirectory: string, entries: JobEntry[], signal: AbortSignal) {
  await runPhotoshop(pluginDirectory, "preview.jsx", {
    items: entries.map((entry) => ({ input: entry.raw, output: entry.preview })),
  }, signal)
  await Promise.all(entries.map((entry) => stat(entry.preview)))
}

function currentPromptText(job: Job, message: string) {
  const group = job.group ?? { type: "single" as const, indices: [job.index] }
  const entries = group.indices.map((index) => job.entries[index])
  const exposureSummary = entries
    .map((entry, offset) => {
      const bias = entry.exposureBias === null ? "unknown" : `${entry.exposureBias ?? 0} EV`
      const gps = entry.gps ? `; GPS ${entry.gps.latitude.toFixed(6)}, ${entry.gps.longitude.toFixed(6)}` : "; no GPS"
      const description = entry.sourceDescription ? `; source Description: ${entry.sourceDescription.slice(0, 500)}` : "; no source Description"
      const creator = entry.creator ? `; Creator: ${entry.creator}` : "; no Creator"
      return `${offset}: ${path.basename(entry.raw)} (${bias}${gps}${description}${creator})`
    })
    .join("\n")
  const metadataInstruction = `Use these preview(s) only to choose the exposure and image adjustments. Identification and metadata must wait until the finished JPEG is saved and returned.`
  const instruction = group.type === "bracket"
    ? `This is a five-shot bracket set. Compare all five attached previews and call raw_photo_processor_apply with selectedOffset 0-4 for the best usable exposure plus restrained Camera Raw and Photoshop finishing adjustments. Only that frame will be processed.`
    : `Analyze the attached preview, then call raw_photo_processor_apply with realistic Camera Raw values, a 3:2 crop, and a subtle photorealistic Photoshop finishing pass.`
  return `${message}\nJob: ${job.id}\nSequence position ${job.index + 1} of ${job.entries.length}:\n${exposureSummary}\n${instruction}\n${metadataInstruction}`
}

function currentResult(job: Job, message: string) {
  const group = job.group ?? { type: "single" as const, indices: [job.index] }
  return {
    content: `Queued ${group.indices.length} actual JPEG image attachment(s) for the next session turn. End this turn now and wait for the queued image message. Do not call apply, finalize_metadata, cancel, or start again until that message arrives.`,
  }
}

function isZeroBias(value: number | null | undefined) {
  return typeof value === "number" && Math.abs(value) < 0.0001
}

function normalizeMetadataText(value: string) {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, " ")
}

function keywordFingerprint(keywords: string[]) {
  return [...new Set(keywords.map(normalizeMetadataText).filter(Boolean))].sort().join("\u001f")
}

function descriptionContainsCoordinates(value: string) {
  return /\b(?:latitude|longitude|gps\s*coordinates?)\b/i.test(value)
    || /[-+]?\d{1,2}\.\d{3,}\s*[,;/]\s*[-+]?\d{1,3}\.\d{3,}/.test(value)
    || /\d+(?:\.\d+)?\s*°\s*(?:[NS]|north|south)|\d+(?:\.\d+)?\s*°\s*(?:[EW]|east|west)/i.test(value)
}

async function ensureMetadata(pluginDirectory: string, job: Job, indices: number[], signal: AbortSignal) {
  const missing = indices.filter((index) => {
    const entry = job.entries[index]
    return entry?.exposureBias === undefined || entry?.gps === undefined
      || entry?.sourceDescription === undefined || entry?.creator === undefined
  })
  if (!missing.length) return
  const output = path.join(job.work, `metadata-${missing[0]}-${missing.length}.tsv`)
  await runPhotoshop(pluginDirectory, "metadata.jsx", {
    inputs: missing.map((index) => job.entries[index].raw),
    output,
  }, signal)
  const lines = (await readFile(output, "utf8")).split(/\r?\n/)
  for (const line of lines) {
    if (!line) continue
    const [positionText, biasText = "", latitudeText = "", longitudeText = "", descriptionText = "", creatorText = ""] = line.split("\t")
    const position = Number(positionText)
    if (!Number.isInteger(position) || position < 0 || position >= missing.length) continue
    const bias = Number(biasText)
    const entry = job.entries[missing[position]]
    entry.exposureBias = biasText.trim() !== "" && Number.isFinite(bias) ? bias : null
    const latitude = Number(latitudeText)
    const longitude = Number(longitudeText)
    entry.gps = latitudeText.trim() !== "" && longitudeText.trim() !== ""
      && Number.isFinite(latitude) && Number.isFinite(longitude)
      && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180
      ? { latitude, longitude }
      : null
    entry.sourceDescription = descriptionText.trim() || null
    entry.creator = creatorText.trim() || null
  }
  for (const index of missing) {
    if (job.entries[index].exposureBias === undefined) job.entries[index].exposureBias = null
    if (job.entries[index].gps === undefined) job.entries[index].gps = null
    if (job.entries[index].sourceDescription === undefined) job.entries[index].sourceDescription = null
    if (job.entries[index].creator === undefined) job.entries[index].creator = null
  }
  await rm(output, { force: true })
}

async function prepareCurrent(pluginDirectory: string, job: Job, signal: AbortSignal) {
  let lookahead = Array.from({ length: 5 }, (_, offset) => job.index + offset)
    .filter((index) => index < job.entries.length)
  await ensureMetadata(pluginDirectory, job, lookahead, signal)

  // A non-zero run immediately before a new zero-EV frame is a partial/ending
  // bracket sequence. Ignore that run and restart at the zero-EV frame.
  if (!isZeroBias(job.entries[job.index].exposureBias)) {
    const nextZero = lookahead.slice(1).find((index) => isZeroBias(job.entries[index].exposureBias))
    if (nextZero !== undefined) {
      for (let index = job.index; index < nextZero; index += 1) {
        job.skipped.push({ raw: job.entries[index].raw, reason: "Non-zero EV frame precedes a new 0 EV sequence." })
      }
      job.index = nextZero
      lookahead = Array.from({ length: 5 }, (_, offset) => job.index + offset)
        .filter((index) => index < job.entries.length)
      await ensureMetadata(pluginDirectory, job, lookahead, signal)
    }
  }

  const bracket = lookahead.length === 5
    && isZeroBias(job.entries[lookahead[0]].exposureBias)
    && lookahead.slice(1).every((index) => {
      const bias = job.entries[index].exposureBias
      return typeof bias === "number" && !isZeroBias(bias)
    })
  job.group = { type: bracket ? "bracket" : "single", indices: bracket ? lookahead : [job.index] }
  await makePreviews(pluginDirectory, job.group.indices.map((index) => job.entries[index]), signal)
}

async function findSidecar(raw: string) {
  const directory = path.dirname(raw)
  const target = `${path.parse(raw).name}.xmp`.toLowerCase()
  const existing = (await readdir(directory)).find((name) => name.toLowerCase() === target)
  return path.join(directory, existing ?? `${path.parse(raw).name}.xmp`)
}

async function applyEdit(pluginDirectory: string, entry: JobEntry, edit: Edit, overwrite: boolean, signal: AbortSignal) {
  const sidecar = await findSidecar(entry.raw)
  let previous: Buffer | undefined
  try {
    previous = await readFile(sidecar)
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error
  }

  await writeFile(sidecar, cameraRawXmp(edit), "utf8")
  try {
    await runPhotoshop(pluginDirectory, "process.jsx", {
      input: entry.raw,
      psd: entry.psd,
      jpeg: entry.jpeg,
      overwrite,
      straightenDegrees: clamp(edit.straightenDegrees, 0, -45, 45),
      orientation: edit.orientation ?? "auto",
      cropCenterX: clamp(edit.cropCenterX, 0.5, 0, 1),
      cropCenterY: clamp(edit.cropCenterY, 0.5, 0, 1),
      cropScale: clamp(edit.cropScale, 0.96, 0.5, 1),
      photoshopFinish: {
        exposure: clamp(edit.photoshopFinish?.exposure, 0, -2, 2),
        brightness: clamp(edit.photoshopFinish?.brightness, 0, -50, 50),
        contrast: clamp(edit.photoshopFinish?.contrast, 0, -50, 50),
        toneGamma: clamp(edit.photoshopFinish?.toneGamma, 1, 0.5, 1.5),
        cyanRed: clamp(edit.photoshopFinish?.cyanRed, 0, -30, 30),
        magentaGreen: clamp(edit.photoshopFinish?.magentaGreen, 0, -30, 30),
        yellowBlue: clamp(edit.photoshopFinish?.yellowBlue, 0, -30, 30),
      },
      identificationPreview: entry.identificationPreview,
    }, signal)
    await stat(entry.identificationPreview)
  } finally {
    if (previous) await writeFile(sidecar, previous)
    else await rm(sidecar, { force: true })
  }
}

async function updateOutputMetadata(pluginDirectory: string, entry: JobEntry, edit: Edit, signal: AbortSignal) {
  const inferred = !entry.gps
    && edit.inferredLocation
    && edit.inferredLocation.confidence > 0.9
    ? edit.inferredLocation
    : undefined
  const hasLocation = Boolean(edit.location && (entry.gps || inferred || entry.sourceDescription))
  await runPhotoshop(pluginDirectory, "update-metadata.jsx", {
    psd: entry.psd,
    jpeg: entry.jpeg,
    description: hasLocation && typeof edit.description === "string" ? edit.description.trim() : null,
    keywords: [...new Set((edit.keywords ?? []).map((keyword) => keyword.trim()).filter(Boolean))].slice(0, 30),
    iptcSceneCodes: [...new Set((edit.iptcSceneCodes ?? []).filter((code) => IPTC_SCENE_CODES.has(code)))].slice(0, 20),
    gps: inferred ? { latitude: inferred.latitude, longitude: inferred.longitude } : null,
    location: hasLocation && edit.location ? {
      sublocation: edit.location.sublocation?.trim() || null,
      city: edit.location.city.trim(),
      stateProvince: edit.location.stateProvince.trim(),
      country: edit.location.country.trim(),
      isoCountryCode: edit.location.isoCountryCode.trim().toUpperCase(),
    } : null,
    creator: entry.creator,
  }, signal)
}

function metadataPromptText(job: Job, entry: JobEntry) {
  const gps = entry.gps
    ? `${entry.gps.latitude.toFixed(6)}, ${entry.gps.longitude.toFixed(6)}`
    : "none"
  return `Identify this attached finished-JPEG preview, then call raw_photo_processor_finalize_metadata for job ${job.id}. Metadata targets the full-resolution PSD/JPEG. Source GPS: ${gps}. Source Description: ${entry.sourceDescription ?? "none"}. Creator: ${entry.creator ?? "none"}. Research this photo independently. Any named place requires locationDecision=verified and complete location fields; without source GPS/Description, also provide >90% inferredLocation. Otherwise use unverified and emit no place names. Never identify people or put coordinates in Description. Select applicable Scene codes only from this official local catalog: ${IPTC_SCENE_CATALOG}`
}

function metadataResult(job: Job, entry: JobEntry) {
  return {
    content: `Queued the actual finished JPEG as an image attachment for the next session turn. End this turn now and wait for the queued image message. Do not call finalize_metadata, cancel, apply, or start again until that message arrives.`,
  }
}

async function nextUnprocessed(job: Job) {
  while (job.index < job.entries.length) {
    const entry = job.entries[job.index]
    if (job.overwrite) return entry
    let psdExists = false
    let jpegExists = false
    try { await stat(entry.psd); psdExists = true } catch {}
    try { await stat(entry.jpeg); jpegExists = true } catch {}
    if (psdExists && jpegExists) {
      job.skipped.push({ raw: entry.raw, reason: "Complete PSD/JPEG pair already exists (overwrite=false)." })
      job.index += 1
      continue
    }
    if (psdExists !== jpegExists) {
      throw new Error(`Incomplete output pair for ${path.basename(entry.raw)}. Both ${entry.psd} and ${entry.jpeg} must exist, or remove/move the partial output before restarting.`)
    }
    return entry
  }
}

async function resumeAfterLastCompleted(job: Job) {
  if (job.overwrite || !job.entries.length) return undefined
  const psdDirectory = path.dirname(job.entries[0].psd)
  const jpegDirectory = path.dirname(job.entries[0].jpeg)
  const [psdItems, jpegItems] = await Promise.all([
    readdir(psdDirectory, { withFileTypes: true }),
    readdir(jpegDirectory, { withFileTypes: true }),
  ])
  const psdNames = new Set(psdItems.filter((item) => item.isFile()).map((item) => item.name.toLowerCase()))
  const jpegNames = new Set(jpegItems.filter((item) => item.isFile()).map((item) => item.name.toLowerCase()))
  let lastCompletedIndex = -1
  for (let index = job.entries.length - 1; index >= 0; index -= 1) {
    const entry = job.entries[index]
    if (psdNames.has(path.basename(entry.psd).toLowerCase()) && jpegNames.has(path.basename(entry.jpeg).toLowerCase())) {
      lastCompletedIndex = index
      break
    }
  }
  if (lastCompletedIndex < 0) return undefined
  for (let index = 0; index <= lastCompletedIndex; index += 1) {
    job.skipped.push({ raw: job.entries[index].raw, reason: "Before or at the last completed PSD/JPEG pair." })
  }
  job.index = lastCompletedIndex + 1
  return job.entries[lastCompletedIndex]
}

export default definePlugin({
  id: "raw-photo-processor",
  async setup(ctx) {
    const pluginDirectory = path.dirname(fileURLToPath(import.meta.url))
    const configuredModel = process.env.RAW_PHOTO_PROCESSOR_MODEL
      || (typeof ctx.options.model === "string" ? ctx.options.model : "openai/gpt-6-luna")
    const requested = configuredModel.split("/")
    const requestedProvider = requested.shift() ?? ""
    const requestedModel = requested.join("/")
    const configuredCompactionInterval = Number(process.env.RAW_PHOTO_PROCESSOR_COMPACT_EVERY ?? ctx.options.compactEvery ?? 8)
    const compactionInterval = Number.isFinite(configuredCompactionInterval)
      ? Math.min(50, Math.max(2, Math.round(configuredCompactionInterval)))
      : 8
    const configuredCompactionPressure = Number(process.env.RAW_PHOTO_PROCESSOR_COMPACT_AT ?? ctx.options.compactAt ?? 0.65)
    const compactionPressure = Number.isFinite(configuredCompactionPressure)
      ? Math.min(0.9, Math.max(0.4, configuredCompactionPressure))
      : 0.65
    const contextLimits = new Map<string, number>()

    const readSessionTokens = async (sessionID: string): Promise<TokenTotals> => {
      const session: any = await ctx.session.get({ sessionID })
      const tokens = session?.tokens
      return {
        input: Number(tokens?.input) || 0,
        output: Number(tokens?.output) || 0,
        reasoning: Number(tokens?.reasoning) || 0,
        cacheRead: Number(tokens?.cache?.read) || 0,
        cacheWrite: Number(tokens?.cache?.write) || 0,
      }
    }

    const readContextPressure = async (sessionID: string) => {
      try {
        const session: any = await ctx.session.get({ sessionID })
        const model = session?.model
        if (!model?.providerID || !model?.id) return undefined
        const modelKey = `${model.providerID}/${model.id}`
        let contextLimit = contextLimits.get(modelKey)
        if (!contextLimit) {
          const models: any[] = await ctx.model.list()
          contextLimit = Number(models.find((item) => item.providerID === model.providerID && item.id === model.id)?.limit?.context) || undefined
          if (contextLimit) contextLimits.set(modelKey, contextLimit)
        }
        if (!contextLimit) return undefined
        const messages: any[] = await ctx.session.context({ sessionID })
        const latest = [...messages].reverse().find((message) => message?.type === "assistant" && message.tokens)?.tokens
        if (!latest) return undefined
        const activeTokens = (Number(latest.input) || 0) + (Number(latest.cache?.read) || 0) + (Number(latest.cache?.write) || 0)
        return activeTokens / contextLimit
      } catch {
        return undefined
      }
    }

    const requestCompaction = async (sessionID: string) => {
      const compact = (ctx.session as any).compact
      try {
        if (typeof compact === "function") {
          await compact({ sessionID, delivery: "steer" })
        } else {
          const cli = process.env.OPENCODE_CLI || path.join(
            process.env.APPDATA ?? "",
            "ai.opencode.desktop", "cli", ctx.app.version, "opencode-cli.exe",
          )
          await stat(cli)
          await new Promise<void>((resolve, reject) => {
            const child = spawn(cli, [
              "api", "post", `/api/session/${sessionID}/compact`,
              "--data", JSON.stringify({ delivery: "steer" }),
            ], { windowsHide: true })
            let stdout = ""
            let stderr = ""
            child.stdout.on("data", (chunk) => { stdout += chunk })
            child.stderr.on("data", (chunk) => { stderr += chunk })
            child.once("error", reject)
            child.once("close", (code) => {
              if (code === 0) return resolve()
              reject(new Error((stderr || stdout || `OpenCode CLI exited with code ${code}`).trim()))
            })
          })
        }
        return "Context compaction requested."
      } catch (error: any) {
        return `Context compaction request failed: ${error?.message ?? String(error)}`
      }
    }

    const queuePreviewAttachments = async (sessionID: string, job: Job, message: string) => {
      const group = job.group ?? { type: "single" as const, indices: [job.index] }
      const entries = group.indices.map((index) => job.entries[index])
      await ctx.session.prompt({
        sessionID,
        delivery: "queue",
        text: `${currentPromptText(job, message)}\nThe JPEG preview files are attached as actual image content. Use the attached images, not their pathnames.`,
        files: entries.map((entry) => ({ uri: pathToFileURL(entry.preview).href })),
      })
    }

    await ctx.session.hook("context", (event) => {
      const jobID = sessionJobs.get(event.sessionID)
      const job = jobID ? jobs.get(jobID) : undefined
      const allowed = new Set(job
        ? [job.pending ? "raw_photo_processor_finalize_metadata" : "raw_photo_processor_apply", "raw_photo_processor_cancel"]
        : ["raw_photo_processor_start"])
      for (const name of Object.keys(event.tools)) {
        if (name.startsWith("raw_photo_processor_") && !allowed.has(name)) delete event.tools[name]
      }
    })

    await ctx.command.transform((editor) => {
      editor.add({
        name: "raw-photo-processor",
        description: "Process every RAW photo in one folder into PSD and maximum-quality JPEG files.",
        execute: async ({ sessionID, prompt, delivery }) => {
          const folder = prompt.text.trim()
          if (!folder) throw new Error("Provide one absolute folder path, for example: /raw-photo-processor C:\\Photos\\RAW")
          try {
            await ctx.session.switchModel({ sessionID, model: { providerID: requestedProvider, id: requestedModel } })
          } catch {
            await ctx.session.switchModel({ sessionID, model: { providerID: "openai", id: "gpt-5.6-terra" } })
          }
          await ctx.session.prompt({
            sessionID,
            delivery,
            text: `Process exactly ${JSON.stringify(folder)}. Call raw_photo_processor_start once. For every queued image message, inspect its attachments, call the one available RAW workflow tool, then end the turn whenever more attachments are queued. Preview stage: choose the best bracket frame, restrained Camera Raw corrections, crop, and required subtle photorealistic Photoshop finish. Finished-JPEG stage: identify/research that photo and finalize unique metadata. Never restart, copy another photo's metadata, identify people, or cancel unless explicitly asked. Continue until complete.`,
          })
        },
      })
    })

    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "raw_photo_processor",
        description: "AI-guided Adobe Camera Raw and Photoshop batch processing for a single local folder.",
      })

      editor.add({
        name: "start",
        description: "Start a non-recursive RAW processing job and return the first JPEG preview for visual assessment.",
        options: { namespace: "raw_photo_processor", codemode: true },
        input: {
          type: "object",
          additionalProperties: false,
          properties: {
            folder: { type: "string", description: "Absolute path to the one folder containing RAW images." },
            overwrite: { type: "boolean", description: "Replace existing PSD/JPEG outputs. Defaults to false." },
          },
          required: ["folder"],
        },
        execute: async (input: any, context) => {
          const activeJobID = sessionJobs.get(context.sessionID)
          if (activeJobID && jobs.has(activeJobID)) throw new Error("This session already has an active RAW processing job.")
          const folder = path.resolve(input.folder)
          const info = await stat(folder)
          if (!info.isDirectory()) throw new Error(`Not a folder: ${folder}`)
          const names = await readdir(folder)
          const raws = names
            .filter((name) => RAW_EXTENSIONS.has(path.extname(name).toLowerCase()))
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
          if (!raws.length) throw new Error(`No supported RAW images were found directly in ${folder}`)

          const counts = new Map<string, number>()
          for (const raw of raws) {
            const stem = path.parse(raw).name.toLowerCase()
            counts.set(stem, (counts.get(stem) ?? 0) + 1)
          }
          const id = randomUUID()
          const work = path.join(tmpdir(), "Raw_Photo_Processor", id)
          await mkdir(work, { recursive: true })
          await mkdir(path.join(folder, "PSDs"), { recursive: true })
          await mkdir(path.join(folder, "JPEGs"), { recursive: true })
          const entries = raws.map((name, index) => {
            const parsed = path.parse(name)
            const stem = counts.get(parsed.name.toLowerCase())! > 1
              ? `${parsed.name}_${parsed.ext.slice(1).toUpperCase()}`
              : parsed.name
            return {
              raw: path.join(folder, name),
              psd: path.join(folder, "PSDs", `${stem}.psd`),
              jpeg: path.join(folder, "JPEGs", `${stem}.jpg`),
              preview: path.join(work, `${String(index + 1).padStart(5, "0")}.jpg`),
              identificationPreview: path.join(work, `${String(index + 1).padStart(5, "0")}-finished.jpg`),
            }
          })
          const tokenBaseline = await readSessionTokens(context.sessionID)
          const job: Job = {
            id,
            sessionID: context.sessionID,
            folder,
            work,
            entries,
            index: 0,
            overwrite: input.overwrite === true,
            completed: [],
            skipped: [],
            descriptions: new Set(),
            keywordSets: new Set(),
            photoStartedAt: Date.now(),
            tokenBaseline,
            photosSinceCompaction: 0,
          }
          jobs.set(id, job)
          sessionJobs.set(context.sessionID, id)
          try {
            const lastCompleted = await resumeAfterLastCompleted(job)
            await nextUnprocessed(job)
            if (job.index >= job.entries.length) {
              jobs.delete(id)
              if (sessionJobs.get(context.sessionID) === id) sessionJobs.delete(context.sessionID)
              await rm(work, { recursive: true, force: true })
              return { content: `Nothing to process. ${job.skipped.length} image(s) skipped because outputs already exist.` }
            }
            await context.progress({ status: `Reading metadata and creating preview(s) at image ${job.index + 1} of ${entries.length}` })
            await prepareCurrent(pluginDirectory, job, context.signal)
            const resumeMessage = lastCompleted
              ? ` Last complete output pair: ${path.basename(lastCompleted.psd)} / ${path.basename(lastCompleted.jpeg)}; resuming with the next photo.`
              : ""
            const message = `Found ${entries.length} RAW image(s). Existing outputs are ${job.overwrite ? "replaced" : "skipped"}.${resumeMessage}`
            await queuePreviewAttachments(context.sessionID, job, message)
            return currentResult(job, message)
          } catch (error) {
            jobs.delete(id)
            if (sessionJobs.get(context.sessionID) === id) sessionJobs.delete(context.sessionID)
            await rm(work, { recursive: true, force: true })
            throw error
          }
        },
      })

      editor.add({
        name: "apply",
        description: "Apply image adjustments and save PSD/JPEG without generated metadata, then return the finished JPEG for identification.",
        options: { namespace: "raw_photo_processor", codemode: true },
        input: {
          type: "object",
          additionalProperties: false,
          properties: {
            jobID: { type: "string" },
            selectedOffset: { type: "integer", minimum: 0, maximum: 4, description: "For a five-shot bracket set, the 0-based preview offset with the best exposure. Use 0 for a normal single image." },
            edit: ADJUSTMENT_SCHEMA,
          },
          required: ["jobID", "edit"],
        },
        execute: async (input: { jobID: string; selectedOffset?: number; edit: Edit }, context) => {
          const job = jobs.get(input.jobID)
          if (!job) throw new Error("Unknown or completed RAW processing job.")
          if (job.sessionID !== context.sessionID) throw new Error("This RAW processing job belongs to another session.")
          if (job.pending) throw new Error("Finalize metadata for the already-saved JPEG before processing another image.")
          const group = job.group ?? { type: "single" as const, indices: [job.index] }
          const selectedOffset = group.type === "bracket" ? input.selectedOffset : 0
          if (group.type === "bracket" && (!Number.isInteger(selectedOffset) || selectedOffset! < 0 || selectedOffset! > 4)) {
            throw new Error("Select the best bracket exposure with selectedOffset 0-4.")
          }
          const selectedIndex = group.indices[selectedOffset ?? 0]
          const entry = job.entries[selectedIndex]
          await context.progress({ status: `Processing selected exposure ${path.basename(entry.raw)} (${selectedIndex + 1}/${job.entries.length})` })
          await applyEdit(pluginDirectory, entry, input.edit, job.overwrite, context.signal)
          job.pending = { group, selectedIndex }
          // Code Mode can reduce rich tool output to a pathname. Queue the finished
          // JPEG as a real session attachment so the next model turn receives image
          // pixels and the workflow resumes automatically after this tool call.
          await ctx.session.prompt({
            sessionID: context.sessionID,
            delivery: "queue",
            text: metadataPromptText(job, entry),
            files: [{ uri: pathToFileURL(entry.identificationPreview).href }],
          })
          return metadataResult(job, entry)
        },
      })

      editor.add({
        name: "finalize_metadata",
        description: "After visually identifying the finished JPEG, update metadata on both the already-saved PSD and JPEG, then continue the batch.",
        options: { namespace: "raw_photo_processor", codemode: true },
        input: {
          type: "object",
          additionalProperties: false,
          properties: {
            jobID: { type: "string" },
            metadata: METADATA_SCHEMA,
          },
          required: ["jobID", "metadata"],
        },
        execute: async (input: { jobID: string; metadata: Edit }, context) => {
          const job = jobs.get(input.jobID)
          if (!job) throw new Error("Unknown or completed RAW processing job.")
          if (job.sessionID !== context.sessionID) throw new Error("This RAW processing job belongs to another session.")
          if (!job.pending) throw new Error("Process and save an image before finalizing its metadata.")
          const { group, selectedIndex } = job.pending
          const entry = job.entries[selectedIndex]
          const edit = input.metadata
          const keywords = [...new Set((edit.keywords ?? []).map((keyword) => keyword.trim()).filter(Boolean))]
          if (!keywords.length) throw new Error("Provide at least one non-identifying subject keyword for the selected image.")
          const inferred = edit.inferredLocation
          if (inferred && entry.gps) throw new Error("Do not infer landmark GPS when the source already contains GPS coordinates.")
          if (inferred && (!(inferred.confidence > 0.9) || !Number.isFinite(inferred.latitude) || !Number.isFinite(inferred.longitude))) {
            throw new Error("Inferred landmark location requires confidence greater than 0.90 and valid verified coordinates.")
          }
          const location = edit.location
          const locationDecision = edit.locationDecision
          if (locationDecision !== "verified" && locationDecision !== "unverified") {
            throw new Error("Set locationDecision to verified or unverified for this photo.")
          }
          const descriptionLocation = Boolean(entry.sourceDescription?.trim() && location)
          const hasKnownLocation = Boolean(location && (entry.gps || inferred || descriptionLocation))
          if (locationDecision === "verified" && !location) {
            throw new Error("A verified location decision requires complete structured location metadata.")
          }
          if (locationDecision === "verified" && !entry.gps && !entry.sourceDescription?.trim() && !inferred) {
            throw new Error("A visually verified location without source GPS or source Description requires inferredLocation above 90% confidence with verified coordinates.")
          }
          if (locationDecision === "unverified" && (location || inferred || edit.description?.trim())) {
            throw new Error("An unverified location decision must omit inferredLocation, structured location fields, and location Description.")
          }
          if (inferred && !location) throw new Error("A verified inferred location requires complete structured location metadata.")
          if (inferred && !location?.sublocation?.trim()) throw new Error("A verified inferred landmark requires its specific name in Sublocation.")
          if (location) {
            const fields = [location.city, location.stateProvince, location.country, location.isoCountryCode]
            if (fields.some((field) => typeof field !== "string" || !field.trim())) {
              throw new Error("Location metadata requires non-empty City, State/Province, Country, and ISO Country Code fields.")
            }
            if (!/^[A-Za-z]{3}$/.test(location.isoCountryCode.trim())) {
              throw new Error("ISO Country Code must be an ISO 3166-1 alpha-3 code such as USA, CAN, GBR, or FRA.")
            }
            if (!entry.gps && !inferred && !entry.sourceDescription?.trim()) {
              throw new Error("Do not add location fields without source GPS, a verified inferred landmark, or a source Description establishing the location.")
            }
            const sublocation = location.sublocation?.trim()
            if (sublocation && !(typeof location.sublocationConfidence === "number" && location.sublocationConfidence > 0.9)) {
              throw new Error("Sublocation from image recognition requires confidence strictly greater than 0.90.")
            }
            if (!sublocation && location.sublocationConfidence !== undefined) {
              throw new Error("Do not provide sublocationConfidence when Sublocation is blank.")
            }
          }
          if (hasKnownLocation && !edit.description?.trim()) {
            throw new Error("A verified location requires a location-informed, non-identifying Description.")
          }
          if (!hasKnownLocation && edit.description?.trim()) {
            throw new Error("Omit Description when an exact location cannot be verified and structured location metadata is blank.")
          }
          if (edit.description && descriptionContainsCoordinates(edit.description)) {
            throw new Error("Description must not contain GPS coordinates, latitude/longitude labels, or coordinate notation.")
          }
          if ((edit.iptcSceneCodes ?? []).some((code) => !IPTC_SCENE_CODES.has(code))) {
            throw new Error("Every IPTC Scene Code must come from the official local Scene-NewsCodes catalog.")
          }
          const descriptionFingerprint = edit.description?.trim() ? normalizeMetadataText(edit.description) : undefined
          const keywordsFingerprint = keywordFingerprint(keywords)
          if (descriptionFingerprint && job.descriptions.has(descriptionFingerprint)) {
            throw new Error("This Description duplicates an earlier processed photo. Provide a unique, photo-specific Description.")
          }
          if (job.keywordSets.has(keywordsFingerprint)) {
            throw new Error("This complete keyword set duplicates an earlier processed photo. Provide a unique, photo-specific keyword set.")
          }
          await context.progress({ status: `Updating metadata after JPEG save: ${path.basename(entry.jpeg)}` })
          await updateOutputMetadata(pluginDirectory, entry, edit, context.signal)
          if (descriptionFingerprint) job.descriptions.add(descriptionFingerprint)
          job.keywordSets.add(keywordsFingerprint)
          job.completed.push({ raw: entry.raw, psd: entry.psd, jpeg: entry.jpeg })
          if (group.type === "bracket") {
            for (const index of group.indices) {
              if (index !== selectedIndex) job.skipped.push({ raw: job.entries[index].raw, reason: `Bracket alternate; selected ${path.basename(entry.raw)}.` })
            }
          }
          job.index = group.indices[group.indices.length - 1] + 1
          job.group = undefined
          job.pending = undefined
          const elapsed = Date.now() - job.photoStartedAt
          const currentTokens = await readSessionTokens(context.sessionID)
          const used = tokenDelta(currentTokens, job.tokenBaseline)
          const billableTotal = used.input + used.output + used.reasoning
          job.tokenBaseline = currentTokens
          job.photosSinceCompaction += 1
          await nextUnprocessed(job)
          const finished = job.index >= job.entries.length
          const contextPressure = finished ? undefined : await readContextPressure(context.sessionID)
          let compactionStatus = "Context compaction not needed; batch complete."
          if (!finished && (job.photosSinceCompaction >= compactionInterval || (contextPressure ?? 0) >= compactionPressure)) {
            compactionStatus = await requestCompaction(context.sessionID)
            if (compactionStatus === "Context compaction requested.") job.photosSinceCompaction = 0
          } else if (!finished) {
            const pressure = contextPressure === undefined ? "context pressure unavailable" : `${Math.round(contextPressure * 100)}% context pressure`
            compactionStatus = `Context compaction deferred (${job.photosSinceCompaction}/${compactionInterval} photos; ${pressure}).`
          }
          const performance = `Photo report — time: ${formatDuration(elapsed)}; recorded tokens: ${billableTotal.toLocaleString()} total (${used.input.toLocaleString()} input, ${used.output.toLocaleString()} output, ${used.reasoning.toLocaleString()} reasoning; cache ${used.cacheRead.toLocaleString()} read/${used.cacheWrite.toLocaleString()} write). ${compactionStatus}`
          if (finished) {
            jobs.delete(job.id)
            if (sessionJobs.get(context.sessionID) === job.id) sessionJobs.delete(context.sessionID)
            await rm(job.work, { recursive: true, force: true })
            return {
              content: `${performance}\nRAW processing complete. Created ${job.completed.length} PSD/JPEG pair(s); skipped ${job.skipped.length}.\nPSD files: ${path.join(job.folder, "PSDs")}\nJPEG files: ${path.join(job.folder, "JPEGs")}`,
            }
          }
          job.photoStartedAt = Date.now()
          await context.progress({ status: `Reading metadata and creating preview(s) at image ${job.index + 1} of ${job.entries.length}` })
          await prepareCurrent(pluginDirectory, job, context.signal)
          const message = `Metadata updated after save for ${path.basename(entry.psd)} and JPEGs/${path.basename(entry.jpeg)}.\n${performance}`
          await queuePreviewAttachments(context.sessionID, job, message)
          return currentResult(job, message)
        },
      })

      editor.add({
        name: "cancel",
        description: "Cancel only when the user explicitly requests cancellation. Never use this while waiting for queued image attachments or after a temporary visual-access delay.",
        options: { namespace: "raw_photo_processor", codemode: true },
        input: {
          type: "object",
          additionalProperties: false,
          properties: { jobID: { type: "string" } },
          required: ["jobID"],
        },
        execute: async (input: { jobID: string }, context) => {
          const job = jobs.get(input.jobID)
          if (!job) return { content: "Job is already completed, cancelled, or unknown." }
          if (job.sessionID !== context.sessionID) throw new Error("This RAW processing job belongs to another session.")
          jobs.delete(input.jobID)
          if (sessionJobs.get(job.sessionID) === input.jobID) sessionJobs.delete(job.sessionID)
          await rm(job.work, { recursive: true, force: true })
          return { content: `Cancelled job ${input.jobID}. Completed output files were retained.` }
        },
      })
    })

    return async () => {
      await Promise.all([...jobs.values()].map((job) => rm(job.work, { recursive: true, force: true })))
      jobs.clear()
      sessionJobs.clear()
    }
  },
})
