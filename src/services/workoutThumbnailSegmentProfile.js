import { load } from "cheerio";
import { buildSegmentHeaderLayout, buildMicroIntervalPhaseAreas, getSegmentColor,
  getSegmentVisibilityKey } from "../shared/SegmentAppearance.js";
import Utils from "../shared/Utils.js";

export function buildThumbnailSegmentProfile(profileSvg, segments, recordCount,
  { showPhases = true, compact = false } = {}) {
  const lastIndex = Number(recordCount) - 1;
  if (!Number.isFinite(lastIndex) || lastIndex < 1) return profileSvg;
  const visible = (segments || []).filter(segment => {
    if (!segment || segment.rowstate === "DEL" || segment.isGPSSegment || segment.segmenttype === "gps") return false;
    const structured = ["intervals", "microintervals"].includes(segment.structure_kind);
    if (!(structured && ["auto", "manual"].includes(segment.segmenttype)
      || segment.segmenttype === "manual" && (!segment.structure_kind || segment.structure_kind === "simple"))) return false;
    const start = Number(segment.start_offset);
    const end = Number(segment.end_offset);
    return segment.start_offset != null && segment.end_offset != null
      && Number.isFinite(start) && Number.isFinite(end) && end > start && start <= lastIndex && end >= 0;
  });
  if (!visible.length) return profileSvg;
  const profile = load(profileSvg, { xml: true });
  const root = profile("svg").first();
  if (root.attr("data-thumbnail-segments")) return profileSvg;
  const bands = root.find("[data-band]").length;
  if (!bands) throw new Error("Band profile required");
  const { items, laneCount } = buildSegmentHeaderLayout({ segments: visible, maxLanes: 4 });
  const headerHeight = 8 + laneCount * 7;
  const position = value => 18 + Math.max(0, Math.min(lastIndex, Number(value))) / lastIndex * 220;
  const areas = [];
  const headers = items.map(({ segment, start, end, lane }) => {
    const key = getSegmentVisibilityKey(segment);
    const color = getSegmentColor(segment);
    const structured = ["intervals", "microintervals"].includes(segment.structure_kind);
    const endExclusive = structured ? end + 1 : end;
    const left = position(start);
    const width = Math.max(0, position(endExclusive) - left);
    const phaseAreas = showPhases ? buildMicroIntervalPhaseAreas(segment) : [];
    const spans = phaseAreas.length ? phaseAreas : [[
      { xAxis: start, itemStyle: { color: getSegmentColor(segment, "area"), opacity: 1 } },
      { xAxis: endExclusive }
    ]];
    for (const span of spans) {
      const spanStart = Math.max(start, Number(span[0].xAxis));
      const spanEnd = Math.min(endExclusive, Number(span[1].xAxis));
      if (!Number.isFinite(spanStart) || !Number.isFinite(spanEnd) || spanEnd <= spanStart) continue;
      for (let band = 0; band < bands; band += 1) {
        const height = 152 / bands;
        areas.push(`<rect data-segment-area="${key}"${phaseAreas.length ? ` data-phase-opacity="${span[0].itemStyle.opacity}"` : ""} x="${position(spanStart)}" y="${4 + band * height + (compact ? 2 : 14)}" width="${Math.max(0, position(spanEnd) - position(spanStart))}" height="${height - (compact ? 6 : 18)}" fill="${span[0].itemStyle.color}" fill-opacity="${span[0].itemStyle.opacity}"/>`);
      }
    }
    const label = compact ? null : Utils.getSegmentShortLabel(segment);
    const labelNode = load('<text xmlns="http://www.w3.org/2000/svg"/>', { xml: true });
    labelNode("text").attr({ x: String(left + 3), y: String(8 + lane * 7), fill: "#ffffff", "font-family": "sans-serif", "font-size": "5" }).text(label || "");
    const labelWidth = String(label || "").length * 3 + 6;
    return `<g data-segment-header="${key}" data-segment-lane="${lane}"><rect x="${left}" y="${4 + lane * 7}" width="${width}" height="5" rx="2" fill="${color}" fill-opacity="0.52"/>${label && width >= labelWidth ? labelNode.xml() : ""}</g>`;
  }).join("");
  root.children("[data-band]").first().before(`<g data-thumbnail-segment-areas="1">${areas.join("")}</g>`);
  const body = root.html();
  const background = compact ? "" : '<rect width="256" height="160" fill="#f8fafc"/>';
  root.attr("data-thumbnail-segments", "1").html(`${background}${headers}<svg data-segment-profile="1" y="${headerHeight}" width="256" height="${160 - headerHeight}" viewBox="0 0 256 160" preserveAspectRatio="none">${body}</svg>`);
  return profile.xml();
}