var split = require("split2");
var pumpify = require("pumpify");
var through = require("through2");
var utf8 = require("to-utf-8");
const _ = require("lodash");

module.exports = function () {
  var buf = [];

  var convert = function () {
    return (
      buf
        .join("\r\n")
        .replace(/\{\\([ibu])\}/g, "</$1>")
        .replace(/\{\\([ibu])1\}/g, "<$1>")
        .replace(/\{([ibu])\}/g, "<$1>")
        .replace(/\{\/([ibu])\}/g, "</$1>")
        .replace(/(\d\d:\d\d:\d\d),(\d\d\d)/g, "$1.$2")
        .replace(/\r\n\{\\an8\}/g, " line:5%\r\n") + "\r\n\r\n"
    );
  };

  var write = function (line, enc, cb) {
    if (line.includes("-->") && !line.includes('line')) {
      line = line + " line:-3";
    }
    line = line.replace("\\N", "\n");
    const lineArr = line.split("\n");
    line = lineArr
      .map((l) => {
        if (l.length > 60) {
          const textArr = _.split(l, " ");
          let count = parseInt(textArr.length / 2 + 1);
          textArr.forEach((tx, index) => {
            if (tx.includes(",") && index >= count - 3 && index <= count + 2) count = index + 1;
          });
          l = [_.dropRight(textArr, textArr.length - count).join(" "), _.drop(textArr, count).join(" ")].join("\n");
        }
        return l;
      })
      .join("\n");

    if (line.trim()) {
      buf.push(line.trim());
      return cb();
    }

    line = convert();
    buf = [];
    cb(null, line);
  };

  var flush = function (cb) {
    if (buf.length) this.push(convert());
    cb();
  };

  var parse = through.obj(write, flush);
  parse.push("WEBVTT FILE\r\n\r\n");
  return pumpify(utf8({ newline: false, detectSize: 4095 }), split(), parse);
};
