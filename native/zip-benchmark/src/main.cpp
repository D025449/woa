#include <libdeflate.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <limits>
#include <cmath>
#include <atomic>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

namespace {
using Clock = std::chrono::steady_clock;

struct Entry {
  std::string name;
  std::uint16_t method{};
  std::uint32_t compressedSize{};
  std::uint32_t uncompressedSize{};
  std::uint32_t localHeaderOffset{};
};

struct FitStats {
  std::uint64_t records{};
  std::uint64_t sessions{};
  std::uint64_t decodedFields{};
  std::uint64_t valueChecksum{};
  std::uint64_t typedArrayBytes{};
  std::uint64_t compactTypedArrayBytes{};
  std::uint64_t woaBytes{};
  std::uint64_t workoutRawBytes{};
  std::uint64_t workoutGzipBytes{};
  std::uint64_t gpsRawBytes{};
  std::uint64_t gpsGzipBytes{};
  double woaBuildMs{};
  std::uint64_t nativeRawContainerBytes{};
  std::uint64_t nativeGzipContainerBytes{};
  double nativeContainerBuildMs{};
  double payloadReadyWallMs{};
};

struct NativeEntryResult {
  FitStats stats;
  std::vector<std::uint8_t> bytes;
};

struct ParallelEntryResult {
  FitStats stats;
  std::vector<std::uint8_t> bytes;
  std::uint64_t outputBytes{};
  std::uint64_t checksum{};
  double extractMs{};
  double parseMs{};
};

struct FitField {
  std::uint8_t number{};
  std::uint8_t size{};
  std::uint8_t baseType{};
};

struct FitDefinition {
  bool valid{};
  bool littleEndian{};
  std::uint16_t globalMessage{};
  std::vector<FitField> fields;
};

struct CompactColumns {
  std::uint64_t baseTimestampMs{};
  std::vector<std::int32_t> timestampOffsetsS;
  std::vector<std::uint32_t> distancesQ;
  std::vector<std::uint16_t> powersW;
  std::vector<std::uint8_t> heartRatesBpm;
  std::vector<std::uint8_t> cadencesRpm;
  std::vector<std::uint16_t> speedsCmS;
  std::vector<std::int16_t> altitudesQ;
  std::vector<std::int32_t> positionLatsE6;
  std::vector<std::int32_t> positionLongsE6;
};

std::vector<std::uint8_t> buildSessionBlockCompact(const CompactColumns& columns);
std::vector<std::uint8_t> buildWoaMetaBlockCompact(
    const CompactColumns& columns,
    std::uint64_t sessionCount,
    const std::vector<std::uint8_t>& workoutStreamRaw,
    const std::vector<std::uint8_t>& workoutStreamGzip,
    const std::vector<std::uint8_t>& gpsTrackRaw,
    const std::vector<std::uint8_t>& gpsTrackGzip,
    std::uint32_t gpsPointCount);

std::uint16_t read16(const std::uint8_t* p) {
  return static_cast<std::uint16_t>(p[0] | (p[1] << 8));
}

std::uint32_t read32(const std::uint8_t* p) {
  return static_cast<std::uint32_t>(p[0]) |
         (static_cast<std::uint32_t>(p[1]) << 8) |
         (static_cast<std::uint32_t>(p[2]) << 16) |
         (static_cast<std::uint32_t>(p[3]) << 24);
}

void write16(std::vector<std::uint8_t>& out, std::size_t offset, std::uint16_t value) {
  out[offset] = static_cast<std::uint8_t>(value & 0xff);
  out[offset + 1] = static_cast<std::uint8_t>((value >> 8) & 0xff);
}

void write32(std::vector<std::uint8_t>& out, std::size_t offset, std::uint32_t value) {
  out[offset] = static_cast<std::uint8_t>(value & 0xff);
  out[offset + 1] = static_cast<std::uint8_t>((value >> 8) & 0xff);
  out[offset + 2] = static_cast<std::uint8_t>((value >> 16) & 0xff);
  out[offset + 3] = static_cast<std::uint8_t>((value >> 24) & 0xff);
}

void write64(std::vector<std::uint8_t>& out, std::size_t offset, std::uint64_t value) {
  for (std::size_t index = 0; index < 8; ++index) {
    out[offset + index] = static_cast<std::uint8_t>((value >> (index * 8)) & 0xff);
  }
}

void writeDouble(std::vector<std::uint8_t>& out, std::size_t offset, double value) {
  static_assert(sizeof(double) == 8);
  std::uint64_t bits = 0;
  std::memcpy(&bits, &value, sizeof(bits));
  for (std::size_t index = 0; index < 8; ++index) {
    out[offset + index] = static_cast<std::uint8_t>((bits >> (index * 8)) & 0xff);
  }
}

void requireRange(std::size_t offset, std::size_t length, std::size_t size) {
  if (offset > size || length > size - offset) {
    throw std::runtime_error("Invalid or truncated ZIP structure");
  }
}

std::vector<std::uint8_t> readFile(const std::filesystem::path& path) {
  std::ifstream input(path, std::ios::binary | std::ios::ate);
  if (!input) throw std::runtime_error("Cannot open file: " + path.string());
  const auto end = input.tellg();
  if (end < 0) throw std::runtime_error("Cannot determine file size");
  std::vector<std::uint8_t> data(static_cast<std::size_t>(end));
  input.seekg(0);
  if (!data.empty() && !input.read(reinterpret_cast<char*>(data.data()), end)) {
    throw std::runtime_error("Cannot read file");
  }
  return data;
}

std::vector<Entry> parseEntries(const std::vector<std::uint8_t>& zip) {
  constexpr std::uint32_t eocdSignature = 0x06054b50;
  constexpr std::uint32_t centralSignature = 0x02014b50;
  if (zip.size() < 22) throw std::runtime_error("File is too small to be a ZIP");

  const std::size_t searchStart = zip.size() > 65557 ? zip.size() - 65557 : 0;
  std::size_t eocd = zip.size() - 22;
  while (read32(zip.data() + eocd) != eocdSignature) {
    if (eocd == searchStart) throw std::runtime_error("ZIP end record not found");
    --eocd;
  }

  const auto count = read16(zip.data() + eocd + 10);
  const auto centralOffset = read32(zip.data() + eocd + 16);
  if (count == 0xffff || centralOffset == 0xffffffffU) {
    throw std::runtime_error("ZIP64 is not supported in this first benchmark version");
  }

  std::vector<Entry> entries;
  entries.reserve(count);
  std::size_t cursor = centralOffset;
  for (std::uint16_t index = 0; index < count; ++index) {
    requireRange(cursor, 46, zip.size());
    const auto* header = zip.data() + cursor;
    if (read32(header) != centralSignature) {
      throw std::runtime_error("Invalid central directory entry");
    }
    const auto nameLength = read16(header + 28);
    const auto extraLength = read16(header + 30);
    const auto commentLength = read16(header + 32);
    requireRange(cursor + 46, nameLength + extraLength + commentLength, zip.size());
    entries.push_back({
        std::string(reinterpret_cast<const char*>(header + 46), nameLength),
        read16(header + 10), read32(header + 20), read32(header + 24),
        read32(header + 42)});
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

bool endsWithFit(const std::string& name) {
  if (name.size() < 4) return false;
  std::string suffix = name.substr(name.size() - 4);
  std::transform(suffix.begin(), suffix.end(), suffix.begin(),
                 [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  return suffix == ".fit";
}

double elapsedMs(Clock::time_point start, Clock::time_point end) {
  return std::chrono::duration<double, std::milli>(end - start).count();
}

std::uint16_t encodeUint16(double value) {
  if (!std::isfinite(value)) return 0xffff;
  return static_cast<std::uint16_t>(std::max(0.0, std::min(65534.0, std::round(value))));
}

std::uint8_t encodeUint8(double value) {
  if (!std::isfinite(value)) return 0xff;
  return static_cast<std::uint8_t>(std::max(0.0, std::min(254.0, std::round(value))));
}

std::int16_t encodeAltitude(double value) {
  if (!std::isfinite(value)) return static_cast<std::int16_t>(-32768);
  return static_cast<std::int16_t>(std::max(-32767.0, std::min(32767.0, std::round(value * 4.0))));
}

std::uint32_t encodeDistance(double value) {
  if (!std::isfinite(value) || value < 0) return 0xffffffffU;
  return static_cast<std::uint32_t>(std::max(0.0, std::min(4294967294.0, std::round(value * 4.0))));
}

std::uint32_t compactDistanceFromCentimeters(std::uint64_t rawCentimeters) {
  return static_cast<std::uint32_t>(std::min<std::uint64_t>(0xfffffffeULL, (rawCentimeters + 12) / 25));
}

std::uint16_t compactSpeedFromMmS(std::uint64_t rawMmS) {
  return static_cast<std::uint16_t>(std::min<std::uint64_t>(0xfffeULL, (rawMmS + 5) / 10));
}

std::int16_t compactAltitudeFromRaw(std::uint64_t rawAltitude) {
  const auto scaled = static_cast<std::int64_t>((rawAltitude * 4 + 2) / 5) - 2000;
  return static_cast<std::int16_t>(std::max<std::int64_t>(-32767, std::min<std::int64_t>(32767, scaled)));
}

std::int32_t compactCoordE6(std::int64_t semicircles) {
  constexpr long double scale = 180000000.0L / 2147483648.0L;
  const auto value = static_cast<long double>(semicircles) * scale;
  return static_cast<std::int32_t>(std::llround(value));
}

std::uint16_t quantizeCompactUint16(std::uint16_t value, std::uint16_t sentinel, std::uint16_t step) {
  if (value == sentinel || step <= 1) {
    return value;
  }
  const std::uint32_t quantized = ((static_cast<std::uint32_t>(value) + (step / 2)) / step) * step;
  return static_cast<std::uint16_t>(std::min<std::uint32_t>(sentinel - 1, quantized));
}

std::uint8_t quantizeCompactUint8(std::uint8_t value, std::uint8_t sentinel, std::uint8_t step) {
  if (value == sentinel || step <= 1) {
    return value;
  }
  const std::uint32_t quantized = ((static_cast<std::uint32_t>(value) + (step / 2)) / step) * step;
  return static_cast<std::uint8_t>(std::min<std::uint32_t>(sentinel - 1, quantized));
}

std::vector<std::uint8_t> buildDistancePayload(const std::vector<double>& distances) {
  constexpr std::size_t blockSize = 128;
  std::vector<std::uint32_t> values(distances.size());
  for (std::size_t index = 0; index < distances.size(); ++index) {
    values[index] = encodeDistance(distances[index]);
  }

  std::vector<std::uint8_t> payload;
  payload.reserve(distances.size() * 2 + distances.size() / 16 + 32);
  for (std::size_t start = 0; start < values.size(); start += blockSize) {
    const std::size_t count = std::min(blockSize, values.size() - start);
    bool canDeltaEncode = count > 0;
    for (std::size_t offset = 0; offset < count; ++offset) {
      const auto current = values[start + offset];
      if (current == 0xffffffffU) {
        canDeltaEncode = false;
        break;
      }
      if (offset > 0) {
        const auto previous = values[start + offset - 1];
        const auto delta = static_cast<std::int64_t>(current) - static_cast<std::int64_t>(previous);
        if (delta < -32767 || delta > 32767) {
          canDeltaEncode = false;
          break;
        }
      }
    }

    if (canDeltaEncode) {
      const std::size_t chunkOffset = payload.size();
      payload.resize(payload.size() + 1 + 2 + 4 + (count > 0 ? count - 1 : 0) * 2);
      payload[chunkOffset] = 1;
      write16(payload, chunkOffset + 1, static_cast<std::uint16_t>(count));
      write32(payload, chunkOffset + 3, values[start]);
      std::size_t writeOffset = chunkOffset + 7;
      for (std::size_t index = 1; index < count; ++index) {
        const auto delta = static_cast<std::int16_t>(
            static_cast<std::int64_t>(values[start + index]) -
            static_cast<std::int64_t>(values[start + index - 1]));
        write16(payload, writeOffset, static_cast<std::uint16_t>(delta));
        writeOffset += 2;
      }
      continue;
    }

    const std::size_t chunkOffset = payload.size();
    payload.resize(payload.size() + 1 + 2 + count * 4);
    payload[chunkOffset] = 0;
    write16(payload, chunkOffset + 1, static_cast<std::uint16_t>(count));
    std::size_t writeOffset = chunkOffset + 3;
    for (std::size_t index = 0; index < count; ++index) {
      write32(payload, writeOffset, values[start + index]);
      writeOffset += 4;
    }
  }
  return payload;
}

std::vector<std::uint8_t> buildDistancePayloadCompact(const std::vector<std::uint32_t>& values) {
  constexpr std::size_t blockSize = 128;
  std::vector<std::uint8_t> payload;
  payload.reserve(values.size() * 2 + values.size() / 16 + 32);
  for (std::size_t start = 0; start < values.size(); start += blockSize) {
    const std::size_t count = std::min(blockSize, values.size() - start);
    bool canDeltaEncode = count > 0;
    for (std::size_t offset = 0; offset < count; ++offset) {
      const auto current = values[start + offset];
      if (current == 0xffffffffU) {
        canDeltaEncode = false;
        break;
      }
      if (offset > 0) {
        const auto previous = values[start + offset - 1];
        const auto delta = static_cast<std::int64_t>(current) - static_cast<std::int64_t>(previous);
        if (delta < -32767 || delta > 32767) {
          canDeltaEncode = false;
          break;
        }
      }
    }

    if (canDeltaEncode) {
      const std::size_t chunkOffset = payload.size();
      payload.resize(payload.size() + 1 + 2 + 4 + (count > 0 ? count - 1 : 0) * 2);
      payload[chunkOffset] = 1;
      write16(payload, chunkOffset + 1, static_cast<std::uint16_t>(count));
      write32(payload, chunkOffset + 3, values[start]);
      std::size_t writeOffset = chunkOffset + 7;
      for (std::size_t index = 1; index < count; ++index) {
        const auto delta = static_cast<std::int16_t>(
            static_cast<std::int64_t>(values[start + index]) -
            static_cast<std::int64_t>(values[start + index - 1]));
        write16(payload, writeOffset, static_cast<std::uint16_t>(delta));
        writeOffset += 2;
      }
      continue;
    }

    const std::size_t chunkOffset = payload.size();
    payload.resize(payload.size() + 1 + 2 + count * 4);
    payload[chunkOffset] = 0;
    write16(payload, chunkOffset + 1, static_cast<std::uint16_t>(count));
    std::size_t writeOffset = chunkOffset + 3;
    for (std::size_t index = 0; index < count; ++index) {
      write32(payload, writeOffset, values[start + index]);
      writeOffset += 4;
    }
  }
  return payload;
}

std::vector<std::uint8_t> buildWorkoutStreamBlock(const std::array<std::vector<double>, 9>& columns) {
  const auto& timestamps = columns[0];
  const auto& distances = columns[1];
  const auto& powers = columns[2];
  const auto& heartRates = columns[3];
  const auto& cadences = columns[4];
  const auto& speeds = columns[5];
  const auto& altitudes = columns[6];
  const std::size_t recordCount = timestamps.size();
  bool hasCompleteDistanceSeries = recordCount > 0;
  for (double value : distances) {
    if (!std::isfinite(value)) {
      hasCompleteDistanceSeries = false;
      break;
    }
  }

  const auto distancePayload = buildDistancePayload(distances);
  const std::uint32_t distancesBytes = static_cast<std::uint32_t>(distancePayload.size());
  const std::uint32_t powersBytes = static_cast<std::uint32_t>(recordCount * 2);
  const std::uint32_t heartRatesBytes = static_cast<std::uint32_t>(recordCount);
  const std::uint32_t cadencesBytes = static_cast<std::uint32_t>(recordCount);
  const std::uint32_t speedsBytes = hasCompleteDistanceSeries ? 0 : static_cast<std::uint32_t>(recordCount * 2);
  const std::uint32_t altitudesBytes = static_cast<std::uint32_t>(recordCount * 2);
  constexpr std::size_t headerBytes = 4 + 4 + 8 + 4 + 6 * 4;
  std::vector<std::uint8_t> out(headerBytes + distancesBytes + powersBytes + heartRatesBytes +
                                cadencesBytes + speedsBytes + altitudesBytes);
  std::memcpy(out.data(), "WST3", 4);
  write32(out, 4, static_cast<std::uint32_t>(recordCount));
  const double baseTimestampMs = recordCount > 0 && std::isfinite(timestamps[0]) ? std::round(timestamps[0]) : 0.0;
  writeDouble(out, 8, baseTimestampMs);
  write32(out, 16, 1000);
  std::size_t headerOffset = 20;
  for (std::uint32_t length : {distancesBytes, powersBytes, heartRatesBytes, cadencesBytes, speedsBytes, altitudesBytes}) {
    write32(out, headerOffset, length);
    headerOffset += 4;
  }

  std::size_t payloadOffset = headerBytes;
  std::memcpy(out.data() + payloadOffset, distancePayload.data(), distancePayload.size());
  payloadOffset += distancePayload.size();
  for (std::size_t index = 0; index < recordCount; ++index) {
    write16(out, payloadOffset + index * 2, encodeUint16(powers[index]));
  }
  payloadOffset += powersBytes;
  for (std::size_t index = 0; index < recordCount; ++index) out[payloadOffset + index] = encodeUint8(heartRates[index]);
  payloadOffset += heartRatesBytes;
  for (std::size_t index = 0; index < recordCount; ++index) out[payloadOffset + index] = encodeUint8(cadences[index]);
  payloadOffset += cadencesBytes;
  if (speedsBytes > 0) {
    for (std::size_t index = 0; index < recordCount; ++index) {
      write16(out, payloadOffset + index * 2, encodeUint16(std::isfinite(speeds[index]) ? speeds[index] * 100.0 : speeds[index]));
    }
    payloadOffset += speedsBytes;
  }
  for (std::size_t index = 0; index < recordCount; ++index) {
    write16(out, payloadOffset + index * 2, static_cast<std::uint16_t>(encodeAltitude(altitudes[index])));
  }
  return out;
}

std::vector<std::uint8_t> buildWorkoutStreamBlockCompact(const CompactColumns& columns) {
  const std::size_t recordCount = columns.timestampOffsetsS.size();
  bool hasCompleteDistanceSeries = recordCount > 0;
  for (auto value : columns.distancesQ) {
    if (value == 0xffffffffU) {
      hasCompleteDistanceSeries = false;
      break;
    }
  }

  const auto distancePayload = buildDistancePayloadCompact(columns.distancesQ);
  const std::uint32_t distancesBytes = static_cast<std::uint32_t>(distancePayload.size());
  const std::uint32_t powersBytes = static_cast<std::uint32_t>(recordCount * 2);
  const std::uint32_t heartRatesBytes = static_cast<std::uint32_t>(recordCount);
  const std::uint32_t cadencesBytes = static_cast<std::uint32_t>(recordCount);
  const std::uint32_t speedsBytes = hasCompleteDistanceSeries ? 0 : static_cast<std::uint32_t>(recordCount * 2);
  const std::uint32_t altitudesBytes = static_cast<std::uint32_t>(recordCount * 2);
  constexpr std::size_t headerBytes = 4 + 4 + 8 + 4 + 6 * 4;
  std::vector<std::uint8_t> out(headerBytes + distancesBytes + powersBytes + heartRatesBytes +
                                cadencesBytes + speedsBytes + altitudesBytes);
  std::memcpy(out.data(), "WST3", 4);
  write32(out, 4, static_cast<std::uint32_t>(recordCount));
  writeDouble(out, 8, static_cast<double>(columns.baseTimestampMs));
  write32(out, 16, 1000);
  std::size_t headerOffset = 20;
  for (std::uint32_t length : {distancesBytes, powersBytes, heartRatesBytes, cadencesBytes, speedsBytes, altitudesBytes}) {
    write32(out, headerOffset, length);
    headerOffset += 4;
  }

  std::size_t payloadOffset = headerBytes;
  std::memcpy(out.data() + payloadOffset, distancePayload.data(), distancePayload.size());
  payloadOffset += distancePayload.size();
  std::memcpy(out.data() + payloadOffset, columns.powersW.data(), powersBytes);
  payloadOffset += powersBytes;
  std::memcpy(out.data() + payloadOffset, columns.heartRatesBpm.data(), heartRatesBytes);
  payloadOffset += heartRatesBytes;
  std::memcpy(out.data() + payloadOffset, columns.cadencesRpm.data(), cadencesBytes);
  payloadOffset += cadencesBytes;
  if (speedsBytes > 0) {
    std::memcpy(out.data() + payloadOffset, columns.speedsCmS.data(), speedsBytes);
    payloadOffset += speedsBytes;
  }
  std::memcpy(out.data() + payloadOffset, columns.altitudesQ.data(), altitudesBytes);
  return out;
}

std::vector<std::uint8_t> gzipBytes(libdeflate_compressor* compressor, const std::vector<std::uint8_t>& raw) {
  std::vector<std::uint8_t> compressed(libdeflate_gzip_compress_bound(compressor, raw.size()));
  const auto compressedSize = libdeflate_gzip_compress(
      compressor, raw.data(), raw.size(), compressed.data(), compressed.size());
  if (compressedSize == 0) throw std::runtime_error("gzip compression failed");
  compressed.resize(compressedSize);
  return compressed;
}

void append32(std::vector<std::uint8_t>& out, std::uint32_t value) {
  const auto offset = out.size();
  out.resize(offset + 4);
  write32(out, offset, value);
}

void appendBytes(std::vector<std::uint8_t>& out, const std::vector<std::uint8_t>& bytes) {
  out.insert(out.end(), bytes.begin(), bytes.end());
}

void appendString(std::vector<std::uint8_t>& out, const std::string& value) {
  append32(out, static_cast<std::uint32_t>(value.size()));
  out.insert(out.end(), value.begin(), value.end());
}

std::string jsonEscape(const std::string& value) {
  std::string out;
  out.reserve(value.size() + 8);
  for (char ch : value) {
    switch (ch) {
      case '\"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\b': out += "\\b"; break;
      case '\f': out += "\\f"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default: out += ch; break;
    }
  }
  return out;
}

std::string replaceFitExtension(std::string name, const std::string& extension) {
  if (endsWithFit(name)) {
    name.resize(name.size() - 4);
    name += extension;
    return name;
  }
  return name + extension;
}

std::uint64_t encodeTimestampMs(double value) {
  if (!std::isfinite(value) || value < 0) return std::numeric_limits<std::uint64_t>::max();
  return static_cast<std::uint64_t>(std::round(value));
}

std::vector<std::uint8_t> buildNativeSummaryBlock(
    const std::array<std::vector<double>, 9>& columns,
    std::uint64_t sessionCount) {
  const auto& timestamps = columns[0];
  const auto& distances = columns[1];
  const auto& powers = columns[2];
  const auto& heartRates = columns[3];
  const auto& cadences = columns[4];
  const auto& altitudes = columns[6];
  const auto& lats = columns[7];
  const auto& lngs = columns[8];
  const std::size_t recordCount = timestamps.size();
  double minLat = std::numeric_limits<double>::infinity();
  double maxLat = -std::numeric_limits<double>::infinity();
  double minLng = std::numeric_limits<double>::infinity();
  double maxLng = -std::numeric_limits<double>::infinity();
  std::uint32_t validGpsCount = 0;
  double maxPower = std::numeric_limits<double>::quiet_NaN();
  double maxHr = std::numeric_limits<double>::quiet_NaN();
  double maxCadence = std::numeric_limits<double>::quiet_NaN();
  double minAltitude = std::numeric_limits<double>::quiet_NaN();
  double maxAltitude = std::numeric_limits<double>::quiet_NaN();

  for (std::size_t index = 0; index < recordCount; ++index) {
    if (std::isfinite(lats[index]) && std::isfinite(lngs[index]) && !(lats[index] == 0.0 && lngs[index] == 0.0)) {
      minLat = std::min(minLat, lats[index]);
      maxLat = std::max(maxLat, lats[index]);
      minLng = std::min(minLng, lngs[index]);
      maxLng = std::max(maxLng, lngs[index]);
      ++validGpsCount;
    }
    if (std::isfinite(powers[index])) maxPower = std::isfinite(maxPower) ? std::max(maxPower, powers[index]) : powers[index];
    if (std::isfinite(heartRates[index])) maxHr = std::isfinite(maxHr) ? std::max(maxHr, heartRates[index]) : heartRates[index];
    if (std::isfinite(cadences[index])) maxCadence = std::isfinite(maxCadence) ? std::max(maxCadence, cadences[index]) : cadences[index];
    if (std::isfinite(altitudes[index])) {
      minAltitude = std::isfinite(minAltitude) ? std::min(minAltitude, altitudes[index]) : altitudes[index];
      maxAltitude = std::isfinite(maxAltitude) ? std::max(maxAltitude, altitudes[index]) : altitudes[index];
    }
  }

  constexpr std::size_t size = 4 + 2 + 2 + 4 + 4 + 4 + 8 + 8 + 4 + 2 + 2 + 1 + 1 + 1 + 1 + 2 + 2 + 4 * 4;
  std::vector<std::uint8_t> out(size);
  std::memcpy(out.data(), "SUM1", 4);
  write16(out, 4, 1);
  write16(out, 6, static_cast<std::uint16_t>(size));
  write32(out, 8, static_cast<std::uint32_t>(recordCount));
  write32(out, 12, static_cast<std::uint32_t>(sessionCount));
  write32(out, 16, validGpsCount);
  write64(out, 20, recordCount > 0 ? encodeTimestampMs(timestamps.front()) : std::numeric_limits<std::uint64_t>::max());
  write64(out, 28, recordCount > 0 ? encodeTimestampMs(timestamps.back()) : std::numeric_limits<std::uint64_t>::max());
  write32(out, 36, recordCount > 0 ? encodeDistance(distances.back()) : 0xffffffffU);
  write16(out, 40, encodeUint16(maxPower));
  write16(out, 42, encodeUint16(maxAltitude));
  out[44] = encodeUint8(maxHr);
  out[45] = encodeUint8(maxCadence);
  out[46] = 5; // sampleRateGps candidate
  out[47] = validGpsCount > 1 ? 1 : 0;
  write16(out, 48, static_cast<std::uint16_t>(encodeAltitude(minAltitude)));
  write16(out, 50, static_cast<std::uint16_t>(encodeAltitude(maxAltitude)));
  auto coord = [](double value) -> std::uint32_t {
    if (!std::isfinite(value)) return 0x80000000U;
    const auto encoded = static_cast<std::int32_t>(std::max(-2147483647.0, std::min(2147483647.0, std::round(value * 10000000.0))));
    return static_cast<std::uint32_t>(encoded);
  };
  write32(out, 52, coord(minLat));
  write32(out, 56, coord(minLng));
  write32(out, 60, coord(maxLat));
  write32(out, 64, coord(maxLng));
  return out;
}

std::vector<std::uint8_t> buildNativeGpsBlock(const std::array<std::vector<double>, 9>& columns) {
  const auto& timestamps = columns[0];
  const auto& lats = columns[7];
  const auto& lngs = columns[8];
  const std::size_t recordCount = timestamps.size();
  std::vector<std::pair<std::int32_t, std::int32_t>> points;
  points.reserve(recordCount / 5 + 1);
  for (std::size_t index = 0; index < recordCount; index += 5) {
    if (!std::isfinite(lats[index]) || !std::isfinite(lngs[index]) || (lats[index] == 0.0 && lngs[index] == 0.0)) continue;
    points.push_back({
        static_cast<std::int32_t>(std::round(lats[index] * 1000000.0)),
        static_cast<std::int32_t>(std::round(lngs[index] * 1000000.0))});
  }

  constexpr std::size_t blockSize = 128;
  std::vector<std::uint8_t> payload;
  payload.reserve(points.size() * 4 + points.size() / 16 + 32);
  for (std::size_t start = 0; start < points.size(); start += blockSize) {
    const std::size_t count = std::min(blockSize, points.size() - start);
    bool canDeltaEncode = count > 0;
    for (std::size_t offset = 1; offset < count; ++offset) {
      const auto& current = points[start + offset];
      const auto& previous = points[start + offset - 1];
      const auto deltaLat = static_cast<std::int64_t>(current.first) - static_cast<std::int64_t>(previous.first);
      const auto deltaLng = static_cast<std::int64_t>(current.second) - static_cast<std::int64_t>(previous.second);
      if (deltaLat < -32767 || deltaLat > 32767 || deltaLng < -32767 || deltaLng > 32767) {
        canDeltaEncode = false;
        break;
      }
    }

    if (canDeltaEncode) {
      const auto chunkOffset = payload.size();
      payload.resize(payload.size() + 1 + 2 + 4 + (count > 0 ? count - 1 : 0) * 2 + 4 + (count > 0 ? count - 1 : 0) * 2);
      payload[chunkOffset] = 1;
      write16(payload, chunkOffset + 1, static_cast<std::uint16_t>(count));
      write32(payload, chunkOffset + 3, static_cast<std::uint32_t>(points[start].first));
      std::size_t writeOffset = chunkOffset + 7;
      for (std::size_t index = 1; index < count; ++index) {
        const auto delta = static_cast<std::int16_t>(
            static_cast<std::int64_t>(points[start + index].first) -
            static_cast<std::int64_t>(points[start + index - 1].first));
        write16(payload, writeOffset, static_cast<std::uint16_t>(delta));
        writeOffset += 2;
      }
      write32(payload, writeOffset, static_cast<std::uint32_t>(points[start].second));
      writeOffset += 4;
      for (std::size_t index = 1; index < count; ++index) {
        const auto delta = static_cast<std::int16_t>(
            static_cast<std::int64_t>(points[start + index].second) -
            static_cast<std::int64_t>(points[start + index - 1].second));
        write16(payload, writeOffset, static_cast<std::uint16_t>(delta));
        writeOffset += 2;
      }
      continue;
    }

    const auto chunkOffset = payload.size();
    payload.resize(payload.size() + 1 + 2 + count * 8);
    payload[chunkOffset] = 0;
    write16(payload, chunkOffset + 1, static_cast<std::uint16_t>(count));
    std::size_t writeOffset = chunkOffset + 3;
    for (std::size_t index = 0; index < count; ++index) {
      write32(payload, writeOffset, static_cast<std::uint32_t>(points[start + index].first));
      writeOffset += 4;
    }
    for (std::size_t index = 0; index < count; ++index) {
      write32(payload, writeOffset, static_cast<std::uint32_t>(points[start + index].second));
      writeOffset += 4;
    }
  }

  std::vector<std::uint8_t> out(4 + 2 + 2 + 4 + payload.size());
  std::memcpy(out.data(), "NGP1", 4);
  write16(out, 4, 1);
  write16(out, 6, 5);
  write32(out, 8, static_cast<std::uint32_t>(points.size()));
  std::memcpy(out.data() + 12, payload.data(), payload.size());
  return out;
}

std::vector<std::uint8_t> buildNativeSummaryBlockCompact(const CompactColumns& columns, std::uint64_t sessionCount) {
  const std::size_t recordCount = columns.timestampOffsetsS.size();
  std::int32_t minLat = std::numeric_limits<std::int32_t>::max();
  std::int32_t maxLat = std::numeric_limits<std::int32_t>::min();
  std::int32_t minLng = std::numeric_limits<std::int32_t>::max();
  std::int32_t maxLng = std::numeric_limits<std::int32_t>::min();
  std::uint32_t validGpsCount = 0;
  std::uint16_t maxPower = 0xffff;
  std::uint8_t maxHr = 0xff;
  std::uint8_t maxCadence = 0xff;
  std::int16_t minAltitude = 0x7fff;
  std::int16_t maxAltitude = static_cast<std::int16_t>(-32768);
  for (std::size_t index = 0; index < recordCount; ++index) {
    const auto lat = columns.positionLatsE6[index];
    const auto lng = columns.positionLongsE6[index];
    if (lat != static_cast<std::int32_t>(0x80000000) && lng != static_cast<std::int32_t>(0x80000000) && !(lat == 0 && lng == 0)) {
      minLat = std::min(minLat, lat);
      maxLat = std::max(maxLat, lat);
      minLng = std::min(minLng, lng);
      maxLng = std::max(maxLng, lng);
      ++validGpsCount;
    }
    const auto power = columns.powersW[index];
    if (power != 0xffff) maxPower = maxPower == 0xffff ? power : std::max(maxPower, power);
    const auto hr = columns.heartRatesBpm[index];
    if (hr != 0xff) maxHr = maxHr == 0xff ? hr : std::max(maxHr, hr);
    const auto cadence = columns.cadencesRpm[index];
    if (cadence != 0xff) maxCadence = maxCadence == 0xff ? cadence : std::max(maxCadence, cadence);
    const auto altitude = columns.altitudesQ[index];
    if (altitude != static_cast<std::int16_t>(-32768)) {
      minAltitude = minAltitude == 0x7fff ? altitude : std::min(minAltitude, altitude);
      maxAltitude = maxAltitude == static_cast<std::int16_t>(-32768) ? altitude : std::max(maxAltitude, altitude);
    }
  }

  constexpr std::size_t size = 4 + 2 + 2 + 4 + 4 + 4 + 8 + 8 + 4 + 2 + 2 + 1 + 1 + 1 + 1 + 2 + 2 + 4 * 4;
  std::vector<std::uint8_t> out(size);
  std::memcpy(out.data(), "SUM1", 4);
  write16(out, 4, 1);
  write16(out, 6, static_cast<std::uint16_t>(size));
  write32(out, 8, static_cast<std::uint32_t>(recordCount));
  write32(out, 12, static_cast<std::uint32_t>(sessionCount));
  write32(out, 16, validGpsCount);
  write64(out, 20, recordCount > 0 ? columns.baseTimestampMs : std::numeric_limits<std::uint64_t>::max());
  const std::uint64_t endTime = recordCount > 0 && columns.timestampOffsetsS.back() != static_cast<std::int32_t>(0x80000000)
      ? columns.baseTimestampMs + static_cast<std::uint64_t>(std::max<std::int32_t>(0, columns.timestampOffsetsS.back())) * 1000ULL
      : std::numeric_limits<std::uint64_t>::max();
  write64(out, 28, endTime);
  write32(out, 36, recordCount > 0 ? columns.distancesQ.back() : 0xffffffffU);
  write16(out, 40, maxPower);
  write16(out, 42, static_cast<std::uint16_t>(maxAltitude));
  out[44] = maxHr;
  out[45] = maxCadence;
  out[46] = 5;
  out[47] = validGpsCount > 1 ? 1 : 0;
  write16(out, 48, static_cast<std::uint16_t>(minAltitude));
  write16(out, 50, static_cast<std::uint16_t>(maxAltitude));
  auto e6ToE7 = [](std::int32_t value) -> std::uint32_t {
    return value == static_cast<std::int32_t>(0x80000000)
      ? 0x80000000U
      : static_cast<std::uint32_t>(value * 10);
  };
  write32(out, 52, e6ToE7(minLat == std::numeric_limits<std::int32_t>::max() ? static_cast<std::int32_t>(0x80000000) : minLat));
  write32(out, 56, e6ToE7(minLng == std::numeric_limits<std::int32_t>::max() ? static_cast<std::int32_t>(0x80000000) : minLng));
  write32(out, 60, e6ToE7(maxLat == std::numeric_limits<std::int32_t>::min() ? static_cast<std::int32_t>(0x80000000) : maxLat));
  write32(out, 64, e6ToE7(maxLng == std::numeric_limits<std::int32_t>::min() ? static_cast<std::int32_t>(0x80000000) : maxLng));
  return out;
}

std::vector<std::uint8_t> buildNativeGpsBlockCompact(const CompactColumns& columns) {
  std::vector<std::pair<std::int32_t, std::int32_t>> points;
  points.reserve(columns.timestampOffsetsS.size() / 5 + 1);
  for (std::size_t index = 0; index < columns.timestampOffsetsS.size(); index += 5) {
    const auto lat = columns.positionLatsE6[index];
    const auto lng = columns.positionLongsE6[index];
    if (lat == static_cast<std::int32_t>(0x80000000) || lng == static_cast<std::int32_t>(0x80000000) || (lat == 0 && lng == 0)) continue;
    points.push_back({lat, lng});
  }

  constexpr std::size_t blockSize = 128;
  std::vector<std::uint8_t> payload;
  payload.reserve(points.size() * 4 + points.size() / 16 + 32);
  for (std::size_t start = 0; start < points.size(); start += blockSize) {
    const std::size_t count = std::min(blockSize, points.size() - start);
    bool canDeltaEncode = count > 0;
    for (std::size_t offset = 1; offset < count; ++offset) {
      const auto deltaLat = static_cast<std::int64_t>(points[start + offset].first) - points[start + offset - 1].first;
      const auto deltaLng = static_cast<std::int64_t>(points[start + offset].second) - points[start + offset - 1].second;
      if (deltaLat < -32767 || deltaLat > 32767 || deltaLng < -32767 || deltaLng > 32767) {
        canDeltaEncode = false;
        break;
      }
    }
    if (canDeltaEncode) {
      const auto chunkOffset = payload.size();
      payload.resize(payload.size() + 1 + 2 + 4 + (count > 0 ? count - 1 : 0) * 2 + 4 + (count > 0 ? count - 1 : 0) * 2);
      payload[chunkOffset] = 1;
      write16(payload, chunkOffset + 1, static_cast<std::uint16_t>(count));
      write32(payload, chunkOffset + 3, static_cast<std::uint32_t>(points[start].first));
      std::size_t writeOffset = chunkOffset + 7;
      for (std::size_t index = 1; index < count; ++index) {
        write16(payload, writeOffset, static_cast<std::uint16_t>(static_cast<std::int16_t>(points[start + index].first - points[start + index - 1].first)));
        writeOffset += 2;
      }
      write32(payload, writeOffset, static_cast<std::uint32_t>(points[start].second));
      writeOffset += 4;
      for (std::size_t index = 1; index < count; ++index) {
        write16(payload, writeOffset, static_cast<std::uint16_t>(static_cast<std::int16_t>(points[start + index].second - points[start + index - 1].second)));
        writeOffset += 2;
      }
      continue;
    }
    const auto chunkOffset = payload.size();
    payload.resize(payload.size() + 1 + 2 + count * 8);
    payload[chunkOffset] = 0;
    write16(payload, chunkOffset + 1, static_cast<std::uint16_t>(count));
    std::size_t writeOffset = chunkOffset + 3;
    for (std::size_t index = 0; index < count; ++index) {
      write32(payload, writeOffset, static_cast<std::uint32_t>(points[start + index].first));
      writeOffset += 4;
    }
    for (std::size_t index = 0; index < count; ++index) {
      write32(payload, writeOffset, static_cast<std::uint32_t>(points[start + index].second));
      writeOffset += 4;
    }
  }
  const std::uint64_t firstTimestampMs = columns.baseTimestampMs;
  std::vector<std::uint8_t> out(4 + 2 + 2 + 4 + 8 + payload.size());
  std::memcpy(out.data(), "GPS2", 4);
  write16(out, 4, 2);
  write16(out, 6, 5);
  write32(out, 8, static_cast<std::uint32_t>(points.size()));
  writeDouble(out, 12, static_cast<double>(firstTimestampMs));
  std::memcpy(out.data() + 20, payload.data(), payload.size());
  return out;
}

std::vector<std::uint8_t> buildNativeEntry(
    const std::array<std::vector<double>, 9>& columns,
    std::uint64_t sessionCount,
    libdeflate_compressor* compressor,
    FitStats& stats) {
  const auto summary = buildNativeSummaryBlock(columns, sessionCount);
  const std::vector<std::uint8_t> sessions = {'S', 'N', 'S', '1', 1, 0, 0, 0};
  const auto workoutRaw = buildWorkoutStreamBlock(columns);
  const auto workoutGzip = gzipBytes(compressor, workoutRaw);
  const auto gpsRaw = buildNativeGpsBlock(columns);
  const auto gpsGzip = gzipBytes(compressor, gpsRaw);
  constexpr std::size_t headerBytes = 4 + 1 + 1 + 2 + 4 + 4 + 4 + 4;
  std::vector<std::uint8_t> out(headerBytes + summary.size() + sessions.size() + workoutGzip.size() + gpsGzip.size());
  std::memcpy(out.data(), "WON1", 4);
  out[4] = 1;
  out[5] = 0;
  write16(out, 6, 0);
  write32(out, 8, static_cast<std::uint32_t>(summary.size()));
  write32(out, 12, static_cast<std::uint32_t>(sessions.size()));
  write32(out, 16, static_cast<std::uint32_t>(workoutGzip.size()));
  write32(out, 20, static_cast<std::uint32_t>(gpsGzip.size()));
  std::size_t offset = headerBytes;
  std::memcpy(out.data() + offset, summary.data(), summary.size());
  offset += summary.size();
  std::memcpy(out.data() + offset, sessions.data(), sessions.size());
  offset += sessions.size();
  std::memcpy(out.data() + offset, workoutGzip.data(), workoutGzip.size());
  offset += workoutGzip.size();
  std::memcpy(out.data() + offset, gpsGzip.data(), gpsGzip.size());

  stats.workoutRawBytes += workoutRaw.size();
  stats.workoutGzipBytes += workoutGzip.size();
  stats.gpsRawBytes += gpsRaw.size();
  stats.gpsGzipBytes += gpsGzip.size();
  stats.woaBytes += out.size();
  return out;
}

std::vector<std::uint8_t> buildWoa1EntryCompact(
    const CompactColumns& columns,
    std::uint64_t sessionCount,
    libdeflate_compressor* compressor,
    FitStats& stats) {
  const auto workoutRaw = buildWorkoutStreamBlockCompact(columns);
  const auto workoutGzip = gzipBytes(compressor, workoutRaw);
  const auto gpsRaw = buildNativeGpsBlockCompact(columns);
  const auto gpsGzip = gzipBytes(compressor, gpsRaw);
  const auto gpsPointCount = gpsRaw.size() >= 12 ? read32(gpsRaw.data() + 8) : 0;
  const auto meta = buildWoaMetaBlockCompact(columns, sessionCount, workoutRaw, workoutGzip, gpsRaw, gpsGzip, gpsPointCount);
  const auto sessions = buildSessionBlockCompact(columns);
  constexpr std::size_t headerBytes = 24;
  std::vector<std::uint8_t> out(headerBytes + meta.size() + sessions.size() + workoutGzip.size() + gpsGzip.size());
  std::memcpy(out.data(), "WOA1", 4);
  out[4] = 2;
  out[5] = 0;
  write16(out, 6, 0);
  write32(out, 8, static_cast<std::uint32_t>(meta.size()));
  write32(out, 12, static_cast<std::uint32_t>(sessions.size()));
  write32(out, 16, static_cast<std::uint32_t>(workoutGzip.size()));
  write32(out, 20, static_cast<std::uint32_t>(gpsGzip.size()));
  std::size_t offset = headerBytes;
  std::memcpy(out.data() + offset, meta.data(), meta.size());
  offset += meta.size();
  std::memcpy(out.data() + offset, sessions.data(), sessions.size());
  offset += sessions.size();
  std::memcpy(out.data() + offset, workoutGzip.data(), workoutGzip.size());
  offset += workoutGzip.size();
  std::memcpy(out.data() + offset, gpsGzip.data(), gpsGzip.size());

  stats.workoutRawBytes += workoutRaw.size();
  stats.workoutGzipBytes += workoutGzip.size();
  stats.gpsRawBytes += gpsRaw.size();
  stats.gpsGzipBytes += gpsGzip.size();
  stats.woaBytes += out.size();
  return out;
}

std::vector<std::uint8_t> buildTransportContainer(const std::vector<std::pair<std::string, std::vector<std::uint8_t>>>& entries) {
  std::vector<std::uint8_t> out;
  out.reserve(9);
  out.insert(out.end(), {'W', 'O', 'A', 'T'});
  out.push_back(1);
  append32(out, static_cast<std::uint32_t>(entries.size()));
  for (const auto& entry : entries) {
    appendString(out, entry.first);
    append32(out, static_cast<std::uint32_t>(entry.second.size()));
    appendBytes(out, entry.second);
  }
  return out;
}

std::vector<std::uint8_t> buildSessionBlockCompact(const CompactColumns& columns) {
  constexpr std::size_t recordSize = 71;
  std::vector<std::uint8_t> out(12 + recordSize, 0);
  std::memcpy(out.data(), "SES1", 4);
  write16(out, 4, 1);
  write16(out, 6, static_cast<std::uint16_t>(recordSize));
  write32(out, 8, 1);

  const std::size_t recordCount = columns.timestampOffsetsS.size();
  const std::uint64_t startTimeMs = columns.baseTimestampMs;
  const std::uint64_t endTimeMs = (recordCount > 0 && columns.timestampOffsetsS.back() != static_cast<std::int32_t>(0x80000000))
    ? (columns.baseTimestampMs + static_cast<std::uint64_t>(std::max<std::int32_t>(0, columns.timestampOffsetsS.back())) * 1000ULL)
    : columns.baseTimestampMs;
  const double totalTimerTimeSeconds = endTimeMs > startTimeMs ? static_cast<double>(endTimeMs - startTimeMs) / 1000.0 : 0.0;
  const double totalDistanceMeters = (!columns.distancesQ.empty() && columns.distancesQ.back() != 0xffffffffU)
    ? static_cast<double>(columns.distancesQ.back()) / 4.0
    : 0.0;

  auto encodeSessionTime = [](std::uint64_t timestampMs) -> std::uint32_t {
    if (timestampMs == 0) return 0xffffffffU;
    return static_cast<std::uint32_t>(timestampMs / 1000ULL);
  };
  auto encodeScaledUint32 = [](double value, double scale) -> std::uint32_t {
    if (!std::isfinite(value) || value < 0) return 0xffffffffU;
    return static_cast<std::uint32_t>(std::min<double>(4294967294.0, std::round(value * scale)));
  };
  auto encodeScaledUint16 = [](double value, double scale) -> std::uint16_t {
    if (!std::isfinite(value) || value < 0) return 0xffff;
    return static_cast<std::uint16_t>(std::min<double>(65534.0, std::round(value * scale)));
  };
  auto encodeSessionCoord = [](std::int32_t valueE6) -> std::int32_t {
    return valueE6 == static_cast<std::int32_t>(0x80000000)
      ? static_cast<std::int32_t>(0x80000000)
      : valueE6 * 10;
  };

  std::uint16_t maxPower = 0xffff;
  std::uint8_t maxHr = 0xff;
  std::uint8_t maxCadence = 0xff;
  std::uint16_t avgPower = 0xffff;
  std::uint8_t avgHr = 0xff;
  std::uint8_t avgCadence = 0xff;
  std::uint16_t maxSpeed = 0xffff;
  std::uint16_t avgSpeed = 0xffff;
  std::int32_t necLat = static_cast<std::int32_t>(0x80000000);
  std::int32_t necLng = static_cast<std::int32_t>(0x80000000);
  std::int32_t swcLat = static_cast<std::int32_t>(0x80000000);
  std::int32_t swcLng = static_cast<std::int32_t>(0x80000000);
  std::uint64_t powerSum = 0;
  std::uint64_t hrSum = 0;
  std::uint64_t cadenceSum = 0;
  std::uint64_t speedSum = 0;
  std::uint32_t powerCount = 0;
  std::uint32_t hrCount = 0;
  std::uint32_t cadenceCount = 0;
  std::uint32_t speedCount = 0;

  for (std::size_t index = 0; index < recordCount; ++index) {
    const auto power = columns.powersW[index];
    if (power != 0xffff) {
      powerSum += power;
      powerCount += 1;
      maxPower = maxPower == 0xffff ? power : std::max(maxPower, power);
    }
    const auto hr = columns.heartRatesBpm[index];
    if (hr != 0xff) {
      hrSum += hr;
      hrCount += 1;
      maxHr = maxHr == 0xff ? hr : std::max(maxHr, hr);
    }
    const auto cadence = columns.cadencesRpm[index];
    if (cadence != 0xff) {
      cadenceSum += cadence;
      cadenceCount += 1;
      maxCadence = maxCadence == 0xff ? cadence : std::max(maxCadence, cadence);
    }
    const auto speed = columns.speedsCmS[index];
    if (speed != 0xffff) {
      speedSum += speed;
      speedCount += 1;
      maxSpeed = maxSpeed == 0xffff ? speed : std::max(maxSpeed, speed);
    }
    const auto lat = columns.positionLatsE6[index];
    const auto lng = columns.positionLongsE6[index];
    if (lat != static_cast<std::int32_t>(0x80000000) && lng != static_cast<std::int32_t>(0x80000000) && !(lat == 0 && lng == 0)) {
      necLat = necLat == static_cast<std::int32_t>(0x80000000) ? lat : std::max(necLat, lat);
      necLng = necLng == static_cast<std::int32_t>(0x80000000) ? lng : std::max(necLng, lng);
      swcLat = swcLat == static_cast<std::int32_t>(0x80000000) ? lat : std::min(swcLat, lat);
      swcLng = swcLng == static_cast<std::int32_t>(0x80000000) ? lng : std::min(swcLng, lng);
    }
  }

  if (powerCount > 0) avgPower = static_cast<std::uint16_t>(std::min<std::uint64_t>(65534, std::llround(static_cast<double>(powerSum) / powerCount)));
  if (hrCount > 0) avgHr = static_cast<std::uint8_t>(std::min<std::uint64_t>(254, std::llround(static_cast<double>(hrSum) / hrCount)));
  if (cadenceCount > 0) avgCadence = static_cast<std::uint8_t>(std::min<std::uint64_t>(254, std::llround(static_cast<double>(cadenceSum) / cadenceCount)));
  if (speedCount > 0) avgSpeed = static_cast<std::uint16_t>(std::min<std::uint64_t>(65534, std::llround(static_cast<double>(speedSum) / speedCount)));

  std::size_t offset = 12;
  write32(out, offset, encodeSessionTime(endTimeMs)); offset += 4;
  write32(out, offset, encodeSessionTime(startTimeMs)); offset += 4;
  write32(out, offset, encodeScaledUint32(totalTimerTimeSeconds, 100)); offset += 4;
  write32(out, offset, encodeScaledUint32(totalTimerTimeSeconds, 100)); offset += 4;
  write32(out, offset, encodeScaledUint32(totalDistanceMeters, 10)); offset += 4;
  write32(out, offset, 0xffffffffU); offset += 4;
  write32(out, offset, 0xffffffffU); offset += 4;
  write32(out, offset, 0xffffffffU); offset += 4;
  write32(out, offset, 0xffffffffU); offset += 4;
  write32(out, offset, 0xffffffffU); offset += 4;
  write16(out, offset, avgSpeed); offset += 2;
  write16(out, offset, avgPower); offset += 2;
  out[offset++] = avgHr;
  out[offset++] = avgCadence;
  write16(out, offset, avgPower); offset += 2;
  write16(out, offset, maxSpeed); offset += 2;
  write16(out, offset, maxPower); offset += 2;
  out[offset++] = maxHr;
  out[offset++] = maxCadence;
  write32(out, offset, static_cast<std::uint32_t>(encodeSessionCoord(necLat))); offset += 4;
  write32(out, offset, static_cast<std::uint32_t>(encodeSessionCoord(necLng))); offset += 4;
  write32(out, offset, static_cast<std::uint32_t>(encodeSessionCoord(swcLat))); offset += 4;
  write32(out, offset, static_cast<std::uint32_t>(encodeSessionCoord(swcLng))); offset += 4;
  out[offset++] = 0;

  return out;
}

std::vector<std::uint8_t> buildWoaMetaBlockCompact(
    const CompactColumns& columns,
    std::uint64_t sessionCount,
    const std::vector<std::uint8_t>& workoutStreamRaw,
    const std::vector<std::uint8_t>& workoutStreamGzip,
    const std::vector<std::uint8_t>& gpsTrackRaw,
    const std::vector<std::uint8_t>& gpsTrackGzip,
    std::uint32_t gpsPointCount) {
  const std::size_t recordCount = columns.timestampOffsetsS.size();
  const bool validGps = gpsPointCount > 1;

  std::string json = "{";
  json += "\"sourceFormat\":\"fit\",";
  json += "\"recordCount\":" + std::to_string(recordCount) + ",";
  json += "\"pointsCount\":" + std::to_string(gpsPointCount) + ",";
  json += "\"sampleRateGps\":5,";
  json += "\"validGps\":" + std::string(validGps ? "true" : "false") + ",";
  json += "\"gpsSource\":\"recorded\",";
  json += "\"blockCodecs\":{\"workout_stream\":\"gzip\",\"gps_track\":\"gzip\"},";
  json += "\"blockBytes\":{";
  json += "\"workout_stream_raw\":" + std::to_string(workoutStreamRaw.size()) + ",";
  json += "\"workout_stream_compressed\":" + std::to_string(workoutStreamGzip.size()) + ",";
  json += "\"gps_track_raw\":" + std::to_string(gpsTrackRaw.size()) + ",";
  json += "\"gps_track_compressed\":" + std::to_string(gpsTrackGzip.size());
  json += "},";
  json += "\"persistedRow\":{";
  json += "\"stream_codec\":\"gzip\",";
  json += "\"gps_track_blob_codec\":\"gzip\",";
  json += "\"points_count\":" + std::to_string(gpsPointCount) + ",";
  json += "\"sampleRateGPS\":5,";
  json += "\"validGps\":" + std::string(validGps ? "true" : "false");
  json += "},";
  json += "\"sessionCount\":" + std::to_string(sessionCount);
  json += "}";

  return std::vector<std::uint8_t>(json.begin(), json.end());
}

std::uint64_t readFitValue(const std::uint8_t* data, std::uint8_t size, bool littleEndian) {
  const std::size_t bytes = std::min<std::size_t>(size, 8);
  std::uint64_t value = 0;
  for (std::size_t index = 0; index < bytes; ++index) {
    const std::size_t source = littleEndian ? index : bytes - index - 1;
    value |= static_cast<std::uint64_t>(data[source]) << (index * 8);
  }
  return value;
}

std::int64_t signExtend(std::uint64_t value, std::uint8_t size) {
  if (size == 0 || size >= 8) return static_cast<std::int64_t>(value);
  const auto bits = static_cast<unsigned>(size) * 8;
  const std::uint64_t sign = std::uint64_t{1} << (bits - 1);
  return static_cast<std::int64_t>((value ^ sign) - sign);
}

double decodedRecordValue(const FitField& field, std::uint64_t raw) {
  constexpr double garminOffsetMs = 631065600000.0;
  constexpr double semicirclesToDegrees = 180.0 / 2147483648.0;
  const auto invalidUnsigned = field.size >= 8
      ? std::numeric_limits<std::uint64_t>::max()
      : ((std::uint64_t{1} << (field.size * 8)) - 1);
  const std::uint8_t baseType = field.baseType & 0x1f;
  const bool signedType = baseType == 1 || baseType == 3 || baseType == 5;
  if ((!signedType && raw == invalidUnsigned) ||
      (signedType && signExtend(raw, field.size) ==
          static_cast<std::int64_t>((std::uint64_t{1} << (field.size * 8 - 1)) - 1))) {
    return std::numeric_limits<double>::quiet_NaN();
  }
  const double value = signedType ? static_cast<double>(signExtend(raw, field.size))
                                  : static_cast<double>(raw);
  switch (field.number) {
    case 253: return value * 1000.0 + garminOffsetMs;
    case 0:
    case 1: return value * semicirclesToDegrees;
    case 2: return value / 5.0 - 500.0;
    case 3:
    case 4:
    case 7: return value;
    case 5: return value / 100.0;
    case 6:
    case 73: return value / 1000.0;
    case 78: return value / 5.0 - 500.0;
    default: return std::numeric_limits<double>::quiet_NaN();
  }
}

NativeEntryResult parseFit(const std::vector<std::uint8_t>& fit, libdeflate_compressor* compressor) {
  if (fit.size() < 12 || (fit[0] != 12 && fit[0] != 14) ||
      std::memcmp(fit.data() + 8, ".FIT", 4) != 0) {
    throw std::runtime_error("Invalid FIT header");
  }
  const std::size_t headerSize = fit[0];
  const std::size_t dataSize = read32(fit.data() + 4);
  requireRange(headerSize, dataSize, fit.size());
  const std::size_t end = headerSize + dataSize;
  std::vector<FitDefinition> definitions(16);
  FitStats stats;
  std::array<std::vector<double>, 9> columns;
  for (auto& column : columns) column.reserve(1024);
  std::size_t cursor = headerSize;

  while (cursor < end) {
    const std::uint8_t header = fit[cursor++];
    const bool compressed = (header & 0x80) != 0;
    const std::uint8_t localMessage = compressed ? ((header >> 5) & 0x03) : (header & 0x0f);
    if (!compressed && (header & 0x40) != 0) {
      requireRange(cursor, 5, end);
      cursor += 1;  // reserved
      const bool littleEndian = fit[cursor++] == 0;
      const std::uint16_t globalMessage = littleEndian
          ? read16(fit.data() + cursor)
          : static_cast<std::uint16_t>((fit[cursor] << 8) | fit[cursor + 1]);
      cursor += 2;
      const std::uint8_t fieldCount = fit[cursor++];
      requireRange(cursor, static_cast<std::size_t>(fieldCount) * 3, end);
      FitDefinition definition{true, littleEndian, globalMessage, {}};
      definition.fields.reserve(fieldCount + 8);
      for (std::uint8_t index = 0; index < fieldCount; ++index) {
        definition.fields.push_back({fit[cursor], fit[cursor + 1], fit[cursor + 2]});
        cursor += 3;
      }
      if ((header & 0x20) != 0) {
        requireRange(cursor, 1, end);
        const std::uint8_t developerCount = fit[cursor++];
        requireRange(cursor, static_cast<std::size_t>(developerCount) * 3, end);
        for (std::uint8_t index = 0; index < developerCount; ++index) {
          definition.fields.push_back({fit[cursor], fit[cursor + 1], 13});
          cursor += 3;
        }
      }
      definitions[localMessage] = std::move(definition);
      continue;
    }

    const auto& definition = definitions[localMessage];
    if (!definition.valid) throw std::runtime_error("FIT data message without definition");
    const bool isRecord = definition.globalMessage == 20;
    if (isRecord) ++stats.records;
    if (definition.globalMessage == 18) ++stats.sessions;
    std::array<double, 9> recordValues;
    recordValues.fill(std::numeric_limits<double>::quiet_NaN());
    for (const auto& field : definition.fields) {
      requireRange(cursor, field.size, end);
      // Decode every scalar field in record/session messages. This mirrors the
      // CPU shape of the targeted JS parser without retaining large arrays.
      if ((definition.globalMessage == 20 || definition.globalMessage == 18) &&
          field.size > 0 && field.size <= 8 && (field.baseType & 0x1f) != 7) {
        const auto value = readFitValue(fit.data() + cursor, field.size, definition.littleEndian);
        stats.valueChecksum = stats.valueChecksum * 131 + value + field.number;
        ++stats.decodedFields;
      }
      if (isRecord && field.size > 0 && field.size <= 8) {
        const auto raw = readFitValue(fit.data() + cursor, field.size, definition.littleEndian);
        const double value = decodedRecordValue(field, raw);
        switch (field.number) {
          case 253: recordValues[0] = value; break;
          case 5: recordValues[1] = value; break;
          case 7: recordValues[2] = value; break;
          case 3: recordValues[3] = value; break;
          case 4: recordValues[4] = value; break;
          case 73: recordValues[5] = value; break;
          case 6:
            if (std::isnan(recordValues[5])) recordValues[5] = value;
            break;
          case 78: recordValues[6] = value; break;
          case 2:
            if (std::isnan(recordValues[6])) recordValues[6] = value;
            break;
          case 0: recordValues[7] = value; break;
          case 1: recordValues[8] = value; break;
          default: break;
        }
      }
      cursor += field.size;
    }
    if (isRecord) {
      for (std::size_t index = 0; index < columns.size(); ++index) {
        columns[index].push_back(recordValues[index]);
      }
    }
  }
  // GrowableFloat64Array.toTypedArray() in the JS parser creates exact-sized
  // result arrays. Mirror that final materialization and consume edge values
  // so an optimizing compiler cannot discard the column writes.
  for (const auto& column : columns) {
    std::vector<double> materialized(column.begin(), column.end());
    stats.typedArrayBytes += materialized.size() * sizeof(double);
    if (!materialized.empty()) {
      std::uint64_t firstBits = 0;
      std::uint64_t lastBits = 0;
      std::memcpy(&firstBits, &materialized.front(), sizeof(firstBits));
      std::memcpy(&lastBits, &materialized.back(), sizeof(lastBits));
      stats.valueChecksum = stats.valueChecksum * 131 + firstBits + lastBits;
    }
  }
  stats.compactTypedArrayBytes += stats.records * (4 + 4 + 2 + 1 + 1 + 2 + 2 + 4 + 4);
  const auto woaStartedAt = Clock::now();
  auto nativeEntry = buildNativeEntry(columns, stats.sessions, compressor, stats);
  stats.woaBuildMs += elapsedMs(woaStartedAt, Clock::now());
  return {stats, std::move(nativeEntry)};
}

NativeEntryResult parseFitCompact(const std::vector<std::uint8_t>& fit, libdeflate_compressor* compressor) {
  if (fit.size() < 12 || (fit[0] != 12 && fit[0] != 14) ||
      std::memcmp(fit.data() + 8, ".FIT", 4) != 0) {
    throw std::runtime_error("Invalid FIT header");
  }
  const std::size_t headerSize = fit[0];
  const std::size_t dataSize = read32(fit.data() + 4);
  requireRange(headerSize, dataSize, fit.size());
  const std::size_t end = headerSize + dataSize;
  std::vector<FitDefinition> definitions(16);
  FitStats stats;
  CompactColumns columns;
  columns.timestampOffsetsS.reserve(1024);
  columns.distancesQ.reserve(1024);
  columns.powersW.reserve(1024);
  columns.heartRatesBpm.reserve(1024);
  columns.cadencesRpm.reserve(1024);
  columns.speedsCmS.reserve(1024);
  columns.altitudesQ.reserve(1024);
  columns.positionLatsE6.reserve(1024);
  columns.positionLongsE6.reserve(1024);
  bool hasBaseTimestamp = false;
  std::size_t cursor = headerSize;

  while (cursor < end) {
    const std::uint8_t header = fit[cursor++];
    const bool compressed = (header & 0x80) != 0;
    const std::uint8_t localMessage = compressed ? ((header >> 5) & 0x03) : (header & 0x0f);
    if (!compressed && (header & 0x40) != 0) {
      requireRange(cursor, 5, end);
      cursor += 1;
      const bool littleEndian = fit[cursor++] == 0;
      const std::uint16_t globalMessage = littleEndian
          ? read16(fit.data() + cursor)
          : static_cast<std::uint16_t>((fit[cursor] << 8) | fit[cursor + 1]);
      cursor += 2;
      const std::uint8_t fieldCount = fit[cursor++];
      requireRange(cursor, static_cast<std::size_t>(fieldCount) * 3, end);
      FitDefinition definition{true, littleEndian, globalMessage, {}};
      definition.fields.reserve(fieldCount + 8);
      for (std::uint8_t index = 0; index < fieldCount; ++index) {
        definition.fields.push_back({fit[cursor], fit[cursor + 1], fit[cursor + 2]});
        cursor += 3;
      }
      if ((header & 0x20) != 0) {
        requireRange(cursor, 1, end);
        const std::uint8_t developerCount = fit[cursor++];
        requireRange(cursor, static_cast<std::size_t>(developerCount) * 3, end);
        cursor += static_cast<std::size_t>(developerCount) * 3;
      }
      definitions[localMessage] = std::move(definition);
      continue;
    }

    const auto& definition = definitions[localMessage];
    if (!definition.valid) throw std::runtime_error("FIT data message without definition");
    const bool isRecord = definition.globalMessage == 20;
    if (isRecord) ++stats.records;
    if (definition.globalMessage == 18) ++stats.sessions;

    std::int32_t timestampOffset = static_cast<std::int32_t>(0x80000000);
    std::uint32_t distance = 0xffffffffU;
    std::uint16_t power = 0xffff;
    std::uint8_t heartRate = 0xff;
    std::uint8_t cadence = 0xff;
    std::uint16_t speed = 0xffff;
    std::int16_t altitude = static_cast<std::int16_t>(-32768);
    std::int32_t lat = static_cast<std::int32_t>(0x80000000);
    std::int32_t lng = static_cast<std::int32_t>(0x80000000);

    for (const auto& field : definition.fields) {
      requireRange(cursor, field.size, end);
      if ((definition.globalMessage == 20 || definition.globalMessage == 18) &&
          field.size > 0 && field.size <= 8 && (field.baseType & 0x1f) != 7) {
        const auto raw = readFitValue(fit.data() + cursor, field.size, definition.littleEndian);
        stats.valueChecksum = stats.valueChecksum * 131 + raw + field.number;
        ++stats.decodedFields;
        if (isRecord) {
          const std::uint8_t baseType = field.baseType & 0x1f;
          const bool signedType = baseType == 1 || baseType == 3 || baseType == 5;
          const auto invalidUnsigned = field.size >= 8
              ? std::numeric_limits<std::uint64_t>::max()
              : ((std::uint64_t{1} << (field.size * 8)) - 1);
          const bool invalid = (!signedType && raw == invalidUnsigned) ||
              (signedType && signExtend(raw, field.size) ==
                  static_cast<std::int64_t>((std::uint64_t{1} << (field.size * 8 - 1)) - 1));
          if (!invalid) {
            switch (field.number) {
              case 253: {
                const std::uint64_t timestampMs = raw * 1000ULL + 631065600000ULL;
                if (!hasBaseTimestamp) {
                  columns.baseTimestampMs = timestampMs;
                  hasBaseTimestamp = true;
                }
                const auto delta = static_cast<std::int64_t>(timestampMs) - static_cast<std::int64_t>(columns.baseTimestampMs);
                timestampOffset = static_cast<std::int32_t>(std::max<std::int64_t>(-2147483647, std::min<std::int64_t>(2147483647, delta / 1000)));
                break;
              }
              case 0:
                lat = compactCoordE6(signExtend(raw, field.size));
                break;
              case 1:
                lng = compactCoordE6(signExtend(raw, field.size));
                break;
              case 2:
                if (altitude == static_cast<std::int16_t>(-32768)) altitude = compactAltitudeFromRaw(raw);
                break;
              case 3:
                heartRate = static_cast<std::uint8_t>(std::min<std::uint64_t>(0xfe, raw));
                break;
              case 4:
                cadence = static_cast<std::uint8_t>(std::min<std::uint64_t>(0xfe, raw));
                break;
              case 5:
                distance = compactDistanceFromCentimeters(raw);
                break;
              case 6:
                if (speed == 0xffff) speed = compactSpeedFromMmS(raw);
                break;
              case 7:
                power = static_cast<std::uint16_t>(std::min<std::uint64_t>(0xfffe, raw));
                break;
              case 73:
                speed = compactSpeedFromMmS(raw);
                break;
              case 78:
                altitude = compactAltitudeFromRaw(raw);
                break;
              default:
                break;
            }
          }
        }
      }
      cursor += field.size;
    }
    if (isRecord) {
      power = quantizeCompactUint16(power, 0xffff, 2);
      cadence = quantizeCompactUint8(cadence, 0xff, 2);
      heartRate = quantizeCompactUint8(heartRate, 0xff, 2);
      columns.timestampOffsetsS.push_back(timestampOffset);
      columns.distancesQ.push_back(distance);
      columns.powersW.push_back(power);
      columns.heartRatesBpm.push_back(heartRate);
      columns.cadencesRpm.push_back(cadence);
      columns.speedsCmS.push_back(speed);
      columns.altitudesQ.push_back(altitude);
      columns.positionLatsE6.push_back(lat);
      columns.positionLongsE6.push_back(lng);
    }
  }

  stats.compactTypedArrayBytes += stats.records * (4 + 4 + 2 + 1 + 1 + 2 + 2 + 4 + 4);
  const auto woaStartedAt = Clock::now();
  auto nativeEntry = buildWoa1EntryCompact(columns, stats.sessions, compressor, stats);
  stats.woaBuildMs += elapsedMs(woaStartedAt, Clock::now());
  return {stats, std::move(nativeEntry)};
}
}  // namespace

int main(int argc, char** argv) {
  try {
    if (argc < 2) {
      std::cerr << "Usage: woa-zip-benchmark <archive.zip> [repeats] [--parallel <workers>] [--write-output <file>]\n";
      return 2;
    }
    const std::filesystem::path path = argv[1];
    int repeats = 5;
    int parallelWorkers = 1;
    std::filesystem::path writeOutputPath;
    bool hasWriteOutput = false;
    int argIndex = 2;
    if (argIndex < argc && std::string(argv[argIndex]).rfind("--", 0) != 0) {
      repeats = std::max(1, std::stoi(argv[argIndex]));
      ++argIndex;
    }
    while (argIndex < argc) {
      const std::string arg = argv[argIndex++];
      if (arg == "--write-output" && argIndex < argc) {
        writeOutputPath = argv[argIndex++];
        hasWriteOutput = true;
      } else if (arg == "--parallel" && argIndex < argc) {
        parallelWorkers = std::max(1, std::stoi(argv[argIndex++]));
        if (parallelWorkers > 64) {
          throw std::runtime_error("--parallel must be between 1 and 64");
        }
      } else {
        throw std::runtime_error("Unknown argument: " + arg);
      }
    }

    std::cout << "File: " << path << "\nRepeats: " << repeats << "\nMode: compact\nParallel workers: " << parallelWorkers << "\n\n";
    for (int run = 1; run <= repeats; ++run) {
      const auto totalStart = Clock::now();
      const auto zip = readFile(path);
      const auto readDone = Clock::now();
      auto entries = parseEntries(zip);
      entries.erase(std::remove_if(entries.begin(), entries.end(),
                                   [](const Entry& e) { return !endsWithFit(e.name); }),
                    entries.end());
      const auto enumerateDone = Clock::now();

      std::uint64_t outputBytes = 0;
      std::uint64_t checksum = 0;
      FitStats fitStats;
      double extractMs = 0;
      double parseMs = 0;
      std::vector<std::pair<std::string, std::vector<std::uint8_t>>> nativeEntries;
      nativeEntries.reserve(entries.size());
      std::vector<ParallelEntryResult> perEntryResults(entries.size());

      auto processEntry = [&](std::size_t entryIndex, libdeflate_decompressor* decompressor, libdeflate_compressor* compressor) {
        const auto& entry = entries[entryIndex];
        requireRange(entry.localHeaderOffset, 30, zip.size());
        const auto* local = zip.data() + entry.localHeaderOffset;
        if (read32(local) != 0x04034b50) throw std::runtime_error("Invalid local header");
        const auto dataOffset = entry.localHeaderOffset + 30 + read16(local + 26) + read16(local + 28);
        requireRange(dataOffset, entry.compressedSize, zip.size());

        std::vector<std::uint8_t> output(entry.uncompressedSize);
        const auto extractStartedAt = Clock::now();
        if (entry.method == 0) {
          if (entry.compressedSize != entry.uncompressedSize) throw std::runtime_error("Invalid stored entry");
          std::memcpy(output.data(), zip.data() + dataOffset, output.size());
        } else if (entry.method == 8) {
          std::size_t actualSize = 0;
          const auto result = libdeflate_deflate_decompress(
              decompressor, zip.data() + dataOffset, entry.compressedSize,
              output.data(), output.size(), &actualSize);
          if (result != LIBDEFLATE_SUCCESS || actualSize != output.size()) {
            throw std::runtime_error("Deflate failed for entry: " + entry.name);
          }
        } else {
          throw std::runtime_error("Unsupported ZIP method " + std::to_string(entry.method));
        }
        const auto extractDoneAt = Clock::now();

        const auto parseStartedAt = Clock::now();
        auto nativeResult = parseFitCompact(output, compressor);
        const auto parseDoneAt = Clock::now();

        auto& destination = perEntryResults[entryIndex];
        destination.stats = std::move(nativeResult.stats);
        destination.bytes = std::move(nativeResult.bytes);
        destination.outputBytes = output.size();
        destination.extractMs = elapsedMs(extractStartedAt, extractDoneAt);
        destination.parseMs = elapsedMs(parseStartedAt, parseDoneAt);
        if (!output.empty()) {
          destination.checksum = output.front() + output.back();
        }
      };

      if (parallelWorkers <= 1 || entries.size() <= 1) {
        libdeflate_decompressor* decompressor = libdeflate_alloc_decompressor();
        if (!decompressor) throw std::runtime_error("Cannot allocate decompressor");
        libdeflate_compressor* compressor = libdeflate_alloc_compressor(4);
        if (!compressor) throw std::runtime_error("Cannot allocate compressor");
        for (std::size_t entryIndex = 0; entryIndex < entries.size(); ++entryIndex) {
          processEntry(entryIndex, decompressor, compressor);
        }
        libdeflate_free_compressor(compressor);
        libdeflate_free_decompressor(decompressor);
      } else {
        std::atomic<std::size_t> nextEntryIndex{0};
        std::exception_ptr workerError = nullptr;
        std::mutex workerErrorMutex;
        std::vector<std::thread> workers;
        workers.reserve(static_cast<std::size_t>(parallelWorkers));

        for (int workerIndex = 0; workerIndex < parallelWorkers; ++workerIndex) {
          workers.emplace_back([&]() {
            libdeflate_decompressor* decompressor = nullptr;
            libdeflate_compressor* compressor = nullptr;
            try {
              decompressor = libdeflate_alloc_decompressor();
              if (!decompressor) {
                throw std::runtime_error("Cannot allocate decompressor");
              }
              compressor = libdeflate_alloc_compressor(4);
              if (!compressor) {
                throw std::runtime_error("Cannot allocate compressor");
              }
              while (true) {
                const std::size_t entryIndex = nextEntryIndex.fetch_add(1);
                if (entryIndex >= entries.size()) {
                  break;
                }
                processEntry(entryIndex, decompressor, compressor);
              }
            } catch (...) {
              std::lock_guard<std::mutex> lock(workerErrorMutex);
              if (!workerError) {
                workerError = std::current_exception();
              }
            }
            if (compressor) {
              libdeflate_free_compressor(compressor);
            }
            if (decompressor) {
              libdeflate_free_decompressor(decompressor);
            }
          });
        }

        for (auto& worker : workers) {
          worker.join();
        }
        if (workerError) {
          std::rethrow_exception(workerError);
        }
      }

      for (std::size_t entryIndex = 0; entryIndex < entries.size(); ++entryIndex) {
        auto& entryResult = perEntryResults[entryIndex];
        const auto& entryFitStats = entryResult.stats;
        extractMs += entryResult.extractMs;
        parseMs += entryResult.parseMs;
        fitStats.records += entryFitStats.records;
        fitStats.sessions += entryFitStats.sessions;
        fitStats.decodedFields += entryFitStats.decodedFields;
        fitStats.valueChecksum = fitStats.valueChecksum * 131 + entryFitStats.valueChecksum;
        fitStats.typedArrayBytes += entryFitStats.typedArrayBytes;
        fitStats.compactTypedArrayBytes += entryFitStats.compactTypedArrayBytes;
        fitStats.woaBytes += entryFitStats.woaBytes;
        fitStats.workoutRawBytes += entryFitStats.workoutRawBytes;
        fitStats.workoutGzipBytes += entryFitStats.workoutGzipBytes;
        fitStats.gpsRawBytes += entryFitStats.gpsRawBytes;
        fitStats.gpsGzipBytes += entryFitStats.gpsGzipBytes;
        fitStats.woaBuildMs += entryFitStats.woaBuildMs;
        nativeEntries.push_back({
            replaceFitExtension(entries[entryIndex].name, ".woa1"),
            std::move(entryResult.bytes)});
        outputBytes += entryResult.outputBytes;
        checksum = checksum * 131 + entryResult.checksum;
      }

      libdeflate_compressor* containerCompressor = libdeflate_alloc_compressor(4);
      if (!containerCompressor) throw std::runtime_error("Cannot allocate container compressor");
      const auto containerStartedAt = Clock::now();
      const auto rawNativeContainer = buildTransportContainer(nativeEntries);
      const auto gzipNativeContainer = gzipBytes(containerCompressor, rawNativeContainer);
      fitStats.nativeContainerBuildMs = elapsedMs(containerStartedAt, Clock::now());
      fitStats.nativeRawContainerBytes = rawNativeContainer.size();
      fitStats.nativeGzipContainerBytes = gzipNativeContainer.size();
      if (hasWriteOutput && run == repeats) {
        std::ofstream output(writeOutputPath, std::ios::binary);
        if (!output) throw std::runtime_error("Cannot open output file: " + writeOutputPath.string());
        output.write(reinterpret_cast<const char*>(gzipNativeContainer.data()),
                     static_cast<std::streamsize>(gzipNativeContainer.size()));
      }
      libdeflate_free_compressor(containerCompressor);
      const auto extractDone = Clock::now();
      fitStats.payloadReadyWallMs = elapsedMs(totalStart, extractDone);

      const double mib = static_cast<double>(outputBytes) / 1024.0 / 1024.0;
      std::cout << std::fixed << std::setprecision(2)
                << "Run " << run << ": read=" << elapsedMs(totalStart, readDone)
                << " ms, enumerate=" << elapsedMs(readDone, enumerateDone)
                << " ms, extract=" << extractMs
                << " ms, total=" << elapsedMs(totalStart, extractDone)
                << " ms, payloadReadyWall=" << fitStats.payloadReadyWallMs
                << " ms, entries=" << entries.size()
                << ", output=" << mib << " MiB"
                << ", parse=" << std::max(0.0, parseMs - fitStats.woaBuildMs) << " ms"
                << ", woaBuild=" << fitStats.woaBuildMs << " ms"
                << ", records=" << fitStats.records
                << ", sessions=" << fitStats.sessions
                << ", typedArrays=" << (static_cast<double>(fitStats.typedArrayBytes) / 1024.0 / 1024.0) << " MiB"
                << ", compactTypedTarget=" << (static_cast<double>(fitStats.compactTypedArrayBytes) / 1024.0 / 1024.0) << " MiB"
                << ", woa=" << (static_cast<double>(fitStats.woaBytes) / 1024.0 / 1024.0) << " MiB"
                << ", workoutRaw=" << (static_cast<double>(fitStats.workoutRawBytes) / 1024.0 / 1024.0) << " MiB"
                << ", workoutGzip=" << (static_cast<double>(fitStats.workoutGzipBytes) / 1024.0 / 1024.0) << " MiB"
                << ", gpsRaw=" << (static_cast<double>(fitStats.gpsRawBytes) / 1024.0 / 1024.0) << " MiB"
                << ", gpsGzip=" << (static_cast<double>(fitStats.gpsGzipBytes) / 1024.0 / 1024.0) << " MiB"
                << ", nativeContainer=" << fitStats.nativeContainerBuildMs << " ms"
                << ", nativeRawContainer=" << (static_cast<double>(fitStats.nativeRawContainerBytes) / 1024.0 / 1024.0) << " MiB"
                << ", nativeContainerGzip=" << (static_cast<double>(fitStats.nativeGzipContainerBytes) / 1024.0 / 1024.0) << " MiB"
                << ", workers=" << parallelWorkers
                << ", extractThroughput=" << (mib * 1000.0 / extractMs) << " MiB/s"
                << ", checksum=" << checksum << "\n";
    }
  } catch (const std::exception& error) {
    std::cerr << "Error: " << error.what() << "\n";
    return 1;
  }
}
