import { requestPresignedUpload, startImport } from './upload-api.js';
import { uploadFileToS3 } from './s3-upload.js';
import { pollImportStatus } from './import-polling.js';
import { createUploadUI } from './upload-ui.js';

const ui = createUploadUI();

ui.elements.form.addEventListener('submit', handleUploadSubmit);

async function handleUploadSubmit(event) {
    event.preventDefault();

    const file = ui.getSelectedFile();

    ui.clearMessage();

    if (!file) {
        ui.setError('Bitte eine Datei auswählen.');
        return;
    }

    const lowerName = file.name.toLowerCase();
    const isZip = lowerName.endsWith('.zip');
    const isFit = lowerName.endsWith('.fit');

    if (!isZip && !isFit) {
        ui.setError('Bitte nur .fit oder .zip Dateien hochladen.');
        return;
    }

    try {
        ui.setLoading(true);
        ui.showStatusArea();

        ui.setPhase('Presigned URL wird angefordert');
        ui.setUploadProgress(0, '');
        ui.setProcessingProgress(0, '');
        ui.setInfo('Upload wird vorbereitet ...');

        const presignResult = await requestPresignedUpload({
            fileName: file.name,
            fileType: file.type || guessContentType(file.name),
            fileSize: file.size
        });

        ui.setPhase('Upload nach S3 läuft');

        await uploadFileToS3({
            uploadUrl: presignResult.uploadUrl,
            file,
            onProgress: ({ loaded, total, percent }) => {
                ui.setUploadProgress(
                    percent,
                    `${formatBytes(loaded)} von ${formatBytes(total)} hochgeladen`
                );
            }
        });

        ui.setUploadProgress(100, `${formatBytes(file.size)} hochgeladen`);
        ui.setPhase('Import wird gestartet');
        ui.setInfo('Datei wurde hochgeladen. Import-Job wird gestartet ...');

        const importResult = await startImport({
            key: presignResult.key,
            originalFileName: file.name,
            sizeBytes: file.size
        });

        ui.setPhase('Verarbeitung läuft');
        ui.setInfo(`Import läuft (Job-ID: ${importResult.jobId})`);

        pollImportStatus(importResult.jobId, {
            onUpdate(job) {
                ui.setPhase(formatStage(job.stage, job.status));

                const progressPercent = Number(job.progressPercent || 0);

                let detailText = `${Math.round(progressPercent)}% verarbeitet`;

                if (job.totalFiles) {
                    detailText = `${job.processedFiles} / ${job.totalFiles} Dateien verarbeitet`;
                    if (job.failedFiles) {
                        detailText += `, ${job.failedFiles} fehlgeschlagen`;
                    }
                }

                ui.setProcessingProgress(progressPercent, detailText);

                if (job.status === 'completed') {
                    ui.setSuccess(
                        `Import abgeschlossen. ${job.processedFiles} Dateien verarbeitet, ${job.failedFiles} fehlgeschlagen.`
                    );
                    ui.setLoading(false);
                }

                if (job.status === 'failed') {
                    ui.setError(job.errorMessage || 'Import fehlgeschlagen.');
                    ui.setLoading(false);
                }
            },
            onError(error) {
                ui.setError(`Polling-Fehler: ${error.message}`);
                ui.setLoading(false);
            },
            intervalMs: 1500
        });
    } catch (error) {
        ui.setError(error.message || 'Unbekannter Fehler beim Upload');
        ui.setLoading(false);
    }
}

function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function guessContentType(fileName) {
    const lower = fileName.toLowerCase();
    if (lower.endsWith('.zip')) return 'application/zip';
    if (lower.endsWith('.fit')) return 'application/octet-stream';
    return 'application/octet-stream';
}

function formatStage(stage, status) {
    if (status === 'queued') return 'Wartet auf Worker';
    if (stage === 'downloading_zip') return 'ZIP wird von S3 geladen';
    if (stage === 'reading_zip') return 'ZIP wird analysiert';
    if (stage === 'parsing_fit_files') return 'FIT-Dateien werden verarbeitet';
    if (stage === 'saving_results') return 'Ergebnisse werden gespeichert';
    if (stage === 'completed') return 'Abgeschlossen';
    if (stage === 'failed') return 'Fehlgeschlagen';
    return stage || status || 'Verarbeitung läuft';
}