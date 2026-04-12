import { createImportJob } from '../db/import-jobs-repo.js';
import { importQueue } from '../queue/import-queue.js';

export async function createAndEnqueueImport({ localPath = null, originalFileName, sizeBytes, uid} ) 
{
    const job = await createImportJob({
        localPath,
        originalFileName,
        sizeBytes,
        uid
    });

    await importQueue.add(
        'process-zip-import',
        {
            jobId: job.id
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
