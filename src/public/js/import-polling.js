import { getImportStatus } from './upload-api.js';

export function pollImportStatus(jobId, { onUpdate, onError, intervalMs = 1500 }) {
    let stopped = false;
    let timerId = null;

    async function tick() {
        if (stopped) return;

        try {
            const job = await getImportStatus(jobId);
            onUpdate(job);

            if (job.status === 'completed' || job.status === 'failed') {
                stopped = true;
                return;
            }
        } catch (error) {
            if (onError) {
                onError(error);
            }
        }

        timerId = window.setTimeout(tick, intervalMs);
    }

    tick();

    return function stop() {
        stopped = true;
        if (timerId) {
            window.clearTimeout(timerId);
        }
    };
}