"""Train a CART model using only sensor features; export a portable tensor."""
import csv
import inspect
import json
import math
import random
import struct
import sys
from pathlib import Path

FEATURES = ['Type','Air temperature [K]','Process temperature [K]','Rotational speed [rpm]','Torque [Nm]','Tool wear [min]']


def read_rows(path):
    with path.open(encoding='utf-8-sig', newline='') as f:
        return list(csv.DictReader(f))


def write_rows(path, fields, rows):
    with path.open('w', encoding='utf-8', newline='') as f:
        w = csv.DictWriter(f, fields, extrasaction='ignore')
        w.writeheader()
        w.writerows(rows)


def split(rows, seed):
    rng = random.Random(seed)
    train, test = [], []
    for label in ('0', '1'):
        group = [r for r in rows if r['Target'] == label]
        rng.shuffle(group)
        n = round(len(group) / 5)
        test.extend(group[:n])
        train.extend(group[n:])
    rng.shuffle(train)
    rng.shuffle(test)
    return train, test


def vector(r):
    air, process, rpm, torque, wear = [float(r[k]) for k in FEATURES[1:]]
    return [air, process, rpm, torque, wear, process-air,
            rpm*torque*2*math.pi/60, wear*torque,
            int(r['Type']=='L'), int(r['Type']=='H')]


def fit(rows, depth, leaf):
    X = [vector(r) for r in rows]
    y = [int(r['Target']) for r in rows]
    nodes = []
    def build(indices, level):
        n = len(indices)
        positives = sum(y[i] for i in indices)
        here = len(nodes)
        nodes.append([-1, positives / n, -1, -1])
        if level >= depth or n < 2 * leaf or positives in (0, n):
            return here
        best = positives ** 2 / n
        choice = None
        for col in range(len(X[0])):
            ordered = sorted(indices, key=lambda i: X[i][col])
            left = 0
            for pos in range(1, n):
                i = ordered[pos-1]
                left += y[i]
                if pos < leaf or n-pos < leaf or X[i][col] == X[ordered[pos]][col]:
                    continue
                purity = left**2/pos + (positives-left)**2/(n-pos)
                if purity > best + 1e-10:
                    best = purity
                    choice = (col, (X[i][col]+X[ordered[pos]][col])/2)
        if choice:
            col, threshold = choice
            a = build([i for i in indices if X[i][col] <= threshold], level+1)
            b = build([i for i in indices if X[i][col] > threshold], level+1)
            nodes[here] = [col, threshold, a, b]
        return here
    build(list(range(len(rows))), 0)
    return nodes


def predict(nodes, r):
    x, idx = vector(r), 0
    while True:
        col, value, left, right = nodes[idx]
        if col < 0:
            return str(int(value >= 0.5))
        idx = int(left if x[int(col)] <= value else right)


def confusion(rows, guesses):
    return [sum(r['Target']==a and p==b for r,p in zip(rows, guesses))
            for a,b in [('0','0'),('0','1'),('1','0'),('1','1')]]


def train_predict(folder):
    train = read_rows(folder/'train.csv')
    inner, valid = split(train, 43)
    candidates = [(5, 3), (8, 3), (8, 8)]
    best_f1, best = -1, candidates[0]
    for depth, leaf in candidates:
        tree = fit(inner, depth, leaf)
        _, fp, fn, tp = confusion(valid, [predict(tree,r) for r in valid])
        f1 = 2*tp / max(1, 2*tp+fp+fn)
        if f1 > best_f1:
            best_f1, best = f1, (depth, leaf)
    tree = fit(train, *best)
    flat = [v for row in tree for v in row]
    payload = struct.pack('<'+'d'*len(flat), *flat)
    meta = json.dumps({'tree':{'dtype':'F64','shape':[len(tree),4],'data_offsets':[0,len(payload)]}}).encode()
    meta += b' ' * (-len(meta)%8)
    path = folder/'model.safetensors'
    path.write_bytes(struct.pack('<Q',len(meta))+meta+payload)
    raw = path.read_bytes()
    length, = struct.unpack_from('<Q',raw)
    tensor = json.loads(raw[8:8+length])['tree']
    count = math.prod(tensor['shape'])
    values = struct.unpack_from('<'+'d'*count,raw,8+length)
    loaded = [values[i:i+4] for i in range(0,count,4)]
    features = read_rows(folder/'features.csv')
    preds = [predict(loaded,r) for r in features]
    write_rows(folder/'prediction.csv',['UDI','Target'],[{'UDI':r['UDI'],'Target':p} for r,p in zip(features,preds)])
    return best, preds


def main(path, folder):
    rows = read_rows(path)
    if len(rows)!=10000 or len({r['UDI'] for r in rows})!=10000 or {r['Target'] for r in rows}!={'0','1'}:
        raise ValueError('Expected the 10,000-row Kaggle predictive_maintenance.csv')
    folder.mkdir(parents=True,exist_ok=True)
    train, test = split(rows, 42)
    fields = ['UDI', *FEATURES]
    write_rows(folder/'train.csv',[*fields,'Target'],train)
    write_rows(folder/'features.csv',fields,test)
    write_rows(folder.parent/'labeled_admin.csv',[*fields,'Target'],test)
    best, preds = train_predict(folder)
    tn,fp,fn,tp = confusion(test,preds)
    source = 'import csv, json, math, struct, random\nfrom pathlib import Path\nFEATURES='+repr(FEATURES)+'\n'
    source += '\n'.join(inspect.getsource(f) for f in [read_rows,write_rows,split,vector,fit,predict,confusion,train_predict])
    source += '\nparams, predictions = train_predict(Path("."))\nprint("Depth, min leaf:", params, "Predictions:", len(predictions))'
    log = f'Depth, min leaf: {best} Predictions: {len(preds)}\n'
    cell = dict(cell_type='code',id='train-infer',metadata={},execution_count=1,source=source,
                outputs=[dict(output_type='stream',name='stdout',text=log)])
    (folder/'notebook.ipynb').write_text(json.dumps(dict(nbformat=4,nbformat_minor=5,metadata={'kernelspec':{'name':'python3','display_name':'Python 3','language':'python'}},cells=[cell])),encoding='utf-8')
    print(json.dumps(dict(classes=['0','1'],train=len(train),test=len(test),correct=tn+tp,tn=tn,fp=fp,fn=fn,tp=tp,params=best)))


if __name__=='__main__':
    main(Path(sys.argv[1]),Path(sys.argv[2]))
