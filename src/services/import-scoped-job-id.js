export function buildImportScopedJobId(baseJobId, importJobId) {
  if (importJobId == null || importJobId === "") {
    return baseJobId;
  }

  const safeImportJobId = String(importJobId).replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${baseJobId}-import-${safeImportJobId}`;
}
