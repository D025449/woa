export function uploadFileAndStartImport({ file, onProgress }) {
    return new Promise((resolve, reject) => {
        const formData = new FormData();
        formData.append('file', file);

        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/uploads');

        xhr.upload.addEventListener('progress', (event) => {
            if (!event.lengthComputable || !onProgress) return;

            const percent = Math.round((event.loaded / event.total) * 100);

            onProgress({
                loaded: event.loaded,
                total: event.total,
                percent
            });
        });

        xhr.onload = () => {
            let data = {};

            try {
                data = xhr.responseText ? JSON.parse(xhr.responseText) : {};
            } catch (_error) {
                reject(new Error('Antwort vom Server konnte nicht gelesen werden'));
                return;
            }

            if (xhr.status >= 200 && xhr.status < 300) {
                resolve(data);
            } else {
                reject(new Error(data.error || `Upload fehlgeschlagen (${xhr.status})`));
            }
        };

        xhr.onerror = () => {
            reject(new Error('Netzwerkfehler beim Upload'));
        };

        xhr.onabort = () => {
            reject(new Error('Upload wurde abgebrochen'));
        };

        xhr.send(formData);
    });
}

export async function getImportStatus(jobId) {
    const response = await fetch(`/api/imports/${jobId}`);
    const data = await response.json();

    if (!response.ok) {
        throw new Error(data.error || 'Importstatus konnte nicht geladen werden');
    }

    return data;
}
