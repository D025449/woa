import { unzipSync } from "/vendor/fflate/browser.js";

self.addEventListener("message", async (event) => {
  const { type, uploads = [] } = event.data || {};
  if (type !== "upload" || !uploads.length) {
    self.postMessage({ type: "done", uploaded: 0, failed: 0 });
    return;
  }

  // Group uploads by source file to read each file only once.
  const byFile = new Map();
  for (const upload of uploads) {
    if (!upload.presignedUrl || !upload.file) continue;
    const key = upload.file;
    if (!byFile.has(key)) byFile.set(key, []);
    byFile.get(key).push(upload);
  }

  let uploaded = 0;
  let failed = 0;

  for (const [file, fileUploads] of byFile) {
    let fileBytes;
    try {
      fileBytes = new Uint8Array(await file.arrayBuffer());
    } catch {
      failed += fileUploads.length;
      continue;
    }

    const isZip = String(file.name || "").toLowerCase().endsWith(".zip");
    let archive = null;
    if (isZip) {
      try {
        archive = unzipSync(fileBytes);
      } catch {
        failed += fileUploads.length;
        continue;
      }
    }

    await Promise.allSettled(fileUploads.map(async (upload) => {
      try {
        let fitBytes;
        if (isZip) {
          const entryName = upload.entryName;
          const entry = archive[entryName]
            ?? archive[Object.keys(archive).find((k) => k === entryName || k.endsWith(`/${entryName}`))];
          if (!entry) throw new Error(`Entry not found: ${entryName}`);
          fitBytes = entry;
        } else {
          fitBytes = fileBytes;
        }

        const response = await fetch(upload.presignedUrl, {
          method: "PUT",
          body: fitBytes,
          headers: { "Content-Type": "application/octet-stream" }
        });
        if (!response.ok) throw new Error(`PUT failed: ${response.status}`);
        uploaded += 1;
      } catch {
        failed += 1;
      }
      self.postMessage({ type: "progress", uploaded, failed, total: uploads.length });
    }));
  }

  self.postMessage({ type: "done", uploaded, failed });
});
