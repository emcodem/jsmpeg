'use strict';
// Diagnostic: trace exact bit positions during MB0 and MB1 decoding
var vm  = require('vm');
var fs  = require('fs');

var tsPath = process.argv[2] || 'vistek_test.ts';

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
var MPEG2Proto = JSMpeg.Decoder.MPEG2Video.prototype;

// ── mock renderer that stops after frame 0 ──────────────────────────────────
var frameCount = 0;
var renderer = {
  resize: function(w, h, cf) { console.log('resize: ' + w + 'x' + h + ' cf=' + cf); },
  render: function() { frameCount++; }
};

// ── raw bytes hex dump helper ────────────────────────────────────────────────
function dumpBitsAt(bits, bitPos, numBytes) {
  var bytePos = bitPos >> 3;
  var bitOff  = bitPos & 7;
  var out = 'bytes[' + bytePos + '] (bit ' + bitPos + ', offset ' + bitOff + ' in byte): ';
  for (var i = 0; i < numBytes; i++) {
    var b = bits.bytes[bytePos + i];
    out += (b !== undefined ? ('0' + b.toString(16)).slice(-2) : '??') + ' ';
  }
  // also show as binary for the first 3 bytes
  out += ' | ';
  for (var i = 0; i < 3; i++) {
    var b = bits.bytes[bytePos + i];
    if (b !== undefined) out += ('0000000' + b.toString(2)).slice(-8) + ' ';
  }
  return out;
}

// ── patch decodeMacroblock to log bit positions ─────────────────────────────
var origMB = MPEG2Proto.decodeMacroblock;
var mbCount = 0;
var traceLimit = 3; // trace first N macroblocks of the first slice

MPEG2Proto.decodeMacroblock = function() {
  mbCount++;
  var before = this.bits.index;

  // Patch readHuffman just for this MB
  var origRH = MPEG2Proto.readHuffman;

  // Track calls within this MB
  var callLog = [];
  MPEG2Proto.readHuffman = function(table) {
    var b = this.bits.index;
    var result = origRH.call(this, table);
    var consumed = this.bits.index - b;
    callLog.push({ b: b, consumed: consumed, result: result });
    return result;
  };

  origMB.call(this);
  MPEG2Proto.readHuffman = origRH;

  var after = this.bits.index;

  if (mbCount <= traceLimit) {
    console.log('\n=== MB ' + (mbCount-1) + ' (addr=' + this.macroblockAddress +
                ' row=' + this.mbRow + ' col=' + this.mbCol + ') ===');
    console.log('  bits: ' + before + ' -> ' + after + '  (' + (after-before) + ' bits)');
    console.log('  ' + dumpBitsAt(this.bits, before, 8));
    console.log('  macroblockIntra=' + this.macroblockIntra +
                ' macroblockMotFw=' + this.macroblockMotFw +
                ' macroblockMotBw=' + this.macroblockMotBw);
    console.log('  readHuffman calls: ' + callLog.length);
    callLog.slice(0,5).forEach(function(c, i) {
      console.log('    [' + i + '] at bit ' + c.b + ': consumed=' + c.consumed +
                  ' result=0x' + (c.result >>> 0).toString(16));
    });
    if (callLog.length > 5) {
      var last = callLog[callLog.length-1];
      console.log('    ... last[' + (callLog.length-1) + '] at bit ' + last.b +
                  ': consumed=' + last.consumed + ' result=0x' + (last.result>>>0).toString(16));
    }
  }
};

// ── patch decodeBlock to log bit positions ──────────────────────────────────
var origBlock = MPEG2Proto.decodeBlock;
var blockInMB = 0;
var mbInSlice = 0;

MPEG2Proto.decodeBlock = function(block) {
  blockInMB = block;
  if (mbInSlice < traceLimit) {
    var before = this.bits.index;
    origBlock.call(this, block);
    var after = this.bits.index;
    console.log('  Block ' + block + ': bits ' + before + '->' + after +
                ' (' + (after-before) + ' bits)');
  } else {
    origBlock.call(this, block);
  }
};

// ── patch decodeSlice to reset per-slice counters ───────────────────────────
var origSlice = MPEG2Proto.decodeSlice;
MPEG2Proto.decodeSlice = function(slice) {
  mbInSlice = 0;
  mbCount = 0;
  console.log('\n--- Slice ' + slice + ' at bit ' + this.bits.index + ' ---');
  // Only trace the first slice
  origSlice.call(this, slice);
  mbInSlice = 999; // disable tracing after first slice
};

// Also wrap the inner MB call to count per-slice
var origMB2 = MPEG2Proto.decodeMacroblock;
MPEG2Proto.decodeMacroblock = function() {
  origMB2.call(this);
  mbInSlice++;
};

// ── pipeline ────────────────────────────────────────────────────────────────
var decoder = new JSMpeg.Decoder.MPEG2Video({ streaming: true });
decoder.connect(renderer);

var demuxer = new JSMpeg.Demuxer.TS({});
demuxer.connect(JSMpeg.Demuxer.TS.STREAM.VIDEO_1, decoder);

var data   = fs.readFileSync(tsPath);
var CHUNK  = 188 * 512;
var offset = 0;

while (frameCount < 1 && offset < data.length) {
  var end   = Math.min(offset + CHUNK, data.length);
  var chunk = data.buffer.slice(data.byteOffset + offset, data.byteOffset + end);
  demuxer.write(chunk);
  while (decoder.canPlay) {
    if (!decoder.decode()) break;
    if (frameCount >= 1) break;
  }
  offset = end;
}

console.log('\nDone. mbCount=' + mbCount);
