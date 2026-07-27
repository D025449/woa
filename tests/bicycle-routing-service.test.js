import assert from "node:assert/strict";
import test from "node:test";

import { fetchBicycleRoute } from "../src/services/bicycleRoutingService.js";

test("fetchBicycleRoute uses the OSRM bicycle graph without unsupported exclude options", async () => {
  let requestedUrl = null;
  const expectedRoute = { distance: 123, geometry: { coordinates: [] } };

  const route = await fetchBicycleRoute(
    [{ lat: 49.1, lng: 8.6 }, { lat: 49.2, lng: 8.7 }],
    {
      provider: "osrm",
      baseUrl: "https://routing.example/routed-bike/route/v1/driving/",
      fetchImpl: async (url) => {
        requestedUrl = url;
        return {
          ok: true,
          status: 200,
          json: async () => ({ code: "Ok", routes: [expectedRoute] })
        };
      }
    }
  );

  assert.deepEqual(route, {
    ...expectedRoute,
    provider: "osrm"
  });
  assert.equal(
    requestedUrl,
    "https://routing.example/routed-bike/route/v1/driving/8.6,49.1;8.7,49.2?overview=full&geometries=geojson"
  );
  assert.equal(requestedUrl.includes("exclude="), false);
  assert.equal(route.provider, "osrm");
});

test("fetchBicycleRoute preserves an upstream no-route result", async () => {
  await assert.rejects(
    fetchBicycleRoute(
      [{ lat: 49.1, lng: 8.6 }, { lat: 49.2, lng: 8.7 }],
      {
        provider: "osrm",
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          json: async () => ({ code: "NoRoute", message: "Impossible route" })
        })
      }
    ),
    (error) => {
      assert.equal(error.statusCode, 404);
      assert.equal(error.upstreamCode, "NoRoute");
      return true;
    }
  );
});

test("fetchBicycleRoute exposes unsupported upstream options as a gateway error", async () => {
  await assert.rejects(
    fetchBicycleRoute(
      [{ lat: 49.1, lng: 8.6 }, { lat: 49.2, lng: 8.7 }],
      {
        provider: "osrm",
        fetchImpl: async () => ({
          ok: false,
          status: 400,
          json: async () => ({ code: "InvalidValue", message: "Unsupported option" })
        })
      }
    ),
    (error) => {
      assert.equal(error.statusCode, 502);
      assert.equal(error.upstreamStatus, 400);
      assert.equal(error.upstreamCode, "InvalidValue");
      return true;
    }
  );
});

test("fetchBicycleRoute normalizes a Valhalla road route to the existing route shape", async () => {
  let requestedUrl = null;
  let requestedOptions = null;

  const route = await fetchBicycleRoute(
    [{ lat: 46.87248, lng: 11.37825 }, { lat: 46.8692, lng: 11.36748 }],
    {
      provider: "valhalla",
      fallbackProvider: "none",
      baseUrl: "https://valhalla.example/route",
      clientId: "cwa24.test",
      fetchImpl: async (url, options) => {
        requestedUrl = url;
        requestedOptions = options;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            trip: {
              summary: { length: 1.123, time: 284.278 },
              legs: [{ shape: "_yzkxAscnuT~kEb`T" }]
            }
          })
        };
      }
    }
  );

  const request = JSON.parse(new URL(requestedUrl).searchParams.get("json"));
  assert.equal(request.costing, "auto");
  assert.deepEqual(request.costing_options.auto, {
    exclude_highways: true,
    exclude_unpaved: true,
    use_tracks: 0,
    service_penalty: 300,
    service_factor: 20
  });
  assert.equal(requestedOptions.headers["X-Client-Id"], "cwa24.test");
  assert.equal(route.provider, "valhalla");
  assert.equal(route.profile, "road");
  assert.equal(route.requestCount, 1);
  assert.equal(route.distance, 1123);
  assert.equal(route.duration, 284.278);
  assert.equal(route.geometry.type, "LineString");
  assert.deepEqual(route.geometry.coordinates, [
    [11.37825, 46.87248],
    [11.36748, 46.8692]
  ]);
});

test("fetchBicycleRoute supports the Valhalla mountain profile", async () => {
  let request = null;

  await fetchBicycleRoute(
    [{ lat: 49.1, lng: 8.6 }, { lat: 49.2, lng: 8.7 }],
    {
      provider: "valhalla",
      profile: "mountain",
      fallbackProvider: "none",
      fetchImpl: async (url) => {
        request = JSON.parse(new URL(url).searchParams.get("json"));
        return {
          ok: true,
          status: 200,
          json: async () => ({
            trip: {
              summary: { length: 1, time: 100 },
              legs: [{ shape: "_yzkxAscnuT~kEb`T" }]
            }
          })
        };
      }
    }
  );

  assert.deepEqual(request.costing_options.bicycle, {
    bicycle_type: "mountain",
    avoid_bad_surfaces: 0.1,
    use_roads: 0.2
  });
});

test("fetchBicycleRoute repairs an extreme short road detour with a bicycle crossing", async () => {
  const costings = [];

  const route = await fetchBicycleRoute(
    [
      { lat: 47.25625538443264, lng: 11.397395544884413 },
      { lat: 47.25577477185118, lng: 11.398146480728599 }
    ],
    {
      provider: "valhalla",
      fallbackProvider: "none",
      fetchImpl: async (url) => {
        const request = JSON.parse(new URL(url).searchParams.get("json"));
        costings.push(request.costing);
        const bicycle = request.costing === "bicycle";
        return {
          ok: true,
          status: 200,
          json: async () => ({
            trip: {
              summary: {
                length: bicycle ? 0.109 : 0.701,
                time: bicycle ? 20 : 90
              },
              legs: [{
                summary: {
                  length: bicycle ? 0.109 : 0.701,
                  time: bicycle ? 20 : 90
                },
                shape: "_yzkxAscnuT~kEb`T"
              }]
            }
          })
        };
      }
    }
  );

  assert.deepEqual(costings, ["auto", "bicycle"]);
  assert.equal(route.distance, 109);
  assert.equal(route.duration, 20);
  assert.equal(route.requestCount, 2);
});

test("fetchBicycleRoute falls back to OSRM only for technical Valhalla failures", async () => {
  const requestedUrls = [];

  const route = await fetchBicycleRoute(
    [{ lat: 49.1, lng: 8.6 }, { lat: 49.2, lng: 8.7 }],
    {
      provider: "valhalla",
      valhallaBaseUrl: "https://valhalla.example/route",
      osrmBaseUrl: "https://osrm.example/route/v1/driving",
      fetchImpl: async (url) => {
        requestedUrls.push(url);
        if (url.startsWith("https://valhalla.example")) {
          return {
            ok: false,
            status: 503,
            json: async () => ({ error: "Temporarily unavailable" })
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            code: "Ok",
            routes: [{ distance: 123, geometry: { coordinates: [] } }]
          })
        };
      }
    }
  );

  assert.equal(requestedUrls.length, 2);
  assert.equal(route.provider, "osrm");
});

test("fetchBicycleRoute splits long Valhalla routes into overlapping requests", async () => {
  const requestLocationCounts = [];
  const points = Array.from({ length: 106 }, (_, index) => ({
    lat: 49 + index / 1000,
    lng: 8 + index / 1000
  }));

  const route = await fetchBicycleRoute(points, {
    provider: "valhalla",
    fallbackProvider: "none",
    fetchImpl: async (url) => {
      const request = JSON.parse(new URL(url).searchParams.get("json"));
      requestLocationCounts.push(request.locations.length);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          trip: {
            summary: { length: 1, time: 100 },
            legs: [{ shape: "_yzkxAscnuT~kEb`T" }]
          }
        })
      };
    }
  });

  assert.deepEqual(requestLocationCounts, [20, 20, 20, 20, 20, 11]);
  assert.equal(route.requestCount, 6);
  assert.equal(route.distance, 6000);
  assert.equal(route.duration, 600);
});

test("fetchBicycleRoute does not fall back for invalid Valhalla requests", async () => {
  let requestCount = 0;

  await assert.rejects(
    fetchBicycleRoute(
      [{ lat: 49.1, lng: 8.6 }, { lat: 49.2, lng: 8.7 }],
      {
        provider: "valhalla",
        fetchImpl: async () => {
          requestCount += 1;
          return {
            ok: false,
            status: 400,
            json: async () => ({
              error_code: 150,
              error: "Exceeded max locations: 50"
            })
          };
        }
      }
    ),
    (error) => {
      assert.equal(error.statusCode, 400);
      assert.equal(error.provider, "valhalla");
      return true;
    }
  );

  assert.equal(requestCount, 1);
});

test("fetchBicycleRoute does not replace a missing Valhalla road route with generic OSRM", async () => {
  let requestCount = 0;

  await assert.rejects(
    fetchBicycleRoute(
      [{ lat: 49.1, lng: 8.6 }, { lat: 49.2, lng: 8.7 }],
      {
        provider: "valhalla",
        fetchImpl: async () => {
          requestCount += 1;
          return {
            ok: false,
            status: 400,
            json: async () => ({ error_code: 442, error: "No path could be found" })
          };
        }
      }
    ),
    (error) => {
      assert.equal(error.statusCode, 404);
      assert.equal(error.provider, "valhalla");
      return true;
    }
  );

  assert.equal(requestCount, 1);
});
