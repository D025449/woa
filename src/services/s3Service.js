const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const s3 = new S3Client({
  region: process.env.AWS_REGION
});

exports.uploadFile = async (key, buffer, contentType) => {
  const command = new PutObjectCommand({
    Bucket: process.env.S3_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType
  });

  await s3.send(command);
};