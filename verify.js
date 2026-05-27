'use strict';
// Decode N frames live, diff each plane against an ffmpeg raw reference.
// Auto-detects chroma format (4:2:0 vs 4:2:2) from the decoder.
// Usage: node verify.js <file.ts> <ref.yuv> <N>
var vm = require('vm');
var fs = require('fs');

var tsPath  = process.argv[2] || 'vistek_test422.ts';
var refPath = process.argv[3] || 'frames_ffmpeg.yuv';
var wantN   = parseInt(process.argv[4] || '5', 10);

var ctx = vm.createContext({
  window: { performance: { now: function() { return Date.now(); } } },
  document: { addEventListener: function() {}, readyState: 'loading',
              querySelectorAll: function() { return []; } },
  performance: { now: function() { return Date.now(); } },
  Uint8Array, Uint8ClampedArray, Int8Array, Int16Array,
  Uint16Array, Int32Array, Uint32Array,
  Float32Array, Float64Array, ArrayBuffer, DataView,
  console, Math, Date, JSON, isNaN, isFinite, parseInt, parseFloat,
  setTimeout: function(fn) { fn(); }, clearTimeout: function() {}
});
['src/jsmpeg.js','src/buffer.js','src/decoder.js','src/mpeg2.js','src/ts.js']
  .forEach(function(f) { vm.runInContext(fs.readFileSync(f, 'utf8'), ctx, { filename: f }); });
var JSMpeg = ctx.JSMpeg;

var frames = [], types = [];
var decoder = new JSMpeg.Decoder.MPEG2Video({ streaming: true });
decoder.connect({
  resize: function(w, h, c) { this.w = w; this.h = h; this.c = c; },
  render: function(y, cr, cb) {
    if (frames.length < wantN)
      frames.push({ y: Uint8ClampedArray.from(y), cr: Uint8ClampedArray.from(cr), cb: Uint8ClampedArray.from(cb) });
  }
});
var P = JSMpeg.Decoder.MPEG2Video.prototype;
var origPic = P.decodePicture;
P.decodePicture = function() { origPic.call(this); types.push(this.pictureType); };

var demuxer = new JSMpeg.Demuxer.TS({});
demuxer.connect(JSMpeg.Demuxer.TS.STREAM.VIDEO_1, decoder);
var data = fs.readFileSync(tsPath);
var CHUNK = 188 * 512, off = 0;
while (frames.length < wantN && off < data.length) {
  var end = Math.min(off + CHUNK, data.length);
  demuxer.write(data.buffer.slice(data.byteOffset + off, data.byteOffset + end));
  while (decoder.canPlay && decoder.decode()) {}
  off = end;
}

var W = decoder.codedWidth, cW = decoder.halfWidth;     // our coded strides
var dW = decoder.width, dH = decoder.height;            // display size
var chroma = decoder.chromaFormat;                       // 1=420, 2=422
var refCW = dW >> 1;
var refCH = (chroma === 2) ? dH : (dH >> 1);
var ourCH = (chroma === 2) ? dH : (dH >> 1);
var refYLen = dW * dH, refCLen = refCW * refCH;
var frameSize = refYLen + 2 * refCLen;

var ref = fs.readFileSync(refPath);
console.log('chroma=' + (chroma === 2 ? '4:2:2' : '4:2:0') + '  display ' + dW + 'x' + dH +
  '  decoded ' + frames.length + ' frames, ref has ' + (ref.length / frameSize));

function diff(our, ourStride, refBuf, refOff, refStride, w, h) {
  var sum = 0, max = 0, n = 0;
  for (var r = 0; r < h; r++) for (var c = 0; c < w; c++) {
    var e = Math.abs(our[r*ourStride + c] - refBuf[refOff + r*refStride + c]);
    sum += e; if (e > max) max = e; n++;
  }
  return { mae: sum/n, max: max };
}

for (var i = 0; i < frames.length; i++) {
  var f = frames[i], base = i * frameSize;
  var sy = diff(f.y,  W,  ref, base,                    dW,    dW,    dH);
  var sb = diff(f.cb, cW, ref, base + refYLen,          refCW, refCW, refCH);
  var sr = diff(f.cr, cW, ref, base + refYLen + refCLen, refCW, refCW, refCH);
  console.log('Frame ' + i + ' type=' + types[i] +
    '  Y MAE=' + sy.mae.toFixed(2) + ' max=' + sy.max +
    '  Cb MAE=' + sb.mae.toFixed(2) + ' max=' + sb.max +
    '  Cr MAE=' + sr.mae.toFixed(2) + ' max=' + sr.max);
}
