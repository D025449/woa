# Native ZIP benchmark

This CLI measures the same basic operation as the browser ZIP benchmark:

1. Read the complete ZIP file.
2. Parse its central directory and select `.fit` entries.
3. Extract every selected entry with `libdeflate`.
4. Parse FIT definition/data messages and decode record/session scalar fields.
5. Build a native binary workout entry (`WON1`) with a fixed binary summary,
   compressed workout stream, and compressed native GPS block.
6. Pack all native entries into the same outer transport container shape
   (`WOAT`) and gzip that container.

The parser creates the same nine double columns as the production JavaScript
typed-array parser, including `NaN` for missing record values. The native output
is intentionally not production WOA1 JSON metadata. It is a C++-style binary
candidate format for comparing the upper bound of a native transport pipeline.

## macOS

Install the build dependencies once:

```sh
brew install cmake libdeflate pkg-config
```

Build and run:

```sh
cmake -S native/zip-benchmark -B build/native-zip -DCMAKE_BUILD_TYPE=Release
cmake --build build/native-zip --config Release
./build/native-zip/woa-zip-benchmark ./sample.zip 5
./build/native-zip/woa-zip-benchmark ./sample.zip 5 --mode compact
./build/native-zip/woa-zip-benchmark ./sample.zip 5 --write-output /tmp/cpp-native.woat.gz
```

The result is a normal native executable, not a macOS `.app`, because this is
a command-line benchmark without a graphical user interface.

## Windows

The easiest reproducible setup is Visual Studio 2022 plus `vcpkg`:

```powershell
vcpkg install libdeflate:x64-windows
cmake -S native/zip-benchmark -B build/native-zip `
  -DCMAKE_BUILD_TYPE=Release `
  -DCMAKE_TOOLCHAIN_FILE=C:/vcpkg/scripts/buildsystems/vcpkg.cmake
cmake --build build/native-zip --config Release
.\build\native-zip\Release\woa-zip-benchmark.exe .\sample.zip 5
```

## Current limits

- ZIP64 is not supported yet.
- Encryption and compression methods other than Stored and Deflate are rejected.
- Peak memory is intentionally similar to the synchronous browser benchmark:
  the source ZIP is held in memory, while one extracted FIT entry is held at a time.
- `--mode float64` keeps the original wide-column reference path.
- `--mode compact` parses FIT records directly into scaled integer columns and
  builds the native candidate container without materializing Float64 columns.
