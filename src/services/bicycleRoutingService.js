const DEFAULT_OSRM_BICYCLE_ROUTING_URL =
  "https://routing.openstreetmap.de/routed-bike/route/v1/driving";
const DEFAULT_VALHALLA_BICYCLE_ROUTING_URL =
  "https://valhalla1.openstreetmap.de/route";
const DEFAULT_VALHALLA_CLIENT_ID = "cwa24";
const DEFAULT_VALHALLA_MAX_LOCATIONS = 50;
const ROAD_DETOUR_MAX_DIRECT_METERS = 250;
const ROAD_DETOUR_MIN_ROUTE_METERS = 400;
const ROAD_DETOUR_MIN_RATIO = 4;
const ROAD_DETOUR_MAX_BICYCLE_RATIO = 2.5;

const VALHALLA_PROFILE_OPTIONS = Object.freeze({
  road: {
    costing: "auto",
    maxLocations: 20,
    options: {
      exclude_highways: true,
      exclude_unpaved: true,
      use_tracks: 0,
      service_penalty: 300,
      service_factor: 20
    }
  },
  mountain: {
    costing: "bicycle",
    maxLocations: DEFAULT_VALHALLA_MAX_LOCATIONS,
    options: {
      bicycle_type: "mountain",
      avoid_bad_surfaces: 0.1,
      use_roads: 0.2
    }
  },
  hybrid: {
    costing: "bicycle",
    maxLocations: DEFAULT_VALHALLA_MAX_LOCATIONS,
    options: {
      bicycle_type: "hybrid",
      avoid_bad_surfaces: 0.5,
      use_roads: 0.5
    }
  }
});

function createRoutingError(message, statusCode, details = {}) {
  const error = new Error(message);
  error.statusCode = statusCode;
  Object.assign(error, details);
  return error;
}

function normalizeProvider(value) {
  const provider = String(value || "").trim().toLowerCase();
  return provider === "osrm" ? "osrm" : "valhalla";
}

function normalizeProfile(value) {
  const profile = String(value || "").trim().toLowerCase();
  return Object.hasOwn(VALHALLA_PROFILE_OPTIONS, profile) ? profile : "road";
}

function decodePolyline6(encoded) {
  if (typeof encoded !== "string" || encoded.length === 0) {
    return [];
  }

  const coordinates = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    const deltas = [];
    for (let coordinateIndex = 0; coordinateIndex < 2; coordinateIndex += 1) {
      let result = 0;
      let shift = 0;
      let byte;

      do {
        if (index >= encoded.length) {
          throw createRoutingError("Valhalla returned an invalid route shape", 502);
        }
        byte = encoded.charCodeAt(index) - 63;
        index += 1;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);

      deltas.push(result & 1 ? ~(result >> 1) : result >> 1);
    }

    lat += deltas[0];
    lng += deltas[1];
    coordinates.push([lng / 1e6, lat / 1e6]);
  }

  return coordinates;
}

function haversineMeters(a, b) {
  const toRadians = (value) => (value * Math.PI) / 180;
  const dLat = toRadians(Number(b.lat) - Number(a.lat));
  const dLng = toRadians(Number(b.lng) - Number(a.lng));
  const lat1 = toRadians(Number(a.lat));
  const lat2 = toRadians(Number(b.lat));
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const value = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
  return 6371000 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function appendCoordinates(target, source) {
  const coordinates = [...source];
  if (
    target.length > 0 &&
    coordinates.length > 0 &&
    target.at(-1)[0] === coordinates[0][0] &&
    target.at(-1)[1] === coordinates[0][1]
  ) {
    coordinates.shift();
  }
  target.push(...coordinates);
}

async function readJsonResponse(response, provider) {
  try {
    return await response.json();
  } catch {
    throw createRoutingError(
      `${provider} bicycle route lookup returned invalid JSON (${response.status})`,
      502,
      {
        provider,
        upstreamStatus: response.status
      }
    );
  }
}

async function fetchOsrmRoute(points, options) {
  const baseUrl = String(
    options.osrmBaseUrl ??
      options.baseUrl ??
      process.env.OSRM_BICYCLE_ROUTING_URL ??
      DEFAULT_OSRM_BICYCLE_ROUTING_URL
  ).replace(/\/+$/, "");
  const coordinates = points
    .map((point) => `${point.lng},${point.lat}`)
    .join(";");
  const url = `${baseUrl}/${coordinates}?overview=full&geometries=geojson`;

  const response = await options.fetchImpl(url);
  const data = await readJsonResponse(response, "OSRM");
  const upstreamCode = data?.code;

  if (!response.ok || (upstreamCode && upstreamCode !== "Ok")) {
    const noRoute = upstreamCode === "NoRoute" || upstreamCode === "NoSegment";
    throw createRoutingError(
      data?.message || (noRoute ? "No bicycle route found" : "Bicycle route lookup failed"),
      noRoute ? 404 : 502,
      {
        provider: "osrm",
        upstreamStatus: response.status,
        upstreamCode
      }
    );
  }

  const route = data?.routes?.[0];
  if (!route) {
    throw createRoutingError("No bicycle route found", 404, {
      provider: "osrm",
      upstreamStatus: response.status,
      upstreamCode
    });
  }

  return {
    ...route,
    provider: "osrm"
  };
}

function splitRoutePoints(points, maxLocations) {
  const chunks = [];
  let start = 0;

  while (start < points.length - 1) {
    const end = Math.min(start + maxLocations, points.length);
    chunks.push(points.slice(start, end));
    start = end - 1;
  }

  return chunks;
}

async function fetchValhallaRouteChunk(points, options) {
  const profileConfig = VALHALLA_PROFILE_OPTIONS[options.profile];
  const request = {
    locations: points.map((point) => ({
      lat: Number(point.lat),
      lon: Number(point.lng)
    })),
    costing: profileConfig.costing,
    costing_options: {
      [profileConfig.costing]: profileConfig.options
    },
    units: "kilometers",
    shape_format: "polyline6",
    directions_type: "none"
  };
  const url = new URL(options.baseUrl);
  url.searchParams.set("json", JSON.stringify(request));

  const response = await options.fetchImpl(url.toString(), {
    headers: options.clientId ? { "X-Client-Id": options.clientId } : undefined
  });
  const data = await readJsonResponse(response, "Valhalla");

  if (!response.ok || data?.error || data?.error_code) {
    const upstreamCode = data?.error_code ?? data?.status_code;
    const noRoute = upstreamCode === 442 || upstreamCode === 443;
    const statusCode = noRoute ? 404 : response.status >= 500 ? 502 : 400;
    throw createRoutingError(
      data?.error || (noRoute ? "No bicycle route found" : "Bicycle route lookup failed"),
      statusCode,
      {
        provider: "valhalla",
        upstreamStatus: response.status,
        upstreamCode
      }
    );
  }

  const coordinates = [];
  const legs = (Array.isArray(data?.trip?.legs) ? data.trip.legs : []).map((leg) => ({
    distance: Number(leg?.summary?.length || 0) * 1000,
    duration: Number(leg?.summary?.time || 0),
    coordinates: decodePolyline6(leg?.shape)
  }));
  for (const leg of legs) {
    appendCoordinates(coordinates, leg.coordinates);
  }

  if (coordinates.length < 2) {
    throw createRoutingError("No bicycle route found", 404, {
      provider: "valhalla",
      upstreamStatus: response.status
    });
  }

  return {
    distance: Number(data?.trip?.summary?.length || 0) * 1000,
    duration: Number(data?.trip?.summary?.time || 0),
    coordinates,
    legs,
    requestCount: 1
  };
}

async function repairShortRoadDetours(points, route, options) {
  if (
    options.profile !== "road" ||
    route.legs.length !== points.length - 1
  ) {
    return route;
  }

  let distance = route.distance;
  let duration = route.duration;
  let requestCount = route.requestCount;
  const legs = [...route.legs];

  for (let index = 0; index < legs.length; index += 1) {
    const directDistance = haversineMeters(points[index], points[index + 1]);
    const roadDistance = legs[index].distance;
    const isExtremeShortDetour =
      directDistance <= ROAD_DETOUR_MAX_DIRECT_METERS &&
      roadDistance >= ROAD_DETOUR_MIN_ROUTE_METERS &&
      roadDistance >= directDistance * ROAD_DETOUR_MIN_RATIO;

    if (!isExtremeShortDetour) {
      continue;
    }

    try {
      const bicycleRoute = await fetchValhallaRouteChunk(
        points.slice(index, index + 2),
        { ...options, profile: "hybrid", repairRoadDetours: false }
      );
      requestCount += bicycleRoute.requestCount;
      const bicycleDistance = bicycleRoute.distance;
      const isPlausibleRepair =
        bicycleDistance < roadDistance / 2 &&
        bicycleDistance <= directDistance * ROAD_DETOUR_MAX_BICYCLE_RATIO;

      if (!isPlausibleRepair) {
        continue;
      }

      distance += bicycleDistance - roadDistance;
      duration += bicycleRoute.duration - legs[index].duration;
      legs[index] = {
        distance: bicycleDistance,
        duration: bicycleRoute.duration,
        coordinates: bicycleRoute.coordinates
      };
    } catch {
      // A failed optional repair must not invalidate the valid road route.
    }
  }

  const coordinates = [];
  for (const leg of legs) {
    appendCoordinates(coordinates, leg.coordinates);
  }

  return {
    ...route,
    distance,
    duration,
    coordinates,
    legs,
    requestCount
  };
}

async function fetchValhallaRoute(points, options) {
  const profile = normalizeProfile(
    options.profile ?? process.env.BICYCLE_ROUTING_PROFILE
  );
  const baseUrl = String(
    options.valhallaBaseUrl ??
      options.baseUrl ??
      process.env.VALHALLA_BICYCLE_ROUTING_URL ??
      DEFAULT_VALHALLA_BICYCLE_ROUTING_URL
  ).replace(/\/+$/, "");
  const clientId = String(
    options.clientId ??
      process.env.VALHALLA_CLIENT_ID ??
      DEFAULT_VALHALLA_CLIENT_ID
  ).trim();
  const configuredMaxLocations = Number(
    options.maxLocations ??
      process.env.VALHALLA_MAX_LOCATIONS ??
      DEFAULT_VALHALLA_MAX_LOCATIONS
  );
  const profileMaxLocations = VALHALLA_PROFILE_OPTIONS[profile].maxLocations;
  const maxLocations = Number.isFinite(configuredMaxLocations)
    ? Math.max(2, Math.min(profileMaxLocations, Math.trunc(configuredMaxLocations)))
    : profileMaxLocations;
  const chunks = splitRoutePoints(points, maxLocations);
  const coordinates = [];
  let distance = 0;
  let duration = 0;
  let requestCount = 0;

  for (const chunk of chunks) {
    const routeOptions = {
      baseUrl,
      clientId,
      fetchImpl: options.fetchImpl,
      profile
    };
    const rawRoute = await fetchValhallaRouteChunk(chunk, routeOptions);
    const route = await repairShortRoadDetours(chunk, rawRoute, routeOptions);
    const chunkCoordinates = route.coordinates;
    appendCoordinates(coordinates, chunkCoordinates);
    distance += route.distance;
    duration += route.duration;
    requestCount += route.requestCount;
  }

  return {
    distance,
    duration,
    geometry: {
      type: "LineString",
      coordinates
    },
    provider: "valhalla",
    profile,
    requestCount
  };
}

export async function fetchBicycleRoute(points, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const provider = normalizeProvider(
    options.provider ??
      process.env.BICYCLE_ROUTING_PROVIDER ??
      (options.baseUrl ? "osrm" : "valhalla")
  );
  const requestOptions = {
    ...options,
    fetchImpl
  };

  if (provider === "osrm") {
    return fetchOsrmRoute(points, requestOptions);
  }

  try {
    return await fetchValhallaRoute(points, requestOptions);
  } catch (error) {
    const fallbackProvider = String(
      options.fallbackProvider ??
        process.env.BICYCLE_ROUTING_FALLBACK_PROVIDER ??
        "osrm"
    ).trim().toLowerCase();
    const canFallback = error?.statusCode === 502 && fallbackProvider === "osrm";

    if (!canFallback) {
      throw error;
    }

    return fetchOsrmRoute(points, {
      ...requestOptions,
      baseUrl: options.osrmBaseUrl
    });
  }
}
