"""Prepare the Kaggle GTA VI frame-annotation classification task."""
import csv
import inspect
import json
import math
import struct
import sys
from collections import Counter
from pathlib import Path

FEATURES = ['characters_present', 'vehicles_present', 'objects_present']


def read_rows(path):
    with path.open(encoding='utf-8-sig', newline='') as handle:
        return list(csv.DictReader(handle))


def write_rows(path, fields, rows):
    with path.open('w', encoding='utf-8', newline='') as handle:
        writer = csv.DictWriter(handle, fields, extrasaction='ignore')
        writer.writeheader()
        writer.writerows(rows)


def tokens(row):
    return [field + '=' + token.strip() for field in FEATURES
            for token in row[field].split(';') if token.strip()]


def train_and_predict(folder):
    train = read_rows(folder / 'train.csv')
    features = read_rows(folder / 'features.csv')
    classes = sorted({row['scene_type'] for row in train})
    vocab = sorted({word for row in train for word in tokens(row)})
    counts = {label: Counter() for label in classes}
    frequencies = Counter(row['scene_type'] for row in train)
    for row in train:
        counts[row['scene_type']].update(tokens(row))
    values = []
    for label in classes:
        values.append(math.log(frequencies[label] / len(train)))
        total = sum(counts[label].values()) + len(vocab)
        values.extend(math.log((counts[label][w] + 1) / total) for w in vocab)
    payload = struct.pack('<' + 'd' * len(values), *values)
    header = {'__metadata__': {'labels': json.dumps(classes), 'vocab': json.dumps(vocab)},
              'weights': {'dtype': 'F64', 'shape': [len(classes), len(vocab) + 1],
                          'data_offsets': [0, len(payload)]}}
    encoded = json.dumps(header).encode()
    encoded += b' ' * (-len(encoded) % 8)
    path = folder / 'model.safetensors'
    path.write_bytes(struct.pack('<Q', len(encoded)) + encoded + payload)
    raw = path.read_bytes()
    size, = struct.unpack_from('<Q', raw)
    header = json.loads(raw[8:8 + size])
    labels = json.loads(header['__metadata__']['labels'])
    words = json.loads(header['__metadata__']['vocab'])
    index = {word: i + 1 for i, word in enumerate(words)}
    n, width = header['weights']['shape']
    weights = struct.unpack_from('<' + 'd' * (n * width), raw, 8 + size)
    predictions = []
    for row in features:
        indices = [index[word] for word in tokens(row) if word in index]
        scores = [weights[i * width] + sum(weights[i * width + j] for j in indices) for i in range(n)]
        predictions.append({'frame_id': row['frame_id'], 'scene_type': labels[scores.index(max(scores))]})
    write_rows(folder / 'prediction.csv', ['frame_id', 'scene_type'], predictions)
    return predictions


def main(source, folder):
    rows = read_rows(source)
    original_count = len(rows)
    distinct = {}
    for row in rows:
        key = row['frame_id']
        if key in distinct and distinct[key] != row:
            raise ValueError('Conflicting annotations for ' + key)
        distinct[key] = row
    rows = list(distinct.values())
    train = [r for r in rows if r['trailer_number'] == '1']
    test = [r for r in rows if r['trailer_number'] == '2']
    if not train or not test or len(train) + len(test) != len(rows):
        raise ValueError('Expected two trailers')
    folder.mkdir(parents=True, exist_ok=True)
    fields = ['frame_id', *FEATURES]
    write_rows(folder / 'train.csv', [*fields, 'scene_type'], train)
    write_rows(folder / 'features.csv', fields, test)
    write_rows(folder.parent / 'labeled_admin.csv', [*fields, 'scene_type'], test)
    predictions = train_and_predict(folder)
    baseline = Counter(r['scene_type'] for r in train).most_common(1)[0][0]
    correct = sum(r['scene_type'] == p['scene_type'] for r, p in zip(test, predictions))
    report = dict(raw=original_count, distinct=len(rows), train=len(train), test=len(test), correct=correct, baseline=baseline,
                  baseline_correct=sum(r['scene_type'] == baseline for r in test),
                  classes=sorted({r['scene_type'] for r in train}))
    print(json.dumps(report, ensure_ascii=False))
    imports = 'import csv, json, math, struct\nfrom collections import Counter\nfrom pathlib import Path\n'
    source_code = imports + 'FEATURES = ' + repr(FEATURES) + '\n\n'
    source_code += '\n\n'.join(inspect.getsource(f) for f in (read_rows, write_rows, tokens, train_and_predict))
    source_code += '\nprint("Predicted frames:", len(train_and_predict(Path("."))))'
    cell = {'cell_type':'code','id':'train-infer','metadata':{},'execution_count':1,
            'source':source_code,'outputs':[{'output_type':'stream','name':'stdout','text':f"Predicted frames: {len(predictions)}\n"}]}
    nb = {'nbformat':4,'nbformat_minor':5,'metadata':{'kernelspec':{'name':'python3','language':'python','display_name':'Python 3'}},'cells':[cell]}
    (folder / 'notebook.ipynb').write_text(json.dumps(nb), encoding='utf-8')


if __name__ == '__main__':
    main(Path(sys.argv[1]), Path(sys.argv[2]))
