const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');

const s3 = new S3Client({
  region: process.env.AWS_REGION
});


class S3Service {

  static async getJsonObject(bucket, key) {

    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: key
    });

    const response = await s3.send(command);

    const streamToString = (stream) =>
      new Promise((resolve, reject) => {
        const chunks = [];
        stream.on("data", (chunk) => chunks.push(chunk));
        stream.on("error", reject);
        stream.on("end", () =>
          resolve(Buffer.concat(chunks).toString("utf-8"))
        );
      });

    const bodyString = await streamToString(response.Body);

    return JSON.parse(bodyString);
  }

  static async putObject(key, buffer, contentType){
  const command = new PutObjectCommand({
    Bucket: process.env.S3_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType
  });

  await s3.send(command);

  }



}

module.exports = S3Service;


/*

exports.uploadFile = async (key, buffer, contentType) => {
  const command = new PutObjectCommand({
    Bucket: process.env.S3_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType
  });

  await s3.send(command);
};

*/