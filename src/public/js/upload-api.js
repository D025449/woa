export async function requestPresignedUpload({ fileName, fileType, fileSize }) {
    const response = await fetch('/api/uploads/presign', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ fileName, fileType, fileSize })
    });

    const data = await response.json();

    if (!response.ok) {
        throw new Error(data.error || 'Presigned URL konnte nicht erstellt werden');
    }

    return data;
}

export async function startImport({ key, originalFileName, sizeBytes }) {
    const response = await fetch('/api/imports', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ key, originalFileName, sizeBytes })
    });

    const data = await response.json();

    if (!response.ok) {
        throw new Error(data.error || 'Import konnte nicht gestartet werden');
    }

    return data;
}

export async function getImportStatus(jobId) {
    const response = await fetch(`/api/imports/${jobId}`);
    const data = await response.json();

    if (!response.ok) {
        throw new Error(data.error || 'Importstatus konnte nicht geladen werden');
    }

    return data;
}