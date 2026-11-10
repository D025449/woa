export const PUBLIC_API_QUOTAS = Object.freeze({ ingress: 480, user: 240,
  analytics: 40, gps: 40, fit: 40, oauth: 120 });

export const PUBLIC_ANALYTICS_LIMITS = Object.freeze({ rows: 50000,
  historyDays: 20000, ftpRows: 500, responseBytes: 1024 * 1024, concurrent: 2 });
