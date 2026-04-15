export default class MapSegment {

  constructor(mapData) {
    this.mapData = mapData;
  }

  /*static async query(controller, args = {}) {

    const res = await fetch("/segments/query", {
      method: "GET",
      credentials: "include"
    });

    const data = await res.json();
    console.log(data);
    data.data.forEach(s => {
      controller.mapSegments.push(s)
    });
    return data;

  }*/


  static async loadSegments(controller, bounds) {
    /*const params = new URLSearchParams({
      minLat: bounds.getSouth(),
      maxLat: bounds.getNorth(),
      minLng: bounds.getWest(),
      maxLng: bounds.getEast(),
      excludeIds: Array.from(controller.mapSegments.map(m => m.id)).join(",")
    });*/

    const response = await fetch(`/segments/query`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        bounds: {
          minLat: bounds.getSouth(),
          maxLat: bounds.getNorth(),
          minLng: bounds.getWest(),
          maxLng: bounds.getEast()
        },
        excludeIds: (controller.mapSegments || []).filter(f => f.rowstate === 'DB').map(m => m.id)
        //excludeIds: Array.from(controller.mapSegments.filter(f=>f.rowstate === 'DB').map(m => m.id))
      })
    });

    if (response.status === 401) {
      window.location.href = '/login';
      return;
    }

    const data = await response.json();
    console.log(data.data.length);
    const lmap = new Map(controller.mapSegments.map(s => [s.id, s]));

    const new_segs = [];
    data.data.forEach(s => {
      if (!lmap.get(s.id)) {
        controller.mapSegments.push(s);
        new_segs.push(s);
        console.log(s.start.name, s.end.name);
      }
    });
    return new_segs;
  }


  static async storeSegments(controller, segs) {

    try {
      const txn_id = globalThis.crypto.randomUUID();
      const res = await fetch(`/segments/save/${txn_id}/segments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          segments: segs
        })
      });

      if (!res.ok) {
        throw new Error("Save failed");
      }



      const result = await res.json();

      console.log("Saved segments:", result);

      if (segs.length !== result.segments.length)
      {
          console.log("AAA");
      }
      else
      {
          for(let i = 0; i < segs.length; ++i)
          {
            const updated = result.segments[i];
            Object.assign(segs[i], updated);
          }
      }


      /*const map = new Map(result.segments.map(s => [s.id, s]));

      for (const seg of controller.mapSegments) {
        const updated = map.get(seg.id);
        if (updated) {
          Object.assign(seg, updated);
        }
      }*/







    } catch (err) {
      console.error(err);
      alert("Failed to save segments");
    }

  }

  static async deleteSegment(segmentId) {
    const res = await fetch(`/segments/${segmentId}`, {
      method: "DELETE",
      credentials: "include"
    });

    if (res.status === 401) {
      window.location.href = "/login";
      return null;
    }

    if (!res.ok) {
      throw new Error("Delete failed");
    }

    return res.json();
  }

  static formatLocation(address, mode = "medium") {
    if (!address) return null;

    const road = address.road;
    const house = address.house_number;

    const village =
      address.village ||
      address.town ||
      address.city ||
      address.municipality;

    const district =
      address.residential ||
      address.suburb ||
      address.neighbourhood;

    const municipality = address.municipality;
    const county = address.county;
    const state = address.state;

    // -------------------
    // SHORT
    // -------------------
    if (mode === "short") {
      return (
        village ||
        district ||
        municipality ||
        county ||
        state ||
        address.country ||
        null
      );
    }

    // -------------------
    // MEDIUM (beste UX)
    // -------------------
    if (mode === "medium") {
      if (district && municipality) {
        return `${district}`;
      }

      if (village && municipality && village !== municipality) {
        return `${village}`;
      }

      return (
        municipality ||
        village ||
        county ||
        state ||
        address.country ||
        null
      );
    }

    // -------------------
    // FULL (max Info)
    // -------------------
    if (mode === "full") {
      if (road && house && district) {
        return `${road} ${house}, ${district}`;
      }

      if (road && house && village) {
        return `${road} ${house}, ${village}`;
      }

      if (district && municipality) {
        return `${district}, ${municipality}`;
      }

      if (village && municipality) {
        return `${village}, ${municipality}`;
      }

      return (
        municipality ||
        village ||
        county ||
        state ||
        address.country ||
        null
      );
    }

    return null;
  }




}
