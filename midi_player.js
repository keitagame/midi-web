'use strict';
/* =========================================================================
 *  SoundFont MIDI Player - No external libraries
 *  - Binary reader utility
 *  - Standard MIDI File (SMF) parser
 *  - SoundFont2 (.sf2) RIFF parser
 *  - Simple wavetable synthesizer (Web Audio API)
 *  - Sequencer / scheduler
 * ========================================================================= */

/* ------------------------- Binary Reader ------------------------------- */
class ByteReader {
  constructor(arrayBuffer) {
    this.dv = new DataView(arrayBuffer);
    this.buf = new Uint8Array(arrayBuffer);
    this.pos = 0;
    this.length = arrayBuffer.byteLength;
  }
  get remaining() { return this.length - this.pos; }
  seek(p) { this.pos = p; }
  skip(n) { this.pos += n; }
  eof() { return this.pos >= this.length; }

  u8() { const v = this.dv.getUint8(this.pos); this.pos += 1; return v; }
  s8() { const v = this.dv.getInt8(this.pos); this.pos += 1; return v; }
  u16le() { const v = this.dv.getUint16(this.pos, true); this.pos += 2; return v; }
  u16be() { const v = this.dv.getUint16(this.pos, false); this.pos += 2; return v; }
  s16le() { const v = this.dv.getInt16(this.pos, true); this.pos += 2; return v; }
  u32le() { const v = this.dv.getUint32(this.pos, true); this.pos += 4; return v; }
  u32be() { const v = this.dv.getUint32(this.pos, false); this.pos += 4; return v; }

  bytes(n) { const v = this.buf.subarray(this.pos, this.pos + n); this.pos += n; return v; }
  ascii(n) {
    const b = this.bytes(n);
    let s = '';
    for (let i = 0; i < b.length; i++) { if (b[i] === 0) break; s += String.fromCharCode(b[i]); }
    return s;
  }
  // MIDI variable-length quantity
  vlq() {
    let value = 0, byte;
    do {
      byte = this.u8();
      value = (value << 7) | (byte & 0x7f);
    } while (byte & 0x80);
    return value >>> 0;
  }
}

/* ------------------------- MIDI Parser ---------------------------------
 * Parses a Standard MIDI File into:
 * {
 *   formatType, trackCount, division, ticksPerBeat (or SMPTE flag),
 *   tracks: [ { events: [ {tick, deltaTime, type, ...} ] } ]
 * }
 * ------------------------------------------------------------------------ */
class MidiFile {
  constructor(arrayBuffer) {
    const r = new ByteReader(arrayBuffer);

    const headerId = r.ascii(4);
    if (headerId !== 'MThd') throw new Error('MIDIヘッダが見つかりません (MThd)');
    const headerLen = r.u32be();
    this.formatType = r.u16be();
    this.trackCount = r.u16be();
    const division = r.u16be();

    if (division & 0x8000) {
      // SMPTE format (rare) - fps and ticks per frame
      const fps = -((division >> 8) << 24 >> 24); // sign-extend top byte
      const tpf = division & 0xff;
      this.smpte = true;
      this.fps = fps;
      this.ticksPerFrame = tpf;
      this.ticksPerBeat = tpf * fps; // approximation for scheduling fallback
    } else {
      this.smpte = false;
      this.ticksPerBeat = division;
    }

    if (headerLen > 6) r.skip(headerLen - 6);

    this.tracks = [];
    for (let t = 0; t < this.trackCount; t++) {
      if (r.eof()) break;
      const chunkId = r.ascii(4);
      const chunkLen = r.u32be();
      if (chunkId !== 'MTrk') {
        // Unknown chunk, skip it
        r.skip(chunkLen);
        t--; // don't count as a track
        continue;
      }
      const trackEnd = r.pos + chunkLen;
      const events = [];
      let tick = 0;
      let runningStatus = null;

      while (r.pos < trackEnd) {
        const delta = r.vlq();
        tick += delta;
        let statusByte = r.u8();

        if (statusByte < 0x80) {
          // running status: reuse previous status, this byte is actual data
          r.pos -= 1;
          statusByte = runningStatus;
        } else if (statusByte < 0xF0) {
          runningStatus = statusByte;
        }

        const type = statusByte & 0xF0;
        const channel = statusByte & 0x0F;

        if (statusByte === 0xFF) {
          // Meta event
          runningStatus = null; // ★追加: メタイベント後はランニングステータス破棄
          const metaType = r.u8();
          const len = r.vlq();
          const data = r.bytes(len);
          const ev = { tick, deltaTime: delta, meta: true, metaType, data };
          if (metaType === 0x51 && len === 3) {
            ev.tempoMPQ = (data[0] << 16) | (data[1] << 8) | data[2];
          } else if (metaType === 0x2F) {
            ev.endOfTrack = true;
          } else if (metaType === 0x58 && len === 4) {
            ev.timeSig = { numerator: data[0], denominator: 1 << data[1], clocks: data[2], b32nds: data[3] };
          } else if ([0x01,0x02,0x03,0x04,0x05,0x06,0x07].includes(metaType)) {
            ev.text = bytesToUtf8(data);
          }
          events.push(ev);
        } else if (statusByte === 0xF0 || statusByte === 0xF7) {
          // SysEx event
          runningStatus = null;
          const len = r.vlq();
          const data = r.bytes(len);
          events.push({ tick, deltaTime: delta, sysex: true, data });
        } else {
          // Channel voice/mode message
          let d1, d2;
          switch (type) {
            case 0x80: // note off
              d1 = r.u8(); d2 = r.u8();
              events.push({ tick, deltaTime: delta, type: 'noteOff', channel, note: d1, velocity: d2 });
              break;
            case 0x90: // note on
              d1 = r.u8(); d2 = r.u8();
              if (d2 === 0) {
                events.push({ tick, deltaTime: delta, type: 'noteOff', channel, note: d1, velocity: 0 });
              } else {
                events.push({ tick, deltaTime: delta, type: 'noteOn', channel, note: d1, velocity: d2 });
              }
              break;
            case 0xA0: // poly aftertouch
              d1 = r.u8(); d2 = r.u8();
              events.push({ tick, deltaTime: delta, type: 'polyAftertouch', channel, note: d1, value: d2 });
              break;
            case 0xB0: // control change
              d1 = r.u8(); d2 = r.u8();
              events.push({ tick, deltaTime: delta, type: 'controlChange', channel, controller: d1, value: d2 });
              break;
            case 0xC0: // program change
              d1 = r.u8();
              events.push({ tick, deltaTime: delta, type: 'programChange', channel, program: d1 });
              break;
            case 0xD0: // channel aftertouch
              d1 = r.u8();
              events.push({ tick, deltaTime: delta, type: 'channelAftertouch', channel, value: d1 });
              break;
            case 0xE0: // pitch bend
              d1 = r.u8(); d2 = r.u8();
              const bend = ((d2 << 7) | d1) - 8192;
              events.push({ tick, deltaTime: delta, type: 'pitchBend', channel, value: bend });
              break;
            default:
              // Unknown status; try to resync by stopping this track
              r.pos = trackEnd;
              break;
          }
        }
      }
      r.pos = trackEnd;
      this.tracks.push({ events });
    }
  }
}

function bytesToUtf8(bytes) {
  try { return new TextDecoder('utf-8').decode(bytes); }
  catch (e) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }
}

/* ========================================================================
 *  SoundFont2 (.sf2) Parser
 *  Reference: SoundFont Technical Specification 2.04
 *  RIFF structure:
 *   RIFF sfbk
 *     LIST INFO
 *     LIST sdta   -> smpl (raw 16-bit PCM sample data), sm24 (optional)
 *     LIST pdta   -> phdr, pbag, pmod, pgen, inst, ibag, imod, igen, shdr
 * ======================================================================== */

// Generator operator IDs we care about (SF2 spec table 8.1)
const GEN = {
  startAddrsOffset: 0, endAddrsOffset: 1, startloopAddrsOffset: 2, endloopAddrsOffset: 3,
  startAddrsCoarseOffset: 4, modLfoToPitch: 5, vibLfoToPitch: 6, modEnvToPitch: 7,
  initialFilterFc: 8, initialFilterQ: 9, modLfoToFilterFc: 10, modEnvToFilterFc: 11,
  endAddrsCoarseOffset: 12, modLfoToVolume: 13, chorusEffectsSend: 15, reverbEffectsSend: 16,
  pan: 17, delayModLFO: 21, freqModLFO: 22, delayVibLFO: 23, freqVibLFO: 24,
  delayModEnv: 25, attackModEnv: 26, holdModEnv: 27, decayModEnv: 28, sustainModEnv: 29, releaseModEnv: 30,
  keynumToModEnvHold: 31, keynumToModEnvDecay: 32,
  delayVolEnv: 33, attackVolEnv: 34, holdVolEnv: 35, decayVolEnv: 36, sustainVolEnv: 37, releaseVolEnv: 38,
  keynumToVolEnvHold: 39, keynumToVolEnvDecay: 40,
  instrument: 41, keyRange: 43, velRange: 44,
  startloopAddrsCoarseOffset: 45, keynum: 46, velocity: 47, initialAttenuation: 48,
  endloopAddrsCoarseOffset: 50, coarseTune: 51, fineTune: 52, sampleID: 53, sampleModes: 54,
  scaleTuning: 56, exclusiveClass: 57, overridingRootKey: 58
};

class SF2Parser {
  constructor(arrayBuffer) {
    this.r = new ByteReader(arrayBuffer);
    this.info = {};
    this.sampleData = null; // Int16Array of all samples concatenated
    this.presets = [];      // from phdr
    this.presetBags = [];   // pbag
    this.presetGens = [];   // pgen
    this.presetMods = [];   // pmod
    this.instruments = [];  // inst
    this.instBags = [];     // ibag
    this.instGens = [];     // igen
    this.instMods = [];     // imod
    this.samples = [];      // shdr

    this._parseRIFF();
    this._buildPresets();
  }

  _parseRIFF() {
    const r = this.r;
    const riff = r.ascii(4);
    if (riff !== 'RIFF') throw new Error('SF2ファイルではありません(RIFFヘッダ無し)');
    const totalLen = r.u32le();
    const form = r.ascii(4);
    if (form !== 'sfbk') throw new Error('SF2ファイルではありません(sfbk無し)');

    const end = r.pos + totalLen - 4;
    while (r.pos < end && r.pos < r.length - 8) {
      const chunkId = r.ascii(4);
      const chunkLen = r.u32le();
      const chunkEnd = r.pos + chunkLen;
      if (chunkId === 'LIST') {
        const listType = r.ascii(4);
        if (listType === 'INFO') {
          this._parseInfo(chunkEnd);
        } else if (listType === 'sdta') {
          this._parseSdta(chunkEnd);
        } else if (listType === 'pdta') {
          this._parsePdta(chunkEnd);
        } else {
          r.pos = chunkEnd;
        }
      } else {
        r.pos = chunkEnd;
      }
      // chunks are word-aligned
      if (chunkLen % 2 === 1) r.pos += 1;
    }
  }

  _parseInfo(end) {
    const r = this.r;
    while (r.pos < end) {
      const id = r.ascii(4);
      const len = r.u32le();
      const chunkEnd = r.pos + len;
      if (id === 'INAM') this.info.name = r.ascii(len).replace(/\0+$/, '');
      else r.pos = chunkEnd;
      r.pos = chunkEnd;
      if (len % 2 === 1) r.pos += 1;
    }
  }

  _parseSdta(end) {
    const r = this.r;
    while (r.pos < end) {
      const id = r.ascii(4);
      const len = r.u32le();
      const chunkEnd = r.pos + len;
      if (id === 'smpl') {
        // 16-bit signed PCM, little-endian, mono, concatenated samples
        const bytes = r.bytes(len);
        this.sampleData = new Int16Array(bytes.buffer, bytes.byteOffset, len / 2);
      } else {
        r.pos = chunkEnd;
      }
      r.pos = chunkEnd;
      if (len % 2 === 1) r.pos += 1;
    }
  }

  _parsePdta(end) {
    const r = this.r;
    while (r.pos < end) {
      const id = r.ascii(4);
      const len = r.u32le();
      const chunkEnd = r.pos + len;
      switch (id) {
        case 'phdr': this._readPhdr(len); break;
        case 'pbag': this._readBag(len, this.presetBags); break;
        case 'pmod': this._readMod(len, this.presetMods); break;
        case 'pgen': this._readGen(len, this.presetGens); break;
        case 'inst': this._readInst(len); break;
        case 'ibag': this._readBag(len, this.instBags); break;
        case 'imod': this._readMod(len, this.instMods); break;
        case 'igen': this._readGen(len, this.instGens); break;
        case 'shdr': this._readShdr(len); break;
        default: r.pos = chunkEnd;
      }
      r.pos = chunkEnd;
      if (len % 2 === 1) r.pos += 1;
    }
  }

  _readPhdr(len) {
    const r = this.r;
    const count = len / 38;
    for (let i = 0; i < count; i++) {
      const name = r.ascii(20);
      const preset = r.u16le();
      const bank = r.u16le();
      const bagIndex = r.u16le();
      r.skip(4 + 4 + 4); // library, genre, morphology (dwords, unused)
      this.presets.push({ name, preset, bank, bagIndex });
    }
  }

  _readBag(len, arr) {
    const r = this.r;
    const count = len / 4;
    for (let i = 0; i < count; i++) {
      const genIndex = r.u16le();
      const modIndex = r.u16le();
      arr.push({ genIndex, modIndex });
    }
  }

  _readMod(len, arr) {
    const r = this.r;
    const count = len / 10;
    for (let i = 0; i < count; i++) {
      const srcOper = r.u16le();
      const destOper = r.u16le();
      const amount = r.s16le();
      const amtSrcOper = r.u16le();
      const transOper = r.u16le();
      arr.push({ srcOper, destOper, amount, amtSrcOper, transOper });
    }
  }

  _readGen(len, arr) {
    const r = this.r;
    const count = len / 4;
    for (let i = 0; i < count; i++) {
      const oper = r.u16le();
      // amount can be signed short, or two unsigned bytes (range), read raw and interpret later
      const lo = r.u8(), hi = r.u8();
      arr.push({ oper, lo, hi, amount: (hi << 8) | lo, signedAmount: ((hi << 8) | lo) << 16 >> 16 });
    }
  }

  _readInst(len) {
    const r = this.r;
    const count = len / 22;
    for (let i = 0; i < count; i++) {
      const name = r.ascii(20);
      const bagIndex = r.u16le();
      this.instruments.push({ name, bagIndex });
    }
  }

  _readShdr(len) {
    const r = this.r;
    const count = len / 46;
    for (let i = 0; i < count; i++) {
      const name = r.ascii(20);
      const start = r.u32le();
      const end = r.u32le();
      const startLoop = r.u32le();
      const endLoop = r.u32le();
      const sampleRate = r.u32le();
      const originalPitch = r.u8();
      const pitchCorrection = r.s8();
      const sampleLink = r.u16le();
      const sampleType = r.u16le();
      this.samples.push({
        name, start, end, startLoop, endLoop, sampleRate,
        originalPitch, pitchCorrection, sampleLink, sampleType
      });
    }
  }

  /* ---- Build usable preset -> instrument -> sample zone structure ---- */
  _buildPresets() {
    // Helper to extract zones (list of gen-maps) from a bag range
    const extractZones = (bagArr, genArr, modArr, startBag, endBag) => {
      const zones = [];
      for (let b = startBag; b < endBag; b++) {
        const bag = bagArr[b];
        const nextBag = bagArr[b + 1];
        const genStart = bag.genIndex;
        const genEnd = nextBag ? nextBag.genIndex : genArr.length;
        const gens = {};
        let instrumentId = null, sampleId = null;
        for (let g = genStart; g < genEnd; g++) {
          const gen = genArr[g];
          if (gen.oper === GEN.instrument) instrumentId = gen.amount;
          else if (gen.oper === GEN.sampleID) sampleId = gen.amount;
          else gens[gen.oper] = gen;
        }
        zones.push({ gens, instrumentId, sampleId });
      }
      return zones;
    };

    // Build instrument zone table (each instrument -> list of zones with sampleId)
    this._instrumentZones = this.instruments.map((inst, idx) => {
      const nextInst = this.instruments[idx + 1];
      const startBag = inst.bagIndex;
      const endBag = nextInst ? nextInst.bagIndex : this.instBags.length;
      return extractZones(this.instBags, this.instGens, this.instMods, startBag, endBag);
    });

    // Build preset zone table (each preset -> list of zones referencing instruments)
    this._presetZonesByIndex = this.presets.map((p, idx) => {
      const next = this.presets[idx + 1];
      const startBag = p.bagIndex;
      const endBag = next ? next.bagIndex : this.presetBags.length;
      return extractZones(this.presetBags, this.presetGens, this.presetMods, startBag, endBag);
    });
  }

 findPreset(bank, program) {
  // ドラムバンク（128）の処理
  if (bank === 128) {
    for (let i = 0; i < this.presets.length; i++) {
      if (this.presets[i].bank === 128 && this.presets[i].preset === program) return i;
    }
    for (let i = 0; i < this.presets.length; i++) {
      if (this.presets[i].bank === 128 && this.presets[i].preset === 0) return i;
    }
  }

  // 通常楽器の処理
  // 1. 指定バンク・指定プログラムの一致
  for (let i = 0; i < this.presets.length; i++) {
    if (this.presets[i].bank === bank && this.presets[i].preset === program) return i;
  }
  // 2. Bank 0（標準バンク）の指定プログラム（ピアノ化を防ぐ重要処理）
  for (let i = 0; i < this.presets.length; i++) {
    if (this.presets[i].bank === 0 && this.presets[i].preset === program) return i;
  }
  // 3. どうしても音色が存在しない場合のみ Program 0 (ピアノ) へ
  for (let i = 0; i < this.presets.length; i++) {
    if (this.presets[i].preset === 0) return i;
  }
  return this.presets.length ? 0 : -1;
}
 
   getZonesForNote(presetIndex, note, velocity) {
  const pzones = this._presetZonesByIndex[presetIndex];
  if (!pzones) return [];

  let presetGlobalGens = {};
  const matchingPresetZones = [];
  for (let i = 0; i < pzones.length; i++) {
    const z = pzones[i];
    if (i === 0 && z.instrumentId === null) {
      presetGlobalGens = z.gens;
      continue;
    }
    if (z.instrumentId === null) continue;

    const combinedGens = { ...presetGlobalGens, ...z.gens };
    if (this._zoneMatches(combinedGens, note, velocity)) {
      matchingPresetZones.push({ z, combinedGens });
    }
  }

  const OVERRIDE_GENS = new Set([
    GEN.overridingRootKey, GEN.keynum, GEN.velocity,
    GEN.sampleModes, GEN.exclusiveClass, GEN.sampleID
  ]);

  const results = [];
  for (const { z: pz, combinedGens: pGens } of matchingPresetZones) {
    const izones = this._instrumentZones[pz.instrumentId] || [];
    let instGlobalGens = {};

    for (let j = 0; j < izones.length; j++) {
      const iz = izones[j];
      if (j === 0 && iz.sampleId === null) {
        instGlobalGens = iz.gens;
        continue;
      }
      if (iz.sampleId === null) continue;

      const combinedInstGens = { ...instGlobalGens, ...iz.gens };
      if (!this._zoneMatches(combinedInstGens, note, velocity)) continue;

      const sample = this.samples[iz.sampleId];
      if (!sample) continue;

      const merged = {};
      for (const k in combinedInstGens) {
        merged[k] = combinedInstGens[k].signedAmount;
      }

      for (const k in pGens) {
        const oper = Number(k);
        if (oper === GEN.keyRange || oper === GEN.velRange) continue;

        const pVal = pGens[k].signedAmount;
        if (OVERRIDE_GENS.has(oper)) {
          // -1 (非設定値) でなければ上書き
          if (pVal !== undefined && pVal !== -1) merged[k] = pVal;
        } else {
          merged[k] = (merged[k] !== undefined ? merged[k] : 0) + pVal;
        }
      }

      results.push({ sample, gens: merged });
    }
  }
  return results;
}
  _zoneMatches(gens, note, velocity) {
    const kr = gens[GEN.keyRange];
    if (kr) { if (note < kr.lo || note > kr.hi) return false; }
    const vr = gens[GEN.velRange];
    if (vr) { if (velocity < vr.lo || velocity > vr.hi) return false; }
    return true;
  }
}

/* ========================================================================
 *  Synthesizer
 *  - Converts SF2 sample zones into AudioBuffers (cached per sample header)
 *  - Plays notes with pitch shift (playbackRate), volume envelope (GainNode
 *    scheduled ADSR via linear/exponential ramps), pan, loop points.
 *  - One AudioBufferSourceNode + GainNode + PannerNode per active note.
 * ======================================================================== */

// Convert SF2 "timecents" to seconds: seconds = 2^(timecents/1200)
function timecentsToSeconds(tc) {
  if (tc === undefined || tc === -32768) return 0;
  return Math.pow(2, tc / 1200);
}
// Convert SF2 "centibels" attenuation to linear gain: gain = 10^(-cb/200)
function centibelsToGain(cb) {
  if (cb === undefined) return 1;
  return Math.pow(10, -cb / 200);
}

class SF2Synth {
  constructor(audioCtx, sf2) {
    this.ctx = audioCtx;
    this.sf2 = sf2;
    this._bufferCache = new Map(); // sampleIndex -> AudioBuffer
    this.masterGain = audioCtx.createGain();
    this.masterGain.gain.value = 0.3;
    this.masterGain.connect(audioCtx.destination);

    // 16 MIDI channels, each with program (bank/preset), pan, volume, pitch bend, etc.
    this.channels = [];
  for (let i = 0; i < 16; i++) {
  this.channels.push({
    bank: 0, program: 0, presetIndex: -1,
    volume: 100, expression: 127, pan: 64,
    pitchBend: 0, pitchBendRangeSemitones: 2,
    fineTune: 0, coarseTune: 0,
    sustain: false, sostenuto: false, softPedal: false,
    cutoff: 64, resonance: 64, attackOffset: 0, releaseOffset: 0,
    rpnMSB: 127, rpnLSB: 127,
    drum: (i === 9)
  });
  this.setProgram(i, i === 9 ? 128 : 0, 0);
}// SF2Synth コンストラクタ内

    this.activeVoices = new Map(); // key `${channel}_${note}` -> [voice,...]
  }
setChannelPitchBend(channel, value) {
  const ch = this.channels[channel];
  ch.pitchBend = value;
  this._updateChannelVoices(channel, (v) => this._updateVoicePitch(v, ch));
}

// リアルタイム・音量/パン更新
setChannelVolume(channel, value) {
  this.channels[channel].volume = value;
  this._updateChannelVoices(channel, (v) => this._updateVoiceGain(v, this.channels[channel]));
}
setChannelExpression(channel, value) {
  this.channels[channel].expression = value;
  this._updateChannelVoices(channel, (v) => this._updateVoiceGain(v, this.channels[channel]));
}
setChannelPan(channel, value) {
  this.channels[channel].pan = value;
  if (this.ctx.createStereoPanner) {
    this._updateChannelVoices(channel, (v) => {
      if (v.panNode) v.panNode.pan.value = Math.max(-1, Math.min(1, (value - 64) / 63));
    });
  }
}
_updateChannelVoices(channel, callback) {
  for (const [key, voiceList] of this.activeVoices.entries()) {
    if (Number(key.split('_')[0]) === channel) {
      for (const v of voiceList) callback(v);
    }
  }
}
_updateVoicePitch(v, ch) {
    const bendSemis = (ch.pitchBend / 8192) * ch.pitchBendRangeSemitones;
    const targetNote = v.targetNote !== undefined ? v.targetNote : v.note;
    const semitoneOffset = (targetNote - v.rootKey) * (v.scaleTuning / 100) + v.coarseTune + ch.coarseTune + bendSemis;
    const centsOffset = v.fineTune + v.pitchCorrection + ch.fineTune;
    const playbackRate = Math.pow(2, (semitoneOffset + centsOffset / 100) / 12);
    if (v.source && v.source.playbackRate) {
      v.source.playbackRate.setValueAtTime(Math.max(0.001, playbackRate), this.ctx.currentTime);
    }
  }_updateVoiceGain(v, ch) {
  // v.velocity を参照（未定義時は100をデフォルトに）
  const vel = (v && v.velocity !== undefined) ? v.velocity : 100;
  const velGain = vel / 127;

  const softFactor = ch.softPedal ? 0.6 : 1.0;
  const volRatio =
    (ch.volume !== undefined ? ch.volume : 100) / 127;

const expRatio =
    (ch.expression !== undefined ? ch.expression : 127) / 127;

const channelVolGain =
    volRatio *
    expRatio *
    softFactor;
  const attenGain = v.attenGain !== undefined ? v.attenGain : 1.0;
  const sustainLevel = v.sustainLevel !== undefined ? v.sustainLevel : 1.0;

  const peakGain = attenGain * velGain * channelVolGain;
  const finalGain = peakGain * sustainLevel;

  if (v.gainNode && v.gainNode.gain && Number.isFinite(finalGain)) {
    v.gainNode.gain.setValueAtTime(Math.max(finalGain, 0.0001), this.ctx.currentTime);
  }
}
// 特定チャンネルの即時完全消音 (CC 120 All Sound Off 用)
allSoundOff(channel) {
  for (const [key, voiceList] of this.activeVoices.entries()) {
    if (Number(key.split('_')[0]) === channel) {
      for (const v of voiceList) {
        try { v.source.stop(); } catch (e) {}
      }
      this.activeVoices.delete(key);
    }
  }
}
  setProgram(channel, bank, program) {
    const ch = this.channels[channel];
    ch.bank = bank;
    ch.program = program;
    
    const searchBank = ch.drum ? 128 : bank;
    const idx = this.sf2.findPreset(searchBank, program);
    ch.presetIndex = idx;
  }

  _getBuffer(sampleHeader) {
    const cacheKey = sampleHeader.start; // unique per sample start offset
    if (this._bufferCache.has(cacheKey)) return this._bufferCache.get(cacheKey);
    const data = this.sf2.sampleData;
    if (!data) return null;

    const startAdj = sampleHeader.start;
    const endAdj = sampleHeader.end;
    const length = Math.max(0, endAdj - startAdj);
    if (length <= 0) return null;

    const sampleRate = sampleHeader.sampleRate || 44100;
    const audioBuffer = this.ctx.createBuffer(1, length, sampleRate);
    const channelData = audioBuffer.getChannelData(0);
    for (let i = 0; i < length; i++) {
      channelData[i] = data[startAdj + i] / 32768;
    }
    this._bufferCache.set(cacheKey, audioBuffer);
    return audioBuffer;
  }

  noteOn(channel, note, velocity, time) {
    const ch = this.channels[channel];
    if (ch.presetIndex === -1 || ch.presetIndex === undefined) return;
    const zones = this.sf2.getZonesForNote(ch.presetIndex, note, velocity);
    if (!zones.length) return;

    const key = `${channel}_${note}`;
    if (!this.activeVoices.has(key)) this.activeVoices.set(key, []);
    const voiceList = this.activeVoices.get(key);

    for (const zone of zones) {
      const voice = this._startVoice(ch, channel, note, velocity, zone, time);
      if (voice) voiceList.push(voice);
    }
  }

  _startVoice(ch, channel, note, velocity, zone, time) {
    const buffer = this._getBuffer(zone.sample);
  if (!buffer) return null;
  const gens = zone.gens;
  const sample = zone.sample;

  const src = this.ctx.createBufferSource();
  src.buffer = buffer;

    // Loop handling
    const sampleModes = gens[GEN.sampleModes] !== undefined ? gens[GEN.sampleModes] : 0;
    const doLoop = (sampleModes === 1 || sampleModes === 3);
    if (doLoop) {
      src.loop = true;
      const loopStartOffset = (gens[GEN.startloopAddrsCoarseOffset] || 0) * 32768 + (gens[GEN.startloopAddrsOffset] || 0);
      const loopEndOffset = (gens[GEN.endloopAddrsCoarseOffset] || 0) * 32768 + (gens[GEN.endloopAddrsOffset] || 0);
      const loopStartSample = sample.startLoop - sample.start + loopStartOffset;
      const loopEndSample = sample.endLoop - sample.start + loopEndOffset;
      src.loopStart = Math.max(0, loopStartSample / sample.sampleRate);
      src.loopEnd = Math.max(src.loopStart + 0.001, loopEndSample / sample.sampleRate);
    }

    // Pitch calculation
    const rootKeyGen = gens[GEN.overridingRootKey];
  const sampleOriginalPitch = (sample.originalPitch >= 128 || sample.originalPitch < 0) ? 60 : sample.originalPitch;
  const rootKey = (rootKeyGen !== undefined && rootKeyGen >= 0 && rootKeyGen <= 127) ? rootKeyGen : sampleOriginalPitch;

  const keynumGen = gens[GEN.keynum];
  const targetNote = (keynumGen !== undefined && keynumGen >= 0 && keynumGen <= 127) ? keynumGen : note;

  const coarseTune = gens[GEN.coarseTune] || 0;
  const fineTune = gens[GEN.fineTune] || 0;
  const pitchCorrection = sample.pitchCorrection || 0;
  const scaleTuning = gens[GEN.scaleTuning] !== undefined ? gens[GEN.scaleTuning] : 100;

  const bendSemis = (ch.pitchBend / 8192) * ch.pitchBendRangeSemitones;
  const semitoneOffset = (targetNote - rootKey) * (scaleTuning / 100) + coarseTune + ch.coarseTune + bendSemis;
  const centsOffset = fineTune + pitchCorrection + ch.fineTune;
  const playbackRate = Math.pow(2, (semitoneOffset + centsOffset / 100) / 12);
  src.playbackRate.value = Math.max(0.001, playbackRate);

    // Gain staging
    const gainNode = this.ctx.createGain();
    const initialAtten = gens[GEN.initialAttenuation] || 0;
    const attenGain = centibelsToGain(initialAtten);
   const velGain = velocity / 127;
const volRatio = ch.volume / 127;
const expRatio = ch.expression / 127;

const channelVolGain =
    volRatio *
    expRatio;
    
    // Pan
    // SF2Synth._startVoice 内の Pan 処理部分
let panGen = gens[GEN.pan] !== undefined ? gens[GEN.pan] : 0; // -500..500
const channelPan = (ch.pan - 64) / 63; // -1..1

// 修正: signedAmount 化された panGen を正しく -1.0 〜 +1.0 に変換
let panValue = Math.max(-1, Math.min(1, (panGen / 500) + channelPan));

let panNode = null;
let outputNode = gainNode;
if (this.ctx.createStereoPanner) {
  panNode = this.ctx.createStereoPanner();
  panNode.pan.value = panValue;
  gainNode.connect(panNode);
  outputNode = panNode;
}
    outputNode.connect(this.masterGain);
    src.connect(gainNode);

    // Volume envelope (simplified DAHDSR -> we implement Delay/Attack/Hold/Decay/Sustain, release handled on noteOff)
    const delay = timecentsToSeconds(gens[GEN.delayVolEnv]);
    const attack = timecentsToSeconds(gens[GEN.attackVolEnv]);
    const hold = timecentsToSeconds(gens[GEN.holdVolEnv]);
    const decay = timecentsToSeconds(gens[GEN.decayVolEnv]);
   const sustainCb = gens[GEN.sustainVolEnv] !== undefined ? gens[GEN.sustainVolEnv] : 0;
const sustainLevel = centibelsToGain(sustainCb);
    const release = timecentsToSeconds(gens[GEN.releaseVolEnv]);

    const peakGain = attenGain * velGain * channelVolGain;
    const g = gainNode.gain;
    const t0 = time + delay;
    g.setValueAtTime(0.0001, time);
    g.setValueAtTime(0.0001, t0);
    g.linearRampToValueAtTime(Math.max(peakGain, 0.0001), t0 + attack);
    const holdEnd = t0 + attack + hold;
    g.setValueAtTime(Math.max(peakGain, 0.0001), holdEnd);
    const decayEnd = holdEnd + decay;
    const sustainGain = Math.max(peakGain * sustainLevel, 0.0001);
    g.linearRampToValueAtTime(sustainGain, decayEnd);

    src.start(time);
return {
    source: src, gainNode, panNode, release: Math.max(release, 0.01),
    sustainGain, sustainLevel, note, targetNote, channel, started: true, buffer,
    rootKey, coarseTune, fineTune, scaleTuning, pitchCorrection, attenGain, velocity
  };
  }

  noteOff(channel, note, time) {
    const key = `${channel}_${note}`;
    const voiceList = this.activeVoices.get(key);
    if (!voiceList) return;
    const ch = this.channels[channel];
    if (ch.sustain) {
      voiceList._heldBySustainOnly = true; // ★この行を追加
      return;
    }

    for (const voice of voiceList) {
      this._releaseVoice(voice, time);
    }
    this.activeVoices.delete(key);
  }
_releaseVoice(voice, time) {
    const g = voice.gainNode.gain;
    try {
      if (g.cancelAndHoldAtTime) {
        g.cancelAndHoldAtTime(time);
      } else {
        g.cancelScheduledValues(time);
        g.setValueAtTime(g.value, time);
      }
      // リリース時間が長すぎる SoundFont 対策（最大1.5秒に制限）
      const rel = Math.min(voice.release || 0.01, 0.2);
      g.linearRampToValueAtTime(0.000, time + rel);
      voice.source.stop(time + rel + 0.005);
    } catch (e) { /* ignore */ }
  }

  channelSustainOff(channel, time) {
    const ch = this.channels[channel];
    ch.sustain = false;
    // release any notes on this channel that are no longer physically held
    for (const [key, voiceList] of this.activeVoices.entries()) {
      if (Number(key.split('_')[0]) !== channel) continue;
      if (voiceList._heldBySustainOnly) {
        for (const voice of voiceList) this._releaseVoice(voice, time);
        this.activeVoices.delete(key);
      }
    }
  }

  allNotesOff(time) {
    for (const [key, voiceList] of this.activeVoices.entries()) {
      for (const voice of voiceList) this._releaseVoice(voice, time || this.ctx.currentTime);
    }
    this.activeVoices.clear();
  }

  panic() {
    for (const [key, voiceList] of this.activeVoices.entries()) {
      for (const voice of voiceList) {
        try { voice.source.stop(); } catch (e) {}
      }
    }
    this.activeVoices.clear();
  }
setChannelSustain(channel, on) { this.channels[channel].sustain = on; }
}

/* ========================================================================
 *  Sequencer
 *  Converts MIDI ticks to seconds using tempo map, flattens all tracks into
 *  a single sorted event timeline, and schedules playback using
 *  AudioContext's clock via a lookahead scheduler (like a mini tracker).
 * ======================================================================== */
class MidiSequencer {
  constructor(audioCtx, synth, midiFile) {
    this.ctx = audioCtx;
    this.synth = synth;
    this.midi = midiFile;

    this.events = [];        // flattened, sorted by tick: {tick,timeSec,...}
    this.durationSec = 0;
    this.trackInfo = [];     // per-track metadata for UI (name, channel usage, mute)
    this.mutedTracks = new Set();

    this._buildTimeline();

    this.isPlaying = false;
    this.isPaused = false;
    this.startCtxTime = 0;   // ctx.currentTime corresponding to playback position 0 offset
    this.pauseOffset = 0;    // seconds into the song where paused
    this.schedulerTimer = null;
    this.scheduledIndex = 0;
    this.lookahead = 0.2;    // seconds
    this.scheduleInterval = 50; // ms
    this.onTimeUpdate = null;
    this.onEnded = null;
    this.onNoteEvent = null; // for visualizer: (note, channel, on) 
  }

  _buildTimeline() {
    const ticksPerBeat = this.midi.ticksPerBeat || 480;

    // Merge all track events, tag with track index, sort by tick (stable)
    const merged = [];
    this.midi.tracks.forEach((track, trackIdx) => {
      let usedChannels = new Set();
      let trackName = '';
      for (const ev of track.events) {
        if (ev.meta && (ev.metaType === 0x03) && ev.text) trackName = ev.text;
        if (ev.channel !== undefined) usedChannels.add(ev.channel);
        merged.push({ ...ev, trackIdx });
      }
      this.trackInfo.push({
        name: trackName || `Track ${trackIdx + 1}`,
        channels: [...usedChannels],
        noteCount: track.events.filter(e => e.type === 'noteOn').length
      });
    });

    merged.sort((a, b) => a.tick - b.tick);

    // Build tempo map: list of {tick, mpq}
    let tempoMap = merged
      .filter(e => e.tempoMPQ !== undefined)
      .map(e => ({ tick: e.tick, mpq: e.tempoMPQ }));
    if (tempoMap.length === 0 || tempoMap[0].tick !== 0) {
      tempoMap.unshift({ tick: 0, mpq: 500000 }); // default 120 BPM
    }
    tempoMap.sort((a, b) => a.tick - b.tick);

    // Precompute cumulative time (seconds) at each tempo-change tick
    const tempoTimeline = [];
    let accTime = 0, prevTick = 0, curMpq = tempoMap[0].mpq;
    for (let i = 0; i < tempoMap.length; i++) {
      const tc = tempoMap[i];
      const deltaTicks = tc.tick - prevTick;
      accTime += (deltaTicks / ticksPerBeat) * (curMpq / 1000000);
      tempoTimeline.push({ tick: tc.tick, timeSec: accTime, mpq: tc.mpq });
      curMpq = tc.mpq;
      prevTick = tc.tick;
    }

    const tickToSeconds = (tick) => {
      // find last tempoTimeline entry with tick <= given tick
      let lo = 0, hi = tempoTimeline.length - 1, idx = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (tempoTimeline[mid].tick <= tick) { idx = mid; lo = mid + 1; }
        else hi = mid - 1;
      }
      const base = tempoTimeline[idx];
      const deltaTicks = tick - base.tick;
      return base.timeSec + (deltaTicks / ticksPerBeat) * (base.mpq / 1000000);
    };
    this._tickToSeconds = tickToSeconds;

    let maxTime = 0;
    for (const ev of merged) {
      ev.timeSec = tickToSeconds(ev.tick);
      if (ev.timeSec > maxTime) maxTime = ev.timeSec;
      this.events.push(ev);
    }
    this.durationSec = maxTime + 1.0; // small tail buffer
  }

  setTrackMuted(trackIdx, muted) {
    if (muted) this.mutedTracks.add(trackIdx);
    else this.mutedTracks.delete(trackIdx);
  }

  play(fromSeconds) {
    if (this.isPlaying && !this.isPaused) return;
    const offset = (fromSeconds !== undefined) ? fromSeconds : this.pauseOffset;
    this.pauseOffset = offset;
    this.startCtxTime = this.ctx.currentTime - offset;
    this.isPlaying = true;
    this.isPaused = false;

    // Find first event index at/after offset
    this.scheduledIndex = this._findEventIndexAtTime(offset);
    this._runScheduler();
  }

  pause() {
    if (!this.isPlaying) return;
    this.pauseOffset = this.ctx.currentTime - this.startCtxTime;
    this.isPlaying = false;
    this.isPaused = true;
    clearTimeout(this.schedulerTimer);
    this.synth.allNotesOff(this.ctx.currentTime);
  }

  stop() {
    this.isPlaying = false;
    this.isPaused = false;
    this.pauseOffset = 0;
    clearTimeout(this.schedulerTimer);
    this.synth.panic();
    if (this.onTimeUpdate) this.onTimeUpdate(0);
  }

  seek(seconds) {
    const wasPlaying = this.isPlaying && !this.isPaused;
    clearTimeout(this.schedulerTimer);
    this.synth.panic();
    this.pauseOffset = Math.max(0, Math.min(seconds, this.durationSec));
    if (wasPlaying) {
      this.play(this.pauseOffset);
    } else {
      this.startCtxTime = this.ctx.currentTime - this.pauseOffset;
      this.scheduledIndex = this._findEventIndexAtTime(this.pauseOffset);
      if (this.onTimeUpdate) this.onTimeUpdate(this.pauseOffset);
    }
  }

  _findEventIndexAtTime(seconds) {
    let lo = 0, hi = this.events.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.events[mid].timeSec < seconds) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  _runScheduler() {
    if (!this.isPlaying) return;
    const nowOffset = this.ctx.currentTime - this.startCtxTime;

    while (this.scheduledIndex < this.events.length) {
      const ev = this.events[this.scheduledIndex];
      if (ev.timeSec > nowOffset + this.lookahead) break;
      const when = this.startCtxTime + ev.timeSec;
      if (when >= this.ctx.currentTime - 0.001) {
        this._dispatchEvent(ev, when);
      }
      this.scheduledIndex++;
    }

    if (this.onTimeUpdate) this.onTimeUpdate(Math.min(nowOffset, this.durationSec));

    if (this.scheduledIndex >= this.events.length && nowOffset >= this.durationSec) {
      this.isPlaying = false;
      this.isPaused = false;
      this.pauseOffset = 0;
      if (this.onEnded) this.onEnded();
      return;
    }

    this.schedulerTimer = setTimeout(() => this._runScheduler(), this.scheduleInterval);
  }

  _dispatchEvent(ev, when) {
  const muted = this.mutedTracks.has(ev.trackIdx);

  if (ev.sysex && !muted) {
    // GM / GS / XG Reset の判定
    if (ev.data && ev.data.length >= 5 && ev.data[1] === 0x7E && ev.data[3] === 0x09) {
      this._resetAllControllers();
    }
    return;
  }

  switch (ev.type) {
    case 'noteOn':
      if (!muted) {
        this.synth.noteOn(ev.channel, ev.note, ev.velocity, when);
        if (this.onNoteEvent) this.onNoteEvent(ev.note, ev.channel, true, when - this.ctx.currentTime);
      }
      break;
    case 'noteOff':
      this.synth.noteOff(ev.channel, ev.note, when);
      if (this.onNoteEvent) this.onNoteEvent(ev.note, ev.channel, false, when - this.ctx.currentTime);
      break;
    case 'programChange':
      const ch = this.synth.channels[ev.channel];
      this.synth.setProgram(ev.channel, ch.bank, ev.program);
      break;
    case 'controlChange':
      this._handleCC(ev, when);
      break;
    case 'pitchBend':
      this.synth.setChannelPitchBend(ev.channel, ev.value);
      break;
  }
}

_handleCC(ev, when) {
  const ch = this.synth.channels[ev.channel];
  const val = ev.value;

  switch (ev.controller) {
    case 0:  // Bank Select MSB
        ch.bank = val;
        this.synth.setProgram(ev.channel, ch.bank, ch.program);
        break;
    case 32: // Bank Select LSB
      
      break;
    case 6: // Data Entry MSB
      // RPN未指定(127)でも、直前にCC100/101が来ていれば柔軟に対応
      if ((ch.rpnMSB === 0 || ch.rpnMSB === 127) && ch.rpnLSB === 0) {
        ch.pitchBendRangeSemitones = val;
      } else if (ch.rpnMSB === 0 && ch.rpnLSB === 1) {
        ch.fineTune = (val - 64) * (100 / 64);
      } else if (ch.rpnMSB === 0 && ch.rpnLSB === 2) {
        ch.coarseTune = val - 64;
      }
      break;
    case 7:  this.synth.setChannelVolume(ev.channel, val); break;
    case 10: this.synth.setChannelPan(ev.channel, val); break;
    case 11: this.synth.setChannelExpression(ev.channel, val); break;
    case 64: // Sustain Pedal
      this.synth.setChannelSustain(ev.channel, val >= 64);
      if (val < 64) this.synth.channelSustainOff(ev.channel, when);
      break;
    case 66: // Sostenuto Pedal
      ch.sostenuto = val >= 64;
      break;
    case 67: // Soft Pedal
      ch.softPedal = val >= 64;
      this.synth.setChannelVolume(ev.channel, ch.volume);
      break;
    case 72: ch.releaseOffset = (val - 64) / 64; break; // Release Time
    case 73: ch.attackOffset = (val - 64) / 64; break;  // Attack Time
    case 100: ch.rpnLSB = val; break;
    case 101: ch.rpnMSB = val; break;
    case 120: // All Sound Off
      this.synth.allSoundOff(ev.channel);
      break;
    case 121: // Reset All Controllers
      this._resetChannelControllers(ev.channel);
      break;
    case 123: // All Notes Off
      this.synth.allNotesOff(when);
      break;
  }
}

_resetChannelControllers(channel) {
  const ch = this.synth.channels[channel];
  ch.pitchBend = 0;
  ch.volume = 100;
  ch.expression = 127;
  ch.pan = 64;
  ch.sustain = false;
  ch.sostenuto = false;
  ch.softPedal = false;
  ch.rpnMSB = 127;
  ch.rpnLSB = 127;
}

_resetAllControllers() {
  for (let i = 0; i < 16; i++) {
    this._resetChannelControllers(i);
  }
}

  
  getCurrentTime() {
    if (this.isPlaying) return Math.min(this.ctx.currentTime - this.startCtxTime, this.durationSec);
    return this.pauseOffset;
  }
}

/* ========================================================================
 *  UI Controller
 * ======================================================================== */
/* ========================================================================
 *  UI Controller (UI削減 & 自動再生版)
 * ======================================================================== */
(function () {
  const $ = (id) => document.getElementById(id);
  const sf2input = $('sf2input');
  const midinput = $('midinput');
  const statusEl = $('status');

  let audioCtx = null;
  let sf2Parser = null;
  let synth = null;
  let midiFile = null;
  let sequencer = null;

  function setStatus(msg) {
    if (statusEl) statusEl.textContent = msg;
  }

  function ensureAudioCtx() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }

  sf2input?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setStatus('SoundFontを解析中...');
    try {
      const buf = await file.arrayBuffer();
      ensureAudioCtx();
      sf2Parser = new SF2Parser(buf);
      synth = new SF2Synth(audioCtx, sf2Parser);
      setStatus('SoundFont読み込み完了');
      checkReady();
    } catch (err) {
      setStatus('SF2読み込みエラー: ' + err.message);
    }
  });

  midinput?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setStatus('MIDIファイルを解析中...');
    try {
      const buf = await file.arrayBuffer();
      midiFile = new MidiFile(buf);
      setStatus('MIDI読み込み完了');
      checkReady();
    } catch (err) {
      setStatus('MIDI読み込みエラー: ' + err.message);
    }
  });

  function checkReady() {
    // 両方揃ったら自動再生[cite: 1]
    if (sf2Parser && midiFile) {
      ensureAudioCtx();
      if (sequencer) sequencer.stop();

      sequencer = new MidiSequencer(audioCtx, synth, midiFile);
      sequencer.play();
      setStatus('再生中...');
    }
  }
})();