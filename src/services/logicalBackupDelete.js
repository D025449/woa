import { DeleteObjectsCommand } from "@aws-sdk/client-s3";

export default async function deleteLogicalBackupObjects({ s3, bucket, root, objects, progress = null }) {
  const manifestKey = `${root}/manifest.json`;
  const dataKeys = objects.map((object) => object.Key).filter((key) => key && key !== manifestKey);
  const totalObjects = dataKeys.length + 1;
  let deletedObjects = 0;
  await progress?.(10, "deleting-backup", { processed: 0, total: totalObjects });

  const deleteBatch = async (keys) => {
    if (keys.length === 0) return;
    const response = await s3.send(new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true }
    }));
    if (response.Errors?.length) {
      throw new Error(`S3 could not delete ${response.Errors.length} logical backup object(s).`);
    }
    deletedObjects += keys.length;
    await progress?.(10 + Math.round((deletedObjects / totalObjects) * 85), "deleting-backup", {
      processed: deletedObjects,
      total: totalObjects
    });
  };

  for (let offset = 0; offset < dataKeys.length; offset += 1000) {
    await deleteBatch(dataKeys.slice(offset, offset + 1000));
  }
  await deleteBatch([manifestKey]);
  await progress?.(100, "completed", { processed: deletedObjects, total: totalObjects });
  return {
    deletedObjects,
    deletedBytes: objects.reduce((sum, object) => sum + (Number(object.Size) || 0), 0)
  };
}
