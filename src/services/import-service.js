import { createImportJob } from '../db/import-jobs-repo.js';
import { importQueue } from '../queue/import-queue.js';

export async function createAndEnqueueImport({
    localPaths = null,
    originalFileNames = null,
    sizeBytes,
    uid,
    shareMode = "private",
    groupIds = []
})
{
    const job = await createImportJob({
        localPaths,
        originalFileNames,
        sizeBytes,
        uid
    });

    await importQueue.add(
        'process-zip-import',
        {
            jobId: job.id,
            shareMode,
            groupIds
        },
        {
            attempts: 3,
            backoff: {
                type: 'exponential',
                delay: 3000
            },
            removeOnComplete: 100,
            removeOnFail: 100
        }
    );

    return job;
}
