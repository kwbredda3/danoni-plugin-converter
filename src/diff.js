// 行ごとの差分（前と後ろの同じ所を除いてから、残りを最長の共通部分で比べる）

/**
 * @param {string[]} a 元の行
 * @param {string[]} b 書き換えたあとの行
 * @returns {{ type: 'same' | 'del' | 'add', text: string, a?: number, b?: number }[]} a・b は行の番号（1 から）
 */
export const diffLines = (a, b) => {
    let head = 0;
    while (head < a.length && head < b.length && a[head] === b[head]) head++;
    let tail = 0;
    while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;

    const out = [];
    for (let i = 0; i < head; i++) out.push({ type: 'same', text: a[i], a: i + 1, b: i + 1 });

    const am = a.slice(head, a.length - tail);
    const bm = b.slice(head, b.length - tail);
    const n = am.length;
    const m = bm.length;
    if (n * m > 6_000_000) {
        // 大きすぎるときは、まとめて「消した・足した」にする
        am.forEach((t, i) => out.push({ type: 'del', text: t, a: head + i + 1 }));
        bm.forEach((t, j) => out.push({ type: 'add', text: t, b: head + j + 1 }));
    } else {
        const w = m + 1;
        const lcs = new Uint32Array((n + 1) * w);
        for (let i = n - 1; i >= 0; i--) {
            for (let j = m - 1; j >= 0; j--) {
                lcs[i * w + j] = am[i] === bm[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
            }
        }
        let i = 0;
        let j = 0;
        while (i < n || j < m) {
            if (i < n && j < m && am[i] === bm[j]) {
                out.push({ type: 'same', text: am[i], a: head + i + 1, b: head + j + 1 });
                i++;
                j++;
            } else if (j < m && (i === n || lcs[i * w + j + 1] > lcs[(i + 1) * w + j])) {
                out.push({ type: 'add', text: bm[j], b: head + j + 1 });
                j++;
            } else {
                out.push({ type: 'del', text: am[i], a: head + i + 1 });
                i++;
            }
        }
    }
    for (let k = 0; k < tail; k++) {
        out.push({ type: 'same', text: a[a.length - tail + k], a: a.length - tail + k + 1, b: b.length - tail + k + 1 });
    }
    return out;
};

/**
 * 変わった所の前後だけを残す
 * @returns {(object | { type: 'skip', count: number })[]}
 */
export const withContext = (ops, context = 3) => {
    const keep = new Uint8Array(ops.length);
    ops.forEach((op, i) => {
        if (op.type !== 'same') {
            for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k++) keep[k] = 1;
        }
    });
    const out = [];
    let skipped = 0;
    ops.forEach((op, i) => {
        if (keep[i]) {
            if (skipped > 0) out.push({ type: 'skip', count: skipped });
            skipped = 0;
            out.push(op);
        } else {
            skipped++;
        }
    });
    if (skipped > 0) out.push({ type: 'skip', count: skipped });
    return out;
};
