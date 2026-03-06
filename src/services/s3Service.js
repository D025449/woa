const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const zlib = require("zlib");
const { Readable } = require("stream");

const s3 = new S3Client({
  region: process.env.AWS_REGION
});


class S3Service {


static jsonToGzipStream(obj) {

  const jsonStream = new Readable({
    read() {}
  });

  process.nextTick(() => {
    try {
      jsonStream.push("{");

      const keys = Object.keys(obj);

      keys.forEach((key, index) => {
        const value = obj[key];

        const chunk =
          JSON.stringify(key) +
          ":" +
          JSON.stringify(value) +
          (index < keys.length - 1 ? "," : "");

        jsonStream.push(chunk);
      });

      jsonStream.push("}");
      jsonStream.push(null);

    } catch (err) {
      jsonStream.destroy(err);
    }
  });

  const gzip = zlib.createGzip({
    level: zlib.constants.Z_BEST_SPEED
  });

  return jsonStream.pipe(gzip);
}


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

  static async putObject(key, buffer, contentType) {
    const compressed = zlib.gzipSync(buffer);


    const command = new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: key,
      Body: compressed,
      ContentType: contentType,
      ContentEncoding: "gzip"
    });

    await s3.send(command);

  }
  static async getPresignedUrl(bucket, key) {


    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: key
    });
    const url = await getSignedUrl(s3, command, {
      expiresIn: 60
    });

    return url;


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