"""Fleet-wide L1 classification accuracy test against XSPOC."""
import struct, numpy as np, pyodbc, math

# Centroids from card-patterns.js
# Features: [areaRatio, flatTop, flatBottom, fluidPoundIdx, svTransition, tvTransition,
#            cdSharpness, abSharpness, dnLoadElev, upDropPt, maxDropLoc, dnConvexity, earlyDnLoad]
CENTROIDS = {
    'full_pump':    {'mean': [0.862,0.806,0.776,0.421,0.306,0.999,0.533,0.616,0.055,0.933,0.126,-0.135,0.302], 'std': [0.060,0.080,0.120,0.100,1.700,0.030,0.200,0.200,0.050,0.060,0.080,0.080,0.180], 'n':7},
    'pump_issue':   {'mean': [0.754,0.748,0.541,0.366,0.088,0.947,0.464,0.514,0.122,0.783,0.156,-0.172,0.456], 'std': [0.090,0.230,0.180,0.100,0.800,0.360,0.340,0.300,0.060,0.310,0.120,0.100,0.210], 'n':11},
    'rod_part':     {'mean': [0.414,0.362,0.512,0.132,-0.097,0.043,0.047,0.022,0.263,0.493,0.483,-0.184,0.430], 'std': [0.180,0.180,0.150,0.100,0.300,0.250,0.100,0.100,0.200,0.200,0.250,0.150,0.200], 'n':1},
    'sv_leak':      {'mean': [0.751,0.714,0.439,0.388,0.614,0.645,0.346,0.251,0.137,0.810,0.373,-0.157,0.261], 'std': [0.080,0.240,0.100,0.130,0.460,0.460,0.470,0.120,0.050,0.220,0.160,0.060,0.120], 'n':2},
    'tv_leak':      {'mean': [0.786,0.538,0.754,0.324,0.768,0.973,0.386,0.296,0.052,0.697,0.083,-0.113,0.190], 'std': [0.160,0.150,0.250,0.100,0.490,0.150,0.250,0.210,0.050,0.270,0.110,0.090,0.120], 'n':5},
    'under_filled': {'mean': [0.658,0.652,0.554,0.407,0.081,0.847,0.234,0.422,0.164,0.673,0.367,-0.223,0.589], 'std': [0.190,0.260,0.200,0.120,0.440,0.430,0.360,0.300,0.200,0.350,0.180,0.200,0.240], 'n':18},
}


def map_xspoc_to_l1(cond):
    """Map XSPOC compound condition to L1 class."""
    if not cond:
        return None
    c = cond.strip().lower()
    if c.startswith('full pump'):
        return 'full_pump'
    if c.startswith('rod part') or c.startswith('severe pump wear or rod part'):
        return 'rod_part'
    if c.startswith('fluid pound') or c.startswith('gas interference') or c.startswith('incomplete pump fillage'):
        return 'under_filled'
    if 'sv leak' in c and not c.startswith('fluid') and not c.startswith('incomplete'):
        return 'sv_leak'
    if 'tv leak' in c and not c.startswith('fluid') and not c.startswith('incomplete'):
        return 'tv_leak'
    if c.startswith('worn pump') or c.startswith('bent pump'):
        return 'pump_issue'
    if c.startswith('pump hitting'):
        return 'pump_issue'
    if c == 'unable to determine.' or c == '':
        return None
    return None


def extract_features(position, load):
    """Python port of JS extractFeatures — returns 13-element feature vector."""
    N = min(len(position), len(load))
    if N < 10:
        return None
    pos = np.array(position[:N], dtype=float)
    ld = np.array(load[:N], dtype=float)
    lr = ld.max() - ld.min()
    pr = pos.max() - pos.min()
    if lr < 1 or pr < 0.1:
        return None
    np_ = (pos - pos.min()) / pr
    nl = (ld - ld.min()) / lr

    # Shoelace area
    j = np.roll(np.arange(N), -1)
    ar = abs(np.sum(np_[np.arange(N)] * nl[j] - np_[j] * nl[np.arange(N)])) / 2

    # Top/bottom indices
    topI = int(np.argmax(np_))
    botI = int(np.argmin(np_))
    upI = []
    k = 0
    while k < N:
        idx = (botI + k) % N
        upI.append(idx)
        if idx == topI:
            break
        k += 1
    dnI = []
    k = 0
    while k < N:
        idx = (topI + k) % N
        dnI.append(idx)
        if idx == botI:
            break
        k += 1

    # flatTop
    if upI:
        maxUpL = max(nl[i] for i in upI)
        ft = sum(1 for i in upI if nl[i] > maxUpL * 0.85) / len(upI)
    else:
        ft = 0

    # flatBottom
    if dnI:
        minDnL = min(nl[i] for i in dnI)
        fb = sum(1 for i in dnI if nl[i] < minDnL + 0.15) / len(dnI)
    else:
        fb = 0

    # fluidPoundIdx
    fp = 0
    if len(dnI) > 5:
        maxDrop = max(nl[dnI[k - 1]] - nl[dnI[k]] for k in range(1, len(dnI)))
        fp = min(1, maxDrop * 3)

    # svTransition
    sv = 0
    svR = dnI[:max(3, len(dnI) // 7)]
    if len(svR) > 1:
        lDrop = nl[svR[0]] - nl[svR[-1]]
        pDrop = np_[svR[0]] - np_[svR[-1]]
        if abs(pDrop) > 0.001:
            sv = min(1, lDrop / (abs(pDrop) * 4))

    # tvTransition
    tv = 0
    tvR = upI[:max(3, len(upI) // 7)]
    if len(tvR) > 1:
        lJump = nl[tvR[-1]] - nl[tvR[0]]
        pJump = np_[tvR[-1]] - np_[tvR[0]]
        if pJump > 0.001:
            tv = min(1, lJump / (pJump * 4))

    # cdSharpness
    cd = 0
    if len(dnI) > 5:
        cdSeg = dnI[:max(5, int(len(dnI) * 3 / 10))]
        cdS = 0
        cdC = 0
        for k in range(1, len(cdSeg)):
            dp = abs(np_[cdSeg[k]] - np_[cdSeg[k - 1]])
            if dp > 0.001:
                cdS += (nl[cdSeg[k - 1]] - nl[cdSeg[k]]) / dp
                cdC += 1
        if cdC > 0:
            cd = min(1, (cdS / cdC) / 15)

    # abSharpness
    ab = 0
    if len(upI) > 5:
        abSeg = upI[:max(5, int(len(upI) * 3 / 10))]
        abS = 0
        abC = 0
        for k in range(1, len(abSeg)):
            dp = abs(np_[abSeg[k]] - np_[abSeg[k - 1]])
            if dp > 0.001:
                abS += (nl[abSeg[k]] - nl[abSeg[k - 1]]) / dp
                abC += 1
        if abC > 0:
            ab = min(1, (abS / abC) / 15)

    # dnLoadElev
    dnE = 0
    if len(dnI) > 4:
        ms = len(dnI) // 4
        me = 3 * len(dnI) // 4
        dnE = np.mean([nl[dnI[k]] for k in range(ms, me)])

    # upDropPt
    upD = 1.0
    if len(upI) > 5:
        upMax = max(nl[i] for i in upI)
        thresh = upMax * 0.80
        for k in range(len(upI) // 4, len(upI)):
            if nl[upI[k]] < thresh:
                upD = k / len(upI)
                break

    # maxDropLoc
    mdl = 0
    if len(dnI) > 5:
        bestD = 0
        for k in range(1, len(dnI)):
            d = nl[dnI[k - 1]] - nl[dnI[k]]
            if d > bestD:
                bestD = d
                mdl = k / len(dnI)

    # dnConvexity
    dnConv = 0
    if len(dnI) > 9:
        t = max(1, len(dnI) // 3)
        e = np.mean([nl[dnI[k]] for k in range(t)])
        m = np.mean([nl[dnI[k]] for k in range(t, 2 * t)])
        la = np.mean([nl[dnI[k]] for k in range(2 * t, len(dnI))])
        dnConv = m - (e + la) / 2

    # earlyDnLoad
    edl = 0
    if len(dnI) > 6:
        t = max(1, len(dnI) // 3)
        edl = np.mean([nl[dnI[k]] for k in range(t)])

    # dsSmooth (downstroke smoothness — std of load differences where position decreases)
    # Uses sequential scan, not formal downstroke segment — matches optimize_v4 approach
    dsSmooth = 0.0
    dsLoads = []
    for i in range(1, N):
        if np_[i] < np_[i - 1]:
            dsLoads.append(float(nl[i]))
    if len(dsLoads) > 3:
        dsDiffs = [dsLoads[k + 1] - dsLoads[k] for k in range(len(dsLoads) - 1)]
        dsSmooth = float(np.std(dsDiffs))

    return [ar, ft, fb, fp, sv, tv, cd, ab, dnE, upD, mdl, dnConv, edl, dsSmooth]


def classify(fvec):
    """Nearest centroid classifier with physics overrides (legacy)."""
    if fvec is None:
        return None
    best_id = None
    best_score = -1e9
    for cid, c in CENTROIDS.items():
        dist = 0
        for i in range(13):
            std = max(c['std'][i], 0.05)
            d = (fvec[i] - c['mean'][i]) / std
            dist += d * d
        dist = math.sqrt(dist)
        bonus = math.log(max(c['n'], 1) + 1) * 0.05
        score = -dist + bonus
        if score > best_score:
            best_score = score
            best_id = cid

    # Physics overrides
    ar, ft, fb, fp, sv, tv, cd, ab, dnE, upD, mdl, dnConv, edl = fvec
    if ar < 0.20 and ft < 0.25 and fb < 0.25:
        best_id = 'rod_part'
    elif ar < 0.15:
        best_id = 'rod_part'
    elif ar > 0.78 and ft > 0.68 and cd > 0.65 and upD > 0.88:
        best_id = 'full_pump'

    return best_id


# kNN classifier — matches card-patterns.js implementation
# drop flatBottom(2), upDropPt(9); add dsSmooth(13)
KNN_KEEP = [0, 1, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13]

def classify_knn(fvec, all_wells, exclude_nid=None, k=3):
    """kNN k=3 distance-weighted hybrid classifier (matches JS implementation).
    5-class voting (sv+tv merged to valve_leak) + svTrans heuristic split.
    73% 5-class LOO-CV, 71% 6-class equivalent."""
    if fvec is None:
        return None

    training = [w for w in all_wells if w['nid'] != exclude_nid]
    # Compute mean/std from training set
    all_vecs = np.array([[w['fvec'][i] for i in KNN_KEEP] for w in training])
    gmean = all_vecs.mean(axis=0)
    gstd = np.maximum(all_vecs.std(axis=0), 0.05)

    # Standardize query
    q = np.array([fvec[i] for i in KNN_KEEP])
    q_s = (q - gmean) / gstd

    # Compute distances
    dists = []
    for w in training:
        t = np.array([w['fvec'][i] for i in KNN_KEEP])
        t_s = (t - gmean) / gstd
        d = np.sqrt(np.sum((q_s - t_s) ** 2))
        dists.append((d, w['l1']))
    dists.sort(key=lambda x: x[0])

    # Distance-weighted voting — merge sv_leak + tv_leak into valve_leak
    from collections import defaultdict
    votes = defaultdict(float)
    for d, l1 in dists[:k]:
        lbl = 'valve_leak' if l1 in ('sv_leak', 'tv_leak') else l1
        votes[lbl] += 1.0 / (d + 0.01)

    pred = max(votes, key=votes.get)

    # Split valve_leak back into sv/tv using svTransition vs tvTransition
    if pred == 'valve_leak':
        pred = 'sv_leak' if fvec[4] > fvec[5] else 'tv_leak'

    return pred


def main():
    conn = pyodbc.connect(
        'DRIVER={ODBC Driver 17 for SQL Server};SERVER=sql2;DATABASE=xspoc;Trusted_Connection=yes;'
    )
    cur = conn.cursor()

    cur.execute('SELECT NodeID, PumpCondition FROM tblXDiagResultsLast WHERE PumpCondition IS NOT NULL')
    xspoc_diags = {r[0]: r[1] for r in cur.fetchall()}

    cur.execute('''
        SELECT c.NodeID, c.DownholeCardB FROM tblCardData c
        INNER JOIN (
            SELECT NodeID, MAX([Date]) as MaxDate FROM tblCardData
            WHERE DownholeCardB IS NOT NULL AND CardType='N' GROUP BY NodeID
        ) m ON c.NodeID=m.NodeID AND c.[Date]=m.MaxDate
        WHERE c.DownholeCardB IS NOT NULL AND c.CardType='N'
    ''')

    # Collect all wells for kNN
    wells = []
    for r in cur.fetchall():
        nid = r[0]
        if nid not in xspoc_diags:
            continue
        xspoc_l1 = map_xspoc_to_l1(xspoc_diags[nid])
        if xspoc_l1 is None:
            continue

        blob = r[1]
        f = struct.unpack('<%df' % (len(blob) // 4), blob)
        n = len(f) // 2
        pos = list(f[n:2 * n])
        ld = list(f[:n])

        fvec = extract_features(pos, ld)
        if fvec is None:
            continue
        wells.append({'nid': nid, 'xspoc_cond': xspoc_diags[nid], 'l1': xspoc_l1, 'fvec': fvec})

    conn.close()

    l1s = ['full_pump', 'under_filled', 'pump_issue', 'sv_leak', 'tv_leak', 'rod_part']

    # === kNN classifier (new, matches card-patterns.js) ===
    print('=== kNN k=3 distance-weighted (LOO-CV) ===')
    correct = 0
    total = len(wells)
    mismatches = []
    confusion = {}
    for w in wells:
        fae_l1 = classify_knn(w['fvec'], wells, exclude_nid=w['nid'])
        key = (w['l1'], fae_l1)
        confusion[key] = confusion.get(key, 0) + 1
        if fae_l1 == w['l1']:
            correct += 1
        else:
            mismatches.append((w['nid'], w['xspoc_cond'], w['l1'], fae_l1))

    print(f'L1 Accuracy: {correct}/{total} = {correct / total * 100:.0f}%')
    print()
    print(f'Confusion matrix (rows=XSPOC, cols=FAE):')
    print(f'{"":15s}', '  '.join(f'{l[:8]:>8s}' for l in l1s), '  total')
    for xl in l1s:
        row = [confusion.get((xl, fl), 0) for fl in l1s]
        if sum(row) == 0:
            continue
        print(f'{xl:15s}', '  '.join(f'{v:8d}' for v in row), f'  {sum(row):5d}')
    print()
    print(f'Mismatches ({len(mismatches)}):')
    for nid, xc, xl, fl in sorted(mismatches, key=lambda x: x[2]):
        print(f'  {nid:30s} XSPOC={xl:15s} FAE={fl:15s}  ({xc})')
    print()
    print('Per-class accuracy:')
    for l1 in l1s:
        tp = confusion.get((l1, l1), 0)
        total_l1 = sum(confusion.get((l1, fl), 0) for fl in l1s)
        if total_l1 > 0:
            print(f'  {l1:15s}: {tp}/{total_l1} = {tp / total_l1 * 100:.0f}%')

    # 3-class and binary accuracy
    map3 = {'full_pump':'N','under_filled':'U','pump_issue':'M','sv_leak':'M','tv_leak':'M','rod_part':'M'}
    mapb = {'full_pump':'ok','under_filled':'A','pump_issue':'A','sv_leak':'A','tv_leak':'A','rod_part':'A'}
    c3 = sum(1 for w in wells if map3.get(classify_knn(w['fvec'], wells, w['nid'])) == map3[w['l1']])
    cb = sum(1 for w in wells if mapb.get(classify_knn(w['fvec'], wells, w['nid'])) == mapb[w['l1']])
    print(f'\n  3-class: {c3}/{total} = {c3/total*100:.0f}%')
    print(f'  Binary:  {cb}/{total} = {cb/total*100:.0f}%')


if __name__ == '__main__':
    main()
