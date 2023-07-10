
const _ = require("lodash");

// let line = 'Ta sớm đã bảo đừng quá làm người khác chú ý như vậy, trông lộ quá mà'
// const lineArr = line.split("\n");
// line = lineArr.map((l) => {
//     if (l.length > 60) {
//       const textArr = _.split(l, " ");
//       const index = _.findIndex(textArr, (str) => str.includes(","));
//       let count = parseInt(textArr.length / 2 + 1);
//       if (index >= count - 3 && index <= count + 2) count = index + 1;
//       l = [_.dropRight(textArr, textArr.length - count).join(' '),_.drop(textArr, count).join(' ')].join("\n");
//       console.log(count);
//     }
//     return l;
//   })
//   .join("\n");
let fileTypes = ["\\.mp4", "\\.mkv", "\\.webm", "\\.TS"];
  console.log(new RegExp(fileTypes.join("|").replace('\\', ''), "g"));