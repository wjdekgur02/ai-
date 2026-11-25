import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

export const MiB = 1024 ** 2;
export const LIMITS = { csv: 4 * MiB, notebook: 3 * MiB, model: 24 * MiB, upload: 32 * MiB };
export const METRICS = { accuracy: 'Accuracy', macro_f1: 'Macro F1', mae: 'MAE', rmse: 'RMSE' };
export const HIGHER = new Set(['accuracy', 'macro_f1']);
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const decoder = new TextDecoder('utf-8', { fatal: true });

export class InputError extends Error {}

export function expect(condition, message) {
  if (!condition) throw new InputError(message);
}

function csv(bytes) {
  let source;
  try { source = decoder.decode(bytes); }
  catch { throw new InputError('CSV를 UTF-8 형식으로 저장해 주세요.'); }
  expect(source.length && !source.includes('\0'), 'CSV 데이터가 비어 있거나 형식이 올바르지 않습니다.');
  const rows = [];
  let row = [];
  let cell = '';
  let state = 'start';
  function pushCell() {
    expect(row.length < 128 && cell.length <= 32768, 'CSV 열 개수 또는 셀 크기 한도를 초과했습니다.');
    row.push(cell);
    cell = '';
    state = 'start';
  }
  function pushRow() {
    pushCell();
    expect(rows.length <= 50000, 'CSV 데이터 행은 최대 50,000개입니다.');
    rows.push(row);
    row = [];
  }
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (state === 'quoted') {
      if (ch !== '"') cell += ch;
      else if (source[i + 1] === '"') { cell += '"'; i++; }
      else state = 'closed';
      continue;
    }
    if (ch === ',') pushCell();
    else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && source[i + 1] === '\n') i++;
      pushRow();
    } else if (ch === '"' && state === 'start') state = 'quoted';
    else {
      expect(state !== 'closed' && ch !== '"', 'CSV 따옴표 형식이 올바르지 않습니다.');
      state = 'plain';
      cell += ch;
    }
  }
  expect(state !== 'quoted', 'CSV에 닫히지 않은 따옴표가 있습니다.');
  if (row.length || state !== 'start') pushRow();
  expect(rows.length >= 2, 'CSV에 헤더와 데이터 행이 필요합니다.');
  const headers = rows.shift();
  expect(headers.every(h => h.trim() && h === h.trim()) && new Set(headers).size === headers.length,
    'CSV 헤더에 빈 열, 중복 열 또는 앞뒤 공백이 있습니다.');
  expect(rows.every(r => r.length === headers.length), 'CSV의 모든 행은 헤더와 열 개수가 같아야 합니다.');
  return { headers, rows };
}

export function encodeCsv(rows) {
  const escape = value => /[",\r\n]/.test(value) ? '"' + value.replaceAll('"', '""') + '"' : value;
  return rows.map(row => row.map(escape).join(',')).join('\r\n') + '\r\n';
}

export function numeric(value) {
  expect(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value), '회귀 예측값과 정답에는 유한한 숫자가 필요합니다.');
  const parsed = Number(value);
  expect(Number.isFinite(parsed) && Math.abs(parsed) <= 1e100, '회귀 값은 절댓값 1e100 이하여야 합니다.');
  return parsed;
}

export function dataset(bytes, idName, targetName, metric, classes) {
  expect(Object.hasOwn(METRICS, metric), '평가 지표를 선택해 주세요.');
  const { headers, rows } = csv(bytes);
  const idIndex = headers.indexOf(idName);
  const targetIndex = headers.indexOf(targetName);
  expect(idIndex >= 0 && targetIndex >= 0 && idIndex !== targetIndex && headers.length >= 3,
    '테스트 CSV에 서로 다른 ID, 정답 열과 하나 이상의 특성 열이 필요합니다.');
  const ids = rows.map(r => r[idIndex]);
  expect(ids.every(id => ID.test(id)) && new Set(ids).size === ids.length, '테스트 CSV ID가 중복되었거나 형식이 올바르지 않습니다.');
  const raw = rows.map(r => r[targetIndex]);
  expect(!HIGHER.has(metric) || (classes.length >= 2 && classes.length <= 100 &&
    classes.every(c => c.length && c.length <= 128) && new Set(classes).size === classes.length &&
    raw.every(c => classes.includes(c))), '분류 레이블을 2~100개 지정하고 정답 CSV와 일치시켜 주세요.');
  const actual = HIGHER.has(metric) ? raw : raw.map(numeric);
  const features = encodeCsv([headers, ...rows].map(row => row.filter((_, i) => i !== targetIndex)));
  const template = encodeCsv([[idName, targetName], ...ids.map(id => [id, ''])]);
  return { ids, actual, features, template };
}

export function evaluate(bytes, project) {
  const { headers, rows } = csv(bytes);
  expect(headers.length === 2 && headers[0] === project.id_name && headers[1] === project.target_name,
    '예측 CSV 헤더와 열 순서를 예측 양식에 맞춰 주세요.');
  const ids = JSON.parse(project.ids);
  expect(rows.length === ids.length, '예측 CSV의 행 개수가 테스트 데이터와 일치해야 합니다.');
  const byId = new Map(rows);
  expect(byId.size === rows.length && ids.every(id => byId.has(id)), '예측 CSV의 ID가 중복되었거나 테스트 데이터와 일치하지 않습니다.');
  const raw = ids.map(id => byId.get(id));
  const classes = JSON.parse(project.classes);
  const classification = HIGHER.has(project.metric);
  expect(!classification || raw.every(c => classes.includes(c)), '예측 CSV에 허용되지 않은 레이블이 있습니다.');
  const values = classification ? raw : raw.map(numeric);
  return {
    values,
    digest: createHash('sha256').update(JSON.stringify(values)).digest('hex'),
  };
}

export function comparePredictions(original, regenerated, project) {
  const submitted = evaluate(original, project);
  const replay = evaluate(regenerated, project);
  const ids = JSON.parse(project.ids);
  const differences = [];
  let matched = 0;
  for (let i = 0; i < ids.length; i++) {
    if (submitted.values[i] === replay.values[i]) matched++;
    else if (differences.length < 5) differences.push(ids[i]);
  }
  return { total: ids.length, matched, differences, digest: replay.digest };
}

export function score(metric, predicted, actual, classes) {
  let value;
  switch (metric) {
    case 'accuracy':
      value = actual.reduce((sum, y, i) => sum + Number(y === predicted[i]), 0) / actual.length;
      break;
    case 'macro_f1': {
      const totals = new Map(classes.map(c => [c, { actual: 0, predicted: 0, correct: 0 }]));
      actual.forEach((y, i) => {
        totals.get(y).actual++;
        totals.get(predicted[i]).predicted++;
        if (y === predicted[i]) totals.get(y).correct++;
      });
      value = [...totals.values()].reduce((sum, c) =>
        sum + (c.actual + c.predicted ? 2 * c.correct / (c.actual + c.predicted) : 0), 0) / classes.length;
      break;
    }
    case 'mae':
      value = actual.reduce((sum, y, i) => sum + Math.abs(y - predicted[i]), 0) / actual.length;
      break;
    case 'rmse':
      value = Math.sqrt(actual.reduce((sum, y, i) => sum + (y - predicted[i]) ** 2, 0) / actual.length);
      break;
    default:
      throw new Error('Unsupported metric');
  }
  return Number(value.toPrecision(10));
}

function json(bytes) {
  return JSON.parse(decoder.decode(bytes));
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

export function inspectNotebook(bytes) {
  let notebook;
  try { notebook = json(bytes); }
  catch { throw new InputError('Notebook을 올바른 .ipynb JSON 파일로 저장해 주세요.'); }
  expect(object(notebook) && notebook.nbformat === 4 && Number.isInteger(notebook.nbformat_minor) &&
    object(notebook.metadata) && Array.isArray(notebook.cells) && notebook.cells.length <= 250,
  'Notebook은 최대 250개 셀의 nbformat 4 형식이어야 합니다.');
  const cells = notebook.cells.map(cell => {
    expect(object(cell) && ['code', 'markdown', 'raw'].includes(cell.cell_type) && object(cell.metadata) &&
      (typeof cell.source === 'string' || (Array.isArray(cell.source) && cell.source.every(line => typeof line === 'string'))),
    'Notebook에 올바르지 않은 셀이 있습니다.');
    const source = Array.isArray(cell.source) ? cell.source.join('') : cell.source;
    if (cell.cell_type === 'code') {
      expect(Array.isArray(cell.outputs) && (cell.execution_count === null || Number.isInteger(cell.execution_count)),
        'Notebook 코드 셀의 출력 구조가 올바르지 않습니다.');
    }
    const logs = Array.isArray(cell.outputs) ? cell.outputs.slice(0, 20).map(output => {
      const content = output?.output_type === 'stream' ? output.text : output?.data?.['text/plain'];
      if (typeof content === 'string') return content.slice(0, 2000);
      if (Array.isArray(content)) return content.filter(line => typeof line === 'string').slice(0, 40).join('').slice(0, 2000);
      return '';
    }).filter(Boolean).join('\n').slice(0, 4000) : '';
    return { type: cell.cell_type, source, logs, outputCount: cell.outputs?.length ?? 0 };
  });
  expect(cells.some(cell => cell.type === 'code' && cell.source.trim()), 'Notebook에 모델 코드가 필요합니다.');
  return cells;
}

function zipMembers(bytes) {
  const endSignature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const end = bytes.lastIndexOf(endSignature);
  if (end < 0 || end + 22 > bytes.length || bytes.readUInt16LE(end + 4) ||
      bytes.readUInt16LE(end + 6) || end + 22 + bytes.readUInt16LE(end + 20) !== bytes.length) throw new Error();
  const count = bytes.readUInt16LE(end + 10);
  const start = bytes.readUInt32LE(end + 16);
  let pos = start;
  if (!count || count > 512 || bytes.readUInt16LE(end + 8) !== count || start + bytes.readUInt32LE(end + 12) !== end) throw new Error();
  const entries = new Map();
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (pos + 46 > end || bytes.readUInt32LE(pos) !== 0x02014b50) throw new Error();
    const flags = bytes.readUInt16LE(pos + 8);
    const method = bytes.readUInt16LE(pos + 10);
    const compressed = bytes.readUInt32LE(pos + 20);
    const size = bytes.readUInt32LE(pos + 24);
    const nameLength = bytes.readUInt16LE(pos + 28);
    const next = pos + 46 + nameLength + bytes.readUInt16LE(pos + 30) + bytes.readUInt16LE(pos + 32);
    const local = bytes.readUInt32LE(pos + 42);
    total += size;
    if (next > end || local + 30 > start || flags & ~0x080e || ![0, 8].includes(method) ||
        total > 96 * MiB || bytes.readUInt32LE(local) !== 0x04034b50 ||
        flags !== bytes.readUInt16LE(local + 6) || method !== bytes.readUInt16LE(local + 8)) throw new Error();
    const name = bytes.toString('utf8', pos + 46, pos + 46 + nameLength);
    const data = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    if (!name || name.startsWith('/') || /[\\:\0]|(?:^|\/)\.\.(?:\/|$)/.test(name) || entries.has(name) ||
        name !== bytes.toString('utf8', local + 30, local + 30 + bytes.readUInt16LE(local + 26)) ||
        data + compressed > start || (method === 0 && compressed !== size)) throw new Error();
    entries.set(name, { size, read(limit) {
      if (size > limit) throw new Error();
      const source = bytes.subarray(data, data + compressed);
      const decoded = method === 0 ? source : inflateRawSync(source, { maxOutputLength: Math.max(size, 1) });
      if (decoded.length !== size) throw new Error();
      return decoded;
    } });
    pos = next;
  }
  if (pos !== end) throw new Error();
  return entries;
}

function inspectSafetensors(bytes) {
  const size = Number(bytes.readBigUInt64LE(0));
  if (!size || size > MiB || size + 8 > bytes.length || bytes[8] !== 123) throw new Error();
  const header = json(bytes.subarray(8, 8 + size));
  if (!object(header)) throw new Error();
  const ranges = [];
  const widths = { BOOL: 1, U8: 1, I8: 1, F8_E4M3: 1, F8_E5M2: 1, I16: 2, U16: 2,
    F16: 2, BF16: 2, I32: 4, U32: 4, F32: 4, F64: 8, I64: 8, U64: 8 };
  for (const [name, tensor] of Object.entries(header)) {
    if (name === '__metadata__') {
      if (!object(tensor) || !Object.values(tensor).every(v => typeof v === 'string')) throw new Error();
      continue;
    }
    if (!object(tensor) || !Object.hasOwn(widths, tensor.dtype) || !Array.isArray(tensor.shape) ||
        tensor.shape.length > 16 || !tensor.shape.every(d => Number.isSafeInteger(d) && d >= 0) ||
        !Array.isArray(tensor.data_offsets) || tensor.data_offsets.length !== 2 ||
        !tensor.data_offsets.every(d => Number.isSafeInteger(d) && d >= 0)) throw new Error();
    const [start, end] = tensor.data_offsets;
    const length = tensor.shape.reduce((count, d) => count * BigInt(d), BigInt(widths[tensor.dtype]));
    if (start > end || length !== BigInt(end - start)) throw new Error();
    ranges.push([start, end]);
  }
  let cursor = 0;
  for (const [start, end] of ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    if (cursor !== start) throw new Error();
    cursor = end;
  }
  if (!ranges.length || cursor !== bytes.length - 8 - size) throw new Error();
}

export function inspectModel(bytes, ext) {
  try {
    if (ext === '.safetensors') return inspectSafetensors(bytes);
    const entries = zipMembers(bytes);
    if (ext === '.skops') {
      const schema = json(entries.get('schema.json').read(MiB));
      if (!object(schema) || typeof schema.__class__ !== 'string' || typeof schema.__module__ !== 'string') throw new Error();
    } else if (ext === '.keras') {
      const config = json(entries.get('config.json').read(MiB));
      const metadata = json(entries.get('metadata.json').read(64 * 1024));
      const weights = entries.get('model.weights.h5').read(48 * MiB);
      if (!object(config) || !object(metadata) || typeof config.class_name !== 'string' ||
          !weights.subarray(0, 8).equals(Buffer.from([137, 72, 68, 70, 13, 10, 26, 10]))) throw new Error();
    } else throw new Error();
  } catch {
    throw new InputError('가중치 파일의 내부 구조가 .safetensors, .skops 또는 .keras 규격과 일치하지 않습니다.');
  }
}
