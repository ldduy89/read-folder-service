const express = require("express");
const app = express();
const fs = require("fs");
const fsExtra = require("fs-extra");
const cors = require("cors");
const path = require("path");
const _ = require("lodash");
const srt2vtt = require("./srt2vtt");
const { SubtitleParser, SubtitleStream } = require("matroska-subtitles");
const { stringifySync } = require("subtitle");
const strstream = require("string-to-stream");
var ass2srt = require("ass-to-srt");
const mime = require("mime-types");
const { spawn, execFile } = require("child_process");

// ffmpeg / ffprobe: ưu tiên bản đóng gói sẵn trong npm (ffmpeg-static, ffprobe-static),
// nếu chưa cài thì dùng ffmpeg/ffprobe có trong PATH của máy.
let ffmpegPath = "ffmpeg";
let ffprobePath = "ffprobe";
try {
  ffmpegPath = require("ffmpeg-static") || "ffmpeg";
} catch (e) {}
try {
  ffprobePath = require("ffprobe-static").path || "ffprobe";
} catch (e) {}

const folderPuclic = [
  {
    name: "Disk_E",
    path: "E:"
  },
  {
    name: "Disk_F",
    path: "F:"
  },
  {
    name: "Download",
    // path: "C:/Users/Duy/Downloads"
    path: "/Users/ngoctrammai/Downloads/"
  }
];

let fileTypes = ["\\.mp4", "\\.mkv", "\\.webm", "\\.TS"];
let pathToConverts = [];
let converting = false;
app.use(cors());
app.use(express.static("public"));

app.get("/statis/*", (req, res) => {
  const name = req.params[0];
  const content = fs.readFileSync(`./statis/${name}`, "utf-8");
  const asd = content.split("\r\n\r\n").map((text) => {
    const newText = _.drop(text.split(new RegExp("\r\n|      ")), 2);
    return `<div>${newText.map((t) => t.trim()).join("<br>")}</div><div>12345678987654321</div>`;
  });
  res.send(asd.join(""));
});

folderPuclic.forEach((f) => {
  app.use(`/public/${f.name}`, express.static(path.join(f.path, "/")));
});
app.get("/public/*", function (req, res) {
  const fullPath = req.params[0].split("/").filter((p) => !!p);

  let root = _.first(fullPath) || "";
  const list = [];
  if (!root) {
    folderPuclic.forEach((f) => {
      list.push({ type: "folder", name: f.name });
    });
    res.send(list);
    return;
  }

  const pathRoot = folderPuclic.find((f) => f.name === root).path;
  const path = [pathRoot, ..._.drop(fullPath)].join("/");

  try {
    const folderNames = fs.readdirSync(path + "/");
    const paths = [];
    folderNames.forEach((name) => {
      let itemStat;
      try {
        itemStat = fs.statSync([path, name].join("/"));
      } catch (error) {}

      if (itemStat && itemStat.isDirectory()) {
        list.push({ type: "folder", name });
      } else if (fileTypes.find((type) => name.includes(type.replace('\\', '')))) {
        list.push({ type: "file", name });
        paths.push([...fullPath, name].join("/"));
      }
    });
    cleanSubs(folderNames, fullPath);
    convertSubtitle(paths);
    res.send(list);
    return;
  } catch (error) {
    console.log(error);
    
  }
  res.send("listName");
});

app.get("/trasks/*", function (req, res) {
  let fulltracks = [];

  try {
    let pathFile = req.params[0];
    const fullPath = pathFile.split("/").filter((p) => !!p);

    let root = _.first(fullPath) || "";
    const pathRoot = folderPuclic.find((f) => f.name === root).path;
    const stream = new SubtitleStream();
    let isTracks = false;

    const pathSub = getSubtitlesOutside(fullPath);
    if (pathSub) fulltracks.push({ language: "default_sv", lable: "default", type: "utf8", default: true });
    stream.once("tracks", (tracks) => {
      isTracks = true;
      for (let index = 0; index < tracks.length; index++) {
        const { language, name } = tracks[index];
        if (!fulltracks.find((t) => t.language == language + "_sv"))
          fulltracks.push({
            language: language ? language + "_sv" : language,
            lable: name || language,
            type: "utf8",
            default: index == 0 && _.isEmpty(fulltracks),
            number: tracks[index].number
          });
      }
      try {
        let fileSubtile = _.clone(pathFile).replace(new RegExp(fileTypes.join("|"), "g"), ".json");
        fs.readFileSync(`subtitles/${fileSubtile}`, "utf8");
        res.send(fulltracks.filter((t) => !!t.language));
      } catch (error) {
        convertSubtitle([pathFile], fulltracks);
        res.send({ waiting: true });
      }
    });
    stream.once("drain", (drain) => {
      if (!isTracks) {
        res.send(fulltracks);
      }
    });
    stream.once("error", (error) => {
      res.send(fulltracks);
    });
    fs.createReadStream([pathRoot, ..._.drop(fullPath)].join("/")).pipe(stream);
  } catch (error) {
    console.log(" error", error);
    res.send(fulltracks);
  }
});


// ================= AUDIO (nhiều audio trong 1 file) =================
const audioDir = path.join(__dirname, "audios");
const audioJobs = new Map(); // outPath -> { error: boolean }

const resolveMediaFile = (p) => {
  const fullPath = (p || "").split("/").filter((x) => !!x);
  if (fullPath.length < 2 || fullPath.includes("..")) return null;
  const folder = folderPuclic.find((f) => f.name === _.first(fullPath));
  if (!folder) return null;
  return { fullPath, file: [folder.path, ..._.drop(fullPath)].join("/") };
};

const channelLayout = (n) => ({ 1: "1.0", 2: "2.0", 6: "5.1", 8: "7.1" }[n] || (n ? `${n}ch` : ""));

const languageName = (code) => {
  if (!code || code === "und") return "";
  try {
    return new Intl.DisplayNames(["vi"], { type: "language" }).of(code) || code;
  } catch (e) {
    return code;
  }
};

const buildAudioLabel = (stream, index) => {
  const tags = stream.tags || {};
  const lang = languageName(tags.language);
  let name = tags.title || lang || `Audio ${index + 1}`;
  if (tags.title && lang && !tags.title.toLowerCase().includes(lang.toLowerCase())) name = `${tags.title} (${lang})`;
  const tech = [(stream.codec_name || "").toUpperCase(), channelLayout(stream.channels)].filter(Boolean).join(" ");
  return tech ? `${name} - ${tech}` : name;
};

const probeAudio = (file) =>
  new Promise((resolve, reject) => {
    execFile(
      ffprobePath,
      [
        "-v",
        "error",
        "-select_streams",
        "a",
        "-show_entries",
        "stream=index,codec_name,channels:stream_disposition=default:stream_tags=language,title",
        "-of",
        "json",
        file
      ],
      { maxBuffer: 10 * 1024 * 1024 },
      (error, stdout) => {
        if (error) return reject(error);
        let streams = [];
        try {
          streams = JSON.parse(stdout).streams || [];
        } catch (e) {}
        let defaultIndex = streams.findIndex((st) => st.disposition && st.disposition.default === 1);
        if (defaultIndex < 0) defaultIndex = 0;
        resolve(
          streams.map((st, i) => ({
            index: i,
            codec: st.codec_name,
            channels: st.channels,
            language: (st.tags || {}).language,
            label: buildAudioLabel(st, i),
            default: i === defaultIndex
          }))
        );
      }
    );
  });

const audioCachePath = (fullPath, track) => path.join(audioDir, ..._.dropRight(fullPath), `${_.last(fullPath)}.a${track}.m4a`);

// Tách 1 audio track ra file .m4a riêng (có cache) để trình duyệt phát song song với video
const startAudioExtract = async (file, track, out) => {
  const job = { error: false };
  audioJobs.set(out, job);
  const tmp = out + ".part";
  try {
    const list = await probeAudio(file);
    const info = list[track];
    if (!info) throw new Error("Khong co audio track " + track);
    fsExtra.ensureDirSync(path.dirname(out));
    const codecArgs = info.codec === "aac" ? ["-c:a", "copy"] : ["-c:a", "aac", "-b:a", info.channels > 2 ? "384k" : "192k"];
    const args = ["-y", "-v", "error", "-i", file, "-map", `0:a:${track}`, "-vn", "-sn", "-dn", ...codecArgs, "-movflags", "+faststart", "-f", "mp4", tmp];
    console.log("audio extract:", file, "track", track, info.codec);
    await new Promise((resolve, reject) => {
      const proc = spawn(ffmpegPath, args);
      let err = "";
      proc.stderr.on("data", (d) => (err += d.toString()));
      proc.on("error", reject);
      proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err || `ffmpeg exit ${code}`))));
    });
    fsExtra.moveSync(tmp, out, { overwrite: true });
    audioJobs.delete(out);
    console.log("audio extract: finish", out);
  } catch (error) {
    console.log("audio extract error:", error.message);
    try {
      fsExtra.removeSync(tmp);
    } catch (e) {}
    job.error = true; // báo lỗi 1 lần ở lần hỏi tiếp theo
  }
};

// Danh sách audio của file
app.get("/audios/*", async (req, res) => {
  const m = resolveMediaFile(req.params[0]);
  if (!m || !fs.existsSync(m.file)) return res.send([]);
  try {
    res.send(await probeAudio(m.file));
  } catch (error) {
    console.log("probe error:", error.message);
    res.send([]);
  }
});

// Chuẩn bị audio track được chọn: { ready: true } | { waiting: true } | { error: true }
app.get("/audio-prepare/*", (req, res) => {
  const track = parseInt(req.query.track, 10);
  const m = resolveMediaFile(req.params[0]);
  if (!m || isNaN(track) || track < 0 || !fs.existsSync(m.file)) return res.status(400).send({ error: true });
  const out = audioCachePath(m.fullPath, track);
  if (fs.existsSync(out)) return res.send({ ready: true });
  const job = audioJobs.get(out);
  if (job && job.error) {
    audioJobs.delete(out);
    return res.send({ error: true });
  }
  if (!job) startAudioExtract(m.file, track, out);
  res.send({ waiting: true });
});

// File audio đã tách (hỗ trợ Range để tua)
app.get("/audio-file/*", (req, res) => {
  const track = parseInt(req.query.track, 10);
  const m = resolveMediaFile(req.params[0]);
  if (!m || isNaN(track) || track < 0) return res.sendStatus(400);
  const out = audioCachePath(m.fullPath, track);
  if (!fs.existsSync(out)) return res.sendStatus(404);
  res.type("audio/mp4");
  res.sendFile(out, { dotfiles: "allow" });
});

app.get("/read/*", function (req, res) {
  const fullPath = req.params[0].split("/").filter((p) => !!p);
  const path = getSubtitlesOutside(fullPath);
  let data = fs.readFileSync(path, "utf8");
  const datas = data.split("\r\n");
  return res.send(datas);
});

app.get("/subtitles/*", function (req, res) {
  const fullPath = req.params[0].split("/").filter((p) => !!p);
  let pathFile = req.params[0].replace(new RegExp(fileTypes.join("|"), "g"), ".json");
  const language = req.query.language;
  let str = "";
  if (language === "default_sv") {
    const path = getSubtitlesOutside(fullPath);
    if (path) {
      if (path.includes(".ass")) {
        const str = fs.readFileSync(path);
        strstream(ass2srt(str)).pipe(srt2vtt()).pipe(res);
      } else {
        fs.createReadStream(path).pipe(srt2vtt()).pipe(res);
      }
    } else strstream("").pipe(res);
    return;
  }
  try {
    const data = fs.readFileSync(`subtitles/${pathFile}`, "utf8");
    if (data) {
      const info = JSON.parse(data || "{}");
      str = stringifySync(info[language] || [], { format: "SRT" });
      strstream(str).pipe(srt2vtt()).pipe(res);
      return;
    }
  } catch (error) {}
  strstream("").pipe(srt2vtt()).pipe(res);
});

const server = app.listen(8081, function () {
  const host = server.address().address;
  const port = server.address().port;
  console.log("Ung dung Node.js dang lang nghe tai dia chi: http://%s:%s", host, port);
});

const getSubtitlesOutside = (fullPath) => {
  const root = _.first(fullPath) || "";
  const pathRoot = folderPuclic.find((f) => f.name === root).path;
  const folder = [pathRoot, ..._.drop(_.dropRight(fullPath))].join("/");
  const file = _.last(fullPath);
  const nameass = file.replace(new RegExp(fileTypes.join("|"), "g"), ".ass");
  const namesrc = file.replace(new RegExp(fileTypes.join("|"), "g"), ".srt");
  const namevtt = file.replace(new RegExp(fileTypes.join("|"), "g"), ".vtt");
  const files = fs.readdirSync(folder);
  let path;
  files.forEach((f) => {
    if ([nameass, namesrc, namevtt].includes(f) && !path) {
      path = [folder, f.trim()].filter((p) => !!p).join("/");
    }
  });
  return path;
};

const cleanSubs = async (fileNames, fullPath) => {
  try {
    const subs = fs.readdirSync(`subtitles/${fullPath.join("/")}`);
    subs.forEach((sub) => {
      const checkNoFile = !fileNames.find((file) => file.replace(new RegExp(fileTypes.join("|"), "g"), "") === sub.replace(".json", ""));
      try {
        if (checkNoFile) fsExtra.removeSync(`subtitles/${[...fullPath, sub].join("/")}`);
      } catch (error) {}
    });
  } catch (error) {}
};

const convertSubtitle = async (paths, tracks, continue_) => {
  if (paths) {
    paths.forEach((path) => {
      if (!pathToConverts.find((c) => c.path === path)) {
        pathToConverts.push({ path, tracks });
      }
    });
  }
  if ((!converting || continue_) && !_.isEmpty(pathToConverts)) {
    converting = true;
    await convert(pathToConverts[0].path, pathToConverts[0].tracks);
    pathToConverts = _.drop(pathToConverts);
    if (_.isEmpty(pathToConverts)) {
      converting = false;
    } else {
      convertSubtitle(null, null, true);
    }
  }
};

const convert = (path, fulltracks) => {
  return new Promise((resolve, reject) => {
    let pathFile = _.clone(path).replace(new RegExp(fileTypes.join("|"), "g"), ".json");
    try {
      fs.readFileSync(`subtitles/${pathFile}`, "utf8");
      resolve("");
      return;
    } catch (error) {}

    const fullPath = path.split("/").filter((p) => !!p);
    let root = _.first(fullPath) || "";
    const pathRoot = folderPuclic.find((f) => f.name === root).path;

    let newTracks = _.cloneDeep(fulltracks);
    if (!newTracks) {
      try {
        newTracks = [];
        const stream = new SubtitleStream();
        let isTracks = false;
        stream.once("tracks", (tracks) => {
          isTracks = true;
          for (let index = 0; index < tracks.length; index++) {
            const { language, lable } = tracks[index];
            if (!newTracks.find((t) => t.language == language + "_sv"))
              newTracks.push({
                language: language ? language + "_sv" : language,
                lable: lable || language,
                type: "utf8",
                default: index == 0,
                number: tracks[index].number
              });
          }
          parter(newTracks, path, pathFile, pathRoot, fullPath, resolve, reject);
        });
        stream.once("drain", (drain) => {
          if (!isTracks) {
            fsExtra.outputFile(`subtitles/${pathFile}`, JSON.stringify({}));
            resolve("");
          }
        });
        fs.createReadStream([pathRoot, ..._.drop(fullPath)].join("/")).pipe(stream);
      } catch (error) {
        fsExtra.outputFile(`subtitles/${pathFile}`, JSON.stringify({}));
        resolve("");
        return;
      }
    } else {
      parter(newTracks, path, pathFile, pathRoot, fullPath, resolve, reject);
    }
  });
};
const parter = (newTracks, path, pathFile, pathRoot, fullPath, resolve, reject) => {
  const parser = new SubtitleParser();
  const subtitleObj = {};
  let index = 1;
  parser.on("subtitle", (subtitle, trackNumber) => {
    if (index % 200 === 0) {
      console.log(pathFile, ": ", index);
    }
    index++;
    const { language } = newTracks.find((track) => track.number == trackNumber) || {};
    if (language && subtitle.duration < 10000) {
      const rowRob = {
        type: "cue",
        data: { start: subtitle.time, end: subtitle.time + subtitle.duration, text: subtitle.text }
      };
      if (subtitleObj[language]) {
        subtitleObj[language].push(rowRob);
      } else {
        subtitleObj[language] = [rowRob];
      }
    }
  });
  parser.on("finish", () => {
    fsExtra.outputFile(`subtitles/${pathFile}`, JSON.stringify(subtitleObj));
    console.log(path, ": finish");
    resolve("finish");
  });
  fs.createReadStream([pathRoot, ..._.drop(fullPath)].join("/")).pipe(parser);
};
