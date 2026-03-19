export function uploadFileToS3({ uploadUrl, file, onProgress }) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();

        xhr.open('PUT', uploadUrl);
        xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');

        xhr.upload.addEventListener('progress', (event) => {
            if (!event.lengthComputable) return;

            const percent = Math.round((event.loaded / event.total) * 100);

            if (onProgress) {
                onProgress({
                    loaded: event.loaded,
                    total: event.total,
                    percent
                });
            }
        });

        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                resolve();
            } else {
                reject(new Error(`S3 Upload fehlgeschlagen (${xhr.status})`));
            }
        };

        xhr.onerror = () => {
            reject(new Error('Netzwerkfehler beim Upload nach S3'));
        };

        xhr.onabort = () => {
            reject(new Error('Upload wurde abgebrochen'));
        };

        xhr.send(file);
    });
}