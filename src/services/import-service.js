import { createImportJob } from '../db/import-jobs-repo.js';
import { importQueue } from '../queue/import-queue.js';

export async function createAndEnqueueImport({ key, originalFileName, sizeBytes, auth_sub} ) 
{
    const job = await createImportJob({
        s3Key: key,
        originalFileName,
        sizeBytes,
        auth_sub
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