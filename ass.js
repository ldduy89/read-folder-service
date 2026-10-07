// ass.js — đọc phụ đề ASS/SSA và đổi sang WebVTT mà KHÔNG làm mất thiết lập của sub:
//  - text của cue giữ nguyên thẻ override ({\pos(..)}, {\an8}, {\fs90}, {\c&H..&}, \N ...)
//  - mỗi cue có "identifier" mang theo tên style, layer và margin riêng của dòng đó
//  - phần header (PlayResX/PlayResY + bảng Style) được trả riêng qua /subtitles-style/*

// "&HAABBGGRR" / "&HBBGGRR&" / số thập phân (SSA) -> "#rrggbb"
function assColor(value) {
  if (value === undefined || value === null) return null;
  let s = String(value).trim();
  if (!s) return null;
  let n;
  if (/^&?h/i.test(s)) {
    s = s.replace(/^&?h/i, "").replace(/&$/, "");
    n = parseInt(s, 16);
  } else {
    n = parseInt(s, 10);
  }
  if (!Number.isFinite(n)) return null;
  n = n >>> 0;
  const bb = (n >>> 16) & 255;
  const gg = (n >>> 8) & 255;
  const rr = n & 255;
  const hex = (v) => v.toString(16).padStart(2, "0");
  return `#${hex(rr)}${hex(gg)}${hex(bb)}`;
}

// SSA cũ (V4) dùng alignment 1-3 / 5-7 / 9-11, đổi về kiểu numpad 1-9 của ASS
const SSA_ALIGN = { 1: 1, 2: 2, 3: 3, 5: 7, 6: 8, 7: 9, 9: 4, 10: 5, 11: 6 };

const flag = (v) => v !== undefined && String(v).trim() !== "" && String(v).trim() !== "0";

// Đọc phần header của file ASS (cũng là CodecPrivate của track ASS trong MKV)
function parseAssHeader(text) {
  const meta = { playResX: 0, playResY: 0, styles: {} };
  let section = "";
  let format = null;
  let ssa = false;
  const lines = String(text || "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line[0] === ";") continue;
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) {
      section = sec[1].toLowerCase();
      format = null;
      ssa = section === "v4 styles";
      continue;
    }
    if (section === "script info") {
      const m = /^(\w+)\s*:\s*(.*)$/.exec(line);
      if (!m) continue;
      const key = m[1].toLowerCase();
      if (key === "playresx") meta.playResX = parseInt(m[2], 10) || 0;
      if (key === "playresy") meta.playResY = parseInt(m[2], 10) || 0;
    } else if (section === "v4+ styles" || section === "v4 styles") {
      if (/^format\s*:/i.test(line)) {
        format = line
          .slice(line.indexOf(":") + 1)
          .split(",")
          .map((s) => s.trim().toLowerCase());
      } else if (/^style\s*:/i.test(line) && format) {
        const vals = line
          .slice(line.indexOf(":") + 1)
          .split(",")
          .map((s) => s.trim());
        const o = {};
        format.forEach((f, i) => (o[f] = vals[i]));
        if (!o.name) continue;
        let alignment = parseInt(o.alignment, 10) || 2;
        if (ssa) alignment = SSA_ALIGN[alignment] || 2;
        meta.styles[o.name] = {
          fontName: o.fontname || "",
          fontSize: parseFloat(o.fontsize) || 0,
          primary: assColor(o.primarycolour),
          outline: assColor(o.outlinecolour || o.tertiarycolour),
          back: assColor(o.backcolour),
          bold: flag(o.bold),
          italic: flag(o.italic),
          underline: flag(o.underline),
          strike: flag(o.strikeout),
          alignment,
          marginL: parseInt(o.marginl, 10) || 0,
          marginR: parseInt(o.marginr, 10) || 0,
          marginV: parseInt(o.marginv, 10) || 0
        };
      }
    }
  }
  // Quy tắc của libass khi thiếu PlayRes
  if (!meta.playResX && !meta.playResY) {
    meta.playResX = 384;
    meta.playResY = 288;
  } else if (!meta.playResX) {
    meta.playResX = Math.round((meta.playResY * 4) / 3);
  } else if (!meta.playResY) {
    meta.playResY = Math.round((meta.playResX * 3) / 4);
  }
  return meta;
}

// h:mm:ss.cc -> giây
function assTime(t) {
  const m = /^(\d+):(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?$/.exec(String(t || "").trim());
  if (!m) return 0;
  const frac = m[4] ? parseFloat("0." + m[4]) : 0;
  return +m[1] * 3600 + +m[2] * 60 + +m[3] + frac;
}

const DEFAULT_EVENT_FORMAT = ["layer", "start", "end", "style", "name", "marginl", "marginr", "marginv", "effect", "text"];

// Đọc các dòng Dialogue của file ASS
function parseAssEvents(text) {
  const events = [];
  let section = "";
  let format = null;
  const lines = String(text || "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) {
      section = sec[1].toLowerCase();
      format = null;
      continue;
    }
    if (section !== "events") continue;
    if (/^format\s*:/i.test(line)) {
      format = line
        .slice(line.indexOf(":") + 1)
        .split(",")
        .map((s) => s.trim().toLowerCase());
      continue;
    }
    if (!/^dialogue\s*:/i.test(line)) continue;
    const fmt = format || DEFAULT_EVENT_FORMAT;
    let rest = line.slice(line.indexOf(":") + 1).replace(/^\s/, "");
    const parts = [];
    for (let i = 0; i < fmt.length - 1; i++) {
      const idx = rest.indexOf(",");
      if (idx < 0) {
        parts.push(rest);
        rest = "";
      } else {
        parts.push(rest.slice(0, idx));
        rest = rest.slice(idx + 1);
      }
    }
    parts.push(rest);
    const o = {};
    fmt.forEach((f, i) => (o[f] = parts[i]));
    events.push({
      start: assTime(o.start),
      end: assTime(o.end),
      layer: parseInt(o.layer || o.marked, 10) || 0,
      style: (o.style || "Default").trim().replace(/^\*/, ""),
      marginL: parseInt(o.marginl, 10) || 0,
      marginR: parseInt(o.marginr, 10) || 0,
      marginV: parseInt(o.marginv, 10) || 0,
      text: o.text || ""
    });
  }
  return events;
}

// Đọc cả file ASS: { meta, events }
function parseAss(text) {
  return { meta: parseAssHeader(text), events: parseAssEvents(text) };
}

function vttTime(sec) {
  const total = Math.max(0, Math.round(sec * 1000));
  const ms = total % 1000;
  const s = Math.floor(total / 1000) % 60;
  const m = Math.floor(total / 60000) % 60;
  const h = Math.floor(total / 3600000);
  const p = (v, n = 2) => String(v).padStart(n, "0");
  return `${p(h)}:${p(m)}:${p(s)}.${p(ms, 3)}`;
}

// events: [{ start, end (giây), text, style, layer, marginL, marginR, marginV }]
// Trả về chuỗi WebVTT; identifier của mỗi cue = "ass:" + JSON đã encodeURIComponent
function eventsToVtt(events) {
  const sorted = events.slice().sort((a, b) => a.start - b.start || (a.layer || 0) - (b.layer || 0));
  const out = ["WEBVTT", ""];
  for (const e of sorted) {
    if (!(e.end > e.start)) continue;
    const text = String(e.text === undefined || e.text === null ? "" : e.text)
      .replace(/\r?\n/g, "\\N")
      .replace(/-->/g, "--\u200b>");
    if (!text.trim()) continue;
    const info = {
      s: e.style || "Default",
      l: e.layer || 0,
      a: e.marginL || 0,
      b: e.marginR || 0,
      v: e.marginV || 0
    };
    out.push("ass:" + encodeURIComponent(JSON.stringify(info)));
    out.push(`${vttTime(e.start)} --> ${vttTime(e.end)}`);
    out.push(text);
    out.push("");
  }
  return out.join("\n");
}

// Đọc file phụ đề dạng Buffer, nhận diện BOM UTF-16 / UTF-8
function decodeText(buf) {
  if (!Buffer.isBuffer(buf)) return String(buf || "");
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString("utf16le").replace(/^\uFEFF/, "");
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.slice(2));
    swapped.swap16();
    return swapped.toString("utf16le");
  }
  return buf.toString("utf8").replace(/^\uFEFF/, "");
}

// Text có thẻ ASS (tìm thẻ override hoặc \N) -> nên đi đường ASS
const looksLikeAss = (text) => /\{\\|\\N/.test(String(text || ""));

module.exports = { parseAss, parseAssHeader, parseAssEvents, eventsToVtt, decodeText, looksLikeAss, assColor };
