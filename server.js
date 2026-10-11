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
const assLib = require("./ass");
const mime = require("mime-types");
const { spawn, execFile } = require("child_process");
const os = require("os");
const { pipeline } = require("stream");

// ================= CHỐNG SẬP SERVICE =================
// Lỗi không bắt được (stream ENOENT, promise không catch, ...) chỉ ghi log chứ không làm service chết.
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err && err.stack ? err.stack : err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason && reason.stack ? reason.stack : reason);
});

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

// ================= ROOTS (trang Home) =================
// Không còn cố định trong code:
//   - Windows: tự lấy các ổ đĩa đang có (Disk_C, Disk_D, ...)
//   - macOS:   /Users
//   - khác:    thư mục home của user
// Ngoài ra là các thư mục người dùng bấm "Pick", lưu trong picked.json (cạnh server.js).
const pickedFile = path.join(__dirname, "picked.json");

const readPicked = () => {
  try {
    const list = JSON.parse(fs.readFileSync(pickedFile, "utf8"));
    return Array.isArray(list) ? list.filter((p) => p && p.name && p.path) : [];
  } catch (e) {
    return [];
  }
};
const writePicked = (list) => fs.writeFileSync(pickedFile, JSON.stringify(list, null, 2));

const getSystemRoots = () => {
  if (process.platform === "win32") {
    const drives = [];
    for (let code = 65; code <= 90; code++) {
      const letter = String.fromCharCode(code);
      try {
        // path dạng "E:" (như bản cũ) để ghép "E:" + "/" + ...
        if (fs.existsSync(`${letter}:\\`)) drives.push({ name: `Disk_${letter}`, path: `${letter}:` });
      } catch (e) {}
    }
    return drives;
  }
  if (process.platform === "darwin") return [{ name: "Users", path: "/Users" }];
  return [{ name: "Home", path: os.homedir() }];
};

// Danh sách root hiện tại (tính lại mỗi lần gọi: cắm/rút ổ đĩa, pick/bỏ pick đều có hiệu lực ngay)
const getRoots = () => [
  ...getSystemRoots().map((r) => ({ ...r, picked: false })),
  ...readPicked().map((r) => ({ ...r, picked: true }))
];
const findRoot = (name) => getRoots().find((r) => r.name === name);
const rootPathOf = (name) => {
  const root = findRoot(name);
  if (!root) throw new Error("Khong co root: " + name);
  return root.path;
};

const samePath = (a, b) => {
  const norm = (p) => {
    const r = path.resolve(p + "/");
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
};

// segments = ["Disk_E", "Phim", "abc"] -> đường dẫn thật trên máy; null nếu root không tồn tại hoặc cố thoát ra ngoài root
const resolveFolder = (segments) => {
  const root = findRoot(_.first(segments));
  if (!root) return null;
  const rootAbs = path.resolve(root.path + "/");
  const full = path.resolve(rootAbs, ..._.drop(segments));
  const rel = path.relative(rootAbs, full);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return full;
};

let fileTypes = ["\\.mp4", "\\.mkv", "\\.webm", "\\.TS"];
let pathToConverts = [];
let converting = false;
app.use(cors());
app.use(express.static("public"));

app.get("/statis/*", (req, res) => {
  try {
    const name = req.params[0];
    if (name.split(/[\\/]/).includes("..")) return res.status(400).send("");
    const content = fs.readFileSync(`./statis/${name}`, "utf-8");
    const asd = content.split("\r\n\r\n").map((text) => {
      const newText = _.drop(text.split(new RegExp("\r\n|      ")), 2);
      return `<div>${newText.map((t) => t.trim()).join("<br>")}</div><div>12345678987654321</div>`;
    });
    res.send(asd.join(""));
  } catch (error) {
    console.log("statis error:", error.message);
    res.status(404).send("");
  }
});

// Phục vụ file video (hỗ trợ Range để tua). Thư mục thì chuyển tiếp xuống handler liệt kê bên dưới.
const safeDecode = (p) => {
  try {
    return decodeURIComponent(p);
  } catch (e) {
    return p;
  }
};
app.use("/public", (req, res, next) => {
  const segments = req.path.split("/").filter((p) => !!p).map(safeDecode);
  if (segments.length < 2) return next();
  const file = resolveFolder(segments);
  if (!file) return next();
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return next();
    res.sendFile(file, { dotfiles: "allow" }, (e) => {
      if (e && !res.headersSent) next(e);
    });
  });
});

app.get("/public/*", function (req, res) {
  const fullPath = req.params[0].split("/").filter((p) => !!p);

  const list = [];
  if (_.isEmpty(fullPath)) {
    // Trang Home: ổ đĩa / /Users + các thư mục đã pick
    getRoots().forEach((r) => {
      if (r.picked && !fs.existsSync(r.path)) return; // thư mục đã pick nhưng đang không truy cập được (vd rút ổ ngoài) thì ẩn tạm
      list.push({ type: "folder", name: r.name, picked: r.picked });
    });
    res.send(list);
    return;
  }

  const dir = resolveFolder(fullPath);
  if (!dir) {
    res.send([]);
    return;
  }
  const pickedList = readPicked();

  try {
    const folderNames = fs.readdirSync(dir);
    const paths = [];
    folderNames.forEach((name) => {
      const itemPath = path.join(dir, name);
      let itemStat;
      try {
        itemStat = fs.statSync(itemPath);
      } catch (error) {}

      if (itemStat && itemStat.isDirectory()) {
        const pickedItem = pickedList.find((p) => samePath(p.path, itemPath));
        list.push({ type: "folder", name, picked: !!pickedItem, ...(pickedItem ? { pickedName: pickedItem.name } : {}) });
      } else if (fileTypes.find((type) => name.includes(type.replace("\\", "")))) {
        list.push({ type: "file", name });
        paths.push([...fullPath, name].join("/"));
      }
    });
    cleanSubs(folderNames, fullPath).catch(() => {});
    convertSubtitle(paths).catch((e) => console.log("convertSubtitle error:", e.message));
    res.send(list);
    return;
  } catch (error) {
    console.log(error.message);
  }
  res.send([]);
});

// Pick một thư mục -> hiện ở trang Home. POST /pick/<root>/<thư mục con>/...
app.post("/pick/*", (req, res) => {
  const segments = req.params[0].split("/").filter((p) => !!p);
  if (segments.length < 2) return res.status(400).send({ error: "Chi pick duoc thu muc ben trong o dia" });
  const dir = resolveFolder(segments);
  let isDir = false;
  try {
    isDir = !!dir && fs.statSync(dir).isDirectory();
  } catch (e) {}
  if (!isDir) return res.status(404).send({ error: "Khong tim thay thu muc" });

  try {
    const list = readPicked();
    const existed = list.find((p) => samePath(p.path, dir));
    if (existed) return res.send({ ok: true, name: existed.name });

    const used = getRoots().map((r) => r.name);
    const base = path.basename(dir) || _.last(segments);
    let name = base;
    for (let i = 2; used.includes(name); i++) name = `${base} (${i})`;
    list.push({ name, path: dir });
    writePicked(list);
    res.send({ ok: true, name });
  } catch (error) {
    console.log("pick error:", error.message);
    res.status(500).send({ error: "Khong luu duoc" });
  }
});

// Bỏ pick (chỉ xoá khỏi Home, không động tới thư mục thật). DELETE /pick/<tên trên Home>
app.delete("/pick/*", (req, res) => {
  const name = req.params[0].split("/").filter((p) => !!p)[0];
  try {
    const list = readPicked();
    const next = list.filter((p) => p.name !== name);
    if (next.length !== list.length) writePicked(next);
    res.send({ ok: true });
  } catch (error) {
    console.log("unpick error:", error.message);
    res.status(500).send({ error: "Khong luu duoc" });
  }
});

app.get("/trasks/*", function (req, res) {
  let fulltracks = [];
  let sent = false;
  // Chỉ trả lời 1 lần (tránh "Cannot set headers after they are sent" làm sập service)
  const send = (data) => {
    if (sent || res.headersSent) return;
    sent = true;
    try {
      res.send(data);
    } catch (e) {
      console.log("trasks send error:", e.message);
    }
  };
  let readStream = null;
  // Đã có danh sách track thì thôi đọc tiếp file video lớn, đồng thời nhả file descriptor
  const cleanup = () => {
    try {
      if (readStream) {
        readStream.unpipe();
        readStream.destroy();
      }
    } catch (e) {}
  };
  res.on("close", cleanup);

  try {
    let pathFile = req.params[0];
    const fullPath = pathFile.split("/").filter((p) => !!p);

    let root = _.first(fullPath) || "";
    const pathRoot = rootPathOf(root);
    const stream = new SubtitleStream();
    let isTracks = false;

    listSubtitlesOutside(fullPath).forEach((r, i) => {
      fulltracks.push({ language: r.language, lable: r.lable, type: "utf8", default: i === 0 });
    });
    stream.once("tracks", (tracks) => {
      isTracks = true;
      try {
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
          send(fulltracks.filter((t) => !!t.language));
        } catch (error) {
          convertSubtitle([pathFile], fulltracks).catch((e) => console.log("convertSubtitle error:", e.message));
          send({ waiting: true });
        }
      } catch (error) {
        console.log("trasks tracks error:", error.message);
        send(fulltracks.filter((t) => !!t.language));
      }
      cleanup();
    });
    const onNoTracks = () => {
      if (!isTracks) {
        send(fulltracks);
        cleanup();
      }
    };
    stream.once("drain", onNoTracks);
    stream.once("finish", onNoTracks); // file nhỏ / không phải mkv: đọc hết mà không có 'drain'
    // on (không phải once): lỗi giải mã có thể phát nhiều lần, lần thứ 2 mà không có handler sẽ làm sập service
    stream.on("error", (error) => {
      console.log("trasks stream error:", error.message);
      send(fulltracks);
      cleanup();
    });
    readStream = fs.createReadStream([pathRoot, ..._.drop(fullPath)].join("/"));
    readStream.on("error", (error) => {
      // File video không tồn tại / không đọc được (ENOENT, EACCES...): vẫn trả các sub nằm ngoài
      console.log("trasks read error:", error.message);
      send(fulltracks);
    });
    readStream.pipe(stream);
  } catch (error) {
    console.log(" error", error.message);
    send(fulltracks);
  }
});


// ================= AUDIO (nhiều audio trong 1 file) =================
const audioDir = path.join(__dirname, "audios");
const audioJobs = new Map(); // outPath -> { error: boolean }

const resolveMediaFile = (p) => {
  const fullPath = (p || "").split("/").filter((x) => !!x);
  if (fullPath.length < 2 || fullPath.includes("..")) return null;
  const folder = findRoot(_.first(fullPath));
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
  res.sendFile(out, { dotfiles: "allow" }, (e) => {
    if (e && !res.headersSent) res.sendStatus(e.status || 500);
  });
});

app.get("/read/*", function (req, res) {
  try {
    const fullPath = req.params[0].split("/").filter((p) => !!p);
    const subPath = getSubtitlesOutside(fullPath);
    if (!subPath) return res.send([]);
    return res.send(fs.readFileSync(subPath, "utf8").split("\r\n"));
  } catch (error) {
    console.log("read error:", error.message);
    res.send([]);
  }
});

const sendVtt = (res, vtt) => {
  res.set("Content-Type", "text/vtt; charset=utf-8");
  res.send(vtt);
};
const EMPTY_VTT = "WEBVTT FILE\r\n\r\n";

// Đẩy dữ liệu qua srt2vtt rồi trả cho client. pipeline bắt mọi lỗi stream (kể cả lỗi giữa chừng) và tự dọn các stream.
const pipeVtt = (res, source) => {
  res.set("Content-Type", "text/vtt; charset=utf-8");
  pipeline(source, srt2vtt(), res, (err) => {
    if (err) console.log("vtt stream error:", err.code || err.message);
  });
};

// Như trên nhưng đọc từ file: nếu không mở được file (mất file, không có quyền) thì trả VTT rỗng thay vì làm sập service
const pipeFileVtt = (res, filePath) => {
  const rs = fs.createReadStream(filePath);
  const onOpenError = (err) => {
    console.log("read sub error:", err.message);
    if (!res.headersSent) sendVtt(res, EMPTY_VTT);
    else res.destroy();
  };
  rs.once("error", onOpenError);
  rs.once("open", () => {
    rs.removeListener("error", onOpenError);
    pipeVtt(res, rs);
  });
};

app.get("/subtitles/*", function (req, res) {
  try {
    const fullPath = req.params[0].split("/").filter((p) => !!p);
    let pathFile = req.params[0].replace(new RegExp(fileTypes.join("|"), "g"), ".json");
    const language = req.query.language;
    let str = "";
    if (isOutsideLang(language)) {
      const subPath = getSubtitlesOutside(fullPath, language);
      if (!subPath) return res.end();
      if (/\.ass$/i.test(subPath)) {
        // Đọc ASS trực tiếp (giữ \pos, \an, \fs, màu... và style) thay vì ass-to-srt
        try {
          const parsed = assLib.parseAss(assLib.decodeText(fs.readFileSync(subPath)));
          sendVtt(res, assLib.eventsToVtt(parsed.events));
          return;
        } catch (error) {
          console.log("ass parse error", error.message);
        }
        pipeVtt(res, strstream(ass2srt(fs.readFileSync(subPath))));
      } else {
        pipeFileVtt(res, subPath);
      }
      return;
    }
    try {
      const data = fs.readFileSync(`subtitles/${pathFile}`, "utf8");
      if (data) {
        const info = JSON.parse(data || "{}");
        const cues = info[language] || [];
        const isAss = (info._ass && info._ass[language]) || cues.some((c) => assLib.looksLikeAss(c.data && c.data.text));
        if (isAss) {
          // Track ASS (hoặc text có thẻ ASS): giữ nguyên thẻ + thông tin style cho client tự vẽ
          const events = cues.map((c) => ({
            start: c.data.start / 1000,
            end: c.data.end / 1000,
            text: c.data.text,
            style: c.data.style,
            layer: c.data.layer,
            marginL: c.data.marginL,
            marginR: c.data.marginR,
            marginV: c.data.marginV
          }));
          sendVtt(res, assLib.eventsToVtt(events));
          return;
        }
        str = stringifySync(cues, { format: "SRT" });
        pipeVtt(res, strstream(str));
        return;
      }
    } catch (error) {}
    pipeVtt(res, strstream(""));
  } catch (error) {
    console.log("subtitles error:", error.message);
    if (!res.headersSent) sendVtt(res, EMPTY_VTT);
    else res.destroy();
  }
});

// Header của sub ASS: PlayResX/PlayResY + bảng style (client dùng để vẽ đúng cỡ chữ, màu, vị trí)
app.get("/subtitles-style/*", function (req, res) {
  const fullPath = req.params[0].split("/").filter((p) => !!p);
  const language = req.query.language;
  try {
    if (isOutsideLang(language)) {
      const subFile = getSubtitlesOutside(fullPath, language);
      if (subFile && /\.ass$/i.test(subFile)) {
        return res.json(assLib.parseAssHeader(assLib.decodeText(fs.readFileSync(subFile))));
      }
      return res.json({});
    }
    const pathFile = req.params[0].replace(new RegExp(fileTypes.join("|"), "g"), ".json");
    const info = JSON.parse(fs.readFileSync(`subtitles/${pathFile}`, "utf8") || "{}");
    return res.json((info._ass && info._ass[language]) || {});
  } catch (error) {
    return res.json({});
  }
});

require("./translate")(app); // /translate, /tts (dịch + giọng đọc)

// Lỗi trong route (kể cả lỗi đồng bộ) -> trả 500 thay vì làm sập; phải đặt sau tất cả route
app.use((err, req, res, next) => {
  console.log("express error:", req.method, req.originalUrl, "-", err && err.message);
  if (res.headersSent) return res.destroy();
  res.status(err && (err.status || err.statusCode) ? err.status || err.statusCode : 500).send({ error: "Loi server" });
});

const server = app.listen(8081, function () {
  const host = server.address().address;
  const port = server.address().port;
  console.log("Ung dung Node.js dang lang nghe tai dia chi: http://%s:%s", host, port);
});
server.on("error", (err) => {
  console.error("Server error:", err.message);
  // Không mở được cổng (đang bị chiếm / không có quyền) thì thoát hẳn để dễ nhận ra, tránh chạy "ma" không nhận kết nối
  if (err.code === "EADDRINUSE" || err.code === "EACCES") process.exit(1);
});

// Sub nằm ngoài, cùng thư mục với video. Với video "video.mp4" nhận:
//   video.ass | video.srt | video.vtt          -> track "default"
//   video_vi.vtt | video-vi.srt | video_en.ass  -> mỗi file một track, tên track = phần sau dấu _ hoặc -
const SUB_FILE = /\.(ass|srt|vtt)$/i;
const outsideLang = (suffix) => "ext_" + suffix.replace(/[&#?%+=\s]/g, "_"); // id track, an toàn khi nằm trong query string
const isOutsideLang = (language) => language === "default_sv" || (typeof language === "string" && language.startsWith("ext_"));

const listSubtitlesOutside = (fullPath) => {
  const root = _.first(fullPath) || "";
  const pathRoot = rootPathOf(root);
  const folder = [pathRoot, ..._.drop(_.dropRight(fullPath))].join("/");
  const base = _.last(fullPath).replace(/\.[^.]+$/, "");
  const result = [];
  fs.readdirSync(folder)
    .sort()
    .forEach((f) => {
      if (!SUB_FILE.test(f)) return;
      const stem = f.replace(SUB_FILE, "").trim();
      const file = [folder, f.trim()].filter((p) => !!p).join("/");
      if (stem === base.trim()) {
        if (!result.find((r) => r.language === "default_sv")) result.unshift({ language: "default_sv", lable: "default", path: file });
      } else if (stem.startsWith(base + "_") || stem.startsWith(base + "-")) {
        const suffix = stem.slice(base.length + 1).trim();
        if (suffix) result.push({ language: outsideLang(suffix), lable: suffix, path: file });
      }
    });
  return result;
};

// language = "default_sv" (file cùng tên) hoặc "ext_<hậu tố>"; không truyền thì lấy track đầu tiên
const getSubtitlesOutside = (fullPath, language) => {
  const list = listSubtitlesOutside(fullPath);
  const found = language ? list.find((r) => r.language === language) : list[0];
  return found ? found.path : undefined;
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

const convertFailedAt = new Map(); // đường dẫn video -> thời điểm lỗi gần nhất, tránh thử lại liên tục mỗi lần mở thư mục
const CONVERT_RETRY_MS = 5 * 60 * 1000;

// Hàng đợi tách sub: chạy tuần tự; 1 file lỗi không được làm kẹt hay làm sập cả hàng đợi
const convertSubtitle = async (paths, tracks) => {
  if (paths) {
    paths.forEach((path) => {
      if (!pathToConverts.find((c) => c.path === path)) {
        pathToConverts.push({ path, tracks });
      }
    });
  }
  if (converting) return;
  converting = true;
  try {
    while (!_.isEmpty(pathToConverts)) {
      const job = pathToConverts[0];
      try {
        await convert(job.path, job.tracks);
      } catch (error) {
        console.log("convert error:", job.path, "-", error.message);
      }
      pathToConverts = _.drop(pathToConverts);
    }
  } finally {
    converting = false;
  }
};

// Promise luôn resolve (không bao giờ reject hay treo) để hàng đợi không bị kẹt
const convert = (path, fulltracks) => {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const fail = (message) => {
      console.log("convert error:", path, "-", message);
      convertFailedAt.set(path, Date.now());
      done("");
    };

    try {
      let pathFile = _.clone(path).replace(new RegExp(fileTypes.join("|"), "g"), ".json");
      try {
        fs.readFileSync(`subtitles/${pathFile}`, "utf8");
        done("");
        return;
      } catch (error) {}

      const failedAt = convertFailedAt.get(path);
      if (failedAt && Date.now() - failedAt < CONVERT_RETRY_MS) {
        done(""); // vừa lỗi gần đây, chưa thử lại ngay
        return;
      }

      const fullPath = path.split("/").filter((p) => !!p);
      let root = _.first(fullPath) || "";
      const rootInfo = findRoot(root);
      if (!rootInfo) {
        done(""); // root đã bị bỏ pick / ổ đĩa đã rút
        return;
      }
      const pathRoot = rootInfo.path;

      let newTracks = _.cloneDeep(fulltracks);
      if (!newTracks) {
        newTracks = [];
        let isTracks = false;
        const stream = new SubtitleStream();
        const rs = fs.createReadStream([pathRoot, ..._.drop(fullPath)].join("/"));
        // Đọc xong danh sách track thì ngừng đọc file này (parter sẽ mở luồng đọc riêng), nhả file descriptor
        const stop = () => {
          try {
            rs.unpipe(stream);
            rs.destroy();
          } catch (e) {}
        };
        stream.on("error", (error) => {
          stop();
          fail(error.message);
        });
        rs.on("error", (error) => fail(error.message)); // file không tồn tại / không đọc được
        stream.once("tracks", (tracks) => {
          isTracks = true;
          stop();
          try {
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
            parter(newTracks, path, pathFile, pathRoot, fullPath, done, fail);
          } catch (error) {
            fail(error.message);
          }
        });
        const onNoTracks = () => {
          if (!isTracks && !settled) {
            stop();
            // File không có sub (hoặc không đọc được như mkv): ghi json rỗng để không phải quét lại
            fsExtra
              .outputFile(`subtitles/${pathFile}`, JSON.stringify({}))
              .catch((e) => console.log("write empty sub json error:", e.message))
              .then(() => done(""));
          }
        };
        stream.once("drain", onNoTracks);
        stream.once("finish", onNoTracks); // file nhỏ: đọc hết mà không có 'drain' thì hàng đợi bị kẹt mãi
        rs.pipe(stream);
      } else {
        parter(newTracks, path, pathFile, pathRoot, fullPath, done, fail);
      }
    } catch (error) {
      fail(error.message);
    }
  });
};

const parter = (newTracks, path, pathFile, pathRoot, fullPath, resolve, fail) => {
  const parser = new SubtitleParser();
  const subtitleObj = {};
  const assMeta = {}; // language -> { playResX, playResY, styles } cho track ASS
  let index = 1;
  parser.once("tracks", (tracks) => {
    try {
      (tracks || []).forEach((t) => {
        const lang = (newTracks.find((n) => n.number == t.number) || {}).language;
        if (lang && t.header && /\[(V4\+? Styles|Script Info)\]/i.test(String(t.header))) {
          assMeta[lang] = assLib.parseAssHeader(t.header);
        }
      });
    } catch (error) {
      console.log("ass header error:", path, "-", error.message); // header ASS lạ: bỏ qua thông tin style, vẫn lấy được chữ
    }
  });
  parser.on("subtitle", (subtitle, trackNumber) => {
    try {
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
        if (subtitle.style !== undefined) {
          // Track ASS: lưu thêm style / layer / margin riêng của từng dòng
          Object.assign(rowRob.data, {
            style: subtitle.style,
            layer: subtitle.layer,
            marginL: subtitle.marginL,
            marginR: subtitle.marginR,
            marginV: subtitle.marginV
          });
          if (!assMeta[language]) assMeta[language] = { playResX: 0, playResY: 0, styles: {} };
        }
        if (subtitleObj[language]) {
          subtitleObj[language].push(rowRob);
        } else {
          subtitleObj[language] = [rowRob];
        }
      }
    } catch (error) {
      console.log("subtitle row error:", path, "-", error.message); // 1 dòng sub lỗi thì bỏ dòng đó
    }
  });
  const rs = fs.createReadStream([pathRoot, ..._.drop(fullPath)].join("/"));
  parser.on("error", (error) => {
    try {
      rs.unpipe(parser);
      rs.destroy();
    } catch (e) {}
    fail(error.message);
  });
  rs.on("error", (error) => {
    // Mất file giữa chừng: bỏ dở, không ghi file json thiếu dữ liệu (lần sau sẽ tách lại)
    try {
      rs.unpipe(parser);
      parser.destroy();
    } catch (e) {}
    fail(error.message);
  });
  parser.on("finish", () => {
    if (!_.isEmpty(assMeta)) subtitleObj._ass = assMeta;
    fsExtra
      .outputFile(`subtitles/${pathFile}`, JSON.stringify(subtitleObj))
      .then(() => {
        console.log(path, ": finish");
        resolve("finish");
      })
      .catch((error) => fail("Khong ghi duoc file sub: " + error.message));
  });
  rs.pipe(parser);
};
