'use strict';
/*
 * npy.js —— 极简 NumPy .npy 读写（v1.0 格式）
 * ---------------------------------------------------------------------------
 * 为什么要自己写：训练侧是 PyTorch，最省事的加载方式就是
 *   np.load('obs.npy')            → ndarray
 *   torch.from_numpy(...)         → tensor
 * 直接产出 .npy 可以让 Python 侧「零解析代码」，比自定义二进制格式可靠得多。
 *
 * 支持 dtype：u1/u8(i.e. uint8)、i4、i2、f4、f8
 */

const fs = require('fs');

const DTYPES = {
  u1: { npy: '|u1', size: 1, read: (b, o) => b.readUInt8(o) },
  i2: { npy: '<i2', size: 2, read: (b, o) => b.readInt16LE(o) },
  i4: { npy: '<i4', size: 4, read: (b, o) => b.readInt32LE(o) },
  f4: { npy: '<f4', size: 4, read: (b, o) => b.readFloatLE(o) },
  f8: { npy: '<f8', size: 8, read: (b, o) => b.readDoubleLE(o) },
};

function shapeToStr(shape) {
  if (shape.length === 1) return `(${shape[0]},)`;
  return `(${shape.join(', ')})`;
}

/**
 * 写 .npy
 * @param {string} file 路径
 * @param {string} dtype 'u1' | 'i4' | 'i2' | 'f4' | 'f8'
 * @param {number[]} shape 形状
 * @param {Buffer|TypedArray} data 数据（长度必须等于 shape 乘积）
 */
function writeNpy(file, dtype, shape, data) {
  const d = DTYPES[dtype];
  if (!d) throw new Error('不支持的 dtype: ' + dtype);
  const n = shape.reduce((a, b) => a * b, 1);
  const buf = Buffer.isBuffer(data)
    ? data
    : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (buf.length !== n * d.size) {
    throw new Error(`数据长度 ${buf.length} != 期望 ${n * d.size}（shape=${shapeToStr(shape)} dtype=${dtype}）`);
  }
  let header = `{'descr': '${d.npy}', 'fortran_order': False, 'shape': ${shapeToStr(shape)}, }`;
  // 头部（magic 6 + version 2 + hlen 2 + header）总长需为 64 的倍数，且以 \n 结尾
  const base = 10 + header.length + 1;
  const pad = (64 - (base % 64)) % 64;
  header = header + ' '.repeat(pad) + '\n';
  if ((10 + header.length) % 64 !== 0) throw new Error('npy 头部对齐失败');
  const hlen = Buffer.byteLength(header, 'latin1');
  if (hlen > 65535) throw new Error('头部过长');
  const head = Buffer.alloc(10 + hlen);
  head.write('\x93NUMPY', 0, 'latin1');
  head.writeUInt8(1, 6); head.writeUInt8(0, 7);
  head.writeUInt16LE(hlen, 8);
  head.write(header, 10, 'latin1');
  const fd = fs.openSync(file, 'w');
  try {
    fs.writeSync(fd, head);
    fs.writeSync(fd, buf);
  } finally { fs.closeSync(fd); }
  return { file, dtype, shape, bytes: buf.length };
}

/** 读 .npy → { dtype, shape, data: Buffer } */
function readNpy(file) {
  const raw = fs.readFileSync(file);
  if (raw.toString('latin1', 0, 6) !== '\x93NUMPY') throw new Error('不是 .npy 文件: ' + file);
  const major = raw.readUInt8(6);
  let headerLen, headerStart;
  if (major === 1) { headerLen = raw.readUInt16LE(8); headerStart = 10; }
  else { headerLen = raw.readUInt32LE(8); headerStart = 12; }
  const header = raw.toString('latin1', headerStart, headerStart + headerLen);
  const descr = /'descr':\s*'([^']+)'/.exec(header)[1];
  const shapeStr = /'shape':\s*\(([^)]*)\)/.exec(header)[1];
  const shape = shapeStr.split(',').map((s) => s.trim()).filter((s) => s.length).map(Number);
  const key = Object.keys(DTYPES).find((k) => DTYPES[k].npy === descr || DTYPES[k].npy.replace('<', '=') === descr);
  if (!key) throw new Error('未知 descr: ' + descr);
  return { dtype: key, shape, data: raw.subarray(headerStart + headerLen) };
}

/** 把若干同 dtype/shape（除第 0 维）的 .npy 沿第 0 维拼接后写出 */
function concatNpy(outFile, files, dropFirstDim) {
  const parts = files.map(readNpy);
  if (!parts.length) throw new Error('没有可分片文件');
  const dtype = parts[0].dtype;
  const rest = parts[0].shape.slice(1);
  const size = DTYPES[dtype].size;
  const rowBytes = rest.reduce((a, b) => a * b, 1) * size;
  let totalRows = 0;
  for (const p of parts) {
    const rows = p.shape[0] || 1;
    if (p.dtype !== dtype) throw new Error('分片 dtype 不一致');
    if (rowBytes > 0 && p.data.length % rowBytes !== 0) throw new Error('分片数据长度异常');
    totalRows += p.data.length / rowBytes;
  }
  const out = Buffer.alloc(totalRows * rowBytes);
  let off = 0;
  for (const p of parts) { p.data.copy(out, off); off += p.data.length; }
  const shape = dropFirstDim ? rest : [totalRows, ...rest];
  return writeNpy(outFile, dtype, shape, out);
}

/**
 * 由若干「裸二进制分片」拼出一个 .npy（流式，不把全部数据读进内存）。
 * 每个分片是定长行的原始字节；总行数 = 总字节数 / 行字节数。
 * @param {string} outFile
 * @param {string} dtype
 * @param {number[]} restShape 除第 0 维外的形状（[] 表示一维向量）
 * @param {string[]} partFiles 裸分片路径（按顺序）
 */
function writeNpyFromParts(outFile, dtype, restShape, partFiles) {
  const d = DTYPES[dtype];
  if (!d) throw new Error('不支持的 dtype: ' + dtype);
  const rowBytes = restShape.reduce((a, b) => a * b, 1) * d.size;
  let totalRows = 0;
  const sizes = [];
  for (const f of partFiles) {
    const st = fs.statSync(f);
    if (st.size % rowBytes !== 0) throw new Error(`分片行宽不整除: ${f} (${st.size} % ${rowBytes})`);
    sizes.push(st.size);
    totalRows += st.size / rowBytes;
  }
  const shape = [totalRows, ...restShape];
  return _streamParts(outFile, dtype, shape, partFiles);
}

function _streamParts(outFile, dtype, shape, partFiles) {
  const d = DTYPES[dtype];
  let header = `{'descr': '${d.npy}', 'fortran_order': False, 'shape': ${shapeToStr(shape)}, }`;
  const pad = (64 - ((10 + header.length + 1) % 64)) % 64;
  header = header + ' '.repeat(pad) + '\n';
  const hlen = Buffer.byteLength(header, 'latin1');
  const head = Buffer.alloc(10 + hlen);
  head.write('\x93NUMPY', 0, 'latin1');
  head.writeUInt8(1, 6); head.writeUInt8(0, 7);
  head.writeUInt16LE(hlen, 8);
  head.write(header, 10, 'latin1');
  const out = fs.openSync(outFile, 'w');
  const buf = Buffer.alloc(1 << 20);
  let bytes = 0;
  try {
    fs.writeSync(out, head);
    for (const f of partFiles) {
      const fd = fs.openSync(f, 'r');
      try {
        let n;
        while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) { fs.writeSync(out, buf, 0, n); bytes += n; }
      } finally { fs.closeSync(fd); }
    }
  } finally { fs.closeSync(out); }
  return { file: outFile, dtype, shape, bytes };
}

module.exports = { writeNpy, readNpy, concatNpy, writeNpyFromParts, DTYPES };
