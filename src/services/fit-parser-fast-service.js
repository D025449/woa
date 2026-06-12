import FitParser from "../../vendor/fit-file-parser-fast/dist/fit-parser.js";

export function parseFitBufferFast(buffer) {
  return new Promise((resolve, reject) => {
    const parser = new FitParser({
      force: true,
      speedUnit: "m/s",
      lengthUnit: "m",
      temperatureUnit: "celsius",
      elapsedRecordField: true,
      mode: "list"
    });

    parser.parse(buffer, (error, data) => {
      if (error) {
        reject(error);
      } else {
        resolve(data);
      }
    });
  });
}
