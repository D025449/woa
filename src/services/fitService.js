const fitParser = require('fit-file-parser').default;

function parseFit(buffer) {
  return new Promise((resolve, reject) => {
    const parser = new fitParser();

    parser.parse(buffer, (err, data) => {
      if (err) reject(err);
      else resolve(data);
    });
  });
}

module.exports = {
  parseFit
};