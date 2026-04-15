import { uploadFilesAndStartImport } from './upload-api.js';
import { pollImportStatus } from './import-polling.js';
import { createUploadUI } from './upload-ui.js';

const ui = createUploadUI();

ui.elements.form.addEventListener('submit', handleUploadSubmit);

async function handleUploadSubmit(event) {
    event.preventDefault();

    const files = ui.getSelectedFiles();

    ui.clearMessage();

    if (files.length === 0) {
        ui.setError('Bitte mindestens eine Datei auswählen.');
        return;
    }

    for (const file of files) {
        const lowerName = file.name.toLowerCase();
        const isZip = lowerName.endsWith('.zip');
        const isFit = lowerName.endsWith('.fit');

        if (!isZip && !isFit) {
            ui.setError('Bitte nur .fit oder .zip Dateien hochladen.');
            return;
        }
    }

    try {
        ui.setLoading(true);
        ui.showStatusArea();

        ui.setPhase('Upload wird vorbereitet');
        ui.setUploadProgress(0, '');
        ui.setProcessingProgress(0, '');
        ui.setInfo('Datei wird hochgeladen ...');

        const importResult = await uploadFilesAndStartImport({
            files,
            onProgress: ({ loaded, total, percent }) => {
                ui.setUploadProgress(
                    percent,
                    `${formatBytes(loaded)} von ${formatBytes(total)} hochgeladen`
                );
            }
        });

        const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
        ui.setUploadProgress(100, `${files.length} Dateien, ${formatBytes(totalBytes)} hochgeladen`);
        ui.setPhase('Import wird gestartet');
        ui.setInfo('Datei wurde hochgeladen. Import-Job wird gestartet ...');

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

function formatStage(stage, status) {
    if (status === 'queued') return 'Wartet auf Worker';
    if (stage === 'downloading_zip') return 'Legacy-Import lädt Datei';
    if (stage === 'reading_zip') return 'ZIP wird analysiert';
    if (stage === 'parsing_fit_files') return 'FIT-Dateien werden verarbeitet';
    if (stage === 'saving_results') return 'Ergebnisse werden gespeichert';
    if (stage === 'completed') return 'Abgeschlossen';
    if (stage === 'failed') return 'Fehlgeschlagen';
    return stage || status || 'Verarbeitung läuft';
}
