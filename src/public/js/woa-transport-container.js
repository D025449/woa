const MAGIC = "WOAT";
const VERSION = 1;
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

function writeUint32LE(target, offset, value) {
  const view = new DataView(target.buffer, target.byteOffset, target.byteLength);
  view.setUint32(offset, value >>> 0, true);
}

function readUint32LE(source, offset) {
  const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
  return view.getUint32(offset, true);
}

export function encodeWoaTransportContainer(entries = []) {
  const preparedEntries = entries.map((entry) => {
    const name = String(entry?.name || "workout.woa1");
    const nameBytes = TEXT_ENCODER.encode(name);
    const payloadBytes = entry?.bytes instanceof Uint8Array
      ? entry.bytes
      : new Uint8Array(entry?.bytes || []);

    return {
      name,
      nameBytes,
      payloadBytes
    };
  });

  let totalBytes = 4 + 1 + 4;
  for (const entry of preparedEntries) {
    totalBytes += 4 + entry.nameBytes.byteLength + 4 + entry.payloadBytes.byteLength;
  }

  const buffer = new Uint8Array(totalBytes);
  let offset = 0;

  buffer.set(TEXT_ENCODER.encode(MAGIC), offset);
  offset += 4;
  buffer[offset] = VERSION;
  offset += 1;
  writeUint32LE(buffer, offset, preparedEntries.length);
  offset += 4;

  for (const entry of preparedEntries) {
    writeUint32LE(buffer, offset, entry.nameBytes.byteLength);
    offset += 4;
    buffer.set(entry.nameBytes, offset);
    offset += entry.nameBytes.byteLength;
    writeUint32LE(buffer, offset, entry.payloadBytes.byteLength);
    offset += 4;
    buffer.set(entry.payloadBytes, offset);
    offset += entry.payloadBytes.byteLength;
  }

  return buffer;
}

export function decodeWoaTransportContainer(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.byteLength < 9) {
    throw new Error("WOA transport container too small");
  }

  const magic = TEXT_DECODER.decode(bytes.subarray(0, 4));
  if (magic !== MAGIC) {
    throw new Error(`Unsupported WOA transport magic: ${magic}`);
  }

  let offset = 4;
  const version = bytes[offset];
  offset += 1;
  if (version !== VERSION) {
    throw new Error(`Unsupported WOA transport version: ${version}`);
  }

  const entryCount = readUint32LE(bytes, offset);
  offset += 4;
  const entries = new Array(entryCount);

  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 8 > bytes.byteLength) {
      throw new Error("WOA transport container ended unexpectedly");
    }

    const nameLength = readUint32LE(bytes, offset);
    offset += 4;
    const nameEnd = offset + nameLength;
    if (nameEnd > bytes.byteLength) {
      throw new Error("WOA transport entry name exceeds container size");
    }
    const name = TEXT_DECODER.decode(bytes.subarray(offset, nameEnd));
    offset = nameEnd;

    const payloadLength = readUint32LE(bytes, offset);
    offset += 4;
    const payloadEnd = offset + payloadLength;
    if (payloadEnd > bytes.byteLength) {
      throw new Error("WOA transport entry payload exceeds container size");
    }

    entries[index] = {
      name,
      bytes: bytes.subarray(offset, payloadEnd)
    };
    offset = payloadEnd;
  }

  return {
    magic,
    version,
    entryCount,
    entries
  };
}
