const MAGIC = "WOPN";
const VERSION = 1;
const HEADER_BYTES = 12;
const BLOCK_HEADER_BYTES = 8;
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

export const WORKOUT_OPEN_V2_BLOCK_TYPES = Object.freeze({
  META_JSON: 1,
  WORKOUT_STREAM: 2,
  GPS_TRACK_BLOB: 3,
  SEGMENTS_JSON: 4,
  GPS_SEGMENTS_JSON: 5
});

function normalizeBytes(bytes) {
  if (bytes instanceof Uint8Array) {
    return bytes;
  }
  if (bytes instanceof ArrayBuffer) {
    return new Uint8Array(bytes);
  }
  if (ArrayBuffer.isView(bytes)) {
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(bytes)) {
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  return new Uint8Array(0);
}

function encodeJson(value) {
  return TEXT_ENCODER.encode(JSON.stringify(value ?? null));
}

function decodeJson(bytes) {
  return JSON.parse(TEXT_DECODER.decode(bytes || new Uint8Array(0)));
}

export default class WorkoutOpenV2 {
  static MAGIC = MAGIC;
  static VERSION = VERSION;
  static HEADER_BYTES = HEADER_BYTES;
  static BLOCK_HEADER_BYTES = BLOCK_HEADER_BYTES;
  static BLOCK_TYPES = WORKOUT_OPEN_V2_BLOCK_TYPES;

  static buildPayload({
    meta = {},
    workoutStream = new Uint8Array(0),
    gpsTrackBlob = new Uint8Array(0),
    segments = [],
    gpsSegments = []
  } = {}) {
    const blocks = [
      {
        type: WORKOUT_OPEN_V2_BLOCK_TYPES.META_JSON,
        bytes: encodeJson(meta)
      },
      {
        type: WORKOUT_OPEN_V2_BLOCK_TYPES.WORKOUT_STREAM,
        bytes: normalizeBytes(workoutStream)
      },
      {
        type: WORKOUT_OPEN_V2_BLOCK_TYPES.GPS_TRACK_BLOB,
        bytes: normalizeBytes(gpsTrackBlob)
      },
      {
        type: WORKOUT_OPEN_V2_BLOCK_TYPES.SEGMENTS_JSON,
        bytes: encodeJson(segments)
      },
      {
        type: WORKOUT_OPEN_V2_BLOCK_TYPES.GPS_SEGMENTS_JSON,
        bytes: encodeJson(gpsSegments)
      }
    ];

    let totalBytes = HEADER_BYTES;
    for (const block of blocks) {
      totalBytes += BLOCK_HEADER_BYTES + block.bytes.byteLength;
    }

    const payload = new Uint8Array(totalBytes);
    const view = new DataView(payload.buffer);
    payload.set(TEXT_ENCODER.encode(MAGIC), 0);
    view.setUint8(4, VERSION);
    view.setUint8(5, 0);
    view.setUint16(6, 0, true);
    view.setUint16(8, blocks.length, true);
    view.setUint16(10, 0, true);

    let offset = HEADER_BYTES;
    for (const block of blocks) {
      view.setUint16(offset, block.type, true);
      view.setUint16(offset + 2, 0, true);
      view.setUint32(offset + 4, block.bytes.byteLength, true);
      offset += BLOCK_HEADER_BYTES;
      payload.set(block.bytes, offset);
      offset += block.bytes.byteLength;
    }

    return payload;
  }

  static parsePayload(buffer) {
    const bytes = normalizeBytes(buffer);
    if (bytes.byteLength < HEADER_BYTES) {
      throw new Error("Workout open v2 payload too small");
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const magic = TEXT_DECODER.decode(bytes.subarray(0, 4));
    if (magic !== MAGIC) {
      throw new Error(`Unsupported workout open payload magic: ${magic}`);
    }

    const version = view.getUint8(4);
    if (version !== VERSION) {
      throw new Error(`Unsupported workout open payload version: ${version}`);
    }

    const blockCount = view.getUint16(8, true);
    const blocks = new Map();
    let offset = HEADER_BYTES;

    for (let index = 0; index < blockCount; index += 1) {
      if ((offset + BLOCK_HEADER_BYTES) > bytes.byteLength) {
        throw new Error("Workout open v2 block header exceeds payload");
      }
      const type = view.getUint16(offset, true);
      const length = view.getUint32(offset + 4, true);
      offset += BLOCK_HEADER_BYTES;
      if ((offset + length) > bytes.byteLength) {
        throw new Error("Workout open v2 block exceeds payload");
      }
      blocks.set(type, bytes.slice(offset, offset + length));
      offset += length;
    }

    return {
      meta: decodeJson(blocks.get(WORKOUT_OPEN_V2_BLOCK_TYPES.META_JSON) || new Uint8Array(0)),
      workoutStream: blocks.get(WORKOUT_OPEN_V2_BLOCK_TYPES.WORKOUT_STREAM) || new Uint8Array(0),
      gpsTrackBlob: blocks.get(WORKOUT_OPEN_V2_BLOCK_TYPES.GPS_TRACK_BLOB) || new Uint8Array(0),
      segments: decodeJson(blocks.get(WORKOUT_OPEN_V2_BLOCK_TYPES.SEGMENTS_JSON) || new Uint8Array(0)),
      gpsSegments: decodeJson(blocks.get(WORKOUT_OPEN_V2_BLOCK_TYPES.GPS_SEGMENTS_JSON) || new Uint8Array(0))
    };
  }
}
