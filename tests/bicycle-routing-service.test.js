import assert from "node:assert/strict";
import test from "node:test";

import { fetchBicycleRoute } from "../src/services/bicycleRoutingService.js";

test("fetchBicycleRoute uses the bicycle graph without unsupported exclude options", async () => {
  let requestedUrl = null;
  const expectedRoute = { distance: 123, geometry: { coordinates: [] } };

  const route = await fetchBicycleRoute(
    [{ lat: 49.1, lng: 8.6 }, { lat: 49.2, lng: 8.7 }],
    {
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

  assert.equal(route, expectedRoute);
  assert.equal(
    requestedUrl,
    "https://routing.example/routed-bike/route/v1/driving/8.6,49.1;8.7,49.2?overview=full&geometries=geojson"
  );
  assert.equal(requestedUrl.includes("exclude="), false);
});

test("fetchBicycleRoute preserves an upstream no-route result", async () => {
  await assert.rejects(
    fetchBicycleRoute(
      [{ lat: 49.1, lng: 8.6 }, { lat: 49.2, lng: 8.7 }],
      {
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
