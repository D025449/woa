import { fetchShareableGroups, uploadFilesAndStartImport } from './upload-api.js';
import { pollImportStatus } from './import-polling.js';
import { createUploadUI } from './upload-ui.js';
import { createTranslator } from "./i18n.js";

const ui = createUploadUI();
const t = createTranslator("upload");

initializeShareGroups();
ui.elements.form.addEventListener('submit', handleUploadSubmit);

async function initializeShareGroups() {
    try {
        const groups = await fetchShareableGroups();
        ui.setShareGroups(groups);
        ui.syncSharePanel();
    } catch (error) {
        console.error(error);
        ui.setError(error.message || t("errorLoadGroups"));
    }
}

async function handleUploadSubmit(event) {
    event.preventDefault();

    const files = ui.getSelectedFiles();
    const shareMode = ui.getSelectedShareMode();
    const groupIds = ui.getSelectedGroupIds();

    ui.clearMessage();

    if (files.length === 0) {
        ui.setError(t("errorSelectFile"));
        return;
    }

    for (const file of files) {
        const lowerName = file.name.toLowerCase();
        const isZip = lowerName.endsWith('.zip');
        const isFit = lowerName.endsWith('.fit');

        if (!isZip && !isFit) {
            ui.setError(t("errorOnlyFitOrZip"));
            return;
        }
    }

    if (shareMode === 'groups' && groupIds.length === 0) {
        ui.setError(t("errorSelectGroupOrPrivate"));
        return;
    }

    try {
        ui.setLoading(true);
        ui.showStatusArea();

        ui.setPhase(t("phasePreparingUpload"));
        ui.setUploadProgress(0, '');
        ui.setProcessingProgress(0, '');
        ui.setInfo(t("infoUploading"));

        const importResult = await uploadFilesAndStartImport({
            files,
            shareMode,
            groupIds,
            onProgress: ({ loaded, total, percent }) => {
                ui.setUploadProgress(
                    percent,
                    t("detailUploadedBytes", {
                        loaded: formatBytes(loaded),
                        total: formatBytes(total)
                    })
                );
            }
        });

        const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
        ui.setUploadProgress(100, t("detailFilesUploaded", {
            count: files.length,
            total: formatBytes(totalBytes)
        }));
        ui.setPhase(t("phaseStartingImport"));
        ui.setInfo(
            shareMode === 'groups'
                ? t("infoFileUploadedShared")
                : t("infoFileUploaded")
        );

        ui.setPhase(t("phaseProcessing"));
        ui.setInfo(t("infoImportInProgress", { jobId: importResult.jobId }));

        pollImportStatus(importResult.jobId, {
            onUpdate(job) {
                ui.setPhase(formatStage(job.stage, job.status));

                const progressPercent = Number(job.progressPercent || 0);

                let detailText = t("detailProcessedPercent", {
                    percent: Math.round(progressPercent)
                });

                if (job.totalFiles) {
                    detailText = t("detailFilesProcessed", {
                        processed: job.processedFiles,
                        total: job.totalFiles
                    });
                    if (job.failedFiles) {
                        detailText += t("detailFilesFailedSuffix", {
                            failed: job.failedFiles
                        });
                    }
                }

                ui.setProcessingProgress(progressPercent, detailText);

                if (job.status === 'completed') {
                    ui.setSuccess(t("successImportCompleted", {
                        processed: job.processedFiles,
                        failed: job.failedFiles
                    }));
                    ui.setLoading(false);
                }

                if (job.status === 'failed') {
                    ui.setError(job.errorMessage || t("errorImportFailed"));
                    ui.setLoading(false);
                }
            },
            onError(error) {
                ui.setError(t("errorPolling", { message: error.message }));
                ui.setLoading(false);
            },
            intervalMs: 1500
        });
    } catch (error) {
        ui.setError(error.message || t("errorUnknownUpload"));
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
    if (status === 'queued') return t("workerQueued");
    if (stage === 'downloading_zip') return t("stageDownloadingZip");
    if (stage === 'reading_zip') return t("stageReadingZip");
    if (stage === 'parsing_fit_files') return t("stageParsingFit");
    if (stage === 'saving_results') return t("stageSavingResults");
    if (stage === 'completed') return t("stageCompleted");
    if (stage === 'failed') return t("stageFailed");
    return stage || status || t("phaseProcessing");
}
