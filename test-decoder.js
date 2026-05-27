'use strict';
// Node.js test harness for JSMpeg.Decoder.MPEG2Video
// Usage: node test-decoder.js [path/to/file.ts] [numFrames]
//
// Decodes N frames, prints chroma statistics, saves frame0_our.yuv (raw yuv422p Y+Cb+Cr).
// Then diffs against frame0_ffmpeg.yuv if it exists (generate with ffmpeg-ref.bat).

var vm  = require('vm');
var fs  = require('fs');
var cp  = require('child_process');

var tsPath     = process.argv[2] || 'vistek_test422.ts';
var wantFrames = parseInt(process.argv[3] || '5', 10);

// ── browser shims ──────────────────────────────────────────────────────────────
var ctx = vm.createContext({
  window:      { performance: { now: function() { return Date.now(); } } },
  document:    { addEventListener: function() {}, readyState: 'loading',
                 querySelectorAll: function() { return []; } },
  performance: { now: function() { return Date.now(); } },
  Uint8Array, Uint8ClampedArray, Int8Array, Int16Array,
  Uint16Array, Int32Array, Uint32Array,
  Float32Array, Float64Array, ArrayBuffer, DataView,
  console, Math, Date, JSON, isNaN, isFinite, parseInt, parseFloat,
  setTimeout: function(fn) { fn(); }, clearTimeout: function() {}
});

['src/jsmpeg.js','src/buffer.js','src/decoder.js','src/mpeg2.js','src/ts.js']
  .forEach(function(f) {
    vm.runInContext(fs.readFileSync(f, 'utf8'), ctx, { filename: f });
  });

var JSMpeg = ctx.JSMpeg;

// ── mock renderer ──────────────────────────────────────────────────────────────
var frames = [];
var lastResize = {};

var renderer = {
  resize: function(w, h, chromaFormat) {
    lastResize = { w: w, h: h, chromaFormat: chromaFormat };
    console.log('resize: ' + w + 'x' + h + '  chromaFormat=' + chromaFormat);
  },
  render: function(y, cr, cb) {
    // render(y, currentCr, currentCb) — Cr is 2nd arg, Cb is 3rd
    if (frames.length < wantFrames) {
      frames.push({
        y:  Buffer.from(y.buffer  || y),
        cr: Buffer.from(cr.buffer || cr),
        cb: Buffer.from(cb.buffer || cb)
      });
    }
  }
};

// ── pipeline ───────────────────────────────────────────────────────────────────
var decoder = new JSMpeg.Decoder.MPEG2Video({ streaming: true });
decoder.connect(renderer);

var demuxer = new JSMpeg.Demuxer.TS({});
demuxer.connect(JSMpeg.Demuxer.TS.STREAM.VIDEO_1, decoder);

// ── feed data ──────────────────────────────────────────────────────────────────
var data   = fs.readFileSync(tsPath);
var CHUNK  = 188 * 512;
var offset = 0;

while (frames.length < wantFrames && offset < data.length) {
  var end   = Math.min(offset + CHUNK, data.length);
  // slice gives an ArrayBuffer-backed Buffer; .buffer may have an offset, use subarray
  var chunk = data.buffer.slice(data.byteOffset + offset, data.byteOffset + end);
  demuxer.write(chunk);
  while (decoder.canPlay) {
    if (!decoder.decode()) break;
  }
  offset = end;
}

console.log('\nDecoded ' + frames.length + ' frame(s) from ' + tsPath + '\n');

// ── statistics ─────────────────────────────────────────────────────────────────
function stats(buf) {
  var sum = 0, min = 255, max = 0, zeros = 0;
  for (var i = 0; i < buf.length; i++) {
    var v = buf[i];
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
    if (v === 0) zeros++;
  }
  return {
    mean: (sum / buf.length).toFixed(1),
    min: min, max: max,
    zeroFrac: (zeros / buf.length * 100).toFixed(1)
  };
}

frames.forEach(function(f, i) {
  var sc = stats(f.cr), sb = stats(f.cb);
  console.log('Frame ' + i + ':');
  console.log('  Cr  mean=' + sc.mean + '  range=[' + sc.min + ',' + sc.max + ']  zeros=' + sc.zeroFrac + '%');
  console.log('  Cb  mean=' + sb.mean + '  range=[' + sb.min + ',' + sb.max + ']  zeros=' + sb.zeroFrac + '%');
});

// ── save frame 0 as raw yuv422p (Y then Cb then Cr) for ffmpeg comparison ─────
if (frames.length > 0) {
  var f0    = frames[0];
  // Our render() call is render(y, currentCr, currentCb)
  // yuv422p on disk is: Y plane, then Cb (U) plane, then Cr (V) plane
  var raw   = Buffer.concat([f0.y, f0.cb, f0.cr]);
  var outYuv = 'frame0_our.yuv';
  fs.writeFileSync(outYuv, raw);
  console.log('\nSaved ' + outYuv + ' (' + raw.length + ' bytes, yuv422p)');

  // ── diff against ffmpeg reference if it exists ───────────────────────────
  var refYuv = 'frame0_ffmpeg.yuv';
  if (fs.existsSync(refYuv)) {
    var ref = fs.readFileSync(refYuv);
    if (ref.length !== raw.length) {
      console.log('ERROR: reference size mismatch: ' + ref.length + ' vs ' + raw.length);
    } else {
      var w = lastResize.w || 640, h = lastResize.h || 360;
      var yLen  = w * h;
      var cLen  = (w >> 1) * h;   // 422: half-width, full-height
      var maxYErr = 0, maxCErr = 0, sumYErr = 0, sumCErr = 0;
      for (var i = 0; i < yLen; i++) {
        var e = Math.abs(raw[i] - ref[i]);
        sumYErr += e; if (e > maxYErr) maxYErr = e;
      }
      for (var i = yLen; i < raw.length; i++) {
        var e = Math.abs(raw[i] - ref[i]);
        sumCErr += e; if (e > maxCErr) maxCErr = e;
      }
      console.log('\nDiff vs ' + refYuv + ':');
      console.log('  Y  MAE=' + (sumYErr/yLen).toFixed(2) + '  maxErr=' + maxYErr);
      console.log('  UV MAE=' + (sumCErr/(cLen*2)).toFixed(2) + '  maxErr=' + maxCErr);
      console.log(maxYErr === 0 && maxCErr === 0 ? '  PERFECT MATCH' : '  (rounding in half-pel is expected; <=1 is fine)');
    }
  } else {
    console.log('\nTip: generate ffmpeg reference with:');
    console.log('  ffmpeg -i ' + tsPath + ' -frames:v 1 -f rawvideo -pix_fmt yuv422p -vsync 0 ' + refYuv);
  }
}
