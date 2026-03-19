import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import zlib from "zlib";
import { Readable } from "stream";

const s3 = new S3Client({
  region: process.env.AWS_REGION
});

class S3Service {
  static jsonToGzipStream(obj) {
    const jsonStream = new Readable({
      read() { }
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

  static async deleteObject(bucket, key) {
    await s3.send(
      new DeleteObjectCommand({
        Bucket: bucket,
        Key: key
      })
    );
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
    const compressed = zlib.brotliCompressSync(buffer, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
        [zlib.constants.BROTLI_PARAM_LGWIN]: 22
      }
    });

    const command = new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: key,
      Body: compressed,
      ContentType: contentType,
      ContentEncoding: "br"
    });

    await s3.send(command);
  }

  static async putObjectBinary(key, buffer, contentType) {
    const compressed = zlib.brotliCompressSync(Buffer.from(buffer), {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
        [zlib.constants.BROTLI_PARAM_LGWIN]: 22
      }
    });

    const command = new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: key,
      Body: compressed,
      ContentType: contentType,
      ContentEncoding: "br"
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

  // NEU: Presigned PUT für Browser-Upload
  static async getPresignedUploadUrl(bucket, key, contentType, expiresIn = 300) {
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: contentType
    });

    const url = await getSignedUrl(s3, command, {
      expiresIn
    });

    return url;
  }

  // NEU: Existenz + Metadaten prüfen
  static async headObject(bucket, key) {
    const command = new HeadObjectCommand({
      Bucket: bucket,
      Key: key
    });

    return await s3.send(command);
  }

  // NEU: Stream für Worker
  static async getObjectStream(bucket, key) {
    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: key
    });

    const response = await s3.send(command);

    if (!response.Body) {
      throw new Error("S3 object has no body");
    }

    return response.Body;
  }
}

export default S3Service;