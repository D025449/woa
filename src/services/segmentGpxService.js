import { buildGpxRoutingAnchors, parseGpxTrack } from "./gpxTrackService.js";

const MAX_SEGMENTS = 5000;
const MAX_TOTAL_POINTS = 100000;

export class SegmentGpxValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "SegmentGpxValidationError";
    this.statusCode = 400;
  }
}

function escapeXml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

function decodeXml(value) {
  return String(value ?? "")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, decimal) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replaceAll("&apos;", "'")
    .replaceAll("&quot;", "\"")
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

function elementText(xml, localName) {
  const expression = new RegExp(
    `<(?:[\\w.-]+:)?${localName}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${localName}\\s*>`,
    "i"
  );
  const value = xml.match(expression)?.[1];
  return value == null ? null : decodeXml(value.replace(/<[^>]+>/g, "")).trim() || null;
}

function finiteNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function segmentLabel(segment, index) {
  const id = segment.id ?? segment.sourceId ?? index + 1;
  const start = String(segment.start?.name || "").trim();
  const end = String(segment.end?.name || "").trim();
  const routeName = start && end ? `${start} - ${end}` : `Segment S-${id}`;
  return { id, routeName };
}

function serializeTrackPoint(point) {
  const elevation = finiteNumber(point?.ele);
  return elevation === null
    ? `      <trkpt lat="${Number(point.lat)}" lon="${Number(point.lng)}"/>`
    : `      <trkpt lat="${Number(point.lat)}" lon="${Number(point.lng)}"><ele>${elevation}</ele></trkpt>`;
}

export function buildSegmentGpx(segments, exportedAt = new Date()) {
  const tracks = (Array.isArray(segments) ? segments : []).map((segment, index) => {
    const { id, routeName } = segmentLabel(segment, index);
    const startName = String(segment.start?.name || "").trim();
    const endName = String(segment.end?.name || "").trim();
    const duration = finiteNumber(segment.duration, 0);
    const ascent = finiteNumber(segment.ascent, 0);
    const startAltitude = finiteNumber(segment.start?.altitude, finiteNumber(segment.track?.[0]?.ele));
    const endAltitude = finiteNumber(
      segment.end?.altitude,
      finiteNumber(segment.track?.[segment.track.length - 1]?.ele)
    );
    const points = (Array.isArray(segment.track) ? segment.track : [])
      .filter((point) => Number.isFinite(Number(point?.lat)) && Number.isFinite(Number(point?.lng)))
      .map(serializeTrackPoint)
      .join("\n");

    return [
      "  <trk>",
      `    <name>${escapeXml(routeName)}</name>`,
      "    <extensions>",
      `      <woa:sourceId>${escapeXml(id)}</woa:sourceId>`,
      `      <woa:startName>${escapeXml(startName)}</woa:startName>`,
      `      <woa:endName>${escapeXml(endName)}</woa:endName>`,
      `      <woa:duration>${duration}</woa:duration>`,
      `      <woa:ascent>${ascent}</woa:ascent>`,
      startAltitude === null ? "" : `      <woa:startAltitude>${startAltitude}</woa:startAltitude>`,
      endAltitude === null ? "" : `      <woa:endAltitude>${endAltitude}</woa:endAltitude>`,
      "    </extensions>",
      "    <trkseg>",
      points,
      "    </trkseg>",
      "  </trk>"
    ].join("\n");
  });

  return [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<gpx version=\"1.1\" creator=\"WOA\"",
    "  xmlns=\"http://www.topografix.com/GPX/1/1\"",
    "  xmlns:woa=\"https://cwa24.com/xmlns/gpx/segments/1\"",
    "  xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\"",
    "  xsi:schemaLocation=\"http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd\">",
    "  <metadata>",
    `    <time>${escapeXml(exportedAt.toISOString())}</time>`,
    "  </metadata>",
    ...tracks,
    "</gpx>",
    ""
  ].join("\n");
}

function extractBlocks(xml, elementName) {
  const expression = new RegExp(
    `<(?:[\\w.-]+:)?${elementName}\\b[^>]*>[\\s\\S]*?<\\/(?:[\\w.-]+:)?${elementName}\\s*>`,
    "gi"
  );
  return [...xml.matchAll(expression)].map((match) => match[0]);
}

function parseBlock(block, kind, index) {
  let parsed;
  try {
    parsed = parseGpxTrack(`<gpx>${block}</gpx>`);
  } catch (error) {
    throw new SegmentGpxValidationError(`GPX ${kind} ${index + 1}: ${error.message}`);
  }

  const sourceId = elementText(block, "sourceId");
  const startName = elementText(block, "startName");
  const endName = elementText(block, "endName");
  const name = elementText(block, "name");
  const duration = finiteNumber(elementText(block, "duration"), 0);
  const ascent = finiteNumber(elementText(block, "ascent"));
  const startAltitude = finiteNumber(elementText(block, "startAltitude"));
  const endAltitude = finiteNumber(elementText(block, "endAltitude"));

  return {
    kind,
    sourceId,
    name,
    startName,
    endName,
    duration,
    ascent,
    startAltitude,
    endAltitude,
    points: parsed.points,
    distanceMeters: parsed.distanceMeters,
    hasUsableElevation: parsed.hasUsableElevation,
    routingAnchors: kind === "route"
      ? buildGpxRoutingAnchors(parsed.points)
      : null
  };
}

export function parseSegmentGpx(input) {
  const xml = Buffer.isBuffer(input) ? input.toString("utf8") : String(input || "");
  if (!/<(?:[\w.-]+:)?gpx\b/i.test(xml)) {
    throw new SegmentGpxValidationError("The uploaded file is not a GPX document");
  }

  const trackBlocks = extractBlocks(xml, "trk");
  const routeBlocks = extractBlocks(xml, "rte");
  const blocks = trackBlocks.length > 0
    ? trackBlocks.map((block) => ({ block, kind: "track" }))
    : routeBlocks.map((block) => ({ block, kind: "route" }));

  if (blocks.length === 0) {
    throw new SegmentGpxValidationError("GPX contains no usable tracks or routes");
  }
  if (blocks.length > MAX_SEGMENTS) {
    throw new SegmentGpxValidationError(`GPX contains more than ${MAX_SEGMENTS} segments`);
  }

  const segments = blocks.map(({ block, kind }, index) => parseBlock(block, kind, index));
  const totalPoints = segments.reduce((sum, segment) => sum + segment.points.length, 0);
  if (totalPoints > MAX_TOTAL_POINTS) {
    throw new SegmentGpxValidationError(`GPX contains more than ${MAX_TOTAL_POINTS} points`);
  }
  return segments;
}

export const SEGMENT_GPX_MAX_BYTES = 25 * 1024 * 1024;
