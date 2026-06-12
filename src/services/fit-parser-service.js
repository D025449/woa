import FitParser from "fit-file-parser";

function parseWith(FitParserImpl, buffer) {
  return new Promise((resolve, reject) => {
    const parser = new FitParserImpl({
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

export function parseFitBufferStandard(buffer) {
  return parseWith(FitParser, buffer);
}
