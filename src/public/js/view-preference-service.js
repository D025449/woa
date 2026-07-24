export default class ViewPreferenceService {
  static async load(viewKey) {
    const response = await fetch(`/api/view-preferences/${encodeURIComponent(viewKey)}`, {
      method: "GET",
      credentials: "include",
      headers: {
        Accept: "application/json"
      }
    });

    if (!response.ok) {
      throw new Error(`View preferences could not be loaded (${response.status})`);
    }

    const payload = await response.json();
    return payload?.data?.state || null;
  }

  static async save(viewKey, state, { keepalive = false } = {}) {
    const response = await fetch(`/api/view-preferences/${encodeURIComponent(viewKey)}`, {
      method: "PUT",
      credentials: "include",
      keepalive,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({ state })
    });

    if (!response.ok) {
      throw new Error(`View preferences could not be saved (${response.status})`);
    }

    const payload = await response.json();
    return payload?.data?.state || null;
  }
}
