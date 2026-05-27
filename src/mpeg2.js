JSMpeg.Decoder.MPEG2Video = (function(){ "use strict";

var MPEG2 = function(options) {
	JSMpeg.Decoder.Base.call(this, options);

	this.onDecodeCallback = options.onVideoDecode;

	var bufferSize = options.videoBufferSize || 512*1024;
	var bufferMode = options.streaming
		? JSMpeg.BitBuffer.MODE.EVICT
		: JSMpeg.BitBuffer.MODE.EXPAND;

	this.bits = new JSMpeg.BitBuffer(bufferSize, bufferMode);

	this.customIntraQuantMatrix = new Uint8Array(64);
	this.customNonIntraQuantMatrix = new Uint8Array(64);
	this.blockData = new Int32Array(64);

	this.currentFrame = 0;
	this.decodeFirstFrame = options.decodeFirstFrame !== false;
	this.hasHeldAnchor = false; // display-reorder: whether an I/P anchor is held back

	// MPEG-2 specific state
	this.isMPEG2 = false;
	this.chromaFormat = 1; // 1=4:2:0, 2=4:2:2, 3=4:4:4
	this.progressiveSequence = true;
	this.intraDcPrecision = 0;
	this.pictureStructure = 3; // FRAME_PICTURE
	this.framePredFrameDct = true;
	this.concealmentMotionVectors = false;
	this.qScaleType = false;
	this.intraVlcFormat = false;
	this.alternateScan = false;

	// fCode[direction][component]: direction 0=fwd, 1=bwd; component 0=H, 1=V
	this.fCode = [[1, 1], [1, 1]];
};

MPEG2.prototype = Object.create(JSMpeg.Decoder.Base.prototype);
MPEG2.prototype.constructor = MPEG2;

MPEG2.prototype.write = function(pts, buffers) {
	JSMpeg.Decoder.Base.prototype.write.call(this, pts, buffers);

	if (!this.hasSequenceHeader) {
		if (this.bits.findStartCode(MPEG2.START.SEQUENCE) === -1) {
			return false;
		}
		this.decodeSequenceHeader();

		if (this.decodeFirstFrame) {
			this.decode();
		}
	}
};

MPEG2.prototype.decode = function() {
	var startTime = JSMpeg.Now();

	if (!this.hasSequenceHeader) {
		return false;
	}

	if (this.bits.findStartCode(MPEG2.START.PICTURE) === -1) {
		return false;
	}

	this.decodePicture();
	this.advanceDecodedTime(1/this.frameRate);

	var elapsedTime = JSMpeg.Now() - startTime;
	if (this.onDecodeCallback) {
		this.onDecodeCallback(this, elapsedTime);
	}
	return true;
};

MPEG2.prototype.readHuffman = function(codeTable) {
	var state = 0;
	do {
		state = codeTable[state + this.bits.read(1)];
	} while (state >= 0 && codeTable[state] !== 0);
	return codeTable[state+2];
};


// Sequence Layer

MPEG2.prototype.frameRate = 30;
MPEG2.prototype.decodeSequenceHeader = function() {
	var newWidth = this.bits.read(12),
		newHeight = this.bits.read(12);

	// skip pixel aspect ratio
	this.bits.skip(4);

	this.frameRate = MPEG2.PICTURE_RATE[this.bits.read(4)];

	// skip bitRate, marker, bufferSize and constrained bit
	this.bits.skip(18 + 1 + 10 + 1);

	if (this.bits.read(1)) { // load custom intra quant matrix?
		for (var i = 0; i < 64; i++) {
			this.customIntraQuantMatrix[MPEG2.ZIG_ZAG[i]] = this.bits.read(8);
		}
		this.intraQuantMatrix = this.customIntraQuantMatrix;
	}

	if (this.bits.read(1)) { // load custom non intra quant matrix?
		for (var i = 0; i < 64; i++) {
			this.customNonIntraQuantMatrix[MPEG2.ZIG_ZAG[i]] = this.bits.read(8);
		}
		this.nonIntraQuantMatrix = this.customNonIntraQuantMatrix;
	}

	// Check for MPEG-2 sequence_extension immediately after sequence header
	var nextCode = this.bits.findNextStartCode();
	if (nextCode === MPEG2.START.EXTENSION) {
		var extId = this.bits.read(4);
		if (extId === 0x01) {
			this.decodeSequenceExtension();
		}
		// Other extension IDs are skipped; decode() will scan forward as needed
	} else if (nextCode !== -1) {
		this.bits.rewind(32);
	}

	if (newWidth !== this.width || newHeight !== this.height) {
		this.width = newWidth;
		this.height = newHeight;

		this.initBuffers();

		if (this.destination) {
			this.destination.resize(newWidth, newHeight, this.chromaFormat);
		}
	}

	this.hasSequenceHeader = true;
};

MPEG2.prototype.decodeSequenceExtension = function() {
	this.isMPEG2 = true;

	// profile_and_level_indication
	this.bits.skip(8);

	this.progressiveSequence = this.bits.read(1);
	this.chromaFormat = this.bits.read(2); // 1=4:2:0, 2=4:2:2

	// horizontal_size_extension (2 bits) and vertical_size_extension (2 bits)
	// extend the 12-bit width/height from the sequence header
	this.bits.skip(2 + 2);

	// bit_rate_extension, marker, vbv_buffer_size_extension, low_delay
	this.bits.skip(12 + 1 + 8 + 1);

	// frame_rate_extension_n (2 bits) and frame_rate_extension_d (5 bits)
	// could adjust frameRate but we skip for simplicity
	this.bits.skip(2 + 5);
};

MPEG2.prototype.initBuffers = function() {
	this.intraQuantMatrix = MPEG2.DEFAULT_INTRA_QUANT_MATRIX;
	this.nonIntraQuantMatrix = MPEG2.DEFAULT_NON_INTRA_QUANT_MATRIX;

	this.mbWidth = (this.width + 15) >> 4;
	this.mbHeight = (this.height + 15) >> 4;
	this.mbSize = this.mbWidth * this.mbHeight;

	this.codedWidth = this.mbWidth << 4;
	this.codedHeight = this.mbHeight << 4;
	this.codedSize = this.codedWidth * this.codedHeight;

	this.halfWidth = this.mbWidth << 3;
	this.halfHeight = this.mbHeight << 3;

	var chromaSize = this.chromaFormat === 2 ? (this.codedSize >> 1) : (this.codedSize >> 2);

	this.currentY = new Uint8ClampedArray(this.codedSize);
	this.currentY32 = new Uint32Array(this.currentY.buffer);
	this.currentCr = new Uint8ClampedArray(chromaSize);
	this.currentCr32 = new Uint32Array(this.currentCr.buffer);
	this.currentCb = new Uint8ClampedArray(chromaSize);
	this.currentCb32 = new Uint32Array(this.currentCb.buffer);

	this.forwardY = new Uint8ClampedArray(this.codedSize);
	this.forwardY32 = new Uint32Array(this.forwardY.buffer);
	this.forwardCr = new Uint8ClampedArray(chromaSize);
	this.forwardCr32 = new Uint32Array(this.forwardCr.buffer);
	this.forwardCb = new Uint8ClampedArray(chromaSize);
	this.forwardCb32 = new Uint32Array(this.forwardCb.buffer);

	// Third buffer set for B-frame bidirectional prediction
	this.backwardY = new Uint8ClampedArray(this.codedSize);
	this.backwardY32 = new Uint32Array(this.backwardY.buffer);
	this.backwardCr = new Uint8ClampedArray(chromaSize);
	this.backwardCr32 = new Uint32Array(this.backwardCr.buffer);
	this.backwardCb = new Uint8ClampedArray(chromaSize);
	this.backwardCb32 = new Uint32Array(this.backwardCb.buffer);
};


// Picture Layer

MPEG2.prototype.currentY = null;
MPEG2.prototype.currentCr = null;
MPEG2.prototype.currentCb = null;

MPEG2.prototype.pictureType = 0;

MPEG2.prototype.forwardY = null;
MPEG2.prototype.forwardCr = null;
MPEG2.prototype.forwardCb = null;

MPEG2.prototype.backwardY = null;
MPEG2.prototype.backwardCr = null;
MPEG2.prototype.backwardCb = null;

MPEG2.prototype.fullPelForward = false;
MPEG2.prototype.forwardFCode = 1;
MPEG2.prototype.forwardRSize = 0;
MPEG2.prototype.forwardF = 1;

MPEG2.prototype.decodePicture = function() {
	this.currentFrame++;

	this.bits.skip(10); // temporal_reference
	this.pictureType = this.bits.read(3);
	this.bits.skip(16); // vbv_delay

	if (this.pictureType <= 0 || this.pictureType > MPEG2.PICTURE_TYPE.B) {
		return;
	}

	if (!this.isMPEG2) {
		// MPEG-1: full_pel and f_code are in the picture header
		if (this.pictureType === MPEG2.PICTURE_TYPE.PREDICTIVE) {
			this.fullPelForward = this.bits.read(1);
			var fcode = this.bits.read(3);
			if (fcode === 0) { return; }
			this.fCode[0][0] = this.fCode[0][1] = fcode;
			this.forwardFCode = fcode;
			this.forwardRSize = fcode - 1;
			this.forwardF = 1 << this.forwardRSize;
		}
		if (this.pictureType === MPEG2.PICTURE_TYPE.B) {
			return; // B-frames not supported in MPEG-1 mode
		}

		var code;
		do {
			code = this.bits.findNextStartCode();
		} while (code === MPEG2.START.EXTENSION || code === MPEG2.START.USER_DATA);

		while (code >= MPEG2.START.SLICE_FIRST && code <= MPEG2.START.SLICE_LAST) {
			this.decodeSlice(code & 0xFF);
			code = this.bits.findNextStartCode();
		}
		if (code !== -1) { this.bits.rewind(32); }

	} else {
		// MPEG-2: skip to picture_coding_extension
		var code;
		do {
			code = this.bits.findNextStartCode();
		} while (code === MPEG2.START.USER_DATA);

		if (code === MPEG2.START.EXTENSION) {
			var extId = this.bits.read(4);
			if (extId === 0x08) {
				this.decodePictureCodingExtension();
			}
			// Skip remaining extensions/user_data before slices
			do {
				code = this.bits.findNextStartCode();
			} while (code === MPEG2.START.EXTENSION || code === MPEG2.START.USER_DATA);
		}

		while (code >= MPEG2.START.SLICE_FIRST && code <= MPEG2.START.SLICE_LAST) {
			this.decodeSlice(code & 0xFF);
			code = this.bits.findNextStartCode();
		}
		if (code !== -1) { this.bits.rewind(32); }
	}

	// Display reordering (decode order -> display order).
	// B-frames are displayed immediately. I/P anchors are held back by one:
	// when a new anchor is decoded, the previously-held anchor (now in the
	// forward buffers) is displayed first, then this frame becomes the new
	// held anchor. This yields correct display order without needing
	// temporal_reference, and survives irregular GOPs. The B-frames between two
	// anchors never overwrite the forward buffers, so the held anchor stays
	// valid until the next anchor arrives.
	if (
		this.pictureType === MPEG2.PICTURE_TYPE.INTRA ||
		this.pictureType === MPEG2.PICTURE_TYPE.PREDICTIVE
	) {
		// Display the previously-held anchor before rotating this one in.
		if (this.destination && this.hasHeldAnchor) {
			this.destination.render(this.forwardY, this.forwardCr, this.forwardCb, true);
		}
		this.hasHeldAnchor = true;

		// Rotate reference buffers: current I/P becomes the new forward anchor.
		var tmpY   = this.backwardY,   tmpY32   = this.backwardY32;
		var tmpCr  = this.backwardCr,  tmpCr32  = this.backwardCr32;
		var tmpCb  = this.backwardCb,  tmpCb32  = this.backwardCb32;

		this.backwardY   = this.forwardY;   this.backwardY32   = this.forwardY32;
		this.backwardCr  = this.forwardCr;  this.backwardCr32  = this.forwardCr32;
		this.backwardCb  = this.forwardCb;  this.backwardCb32  = this.forwardCb32;

		this.forwardY   = this.currentY;   this.forwardY32   = this.currentY32;
		this.forwardCr  = this.currentCr;  this.forwardCr32  = this.currentCr32;
		this.forwardCb  = this.currentCb;  this.forwardCb32  = this.currentCb32;

		this.currentY   = tmpY;   this.currentY32   = tmpY32;
		this.currentCr  = tmpCr;  this.currentCr32  = tmpCr32;
		this.currentCb  = tmpCb;  this.currentCb32  = tmpCb32;
	} else if (this.destination) {
		// B-frame: display immediately, no reference rotation.
		this.destination.render(this.currentY, this.currentCr, this.currentCb, true);
	}
};

MPEG2.prototype.decodePictureCodingExtension = function() {
	this.fCode[0][0] = this.bits.read(4); // forward horizontal
	this.fCode[0][1] = this.bits.read(4); // forward vertical
	this.fCode[1][0] = this.bits.read(4); // backward horizontal
	this.fCode[1][1] = this.bits.read(4); // backward vertical

	this.intraDcPrecision      = this.bits.read(2);
	this.pictureStructure      = this.bits.read(2);
	this.bits.skip(1);                                  // top_field_first
	this.framePredFrameDct     = this.bits.read(1);
	this.concealmentMotionVectors = this.bits.read(1);
	this.qScaleType            = this.bits.read(1);
	this.intraVlcFormat        = this.bits.read(1);
	this.alternateScan         = this.bits.read(1);
	this.bits.skip(1 + 1 + 1);                         // repeat_first_field, chroma_420_type, progressive_frame
};


// Slice Layer

MPEG2.prototype.quantizerScale = 0;
MPEG2.prototype.sliceBegin = false;

MPEG2.prototype.decodeSlice = function(slice) {
	this.sliceBegin = true;
	this.macroblockAddress = (slice - 1) * this.mbWidth - 1;

	// Reset motion vectors and DC predictors
	this.motionFwH = this.motionFwHPrev = 0;
	this.motionFwV = this.motionFwVPrev = 0;
	this.motionBwH = this.motionBwHPrev = 0;
	this.motionBwV = this.motionBwVPrev = 0;

	var dcInit = 128 << this.intraDcPrecision;
	this.dcPredictorY  = dcInit;
	this.dcPredictorCr = dcInit;
	this.dcPredictorCb = dcInit;

	var qsCode = this.bits.read(5);
	this.quantizerScale = this.qScaleType
		? MPEG2.NON_LINEAR_QUANTIZER_SCALE[qsCode]
		: qsCode;

	// skip extra slice data (handles both MPEG-1 extra_bit_slice and MPEG-2 intra_slice_flag)
	while (this.bits.read(1)) {
		this.bits.skip(8);
	}

	do {
		this.decodeMacroblock();
	} while (!this.bits.nextBytesAreStartCode());
};


// Macroblock Layer

MPEG2.prototype.macroblockAddress = 0;
MPEG2.prototype.mbRow = 0;
MPEG2.prototype.mbCol = 0;

MPEG2.prototype.macroblockType = 0;
MPEG2.prototype.macroblockIntra = false;
MPEG2.prototype.macroblockMotFw = false;
MPEG2.prototype.macroblockMotBw = false;

MPEG2.prototype.motionFwH = 0;
MPEG2.prototype.motionFwV = 0;
MPEG2.prototype.motionFwHPrev = 0;
MPEG2.prototype.motionFwVPrev = 0;
MPEG2.prototype.motionBwH = 0;
MPEG2.prototype.motionBwV = 0;
MPEG2.prototype.motionBwHPrev = 0;
MPEG2.prototype.motionBwVPrev = 0;

MPEG2.prototype.decodeMacroblock = function() {
	var increment = 0,
		t = this.readHuffman(MPEG2.MACROBLOCK_ADDRESS_INCREMENT);

	while (t === 34) {
		t = this.readHuffman(MPEG2.MACROBLOCK_ADDRESS_INCREMENT);
	}
	while (t === 35) {
		increment += 33;
		t = this.readHuffman(MPEG2.MACROBLOCK_ADDRESS_INCREMENT);
	}
	increment += t;

	if (this.sliceBegin) {
		this.sliceBegin = false;
		this.macroblockAddress += increment;
	} else {
		if (this.macroblockAddress + increment >= this.mbSize) {
			return;
		}
		if (increment > 1) {
			this.dcPredictorY  = 128 << this.intraDcPrecision;
			this.dcPredictorCr = 128 << this.intraDcPrecision;
			this.dcPredictorCb = 128 << this.intraDcPrecision;

			if (this.pictureType === MPEG2.PICTURE_TYPE.PREDICTIVE) {
				this.motionFwH = this.motionFwHPrev = 0;
				this.motionFwV = this.motionFwVPrev = 0;
			}
		}

		// Predict skipped macroblocks
		while (increment > 1) {
			this.macroblockAddress++;
			this.mbRow = (this.macroblockAddress / this.mbWidth)|0;
			this.mbCol = this.macroblockAddress % this.mbWidth;

			if (this.pictureType === MPEG2.PICTURE_TYPE.B) {
				// B-frame skipped: copy using previous motion vectors
				if (this.macroblockMotFw) {
					this.copyMacroblock(
						this.motionFwH, this.motionFwV,
						this.backwardY, this.backwardCr, this.backwardCb
					);
				}
				if (this.macroblockMotBw) {
					if (this.macroblockMotFw) {
						this.copyMacroblockInterpolated(
							this.motionFwH, this.motionFwV,
							this.motionBwH, this.motionBwV
						);
					} else {
						this.copyMacroblock(
							this.motionBwH, this.motionBwV,
							this.forwardY, this.forwardCr, this.forwardCb
						);
					}
				}
			} else {
				this.copyMacroblock(
					this.motionFwH, this.motionFwV,
					this.forwardY, this.forwardCr, this.forwardCb
				);
			}
			increment--;
		}
		this.macroblockAddress++;
	}
	this.mbRow = (this.macroblockAddress / this.mbWidth)|0;
	this.mbCol = this.macroblockAddress % this.mbWidth;

	var mbTable = MPEG2.MACROBLOCK_TYPE[this.pictureType];
	this.macroblockType = this.readHuffman(mbTable);
	this.macroblockIntra = (this.macroblockType & 0x01);
	this.macroblockMotFw = (this.macroblockType & 0x08);
	this.macroblockMotBw = (this.macroblockType & 0x04);

	if ((this.macroblockType & 0x10) !== 0) {
		var qsCode = this.bits.read(5);
		this.quantizerScale = this.qScaleType
			? MPEG2.NON_LINEAR_QUANTIZER_SCALE[qsCode]
			: qsCode;
	}

	if (this.macroblockIntra) {
		this.motionFwH = this.motionFwHPrev = 0;
		this.motionFwV = this.motionFwVPrev = 0;
		this.motionBwH = this.motionBwHPrev = 0;
		this.motionBwV = this.motionBwVPrev = 0;
	} else {
		this.dcPredictorY  = 128 << this.intraDcPrecision;
		this.dcPredictorCr = 128 << this.intraDcPrecision;
		this.dcPredictorCb = 128 << this.intraDcPrecision;

		if (this.pictureType === MPEG2.PICTURE_TYPE.B) {
			// B-frame: decode forward and/or backward motion vectors
			if (this.macroblockMotFw) {
				this.decodeMotionVectorsFwd();
			}
			if (this.macroblockMotBw) {
				this.decodeMotionVectorsBwd();
			}

			if (this.macroblockMotFw && this.macroblockMotBw) {
				this.copyMacroblockInterpolated(
					this.motionFwH, this.motionFwV,
					this.motionBwH, this.motionBwV
				);
			} else if (this.macroblockMotFw) {
				// forward motion uses backward ref (past anchor)
				this.copyMacroblock(
					this.motionFwH, this.motionFwV,
					this.backwardY, this.backwardCr, this.backwardCb
				);
			} else if (this.macroblockMotBw) {
				// backward motion uses forward ref (future anchor)
				this.copyMacroblock(
					this.motionBwH, this.motionBwV,
					this.forwardY, this.forwardCr, this.forwardCb
				);
			}
		} else {
			// I or P frame
			this.decodeMotionVectorsFwd();
			this.copyMacroblock(
				this.motionFwH, this.motionFwV,
				this.forwardY, this.forwardCr, this.forwardCb
			);
		}
	}

	var cbp;
	if ((this.macroblockType & 0x02) !== 0) {
		cbp = this.readHuffman(MPEG2.CODE_BLOCK_PATTERN);
		if (this.chromaFormat === 2) {
			cbp = (cbp << 2) | this.bits.read(2);
		}
	} else {
		cbp = this.macroblockIntra ? (this.chromaFormat === 2 ? 0xff : 0x3f) : 0;
	}

	var numBlocks = this.chromaFormat === 2 ? 8 : 6;
	for (var block = 0, mask = (numBlocks === 8 ? 0x80 : 0x20); block < numBlocks; block++) {
		if ((cbp & mask) !== 0) {
			this.decodeBlock(block);
		}
		mask >>= 1;
	}
};


MPEG2.prototype.decodeMotionVectorsFwd = function() {
	var fCodeH, fCodeV, rSizeH, rSizeV, fH, fV;

	if (this.macroblockMotFw || this.pictureType === MPEG2.PICTURE_TYPE.PREDICTIVE) {
		fCodeH = this.fCode[0][0];
		fCodeV = this.fCode[0][1];
		rSizeH = fCodeH - 1;
		rSizeV = fCodeV - 1;
		fH = 1 << rSizeH;
		fV = 1 << rSizeV;
	}

	if (!this.macroblockMotFw) {
		if (this.pictureType === MPEG2.PICTURE_TYPE.PREDICTIVE) {
			this.motionFwH = this.motionFwHPrev = 0;
			this.motionFwV = this.motionFwVPrev = 0;
		}
		return;
	}

	var code, r = 0, d;

	// Horizontal
	code = this.readHuffman(MPEG2.MOTION);
	if (code !== 0 && fH !== 1) {
		r = this.bits.read(rSizeH);
		d = ((Math.abs(code) - 1) << rSizeH) + r + 1;
		if (code < 0) { d = -d; }
	} else {
		d = code;
	}
	this.motionFwHPrev += d;
	if (this.motionFwHPrev > (fH << 4) - 1) { this.motionFwHPrev -= fH << 5; }
	else if (this.motionFwHPrev < -(fH << 4)) { this.motionFwHPrev += fH << 5; }
	this.motionFwH = this.motionFwHPrev;
	if (!this.isMPEG2 && this.fullPelForward) { this.motionFwH <<= 1; }

	// Vertical
	code = this.readHuffman(MPEG2.MOTION);
	if (code !== 0 && fV !== 1) {
		r = this.bits.read(rSizeV);
		d = ((Math.abs(code) - 1) << rSizeV) + r + 1;
		if (code < 0) { d = -d; }
	} else {
		d = code;
	}
	this.motionFwVPrev += d;
	if (this.motionFwVPrev > (fV << 4) - 1) { this.motionFwVPrev -= fV << 5; }
	else if (this.motionFwVPrev < -(fV << 4)) { this.motionFwVPrev += fV << 5; }
	this.motionFwV = this.motionFwVPrev;
	if (!this.isMPEG2 && this.fullPelForward) { this.motionFwV <<= 1; }
};

MPEG2.prototype.decodeMotionVectorsBwd = function() {
	if (!this.macroblockMotBw) { return; }

	var fCodeH = this.fCode[1][0];
	var fCodeV = this.fCode[1][1];
	var rSizeH = fCodeH - 1;
	var rSizeV = fCodeV - 1;
	var fH = 1 << rSizeH;
	var fV = 1 << rSizeV;

	var code, r = 0, d;

	// Horizontal
	code = this.readHuffman(MPEG2.MOTION);
	if (code !== 0 && fH !== 1) {
		r = this.bits.read(rSizeH);
		d = ((Math.abs(code) - 1) << rSizeH) + r + 1;
		if (code < 0) { d = -d; }
	} else {
		d = code;
	}
	this.motionBwHPrev += d;
	if (this.motionBwHPrev > (fH << 4) - 1) { this.motionBwHPrev -= fH << 5; }
	else if (this.motionBwHPrev < -(fH << 4)) { this.motionBwHPrev += fH << 5; }
	this.motionBwH = this.motionBwHPrev;

	// Vertical
	code = this.readHuffman(MPEG2.MOTION);
	if (code !== 0 && fV !== 1) {
		r = this.bits.read(rSizeV);
		d = ((Math.abs(code) - 1) << rSizeV) + r + 1;
		if (code < 0) { d = -d; }
	} else {
		d = code;
	}
	this.motionBwVPrev += d;
	if (this.motionBwVPrev > (fV << 4) - 1) { this.motionBwVPrev -= fV << 5; }
	else if (this.motionBwVPrev < -(fV << 4)) { this.motionBwVPrev += fV << 5; }
	this.motionBwV = this.motionBwVPrev;
};

MPEG2.prototype.copyMacroblock = function(motionH, motionV, sY, sCr, sCb) {
	var
		width, scan,
		H, V, oddH, oddV,
		src, dest, last;

	var dY = this.currentY32,
		dCb = this.currentCb32,
		dCr = this.currentCr32;

	// Luminance
	width = this.codedWidth;
	scan = width - 16;

	H = motionH >> 1;
	V = motionV >> 1;
	oddH = (motionH & 1) === 1;
	oddV = (motionV & 1) === 1;

	src = ((this.mbRow << 4) + V) * width + (this.mbCol << 4) + H;
	dest = (this.mbRow * width + this.mbCol) << 2;
	last = dest + (width << 2);

	var x, y1, y2, y;
	if (oddH) {
		if (oddV) {
			while (dest < last) {
				y1 = sY[src] + sY[src+width]; src++;
				for (x = 0; x < 4; x++) {
					y2 = sY[src] + sY[src+width]; src++;
					y = (((y1 + y2 + 2) >> 2) & 0xff);
					y1 = sY[src] + sY[src+width]; src++;
					y |= (((y1 + y2 + 2) << 6) & 0xff00);
					y2 = sY[src] + sY[src+width]; src++;
					y |= (((y1 + y2 + 2) << 14) & 0xff0000);
					y1 = sY[src] + sY[src+width]; src++;
					y |= (((y1 + y2 + 2) << 22) & 0xff000000);
					dY[dest++] = y;
				}
				dest += scan >> 2; src += scan-1;
			}
		} else {
			while (dest < last) {
				y1 = sY[src++];
				for (x = 0; x < 4; x++) {
					y2 = sY[src++];
					y = (((y1 + y2 + 1) >> 1) & 0xff);
					y1 = sY[src++];
					y |= (((y1 + y2 + 1) << 7) & 0xff00);
					y2 = sY[src++];
					y |= (((y1 + y2 + 1) << 15) & 0xff0000);
					y1 = sY[src++];
					y |= (((y1 + y2 + 1) << 23) & 0xff000000);
					dY[dest++] = y;
				}
				dest += scan >> 2; src += scan-1;
			}
		}
	} else {
		if (oddV) {
			while (dest < last) {
				for (x = 0; x < 4; x++) {
					y = (((sY[src] + sY[src+width] + 1) >> 1) & 0xff); src++;
					y |= (((sY[src] + sY[src+width] + 1) << 7) & 0xff00); src++;
					y |= (((sY[src] + sY[src+width] + 1) << 15) & 0xff0000); src++;
					y |= (((sY[src] + sY[src+width] + 1) << 23) & 0xff000000); src++;
					dY[dest++] = y;
				}
				dest += scan >> 2; src += scan;
			}
		} else {
			while (dest < last) {
				for (x = 0; x < 4; x++) {
					y = sY[src]; src++;
					y |= sY[src] << 8; src++;
					y |= sY[src] << 16; src++;
					y |= sY[src] << 24; src++;
					dY[dest++] = y;
				}
				dest += scan >> 2; src += scan;
			}
		}
	}

	// Chrominance
	width = this.halfWidth;
	scan = width - 8;

	if (this.chromaFormat === 2) {
		// 4:2:2: 16 chroma rows per MB, no extra vertical halving of motion vector
		// Horizontal chroma MV = motionH/2 truncated toward zero (ISO 13818-2,
		// matching ffmpeg's `mx = motion_x / 2`). JS float-divide then bitwise op
		// truncates toward zero; `>>` would floor toward -infinity and misplace
		// the half-pel for negative motion vectors.
		var cH = (motionH / 2) >> 1;
		var cV = motionV >> 1;
		var cOddH = ((motionH / 2) & 1) === 1;
		var cOddV = (motionV & 1) === 1;
		var cSrc = ((this.mbRow << 4) + cV) * width + (this.mbCol << 3) + cH;
		var cDest = (this.mbRow << 4) * width + (this.mbCol << 3);
		var cLast = cDest + (width << 4);
		var dCrB = this.currentCr, dCbB = this.currentCb;
		if (cOddH && cOddV) {
			while (cDest < cLast) {
				for (var xi = 0; xi < 8; xi++, cSrc++, cDest++) {
					dCrB[cDest] = (sCr[cSrc]+sCr[cSrc+1]+sCr[cSrc+width]+sCr[cSrc+width+1]+2)>>2;
					dCbB[cDest] = (sCb[cSrc]+sCb[cSrc+1]+sCb[cSrc+width]+sCb[cSrc+width+1]+2)>>2;
				}
				cSrc += width - 8;
				cDest += width - 8;
			}
		} else if (cOddH) {
			while (cDest < cLast) {
				for (var xi = 0; xi < 8; xi++, cSrc++, cDest++) {
					dCrB[cDest] = (sCr[cSrc]+sCr[cSrc+1]+1)>>1;
					dCbB[cDest] = (sCb[cSrc]+sCb[cSrc+1]+1)>>1;
				}
				cSrc += width - 8;
				cDest += width - 8;
			}
		} else if (cOddV) {
			while (cDest < cLast) {
				for (var xi = 0; xi < 8; xi++, cSrc++, cDest++) {
					dCrB[cDest] = (sCr[cSrc]+sCr[cSrc+width]+1)>>1;
					dCbB[cDest] = (sCb[cSrc]+sCb[cSrc+width]+1)>>1;
				}
				cSrc += width - 8;
				cDest += width - 8;
			}
		} else {
			while (cDest < cLast) {
				for (var xi = 0; xi < 8; xi++, cSrc++, cDest++) {
					dCrB[cDest] = sCr[cSrc];
					dCbB[cDest] = sCb[cSrc];
				}
				cSrc += width - 8;
				cDest += width - 8;
			}
		}
		return;
	}

	H = (motionH/2) >> 1;
	V = (motionV/2) >> 1;
	oddH = ((motionH/2) & 1) === 1;
	oddV = ((motionV/2) & 1) === 1;

	src = ((this.mbRow << 3) + V) * width + (this.mbCol << 3) + H;
	dest = (this.mbRow * width + this.mbCol) << 1;
	last = dest + (width << 1);

	var cr1, cr2, cr, cb1, cb2, cb;
	if (oddH) {
		if (oddV) {
			while (dest < last) {
				cr1 = sCr[src] + sCr[src+width];
				cb1 = sCb[src] + sCb[src+width]; src++;
				for (x = 0; x < 2; x++) {
					cr2 = sCr[src] + sCr[src+width];
					cb2 = sCb[src] + sCb[src+width]; src++;
					cr = (((cr1 + cr2 + 2) >> 2) & 0xff);
					cb = (((cb1 + cb2 + 2) >> 2) & 0xff);
					cr1 = sCr[src] + sCr[src+width];
					cb1 = sCb[src] + sCb[src+width]; src++;
					cr |= (((cr1 + cr2 + 2) << 6) & 0xff00);
					cb |= (((cb1 + cb2 + 2) << 6) & 0xff00);
					cr2 = sCr[src] + sCr[src+width];
					cb2 = sCb[src] + sCb[src+width]; src++;
					cr |= (((cr1 + cr2 + 2) << 14) & 0xff0000);
					cb |= (((cb1 + cb2 + 2) << 14) & 0xff0000);
					cr1 = sCr[src] + sCr[src+width];
					cb1 = sCb[src] + sCb[src+width]; src++;
					cr |= (((cr1 + cr2 + 2) << 22) & 0xff000000);
					cb |= (((cb1 + cb2 + 2) << 22) & 0xff000000);
					dCr[dest] = cr; dCb[dest] = cb; dest++;
				}
				dest += scan >> 2; src += scan-1;
			}
		} else {
			while (dest < last) {
				cr1 = sCr[src]; cb1 = sCb[src]; src++;
				for (x = 0; x < 2; x++) {
					cr2 = sCr[src]; cb2 = sCb[src++];
					cr = (((cr1 + cr2 + 1) >> 1) & 0xff);
					cb = (((cb1 + cb2 + 1) >> 1) & 0xff);
					cr1 = sCr[src]; cb1 = sCb[src++];
					cr |= (((cr1 + cr2 + 1) << 7) & 0xff00);
					cb |= (((cb1 + cb2 + 1) << 7) & 0xff00);
					cr2 = sCr[src]; cb2 = sCb[src++];
					cr |= (((cr1 + cr2 + 1) << 15) & 0xff0000);
					cb |= (((cb1 + cb2 + 1) << 15) & 0xff0000);
					cr1 = sCr[src]; cb1 = sCb[src++];
					cr |= (((cr1 + cr2 + 1) << 23) & 0xff000000);
					cb |= (((cb1 + cb2 + 1) << 23) & 0xff000000);
					dCr[dest] = cr; dCb[dest] = cb; dest++;
				}
				dest += scan >> 2; src += scan-1;
			}
		}
	} else {
		if (oddV) {
			while (dest < last) {
				for (x = 0; x < 2; x++) {
					cr = (((sCr[src] + sCr[src+width] + 1) >> 1) & 0xff);
					cb = (((sCb[src] + sCb[src+width] + 1) >> 1) & 0xff); src++;
					cr |= (((sCr[src] + sCr[src+width] + 1) << 7) & 0xff00);
					cb |= (((sCb[src] + sCb[src+width] + 1) << 7) & 0xff00); src++;
					cr |= (((sCr[src] + sCr[src+width] + 1) << 15) & 0xff0000);
					cb |= (((sCb[src] + sCb[src+width] + 1) << 15) & 0xff0000); src++;
					cr |= (((sCr[src] + sCr[src+width] + 1) << 23) & 0xff000000);
					cb |= (((sCb[src] + sCb[src+width] + 1) << 23) & 0xff000000); src++;
					dCr[dest] = cr; dCb[dest] = cb; dest++;
				}
				dest += scan >> 2; src += scan;
			}
		} else {
			while (dest < last) {
				for (x = 0; x < 2; x++) {
					cr = sCr[src]; cb = sCb[src]; src++;
					cr |= sCr[src] << 8; cb |= sCb[src] << 8; src++;
					cr |= sCr[src] << 16; cb |= sCb[src] << 16; src++;
					cr |= sCr[src] << 24; cb |= sCb[src] << 24; src++;
					dCr[dest] = cr; dCb[dest] = cb; dest++;
				}
				dest += scan >> 2; src += scan;
			}
		}
	}
};

// B-frame bidirectional: average of forward (past=backwardY) and backward (future=forwardY)
MPEG2.prototype.copyMacroblockInterpolated = function(fwdH, fwdV, bwdH, bwdV) {
	// First copy from past reference (backwardY) using fwd motion
	this.copyMacroblock(fwdH, fwdV, this.backwardY, this.backwardCr, this.backwardCb);

	// Then average with future reference (forwardY) using bwd motion in place
	var width = this.codedWidth;
	var fH = bwdH >> 1, fV = bwdV >> 1;
	var oddH = (bwdH & 1) === 1, oddV = (bwdV & 1) === 1;
	var sY = this.forwardY, sCr = this.forwardCr, sCb = this.forwardCb;
	var dY = this.currentY, dCr = this.currentCr, dCb = this.currentCb;

	var rowBase = this.mbRow << 4, colBase = this.mbCol << 4;
	var srcBase = (rowBase + fV) * width + colBase + fH;
	var destBase = rowBase * width + colBase;

	for (var row = 0; row < 16; row++) {
		for (var col = 0; col < 16; col++) {
			var s = srcBase + row * width + col;
			var d = destBase + row * width + col;
			var val;
			if (oddH && oddV) {
				val = (sY[s] + sY[s+1] + sY[s+width] + sY[s+width+1] + 2) >> 2;
			} else if (oddH) {
				val = (sY[s] + sY[s+1] + 1) >> 1;
			} else if (oddV) {
				val = (sY[s] + sY[s+width] + 1) >> 1;
			} else {
				val = sY[s];
			}
			dY[d] = (dY[d] + val + 1) >> 1;
		}
	}

	// Chrominance average
	var halfWidth = this.halfWidth;
	var cFH, cFV, cOddH, cOddV, cRowBase, cChromaRows;
	if (this.chromaFormat === 2) {
		cFH = (bwdH / 2) >> 1; cFV = bwdV >> 1;
		cOddH = ((bwdH / 2) & 1) === 1; cOddV = (bwdV & 1) === 1;
		cRowBase = this.mbRow << 4; cChromaRows = 16;
	} else {
		cFH = (bwdH/2) >> 1; cFV = (bwdV/2) >> 1;
		cOddH = ((bwdH/2) & 1) === 1; cOddV = ((bwdV/2) & 1) === 1;
		cRowBase = this.mbRow << 3; cChromaRows = 8;
	}
	var cColBase = this.mbCol << 3;
	var cSrcBase = (cRowBase + cFV) * halfWidth + cColBase + cFH;
	var cDestBase = cRowBase * halfWidth + cColBase;

	for (var row = 0; row < cChromaRows; row++) {
		for (var col = 0; col < 8; col++) {
			var s = cSrcBase + row * halfWidth + col;
			var d = cDestBase + row * halfWidth + col;
			var cr, cb;
			if (cOddH && cOddV) {
				cr = (sCr[s]+sCr[s+1]+sCr[s+halfWidth]+sCr[s+halfWidth+1]+2)>>2;
				cb = (sCb[s]+sCb[s+1]+sCb[s+halfWidth]+sCb[s+halfWidth+1]+2)>>2;
			} else if (cOddH) {
				cr = (sCr[s]+sCr[s+1]+1)>>1;
				cb = (sCb[s]+sCb[s+1]+1)>>1;
			} else if (cOddV) {
				cr = (sCr[s]+sCr[s+halfWidth]+1)>>1;
				cb = (sCb[s]+sCb[s+halfWidth]+1)>>1;
			} else {
				cr = sCr[s]; cb = sCb[s];
			}
			dCr[d] = (dCr[d] + cr + 1) >> 1;
			dCb[d] = (dCb[d] + cb + 1) >> 1;
		}
	}
};


// Block Layer

MPEG2.prototype.dcPredictorY = 0;
MPEG2.prototype.dcPredictorCr = 0;
MPEG2.prototype.dcPredictorCb = 0;

MPEG2.prototype.blockData = null;

MPEG2.prototype.decodeBlock = function(block) {
	var n = 0, quantMatrix;

	if (this.macroblockIntra) {
		var predictor, dctSize;

		if (block < 4) {
			predictor = this.dcPredictorY;
			dctSize = this.readHuffman(MPEG2.DCT_DC_SIZE_LUMINANCE);
		} else {
			// blocks 4,6 (even) map to Cr predictor; blocks 5,7 (odd) map to Cb predictor
			predictor = ((block & 1) === 0 ? this.dcPredictorCr : this.dcPredictorCb);
			dctSize = this.readHuffman(MPEG2.DCT_DC_SIZE_CHROMINANCE);
		}

		if (dctSize > 0) {
			var differential = this.bits.read(dctSize);
			if ((differential & (1 << (dctSize - 1))) !== 0) {
				this.blockData[0] = predictor + differential;
			} else {
				this.blockData[0] = predictor + ((-1 << dctSize)|(differential+1));
			}
		} else {
			this.blockData[0] = predictor;
		}

		if (block < 4) {
			this.dcPredictorY = this.blockData[0];
		} else if ((block & 1) === 0) {
			this.dcPredictorCr = this.blockData[0]; // blocks 4,6 → Cr predictor
		} else {
			this.dcPredictorCb = this.blockData[0]; // blocks 5,7 → Cb predictor
		}

		// Premultiply DC: adjust for intraDcPrecision
		this.blockData[0] <<= (3 + 5 - this.intraDcPrecision);

		quantMatrix = this.intraQuantMatrix;
		n = 1;
	} else {
		quantMatrix = this.nonIntraQuantMatrix;
	}

	var zigZag = this.alternateScan ? MPEG2.ALTERNATE_SCAN : MPEG2.ZIG_ZAG;
	var dctCoeffTable = MPEG2.DCT_COEFF; // intra_vlc_format=1 not yet supported
	var isMPEG2 = this.isMPEG2;
	var isIntra = this.macroblockIntra;
	var qs = this.quantizerScale;
	// MPEG-2 mismatch control: XOR of LSBs of all F''[v][u] in the block.
	// For intra blocks at intraDcPrec=0..3, F''[0][0] = raw_DC * (8>>prec), which is always
	// even (multiple of 1, 2, 4, or 8) so its LSB contribution to the parity for prec<3 is 0.
	// We track parity from AC coeffs; DC parity handling below.
	var mismatchParity = 0;

	var level = 0;
	while (true) {
		var run = 0,
			coeff = this.readHuffman(dctCoeffTable);

		if ((coeff === 0x0001) && (n > 0) && (this.bits.read(1) === 0)) {
			break; // end_of_block
		}
		if (coeff === 0xffff) {
			// escape
			run = this.bits.read(6);
			if (isMPEG2) {
				// ISO 13818-2: 12-bit signed level
				level = this.bits.read(12);
				if (level >= 2048) { level -= 4096; }
			} else {
				level = this.bits.read(8);
				if (level === 0) {
					level = this.bits.read(8);
				} else if (level === 128) {
					level = this.bits.read(8) - 256;
				} else if (level > 128) {
					level = level - 256;
				}
			}
		} else {
			run = coeff >> 8;
			level = coeff & 0xff;
			if (this.bits.read(1)) {
				level = -level;
			}
		}

		n += run;
		if (n >= 64) { break; }
		var dezigZagged = zigZag[n];
		n++;

		// Dequantization. The scaling (>> 4, with the 2x in the numerator) is
		// identical for MPEG-1 and MPEG-2 because both feed the same IDCT and the
		// same PREMULTIPLIER_MATRIX. The ONLY codec difference is the final rounding
		// step: MPEG-1 forces each coefficient odd ("oddification"); MPEG-2 instead
		// applies a single end-of-block mismatch toggle on F[7][7] (handled below).
		level <<= 1;
		if (!isIntra) {
			level += (level < 0 ? -1 : 1);
		}
		level = (level * qs * quantMatrix[dezigZagged]) >> 4;

		if (isMPEG2) {
			// Saturation per 7.4.2.4: |F'[v][u]| <= 2047
			if (level > 2047) { level = 2047; }
			else if (level < -2047) { level = -2047; }
			mismatchParity ^= (level & 1);
		} else {
			// MPEG-1 per-coefficient odd-only adjustment.
			if ((level & 1) === 0) {
				level -= level > 0 ? 1 : -1;
			}
			if (level > 2047) { level = 2047; }
			else if (level < -2048) { level = -2048; }
		}

		this.blockData[dezigZagged] = level * MPEG2.PREMULTIPLIER_MATRIX[dezigZagged];
	}

	if (isMPEG2) {
		// Mismatch control (7.4.2.5): if sum is even, flip LSB of F[7][7].
		// For intra blocks the DC contributes F''[0][0] = raw_DC << (3 - intraDcPrec);
		// its LSB is 0 when intraDcPrec <= 2 and raw_DC's parity when intraDcPrec == 3.
		var dcParity = (isIntra && this.intraDcPrecision === 3)
			? ((this.blockData[0] >> 5) & 1)
			: 0;
		if (((mismatchParity ^ dcParity) & 1) === 0) {
			// PREMULTIPLIER_MATRIX[63] = 2, so flipping the underlying level's LSB
			// corresponds to XOR-ing the stored value by 2.
			this.blockData[63] ^= 2;
		}
	}

	var destArray, destIndex, scan;

	if (block < 4) {
		destArray = this.currentY;
		scan = this.codedWidth - 8;
		destIndex = (this.mbRow * this.codedWidth + this.mbCol) << 4;
		if ((block & 1) !== 0) { destIndex += 8; }
		if ((block & 2) !== 0) { destIndex += this.codedWidth << 3; }
	} else {
		var halfWidth = this.halfWidth;
		// blocks 4,6 (even) → Cb buffer; blocks 5,7 (odd) → Cr buffer
		destArray = ((block & 1) === 0) ? this.currentCb : this.currentCr;
		scan = halfWidth - 8;
		if (this.chromaFormat === 2) {
			// 4:2:2: full chroma height; blocks 4-5 = top 8 rows, 6-7 = bottom 8 rows
			var chromaRow = (block < 6) ? (this.mbRow << 4) : (this.mbRow << 4) + 8;
			destIndex = chromaRow * halfWidth + (this.mbCol << 3);
		} else {
			// 4:2:0
			destIndex = ((this.mbRow * this.codedWidth) << 2) + (this.mbCol << 3);
		}
	}

	if (this.macroblockIntra) {
		if (n === 1) {
			MPEG2.CopyValueToDestination((this.blockData[0] + 128) >> 8, destArray, destIndex, scan);
			this.blockData[0] = 0;
		} else {
			MPEG2.IDCT(this.blockData);
			MPEG2.CopyBlockToDestination(this.blockData, destArray, destIndex, scan);
			JSMpeg.Fill(this.blockData, 0);
		}
	} else {
		if (n === 1) {
			MPEG2.AddValueToDestination((this.blockData[0] + 128) >> 8, destArray, destIndex, scan);
			this.blockData[0] = 0;
		} else {
			MPEG2.IDCT(this.blockData);
			MPEG2.AddBlockToDestination(this.blockData, destArray, destIndex, scan);
			JSMpeg.Fill(this.blockData, 0);
		}
	}

	n = 0;
};

MPEG2.CopyBlockToDestination = function(block, dest, index, scan) {
	for (var n = 0; n < 64; n += 8, index += scan+8) {
		dest[index+0] = block[n+0]; dest[index+1] = block[n+1];
		dest[index+2] = block[n+2]; dest[index+3] = block[n+3];
		dest[index+4] = block[n+4]; dest[index+5] = block[n+5];
		dest[index+6] = block[n+6]; dest[index+7] = block[n+7];
	}
};

MPEG2.AddBlockToDestination = function(block, dest, index, scan) {
	for (var n = 0; n < 64; n += 8, index += scan+8) {
		dest[index+0] += block[n+0]; dest[index+1] += block[n+1];
		dest[index+2] += block[n+2]; dest[index+3] += block[n+3];
		dest[index+4] += block[n+4]; dest[index+5] += block[n+5];
		dest[index+6] += block[n+6]; dest[index+7] += block[n+7];
	}
};

MPEG2.CopyValueToDestination = function(value, dest, index, scan) {
	for (var n = 0; n < 64; n += 8, index += scan+8) {
		dest[index+0] = value; dest[index+1] = value;
		dest[index+2] = value; dest[index+3] = value;
		dest[index+4] = value; dest[index+5] = value;
		dest[index+6] = value; dest[index+7] = value;
	}
};

MPEG2.AddValueToDestination = function(value, dest, index, scan) {
	for (var n = 0; n < 64; n += 8, index += scan+8) {
		dest[index+0] += value; dest[index+1] += value;
		dest[index+2] += value; dest[index+3] += value;
		dest[index+4] += value; dest[index+5] += value;
		dest[index+6] += value; dest[index+7] += value;
	}
};

MPEG2.IDCT = function(block) {
	var b1, b3, b4, b6, b7, tmp1, tmp2, m0,
		x0, x1, x2, x3, x4, y3, y4, y5, y6, y7;

	for (var i = 0; i < 8; ++i) {
		b1 = block[4*8+i];
		b3 = block[2*8+i] + block[6*8+i];
		b4 = block[5*8+i] - block[3*8+i];
		tmp1 = block[1*8+i] + block[7*8+i];
		tmp2 = block[3*8+i] + block[5*8+i];
		b6 = block[1*8+i] - block[7*8+i];
		b7 = tmp1 + tmp2;
		m0 = block[0*8+i];
		x4 = ((b6*473 - b4*196 + 128) >> 8) - b7;
		x0 = x4 - (((tmp1 - tmp2)*362 + 128) >> 8);
		x1 = m0 - b1;
		x2 = (((block[2*8+i] - block[6*8+i])*362 + 128) >> 8) - b3;
		x3 = m0 + b1;
		y3 = x1 + x2; y4 = x3 + b3; y5 = x1 - x2; y6 = x3 - b3;
		y7 = -x0 - ((b4*473 + b6*196 + 128) >> 8);
		block[0*8+i] = b7 + y4; block[1*8+i] = x4 + y3;
		block[2*8+i] = y5 - x0; block[3*8+i] = y6 - y7;
		block[4*8+i] = y6 + y7; block[5*8+i] = x0 + y5;
		block[6*8+i] = y3 - x4; block[7*8+i] = y4 - b7;
	}

	for (var i = 0; i < 64; i += 8) {
		b1 = block[4+i];
		b3 = block[2+i] + block[6+i];
		b4 = block[5+i] - block[3+i];
		tmp1 = block[1+i] + block[7+i];
		tmp2 = block[3+i] + block[5+i];
		b6 = block[1+i] - block[7+i];
		b7 = tmp1 + tmp2;
		m0 = block[0+i];
		x4 = ((b6*473 - b4*196 + 128) >> 8) - b7;
		x0 = x4 - (((tmp1 - tmp2)*362 + 128) >> 8);
		x1 = m0 - b1;
		x2 = (((block[2+i] - block[6+i])*362 + 128) >> 8) - b3;
		x3 = m0 + b1;
		y3 = x1 + x2; y4 = x3 + b3; y5 = x1 - x2; y6 = x3 - b3;
		y7 = -x0 - ((b4*473 + b6*196 + 128) >> 8);
		block[0+i] = (b7 + y4 + 128) >> 8; block[1+i] = (x4 + y3 + 128) >> 8;
		block[2+i] = (y5 - x0 + 128) >> 8; block[3+i] = (y6 - y7 + 128) >> 8;
		block[4+i] = (y6 + y7 + 128) >> 8; block[5+i] = (x0 + y5 + 128) >> 8;
		block[6+i] = (y3 - x4 + 128) >> 8; block[7+i] = (y4 - b7 + 128) >> 8;
	}
};


// VLC Tables and Constants

MPEG2.PICTURE_RATE = [
	0.000, 23.976, 24.000, 25.000, 29.970, 30.000, 50.000, 59.940,
	60.000, 0.000, 0.000, 0.000, 0.000, 0.000, 0.000, 0.000
];

MPEG2.ZIG_ZAG = new Uint8Array([
	 0,  1,  8, 16,  9,  2,  3, 10,
	17, 24, 32, 25, 18, 11,  4,  5,
	12, 19, 26, 33, 40, 48, 41, 34,
	27, 20, 13,  6,  7, 14, 21, 28,
	35, 42, 49, 56, 57, 50, 43, 36,
	29, 22, 15, 23, 30, 37, 44, 51,
	58, 59, 52, 45, 38, 31, 39, 46,
	53, 60, 61, 54, 47, 55, 62, 63
]);

MPEG2.ALTERNATE_SCAN = new Uint8Array([
	 0,  8, 16, 24,  1,  9,  2, 10,
	17, 25, 32, 40, 48, 56, 57, 49,
	41, 33, 26, 18,  3, 11,  4, 12,
	19, 27, 34, 42, 50, 58, 35, 43,
	51, 59, 20, 28,  5, 13,  6, 14,
	21, 29, 36, 44, 52, 60, 37, 45,
	53, 61, 22, 30,  7, 15, 23, 31,
	38, 46, 54, 62, 39, 47, 55, 63
]);

MPEG2.NON_LINEAR_QUANTIZER_SCALE = new Uint8Array([
	  0,  1,  2,  3,  4,  5,  6,  7,
	  8, 10, 12, 14, 16, 18, 20, 22,
	 24, 28, 32, 36, 40, 44, 48, 52,
	 56, 64, 72, 80, 88, 96,104,112
]);

MPEG2.DEFAULT_INTRA_QUANT_MATRIX = new Uint8Array([
	 8, 16, 19, 22, 26, 27, 29, 34,
	16, 16, 22, 24, 27, 29, 34, 37,
	19, 22, 26, 27, 29, 34, 34, 38,
	22, 22, 26, 27, 29, 34, 37, 40,
	22, 26, 27, 29, 32, 35, 40, 48,
	26, 27, 29, 32, 35, 40, 48, 58,
	26, 27, 29, 34, 38, 46, 56, 69,
	27, 29, 35, 38, 46, 56, 69, 83
]);

MPEG2.DEFAULT_NON_INTRA_QUANT_MATRIX = new Uint8Array([
	16, 16, 16, 16, 16, 16, 16, 16,
	16, 16, 16, 16, 16, 16, 16, 16,
	16, 16, 16, 16, 16, 16, 16, 16,
	16, 16, 16, 16, 16, 16, 16, 16,
	16, 16, 16, 16, 16, 16, 16, 16,
	16, 16, 16, 16, 16, 16, 16, 16,
	16, 16, 16, 16, 16, 16, 16, 16,
	16, 16, 16, 16, 16, 16, 16, 16
]);

MPEG2.PREMULTIPLIER_MATRIX = new Uint8Array([
	32, 44, 42, 38, 32, 25, 17,  9,
	44, 62, 58, 52, 44, 35, 24, 12,
	42, 58, 55, 49, 42, 33, 23, 12,
	38, 52, 49, 44, 38, 30, 20, 10,
	32, 44, 42, 38, 32, 25, 17,  9,
	25, 35, 33, 30, 25, 20, 14,  7,
	17, 24, 23, 20, 17, 14,  9,  5,
	 9, 12, 12, 10,  9,  7,  5,  2
]);

MPEG2.MACROBLOCK_ADDRESS_INCREMENT = new Int16Array([
	 1*3,  2*3,  0, //   0
	 3*3,  4*3,  0, //   1  0
	   0,    0,  1, //   2  1.
	 5*3,  6*3,  0, //   3  00
	 7*3,  8*3,  0, //   4  01
	 9*3, 10*3,  0, //   5  000
	11*3, 12*3,  0, //   6  001
	   0,    0,  3, //   7  010.
	   0,    0,  2, //   8  011.
	13*3, 14*3,  0, //   9  0000
	15*3, 16*3,  0, //  10  0001
	   0,    0,  5, //  11  0010.
	   0,    0,  4, //  12  0011.
	17*3, 18*3,  0, //  13  0000 0
	19*3, 20*3,  0, //  14  0000 1
	   0,    0,  7, //  15  0001 0.
	   0,    0,  6, //  16  0001 1.
	21*3, 22*3,  0, //  17  0000 00
	23*3, 24*3,  0, //  18  0000 01
	25*3, 26*3,  0, //  19  0000 10
	27*3, 28*3,  0, //  20  0000 11
	  -1, 29*3,  0, //  21  0000 000
	  -1, 30*3,  0, //  22  0000 001
	31*3, 32*3,  0, //  23  0000 010
	33*3, 34*3,  0, //  24  0000 011
	35*3, 36*3,  0, //  25  0000 100
	37*3, 38*3,  0, //  26  0000 101
	   0,    0,  9, //  27  0000 110.
	   0,    0,  8, //  28  0000 111.
	39*3, 40*3,  0, //  29  0000 0001
	41*3, 42*3,  0, //  30  0000 0011
	43*3, 44*3,  0, //  31  0000 0100
	45*3, 46*3,  0, //  32  0000 0101
	   0,    0, 15, //  33  0000 0110.
	   0,    0, 14, //  34  0000 0111.
	   0,    0, 13, //  35  0000 1000.
	   0,    0, 12, //  36  0000 1001.
	   0,    0, 11, //  37  0000 1010.
	   0,    0, 10, //  38  0000 1011.
	47*3,   -1,  0, //  39  0000 0001 0
	  -1, 48*3,  0, //  40  0000 0001 1
	49*3, 50*3,  0, //  41  0000 0011 0
	51*3, 52*3,  0, //  42  0000 0011 1
	53*3, 54*3,  0, //  43  0000 0100 0
	55*3, 56*3,  0, //  44  0000 0100 1
	57*3, 58*3,  0, //  45  0000 0101 0
	59*3, 60*3,  0, //  46  0000 0101 1
	61*3,   -1,  0, //  47  0000 0001 00
	  -1, 62*3,  0, //  48  0000 0001 11
	63*3, 64*3,  0, //  49  0000 0011 00
	65*3, 66*3,  0, //  50  0000 0011 01
	67*3, 68*3,  0, //  51  0000 0011 10
	69*3, 70*3,  0, //  52  0000 0011 11
	71*3, 72*3,  0, //  53  0000 0100 00
	73*3, 74*3,  0, //  54  0000 0100 01
	   0,    0, 21, //  55  0000 0100 10.
	   0,    0, 20, //  56  0000 0100 11.
	   0,    0, 19, //  57  0000 0101 00.
	   0,    0, 18, //  58  0000 0101 01.
	   0,    0, 17, //  59  0000 0101 10.
	   0,    0, 16, //  60  0000 0101 11.
	   0,    0, 35, //  61  0000 0001 000. -- macroblock_escape
	   0,    0, 34, //  62  0000 0001 111. -- macroblock_stuffing
	   0,    0, 33, //  63  0000 0011 000.
	   0,    0, 32, //  64  0000 0011 001.
	   0,    0, 31, //  65  0000 0011 010.
	   0,    0, 30, //  66  0000 0011 011.
	   0,    0, 29, //  67  0000 0011 100.
	   0,    0, 28, //  68  0000 0011 101.
	   0,    0, 27, //  69  0000 0011 110.
	   0,    0, 26, //  70  0000 0011 111.
	   0,    0, 25, //  71  0000 0100 000.
	   0,    0, 24, //  72  0000 0100 001.
	   0,    0, 23, //  73  0000 0100 010.
	   0,    0, 22  //  74  0000 0100 011.
]);

MPEG2.MACROBLOCK_TYPE_INTRA = new Int8Array([
	 1*3,  2*3,     0,
	  -1,  3*3,     0,
	   0,    0,  0x01,
	   0,    0,  0x11
]);

MPEG2.MACROBLOCK_TYPE_PREDICTIVE = new Int8Array([
	 1*3,  2*3,     0,
	 3*3,  4*3,     0,
	   0,    0,  0x0a,
	 5*3,  6*3,     0,
	   0,    0,  0x02,
	 7*3,  8*3,     0,
	   0,    0,  0x08,
	 9*3, 10*3,     0,
	11*3, 12*3,     0,
	  -1, 13*3,     0,
	   0,    0,  0x12,
	   0,    0,  0x1a,
	   0,    0,  0x01,
	   0,    0,  0x11
]);

MPEG2.MACROBLOCK_TYPE_B = new Int8Array([
	 1*3,  2*3,     0,
	 3*3,  5*3,     0,
	 4*3,  6*3,     0,
	 8*3,  7*3,     0,
	   0,    0,  0x0c,
	 9*3, 10*3,     0,
	   0,    0,  0x0e,
	13*3, 14*3,     0,
	12*3, 11*3,     0,
	   0,    0,  0x04,
	   0,    0,  0x06,
	18*3, 16*3,     0,
	15*3, 17*3,     0,
	   0,    0,  0x08,
	   0,    0,  0x0a,
	  -1, 19*3,     0,
	   0,    0,  0x01,
	20*3, 21*3,     0,
	   0,    0,  0x1e,
	   0,    0,  0x11,
	   0,    0,  0x16,
	   0,    0,  0x1a
]);

MPEG2.MACROBLOCK_TYPE = [
	null,
	MPEG2.MACROBLOCK_TYPE_INTRA,
	MPEG2.MACROBLOCK_TYPE_PREDICTIVE,
	MPEG2.MACROBLOCK_TYPE_B
];

MPEG2.CODE_BLOCK_PATTERN = new Int16Array([
	  18*3,    1*3,   0,
	   7*3,    2*3,   0,
	   4*3,    3*3,   0,
	     0,      0,  60,
	   6*3,    5*3,   0,
	     0,      0,   4,
	     0,      0,   8,
	  11*3,    8*3,   0,
	  10*3,    9*3,   0,
	     0,      0,  16,
	     0,      0,  32,
	  15*3,   12*3,   0,
	  14*3,   13*3,   0,
	     0,      0,  12,
	     0,      0,  48,
	  17*3,   16*3,   0,
	     0,      0,  20,
	     0,      0,  40,
	  34*3,   19*3,   0,
	  27*3,   20*3,   0,
	  24*3,   21*3,   0,
	  23*3,   22*3,   0,
	     0,      0,  28,
	     0,      0,  44,
	  26*3,   25*3,   0,
	     0,      0,  52,
	     0,      0,  56,
	  31*3,   28*3,   0,
	  30*3,   29*3,   0,
	     0,      0,   1,
	     0,      0,  61,
	  33*3,   32*3,   0,
	     0,      0,   2,
	     0,      0,  62,
	  58*3,   35*3,   0,
	  43*3,   36*3,   0,
	  40*3,   37*3,   0,
	  39*3,   38*3,   0,
	     0,      0,  24,
	     0,      0,  36,
	  42*3,   41*3,   0,
	     0,      0,   3,
	     0,      0,  63,
	  51*3,   44*3,   0,
	  48*3,   45*3,   0,
	  47*3,   46*3,   0,
	     0,      0,   5,
	     0,      0,   9,
	  50*3,   49*3,   0,
	     0,      0,  17,
	     0,      0,  33,
	  55*3,   52*3,   0,
	  54*3,   53*3,   0,
	     0,      0,   6,
	     0,      0,  10,
	  57*3,   56*3,   0,
	     0,      0,  18,
	     0,      0,  34,
	  90*3,   59*3,   0,
	  75*3,   60*3,   0,
	  68*3,   61*3,   0,
	  65*3,   62*3,   0,
	  64*3,   63*3,   0,
	     0,      0,   7,
	     0,      0,  11,
	  67*3,   66*3,   0,
	     0,      0,  19,
	     0,      0,  35,
	  72*3,   69*3,   0,
	  71*3,   70*3,   0,
	     0,      0,  13,
	     0,      0,  49,
	  74*3,   73*3,   0,
	     0,      0,  21,
	     0,      0,  41,
	  83*3,   76*3,   0,
	  80*3,   77*3,   0,
	  79*3,   78*3,   0,
	     0,      0,  14,
	     0,      0,  50,
	  82*3,   81*3,   0,
	     0,      0,  22,
	     0,      0,  42,
	  87*3,   84*3,   0,
	  86*3,   85*3,   0,
	     0,      0,  15,
	     0,      0,  51,
	  89*3,   88*3,   0,
	     0,      0,  23,
	     0,      0,  43,
	 106*3,   91*3,   0,
	  99*3,   92*3,   0,
	  96*3,   93*3,   0,
	  95*3,   94*3,   0,
	     0,      0,  25,
	     0,      0,  37,
	  98*3,   97*3,   0,
	     0,      0,  26,
	     0,      0,  38,
	 103*3,  100*3,   0,
	 102*3,  101*3,   0,
	     0,      0,  29,
	     0,      0,  45,
	 105*3,  104*3,   0,
	     0,      0,  53,
	     0,      0,  57,
	 114*3,  107*3,   0,
	 111*3,  108*3,   0,
	 110*3,  109*3,   0,
	     0,      0,  30,
	     0,      0,  46,
	 113*3,  112*3,   0,
	     0,      0,  54,
	     0,      0,  58,
	 122*3,  115*3,   0,
	 119*3,  116*3,   0,
	 118*3,  117*3,   0,
	     0,      0,  31,
	     0,      0,  47,
	 121*3,  120*3,   0,
	     0,      0,  55,
	     0,      0,  59,
	 126*3,  123*3,   0,
	 125*3,  124*3,   0,
	     0,      0,  27,
	     0,      0,  39,
	    -1,  127*3,   0,
	     0,      0,   0
]);

MPEG2.MOTION = new Int16Array([
	  1*3,   2*3,   0,
	  4*3,   3*3,   0,
	    0,     0,   0,
	  6*3,   5*3,   0,
	  8*3,   7*3,   0,
	    0,     0,  -1,
	    0,     0,   1,
	  9*3,  10*3,   0,
	 12*3,  11*3,   0,
	    0,     0,   2,
	    0,     0,  -2,
	 14*3,  15*3,   0,
	 16*3,  13*3,   0,
	 20*3,  18*3,   0,
	    0,     0,   3,
	    0,     0,  -3,
	 17*3,  19*3,   0,
	   -1,  23*3,   0,
	 27*3,  25*3,   0,
	 26*3,  21*3,   0,
	 24*3,  22*3,   0,
	 32*3,  28*3,   0,
	 29*3,  31*3,   0,
	   -1,  33*3,   0,
	 36*3,  35*3,   0,
	    0,     0,  -4,
	 30*3,  34*3,   0,
	    0,     0,   4,
	    0,     0,  -7,
	    0,     0,   5,
	 37*3,  41*3,   0,
	    0,     0,  -5,
	    0,     0,   7,
	 38*3,  40*3,   0,
	 42*3,  39*3,   0,
	    0,     0,  -6,
	    0,     0,   6,
	 51*3,  54*3,   0,
	 50*3,  49*3,   0,
	 45*3,  46*3,   0,
	 52*3,  47*3,   0,
	 43*3,  53*3,   0,
	 44*3,  48*3,   0,
	    0,     0,  10,
	    0,     0,   9,
	    0,     0,   8,
	    0,     0,  -8,
	 57*3,  66*3,   0,
	    0,     0,  -9,
	 60*3,  64*3,   0,
	 56*3,  61*3,   0,
	 55*3,  62*3,   0,
	 58*3,  63*3,   0,
	    0,     0, -10,
	 59*3,  65*3,   0,
	    0,     0,  12,
	    0,     0,  16,
	    0,     0,  13,
	    0,     0,  14,
	    0,     0,  11,
	    0,     0,  15,
	    0,     0, -16,
	    0,     0, -12,
	    0,     0, -14,
	    0,     0, -15,
	    0,     0, -11,
	    0,     0, -13
]);

MPEG2.DCT_DC_SIZE_LUMINANCE = new Int8Array([
	  2*3,   1*3, 0,
	  6*3,   5*3, 0,
	  3*3,   4*3, 0,
	    0,     0, 1,
	    0,     0, 2,
	  9*3,   8*3, 0,
	  7*3,  10*3, 0,
	    0,     0, 0,
	 12*3,  11*3, 0,
	    0,     0, 4,
	    0,     0, 3,
	 13*3,  14*3, 0,
	    0,     0, 5,
	    0,     0, 6,
	 16*3,  15*3, 0,
	 17*3,    -1, 0,
	    0,     0, 7,
	    0,     0, 8
]);

MPEG2.DCT_DC_SIZE_CHROMINANCE = new Int8Array([
	  2*3,   1*3, 0,
	  4*3,   3*3, 0,
	  6*3,   5*3, 0,
	  8*3,   7*3, 0,
	    0,     0, 2,
	    0,     0, 1,
	    0,     0, 0,
	 10*3,   9*3, 0,
	    0,     0, 3,
	 12*3,  11*3, 0,
	    0,     0, 4,
	 14*3,  13*3, 0,
	    0,     0, 5,
	 16*3,  15*3, 0,
	    0,     0, 6,
	 17*3,    -1, 0,
	    0,     0, 7,
	    0,     0, 8
]);

MPEG2.DCT_COEFF = new Int32Array([
	  1*3,   2*3,      0,  //   0
	  4*3,   3*3,      0,  //   1  0
	    0,     0, 0x0001,  //   2  1.
	  7*3,   8*3,      0,  //   3  01
	  6*3,   5*3,      0,  //   4  00
	 13*3,   9*3,      0,  //   5  001
	 11*3,  10*3,      0,  //   6  000
	 14*3,  12*3,      0,  //   7  010
	    0,     0, 0x0101,  //   8  011.
	 20*3,  22*3,      0,  //   9  0011
	 18*3,  21*3,      0,  //  10  0001
	 16*3,  19*3,      0,  //  11  0000
	    0,     0, 0x0201,  //  12  0101.
	 17*3,  15*3,      0,  //  13  0010
	    0,     0, 0x0002,  //  14  0100.
	    0,     0, 0x0003,  //  15  0010 1.
	 27*3,  25*3,      0,  //  16  0000 0
	 29*3,  31*3,      0,  //  17  0010 0
	 24*3,  26*3,      0,  //  18  0001 0
	 32*3,  30*3,      0,  //  19  0000 1
	    0,     0, 0x0401,  //  20  0011 0.
	 23*3,  28*3,      0,  //  21  0001 1
	    0,     0, 0x0301,  //  22  0011 1.
	    0,     0, 0x0102,  //  23  0001 10.
	    0,     0, 0x0701,  //  24  0001 00.
	    0,     0, 0xffff,  //  25  0000 01. -- escape
	    0,     0, 0x0601,  //  26  0001 01.
	 37*3,  36*3,      0,  //  27  0000 00
	    0,     0, 0x0501,  //  28  0001 11.
	 35*3,  34*3,      0,  //  29  0010 00
	 39*3,  38*3,      0,  //  30  0000 11
	 33*3,  42*3,      0,  //  31  0010 01
	 40*3,  41*3,      0,  //  32  0000 10
	 52*3,  50*3,      0,  //  33  0010 010
	 54*3,  53*3,      0,  //  34  0010 001
	 48*3,  49*3,      0,  //  35  0010 000
	 43*3,  45*3,      0,  //  36  0000 001
	 46*3,  44*3,      0,  //  37  0000 000
	    0,     0, 0x0801,  //  38  0000 111.
	    0,     0, 0x0004,  //  39  0000 110.
	    0,     0, 0x0202,  //  40  0000 100.
	    0,     0, 0x0901,  //  41  0000 101.
	 51*3,  47*3,      0,  //  42  0010 011
	 55*3,  57*3,      0,  //  43  0000 0010
	 60*3,  56*3,      0,  //  44  0000 0001
	 59*3,  58*3,      0,  //  45  0000 0011
	 61*3,  62*3,      0,  //  46  0000 0000
	    0,     0, 0x0a01,  //  47  0010 0111.
	    0,     0, 0x0d01,  //  48  0010 0000.
	    0,     0, 0x0006,  //  49  0010 0001.
	    0,     0, 0x0103,  //  50  0010 0101.
	    0,     0, 0x0005,  //  51  0010 0110.
	    0,     0, 0x0302,  //  52  0010 0100.
	    0,     0, 0x0b01,  //  53  0010 0011.
	    0,     0, 0x0c01,  //  54  0010 0010.
	 76*3,  75*3,      0,  //  55  0000 0010 0
	 67*3,  70*3,      0,  //  56  0000 0001 1
	 73*3,  71*3,      0,  //  57  0000 0010 1
	 78*3,  74*3,      0,  //  58  0000 0011 1
	 72*3,  77*3,      0,  //  59  0000 0011 0
	 69*3,  64*3,      0,  //  60  0000 0001 0
	 68*3,  63*3,      0,  //  61  0000 0000 0
	 66*3,  65*3,      0,  //  62  0000 0000 1
	 81*3,  87*3,      0,  //  63  0000 0000 01
	 91*3,  80*3,      0,  //  64  0000 0001 01
	 82*3,  79*3,      0,  //  65  0000 0000 11
	 83*3,  86*3,      0,  //  66  0000 0000 10
	 93*3,  92*3,      0,  //  67  0000 0001 10
	 84*3,  85*3,      0,  //  68  0000 0000 00
	 90*3,  94*3,      0,  //  69  0000 0001 00
	 88*3,  89*3,      0,  //  70  0000 0001 11
	    0,     0, 0x0203,  //  71  0000 0010 11.
	    0,     0, 0x0104,  //  72  0000 0011 00.
	    0,     0, 0x0007,  //  73  0000 0010 10.
	    0,     0, 0x0402,  //  74  0000 0011 11.
	    0,     0, 0x0502,  //  75  0000 0010 01.
	    0,     0, 0x1001,  //  76  0000 0010 00.
	    0,     0, 0x0f01,  //  77  0000 0011 01.
	    0,     0, 0x0e01,  //  78  0000 0011 10.
	105*3, 107*3,      0,  //  79  0000 0000 111
	111*3, 114*3,      0,  //  80  0000 0001 011
	104*3,  97*3,      0,  //  81  0000 0000 010
	125*3, 119*3,      0,  //  82  0000 0000 110
	 96*3,  98*3,      0,  //  83  0000 0000 100
	   -1, 123*3,      0,  //  84  0000 0000 000
	 95*3, 101*3,      0,  //  85  0000 0000 001
	106*3, 121*3,      0,  //  86  0000 0000 101
	 99*3, 102*3,      0,  //  87  0000 0000 011
	113*3, 103*3,      0,  //  88  0000 0001 110
	112*3, 116*3,      0,  //  89  0000 0001 111
	110*3, 100*3,      0,  //  90  0000 0001 000
	124*3, 115*3,      0,  //  91  0000 0001 010
	117*3, 122*3,      0,  //  92  0000 0001 101
	109*3, 118*3,      0,  //  93  0000 0001 100
	120*3, 108*3,      0,  //  94  0000 0001 001
	127*3, 136*3,      0,  //  95  0000 0000 0010
	139*3, 140*3,      0,  //  96  0000 0000 1000
	130*3, 126*3,      0,  //  97  0000 0000 0101
	145*3, 146*3,      0,  //  98  0000 0000 1001
	128*3, 129*3,      0,  //  99  0000 0000 0110
	    0,     0, 0x0802,  // 100  0000 0001 0001.
	132*3, 134*3,      0,  // 101  0000 0000 0011
	155*3, 154*3,      0,  // 102  0000 0000 0111
	    0,     0, 0x0008,  // 103  0000 0001 1101.
	137*3, 133*3,      0,  // 104  0000 0000 0100
	143*3, 144*3,      0,  // 105  0000 0000 1110
	151*3, 138*3,      0,  // 106  0000 0000 1010
	142*3, 141*3,      0,  // 107  0000 0000 1111
	    0,     0, 0x000a,  // 108  0000 0001 0011.
	    0,     0, 0x0009,  // 109  0000 0001 1000.
	    0,     0, 0x000b,  // 110  0000 0001 0000.
	    0,     0, 0x1501,  // 111  0000 0001 0110.
	    0,     0, 0x0602,  // 112  0000 0001 1110.
	    0,     0, 0x0303,  // 113  0000 0001 1100.
	    0,     0, 0x1401,  // 114  0000 0001 0111.
	    0,     0, 0x0702,  // 115  0000 0001 0101.
	    0,     0, 0x1101,  // 116  0000 0001 1111.
	    0,     0, 0x1201,  // 117  0000 0001 1010.
	    0,     0, 0x1301,  // 118  0000 0001 1001.
	148*3, 152*3,      0,  // 119  0000 0000 1101
	    0,     0, 0x0403,  // 120  0000 0001 0010.
	153*3, 150*3,      0,  // 121  0000 0000 1011
	    0,     0, 0x0105,  // 122  0000 0001 1011.
	131*3, 135*3,      0,  // 123  0000 0000 0001
	    0,     0, 0x0204,  // 124  0000 0001 0100.
	149*3, 147*3,      0,  // 125  0000 0000 1100
	172*3, 173*3,      0,  // 126  0000 0000 0101 1
	162*3, 158*3,      0,  // 127  0000 0000 0010 0
	170*3, 161*3,      0,  // 128  0000 0000 0110 0
	168*3, 166*3,      0,  // 129  0000 0000 0110 1
	157*3, 179*3,      0,  // 130  0000 0000 0101 0
	169*3, 167*3,      0,  // 131  0000 0000 0001 0
	174*3, 171*3,      0,  // 132  0000 0000 0011 0
	178*3, 177*3,      0,  // 133  0000 0000 0100 1
	156*3, 159*3,      0,  // 134  0000 0000 0011 1
	164*3, 165*3,      0,  // 135  0000 0000 0001 1
	183*3, 182*3,      0,  // 136  0000 0000 0010 1
	175*3, 176*3,      0,  // 137  0000 0000 0100 0
	    0,     0, 0x0107,  // 138  0000 0000 1010 1.
	    0,     0, 0x0a02,  // 139  0000 0000 1000 0.
	    0,     0, 0x0902,  // 140  0000 0000 1000 1.
	    0,     0, 0x1601,  // 141  0000 0000 1111 1.
	    0,     0, 0x1701,  // 142  0000 0000 1111 0.
	    0,     0, 0x1901,  // 143  0000 0000 1110 0.
	    0,     0, 0x1801,  // 144  0000 0000 1110 1.
	    0,     0, 0x0503,  // 145  0000 0000 1001 0.
	    0,     0, 0x0304,  // 146  0000 0000 1001 1.
	    0,     0, 0x000d,  // 147  0000 0000 1100 1.
	    0,     0, 0x000c,  // 148  0000 0000 1101 0.
	    0,     0, 0x000e,  // 149  0000 0000 1100 0.
	    0,     0, 0x000f,  // 150  0000 0000 1011 1.
	    0,     0, 0x0205,  // 151  0000 0000 1010 0.
	    0,     0, 0x1a01,  // 152  0000 0000 1101 1.
	    0,     0, 0x0106,  // 153  0000 0000 1011 0.
	180*3, 181*3,      0,  // 154  0000 0000 0111 1
	160*3, 163*3,      0,  // 155  0000 0000 0111 0
	196*3, 199*3,      0,  // 156  0000 0000 0011 10
	    0,     0, 0x001b,  // 157  0000 0000 0101 00.
	203*3, 185*3,      0,  // 158  0000 0000 0010 01
	202*3, 201*3,      0,  // 159  0000 0000 0011 11
	    0,     0, 0x0013,  // 160  0000 0000 0111 00.
	    0,     0, 0x0016,  // 161  0000 0000 0110 01.
	197*3, 207*3,      0,  // 162  0000 0000 0010 00
	    0,     0, 0x0012,  // 163  0000 0000 0111 01.
	191*3, 192*3,      0,  // 164  0000 0000 0001 10
	188*3, 190*3,      0,  // 165  0000 0000 0001 11
	    0,     0, 0x0014,  // 166  0000 0000 0110 11.
	184*3, 194*3,      0,  // 167  0000 0000 0001 01
	    0,     0, 0x0015,  // 168  0000 0000 0110 10.
	186*3, 193*3,      0,  // 169  0000 0000 0001 00
	    0,     0, 0x0017,  // 170  0000 0000 0110 00.
	204*3, 198*3,      0,  // 171  0000 0000 0011 01
	    0,     0, 0x0019,  // 172  0000 0000 0101 10.
	    0,     0, 0x0018,  // 173  0000 0000 0101 11.
	200*3, 205*3,      0,  // 174  0000 0000 0011 00
	    0,     0, 0x001f,  // 175  0000 0000 0100 00.
	    0,     0, 0x001e,  // 176  0000 0000 0100 01.
	    0,     0, 0x001c,  // 177  0000 0000 0100 11.
	    0,     0, 0x001d,  // 178  0000 0000 0100 10.
	    0,     0, 0x001a,  // 179  0000 0000 0101 01.
	    0,     0, 0x0011,  // 180  0000 0000 0111 10.
	    0,     0, 0x0010,  // 181  0000 0000 0111 11.
	189*3, 206*3,      0,  // 182  0000 0000 0010 11
	187*3, 195*3,      0,  // 183  0000 0000 0010 10
	218*3, 211*3,      0,  // 184  0000 0000 0001 010
	    0,     0, 0x0025,  // 185  0000 0000 0010 011.
	215*3, 216*3,      0,  // 186  0000 0000 0001 000
	    0,     0, 0x0024,  // 187  0000 0000 0010 100.
	210*3, 212*3,      0,  // 188  0000 0000 0001 110
	    0,     0, 0x0022,  // 189  0000 0000 0010 110.
	213*3, 209*3,      0,  // 190  0000 0000 0001 111
	221*3, 222*3,      0,  // 191  0000 0000 0001 100
	219*3, 208*3,      0,  // 192  0000 0000 0001 101
	217*3, 214*3,      0,  // 193  0000 0000 0001 001
	223*3, 220*3,      0,  // 194  0000 0000 0001 011
	    0,     0, 0x0023,  // 195  0000 0000 0010 101.
	    0,     0, 0x010b,  // 196  0000 0000 0011 100.
	    0,     0, 0x0028,  // 197  0000 0000 0010 000.
	    0,     0, 0x010c,  // 198  0000 0000 0011 011.
	    0,     0, 0x010a,  // 199  0000 0000 0011 101.
	    0,     0, 0x0020,  // 200  0000 0000 0011 000.
	    0,     0, 0x0108,  // 201  0000 0000 0011 111.
	    0,     0, 0x0109,  // 202  0000 0000 0011 110.
	    0,     0, 0x0026,  // 203  0000 0000 0010 010.
	    0,     0, 0x010d,  // 204  0000 0000 0011 010.
	    0,     0, 0x010e,  // 205  0000 0000 0011 001.
	    0,     0, 0x0021,  // 206  0000 0000 0010 111.
	    0,     0, 0x0027,  // 207  0000 0000 0010 001.
	    0,     0, 0x1f01,  // 208  0000 0000 0001 1011.
	    0,     0, 0x1b01,  // 209  0000 0000 0001 1111.
	    0,     0, 0x1e01,  // 210  0000 0000 0001 1100.
	    0,     0, 0x1002,  // 211  0000 0000 0001 0101.
	    0,     0, 0x1d01,  // 212  0000 0000 0001 1101.
	    0,     0, 0x1c01,  // 213  0000 0000 0001 1110.
	    0,     0, 0x010f,  // 214  0000 0000 0001 0011.
	    0,     0, 0x0112,  // 215  0000 0000 0001 0000.
	    0,     0, 0x0111,  // 216  0000 0000 0001 0001.
	    0,     0, 0x0110,  // 217  0000 0000 0001 0010.
	    0,     0, 0x0603,  // 218  0000 0000 0001 0100.
	    0,     0, 0x0b02,  // 219  0000 0000 0001 1010.
	    0,     0, 0x0e02,  // 220  0000 0000 0001 0111.
	    0,     0, 0x0d02,  // 221  0000 0000 0001 1000.
	    0,     0, 0x0c02,  // 222  0000 0000 0001 1001.
	    0,     0, 0x0f02   // 223  0000 0000 0001 0110.
]);

MPEG2.PICTURE_TYPE = {
	INTRA: 1,
	PREDICTIVE: 2,
	B: 3
};

MPEG2.START = {
	SEQUENCE: 0xB3,
	SLICE_FIRST: 0x01,
	SLICE_LAST: 0xAF,
	PICTURE: 0x00,
	EXTENSION: 0xB5,
	USER_DATA: 0xB2
};

return MPEG2;

})();
