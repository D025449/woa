import { decodeAnalyticsOverview } from "../../shared/AnalyticsOverviewCodec.js";

const overviewRequests = new Map();

function normalizeGrouping(grouping) {
  const value = String(grouping || "").replace(/^year_/u, "");
  return ["week", "month", "quarter", "year"].includes(value) ? value : "month";
}

export async function loadAnalyticsOverview(grouping) {
  const sharedGrouping = normalizeGrouping(grouping);
  const pending = overviewRequests.get(sharedGrouping);
  if (pending) return pending;

  const request = fetch(`/files/analytics-overview?grouping=${sharedGrouping}`)
    .then(async (response) => {
      if (response.status === 401) {
        window.location.href = "/login";
        return null;
      }
      if (!response.ok) {
        throw new Error(`Analytics load failed (${response.status})`);
      }
      return decodeAnalyticsOverview(await response.arrayBuffer());
    });
  overviewRequests.set(sharedGrouping, request);

  try {
    return await request;
  } finally {
    if (overviewRequests.get(sharedGrouping) === request) {
      overviewRequests.delete(sharedGrouping);
    }
  }
}
