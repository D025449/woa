export {};

declare global {
  interface Error {
    statusCode?: number;
    limit?: unknown;
  }
}
