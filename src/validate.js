// 宣言が、ランチャーの規格 v0.3 の決まりに合うかを確かめる
// 決まりは、ランチャー 1.0.0（danoni_launcher.js）の検査と同じにしてある（normSetting・cleanValue・cleanColor）。

export const SPEC_VERSION = '0.3';
export const LIMITS = { settings: 40, options: 40, text: 80 };
export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
export const KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,29}$/;
const COLOR_RE = /^#[0-9a-f]{6}$/;
const COLOR_A_RE = /^#[0-9a-f]{8}$/;
const DIGITS_MAX = 20;

/** 色コードを #rrggbb（alpha のときは #rrggbbaa）にそろえる。色コードでなければ undefined */
export const cleanColor = (v, alpha = false) => {
    if (typeof v !== 'string') return undefined;
    const c = v.trim().toLowerCase();
    const full = /^#[0-9a-f]{3,4}$/.test(c) ? `#${[...c.slice(1)].map(x => x + x).join('')}` : c;
    if (alpha) return COLOR_RE.test(full) ? `${full}ff` : (COLOR_A_RE.test(full) ? full : undefined);
    return COLOR_RE.test(full) ? full : undefined;
};

/** 文字が色コードの形か。形なら不透明度つきかどうかを返す */
export const colorShape = v => {
    if (typeof v !== 'string') return null;
    const c = v.trim().toLowerCase();
    if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(c)) return { alpha: false };
    if (/^#([0-9a-f]{4}|[0-9a-f]{8})$/.test(c)) return { alpha: true };
    return null;
};

export const decimalsOf = n => {
    const [mant, exp] = String(n).toLowerCase().split('e');
    return Math.max((mant.split('.')[1] ?? '').length - Number(exp ?? 0), 0);
};

/** 数の設定の、刻みの数と桁数。決まりに合わなければ、理由の文字 */
const numberShape = (min, max, step) => {
    if (![min, max, step].every(Number.isFinite)) return '最小・最大・刻みに、数を入れてください';
    if (!(min < max)) return '最小は、最大より小さくしてください';
    if (!(step > 0)) return '刻みは、0 より大きくしてください';
    const digits = Math.max(decimalsOf(min), decimalsOf(step));
    if (digits > DIGITS_MAX) return '最小・刻みが細かすぎます（小数 20 桁まで）';
    if (!(Math.max(Math.abs(min), Math.abs(max)) / step <= 2 ** 50)) return '範囲に対して刻みが細かすぎます';
    let lastStep = Math.floor((max - min) / step + 1e-9);
    if (!Number.isFinite(lastStep)) return '範囲が広すぎます';
    if (lastStep > 0 && Number((min + lastStep * step).toFixed(digits)) > max) lastStep--;
    return { lastStep, digits };
};

/** ランチャーが値を範囲と刻みに合わせたあとの数 */
export const snapNumber = (v, min, max, step) => {
    const shape = numberShape(min, max, step);
    if (typeof shape === 'string') return undefined;
    const inRange = Math.min(Math.max(v, min), max);
    const index = Math.min(Math.round((inRange - min) / step), shape.lastStep);
    const snapped = Number((min + index * step).toFixed(shape.digits));
    return Math.min(Math.max(snapped, min), max);
};

const hasTag = v => typeof v === 'string' && v.length > 200;

/**
 * 変換の指定を確かめる
 * @param {object} config 変換の指定（convert() に渡すもの）
 * @param {Map<string, object>} candidates 候補（id → 候補）
 * @returns {{ field: string, text: string }[]} 直さないと変換できない所
 */
export const validateConfig = (config, candidates) => {
    const errors = [];
    const err = (field, text) => errors.push({ field, text });

    if (typeof config.id !== 'string' || !ID_RE.test(config.id)) {
        err('id', 'id は、英数字で始まる英数字と . _ - で、40 文字までです');
    }
    for (const [field, v] of [['name', config.name], ['description', config.description]]) {
        if (hasTag(v?.ja) || hasTag(v?.en)) err(field, '200 文字までにしてください');
    }
    const settings = Array.isArray(config.settings) ? config.settings : [];
    if (settings.length > LIMITS.settings) err('settings', `設定は ${LIMITS.settings} 個までです`);

    const keys = new Set();
    const used = new Set();
    for (const s of settings) {
        const cand = candidates.get(s.cand);
        const where = `setting:${s.cand}`;
        if (cand === undefined) {
            err(where, `候補が見つかりません: ${s.cand}`);
            continue;
        }
        if (used.has(s.cand)) err(where, '同じ候補が 2 回選ばれています');
        used.add(s.cand);
        const at = `${cand.name}: `;
        if (typeof s.key !== 'string' || !KEY_RE.test(s.key)) {
            err(where, `${at}key は、英字で始まる英数字と _ で、30 文字までです`);
        } else if (keys.has(s.key)) {
            err(where, `${at}key「${s.key}」が、ほかの設定と同じです`);
        }
        keys.add(s.key);

        if (s.type === 'toggle') {
            if (cand.valueType !== 'boolean') err(where, `${at}オン／オフにできるのは、true / false の定数だけです`);
        } else if (s.type === 'number') {
            if (cand.valueType !== 'number') {
                err(where, `${at}数にできるのは、数の定数だけです`);
                continue;
            }
            const [min, max, step] = [Number(s.min), Number(s.max), Number(s.step)];
            const shape = numberShape(min, max, step);
            if (typeof shape === 'string') {
                err(where, at + shape);
            } else if (snapNumber(cand.value, min, max, step) !== cand.value) {
                err(where, `${at}いまの値 ${cand.value} が、範囲と刻みに乗っていません（ランチャーが入ると ${snapNumber(cand.value, min, max, step)} になります）`);
            }
        } else if (s.type === 'color') {
            const shape = colorShape(cand.value);
            if (shape === null) {
                err(where, `${at}色コードにできるのは、#rrggbb の形の文字だけです`);
            } else if (shape.alpha && s.alpha !== true) {
                err(where, `${at}いまの値に不透明度が入っているので、「不透明度も選ぶ」を入れてください`);
            }
        } else if (s.type === 'select') {
            if (cand.valueType === 'boolean') {
                err(where, `${at}true / false の定数は、オン／オフにしてください`);
                continue;
            }
            const wantNumber = cand.valueType === 'number';
            const options = Array.isArray(s.options) ? s.options : [];
            if (options.length < 2) err(where, `${at}選択肢を 2 つ以上入れてください`);
            if (options.length > LIMITS.options) err(where, `${at}選択肢は ${LIMITS.options} 個までです`);
            const seen = new Set();
            for (const o of options) {
                if (wantNumber ? !(typeof o.value === 'number' && Number.isFinite(o.value)) : typeof o.value !== 'string') {
                    err(where, `${at}選択肢の値は、${wantNumber ? '数' : '文字'}にしてください（元の定数と同じ種類）`);
                } else if (String(o.value).length > LIMITS.text) {
                    err(where, `${at}選択肢の値は ${LIMITS.text} 文字までです`);
                }
                if (seen.has(o.value)) err(where, `${at}同じ値の選択肢があります: ${o.value}`);
                seen.add(o.value);
            }
            if (options.length >= 2 && !seen.has(cand.value)) {
                err(where, `${at}いまの値 ${JSON.stringify(cand.value)} を、選択肢に入れてください`);
            }
        } else {
            err(where, `${at}型は、オン／オフ・選択・数・色コードの 4 つです`);
        }
    }
    return errors;
};
