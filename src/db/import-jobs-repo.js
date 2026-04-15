//import crypto from 'node:crypto';
import pool from '../services/database.js';

export async function createImportJob({
    localPaths = null,
    originalFileNames = null,
    sizeBytes,
    uid: uid
}) {
    //const id = crypto.randomUUID();

    const result = await pool.query(
        `
        insert into import_jobs (
            uid,
            local_paths,
            original_file_names,
            size_bytes,
            status,
            stage,
            progress_percent,
            processed_files,
            failed_files
        ) 
        values ($1, $2::jsonb, $3::jsonb, $4, 'queued', 'waiting_for_worker', 0, 0, 0) returning id
        `,
        [
            uid,
            localPaths ? JSON.stringify(localPaths) : null,
            originalFileNames ? JSON.stringify(originalFileNames) : null,
            sizeBytes
        ]
    );

    return { id: result.rows[0].id };
}

export async function getImportJobById(id) {
    const result = await pool.query(
        `
        select
            id,
            uid,
            local_paths as "localPaths",
            original_file_names as "originalFileNames",
            size_bytes as "sizeBytes",
            status,
            stage,
            progress_percent as "progressPercent",
            total_files as "totalFiles",
            processed_files as "processedFiles",
            failed_files as "failedFiles",
            error_message as "errorMessage",
            created_at as "createdAt",
            updated_at as "updatedAt"
        from import_jobs
        where id = $1
        `,
        [id]
    );

    return result.rows[0] || null;
}

export async function updateImportJob(id, patch) {
    const fieldMap = {
        status: 'status',
        stage: 'stage',
        progressPercent: 'progress_percent',
        totalFiles: 'total_files',
        processedFiles: 'processed_files',
        failedFiles: 'failed_files',
        errorMessage: 'error_message'
    };

    const updates = [];
    const values = [];
    let index = 1;

    for (const [key, value] of Object.entries(patch)) {
        const dbField = fieldMap[key];
        if (!dbField) continue;

        updates.push(`${dbField} = $${index}`);
        values.push(value);
        index += 1;
    }

    if (updates.length === 0) {
        return;
    }

    updates.push(`updated_at = now()`);
    values.push(id);

    await pool.query(
        `update import_jobs set ${updates.join(', ')} where id = $${index}`,
        values
    );
}
