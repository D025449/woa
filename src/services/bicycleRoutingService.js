const DEFAULT_BICYCLE_ROUTING_URL =
  "https://routing.openstreetmap.de/routed-bike/route/v1/driving";

function createRoutingError(message, statusCode, details = {}) {
  const error = new Error(message);
  error.statusCode = statusCode;
  Object.assign(error, details);
  return error;
}

export async function fetchBicycleRoute(points, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const baseUrl = String(
    options.baseUrl ?? process.env.OSRM_BICYCLE_ROUTING_URL ?? DEFAULT_BICYCLE_ROUTING_URL
  ).replace(/\/+$/, "");
  const coordinates = points
    .map((point) => `${point.lng},${point.lat}`)
    .join(";");
  const url = `${baseUrl}/${coordinates}?overview=full&geometries=geojson`;

  const response = await fetchImpl(url);
  let data;

  try {
    data = await response.json();
  } catch {
    throw createRoutingError(`Bicycle route lookup returned invalid JSON (${response.status})`, 502, {
      upstreamStatus: response.status
    });
  }

  const upstreamCode = data?.code;
  if (!response.ok || (upstreamCode && upstreamCode !== "Ok")) {
    const noRoute = upstreamCode === "NoRoute" || upstreamCode === "NoSegment";
    throw createRoutingError(
      data?.message || (noRoute ? "No bicycle route found" : "Bicycle route lookup failed"),
      noRoute ? 404 : 502,
      {
        upstreamStatus: response.status,
        upstreamCode
      }
    );
  }

  const route = data?.routes?.[0];
  if (!route) {
    throw createRoutingError("No bicycle route found", 404, {
      upstreamStatus: response.status,
      upstreamCode
    });
  }

  return route;
}

