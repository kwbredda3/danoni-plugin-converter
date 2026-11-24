// 既存のカスタムjsを、ランチャーの規格（v0.3）に合わせて書き換える
//
//   analyze(source)          … 設定にできそうな定数（候補）と、気を付ける所を返す
//   convert(source, config)  … 選んだ候補を設定にして、書き換えた js を返す
//
// 書き換えは、構文木で場所を決めて、その場所の文字だけを差し替える。ほかの所（注釈・字下げ・改行）は元のまま。
// 画面（ブラウザ）とコマンドラインの両方から呼ぶので、ここでは DOM もファイルも触らない。

import { parse } from '../vendor/acorn.mjs';
import { walkProgram, resolve, memberChain, isFunction } from './scope.js';
import { validateConfig, cleanColor, colorShape, decimalsOf, KEY_RE, SPEC_VERSION } from './validate.js';

export { SPEC_VERSION };
export const TOOL_VERSION = '0.1.1';

/* ------------------------------------------------------------
 * 読み取り
 * ------------------------------------------------------------ */

/** 定数として書かれた値（true / false・数・文字）。それ以外は null */
const scalar = n => {
    if (!n) return null;
    if (n.type === 'Literal' && ['boolean', 'number', 'string'].includes(typeof n.value)) {
        return { value: n.value };
    }
    if (n.type === 'UnaryExpression' && (n.operator === '-' || n.operator === '+')
        && n.argument.type === 'Literal' && typeof n.argument.value === 'number') {
        return { value: n.operator === '-' ? -n.argument.value : n.argument.value };
    }
    if (n.type === 'TemplateLiteral' && n.expressions.length === 0 && typeof n.quasis[0].value.cooked === 'string') {
        return { value: n.quasis[0].value.cooked };
    }
    return null;
};

const valueTypeOf = v => (typeof v === 'string' ? (colorShape(v) !== null ? 'color' : 'string') : typeof v);

/** 定数を足し合わせるだけの式か（関数にしても、意味が変わらない式） */
const PURE_CALLS = new Set(['Number', 'String', 'Boolean', 'parseInt', 'parseFloat']);
const isPure = n => {
    switch (n?.type) {
        case 'Literal':
        case 'Identifier':
            return true;
        case 'TemplateLiteral': return n.expressions.every(isPure);
        case 'UnaryExpression': return n.operator !== 'delete' && isPure(n.argument);
        case 'BinaryExpression':
        case 'LogicalExpression':
            return isPure(n.left) && isPure(n.right);
        case 'ConditionalExpression': return isPure(n.test) && isPure(n.consequent) && isPure(n.alternate);
        case 'MemberExpression': return isPure(n.object) && (!n.computed || isPure(n.property));
        case 'CallExpression': {
            const c = n.callee;
            const ok = (c.type === 'Identifier' && PURE_CALLS.has(c.name))
                || (c.type === 'MemberExpression' && !c.computed && c.object.type === 'Identifier' && c.object.name === 'Math');
            return ok && n.arguments.every(isPure);
        }
        default: return false;
    }
};

/** 注釈から、ラベルの下書き（最初の 1 行）を取る */
const commentLine = c => {
    const lines = c.value.split(/\r?\n/).map(l => l.replace(/^[\s*/]+/, '').trim()).filter(l => l !== '' && !l.startsWith('@'));
    return lines[0] ?? '';
};

const UNIT_RE = /[(（]\s*(px|ms|%|％|秒|sec|s|fps|frames?|フレーム|度|deg)\s*[)）]/i;

/** 定数の名前から、設定の key の下書きを作る（BAR_H → barH） */
const toKey = name => {
    let s = name.replace(/^[CcGg]_(?=.)/, '').replace(/[^A-Za-z0-9_]/g, '_');
    if (/^[A-Z0-9_]+$/.test(s)) {
        s = s.toLowerCase().replace(/_+([a-z0-9])/g, (_, c) => c.toUpperCase());
    }
    s = s.replace(/^[^A-Za-z]+/, '').replace(/_+$/, '');
    if (s === '') s = 'value';
    return (s[0].toLowerCase() + s.slice(1)).slice(0, 30);
};

/** 数の設定の、範囲と刻みの下書き */
const suggestRange = v => {
    const dec = Math.min(decimalsOf(v), 6);
    const step = dec === 0 ? 1 : Number((10 ** -dec).toFixed(dec));
    const abs = Math.abs(v);
    let hi;
    if (abs === 0) hi = dec === 0 ? 10 : 1;
    else if (abs <= 1 && dec > 0) hi = 1;
    else hi = Math.ceil(abs * 2);
    return v < 0 ? { min: -hi, max: hi, step } : { min: 0, max: hi, step };
};

/** ファイル名から、id の下書きを作る（danoni_lifegauge_pos.js → lifegauge-pos） */
export const suggestId = fileName => {
    const base = String(fileName ?? '').replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '')
        .replace(/^danoni[_-]?/i, '').replace(/^custom[_-]?/i, '');
    const id = base.replace(/[^A-Za-z0-9.-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').replace(/-+$/, '').toLowerCase().slice(0, 40);
    return id;
};

/**
 * 元の js を読んで、あとの作業に要るものをそろえる
 * @returns {object} 失敗したときは { error: { line, text } }
 */
const prepare = source => {
    const bom = source.charCodeAt(0) === 0xfeff;
    const text = bom ? source.slice(1) : source;
    const comments = [];
    let ast;
    try {
        ast = parse(text, { ecmaVersion: 'latest', sourceType: 'script', locations: true, allowHashBang: true, onComment: comments });
    } catch (e) {
        return { error: { line: e.loc?.line ?? null, text: `構文エラーで読めませんでした: ${e.message}` } };
    }

    // 全体が 1 つの即時関数に包まれているか
    const stmts = ast.body.filter(s => !s.directive);
    let style = 'global';
    let rootFn = null;
    let rootContainer = ast;
    if (stmts.length === 1 && stmts[0].type === 'ExpressionStatement') {
        let e = stmts[0].expression;
        if (e.type === 'UnaryExpression') e = e.argument;
        if (e.type === 'CallExpression' && isFunction(e.callee) && e.callee.body.type === 'BlockStatement' && !e.callee.generator) {
            style = 'iife';
            rootFn = e.callee;
            rootContainer = e.callee.body;
        }
    }
    const rootBody = rootContainer.body;

    const { refs, idents, programScope } = walkProgram(ast);
    const rootScope = style === 'iife' ? rootFn._scope : programScope;

    /** 名前 → 冒頭の宣言を指す参照 */
    const rootRefs = new Map();
    for (const ref of refs) {
        const r = resolve(ref);
        if (r.scope === rootScope) {
            ref.depth = r.depth;
            if (!rootRefs.has(ref.name)) rootRefs.set(ref.name, []);
            rootRefs.get(ref.name).push(ref);
        }
    }

    const eol = /\r\n/.test(text) ? '\r\n' : '\n';
    const lineStart = pos => text.lastIndexOf('\n', pos - 1) + 1;
    const lineEnd = pos => {
        const i = text.indexOf('\n', pos);
        return i === -1 ? text.length : i;
    };
    const indentOf = pos => /^[ \t]*/.exec(text.slice(lineStart(pos)))[0];
    const startsLine = pos => /^[ \t]*$/.test(text.slice(lineStart(pos), pos));

    /** すぐ上に続けて書かれた注釈（空行をはさまないもの） */
    const leadingComments = pos => {
        const out = [];
        let cur = pos;
        for (let i = comments.length - 1; i >= 0; i--) {
            const c = comments[i];
            if (c.end > cur) continue;
            const gap = text.slice(c.end, cur);
            if (!/^\s*$/.test(gap) || /\n[ \t]*\r?\n/.test(gap) || !startsLine(c.start)) break;
            out.unshift(c);
            cur = c.start;
        }
        return out;
    };
    /** 同じ行の後ろに書かれた注釈 */
    const trailingComment = end => {
        const stop = lineEnd(end);
        const c = comments.find(x => x.start >= end && x.start < stop);
        return c !== undefined && /^[ \t;,]*$/.test(text.slice(end, c.start)) ? c : null;
    };

    // 字下げの単位
    const tabLines = (text.match(/^\t+\S/gm) ?? []).length;
    const spaceRuns = (text.match(/^ +(?=\S)/gm) ?? []).map(s => s.length).filter(n => n >= 2);
    const indentUnit = tabLines > spaceRuns.length ? '\t' : ' '.repeat(spaceRuns.length > 0 ? Math.min(4, Math.min(...spaceRuns)) : 4);

    // 候補を集める
    const cands = [];
    const add = c => {
        c.id = `c${cands.length}`;
        c.valueType = valueTypeOf(c.value);
        c.line = c.node.loc.start.line;
        cands.push(c);
    };
    const collectProps = (obj, objName, path, frozen) => {
        for (const p of obj.properties) {
            if (p.type !== 'Property' || p.computed || p.shorthand || p.method || p.kind !== 'init') continue;
            const key = p.key.type === 'Identifier' ? p.key.name
                : (p.key.type === 'Literal' && ['string', 'number'].includes(typeof p.key.value) ? String(p.key.value) : null);
            if (key === null || key === '__proto__') continue;
            const s = scalar(p.value);
            if (s !== null) {
                add({
                    kind: 'prop', name: [objName, ...path, key].join('.'), objName, path: [...path, key], value: s.value,
                    node: p, frozen, leading: leadingComments(p.start), trailing: trailingComment(p.end),
                });
            } else if (p.value.type === 'ObjectExpression') {
                collectProps(p.value, objName, [...path, key], frozen);
            }
        }
    };
    for (const stmt of rootBody) {
        if (stmt.type !== 'VariableDeclaration') continue;
        for (const d of stmt.declarations) {
            if (d.id.type !== 'Identifier' || !d.init) continue;
            const s = scalar(d.init);
            if (s !== null) {
                add({
                    kind: 'const', name: d.id.name, value: s.value, node: d, decl: stmt,
                    leading: stmt.declarations.length === 1 ? leadingComments(stmt.start) : [],
                    trailing: stmt.declarations.length === 1 ? trailingComment(stmt.end) : null,
                });
                continue;
            }
            // const a = window.b = Object.freeze({ ... }) の形も、中のオブジェクトを見る
            let o = d.init;
            let frozen = false;
            for (;;) {
                if (o.type === 'AssignmentExpression' && o.operator === '=') {
                    o = o.right;
                } else if (o.type === 'CallExpression' && o.arguments.length === 1 && o.callee.type === 'MemberExpression'
                    && o.callee.object.name === 'Object' && ['freeze', 'seal'].includes(o.callee.property.name)) {
                    frozen = true;
                    o = o.arguments[0];
                } else {
                    break;
                }
            }
            if (o.type === 'ObjectExpression') collectProps(o, d.id.name, [], frozen);
        }
    }

    // 読み込みのときにだけ呼ばれる関数を探す。
    // 冒頭で名前を付けた関数のうち、使い方が「その場で呼ぶ」だけで（フックに渡す・ほかへ入れる、が無い）、
    // 呼ぶ所がどれも読み込みの流れの中（冒頭の直下か、同じく読み込みのときにだけ呼ばれる関数の中）にあるもの。
    // その中で読んだ設定も、読み込みのときに 1 回だけ読まれる（例: let type = loadType(); の loadType の中）。
    /** そのノードを囲む、いちばん内側の「あとで呼ばれる関数」（無ければ null） */
    const boundaryOf = node => {
        for (let cur = node._p; cur; cur = cur._p) {
            if (isFunction(cur) && cur._immediate !== true) return cur;
        }
        return null;
    };
    const namedFns = new Map();   // 関数のノード → 名前
    for (const stmt of rootBody) {
        if (stmt.type === 'FunctionDeclaration' && stmt.id) {
            namedFns.set(stmt, stmt.id.name);
        } else if (stmt.type === 'VariableDeclaration') {
            for (const d of stmt.declarations) {
                if (d.id.type === 'Identifier' && isFunction(d.init)) namedFns.set(d.init, d.id.name);
            }
        }
    }
    const loadOnly = new Set();   // 関数のノード
    for (let grew = true; grew;) {
        grew = false;
        for (const [fn, name] of namedFns) {
            if (loadOnly.has(fn)) continue;
            const uses = rootRefs.get(name) ?? [];
            const ok = uses.length > 0 && uses.every(ref => {
                const p = ref.node._p;
                if (p?.type !== 'CallExpression' || p.callee !== ref.node) return false;
                const b = boundaryOf(ref.node);
                return b === null || loadOnly.has(b);
            });
            if (ok) {
                loadOnly.add(fn);
                grew = true;
            }
        }
    }
    /** その参照が、読み込みのときにだけ呼ばれる関数の中（直下）にあれば、その関数の名前。無ければ null */
    const loadFnOf = ref => {
        if (ref.depth === 0) return null;
        const b = boundaryOf(ref.node);
        return b !== null && loadOnly.has(b) ? namedFns.get(b) : null;
    };

    // 候補ごとに、使われ方を調べる
    const startsWith = (long, short) => short.every((k, i) => long[i] === k);
    for (const c of cands) {
        c.mutated = false;
        c.loadReads = [];   // 読み込みのときに 1 回だけ読む所
        c.loadCalls = [];   // 読み込みのときにだけ呼ばれる関数の中で読む所 { ref, fn }
        const note = ref => {
            if (ref.depth === 0) {
                c.loadReads.push(ref);
                return;
            }
            const fn = loadFnOf(ref);
            if (fn !== null) c.loadCalls.push({ ref, fn });
        };
        if (c.kind === 'const') {
            c.refs = rootRefs.get(c.name) ?? [];
            for (const ref of c.refs) {
                const ch = memberChain(ref);
                if (ch.path.length === 0 && !ch.dynamic && ch.write) c.mutated = true;
                note(ref);
            }
        } else {
            c.refs = [];
            for (const ref of rootRefs.get(c.objName) ?? []) {
                const ch = memberChain(ref);
                if (startsWith(ch.path, c.path)) {
                    c.refs.push(ref);
                    if (ch.path.length === c.path.length && !ch.dynamic && ch.write) c.mutated = true;
                    note(ref);
                } else if (!ch.dynamic && startsWith(c.path, ch.path)) {
                    // オブジェクトごと、読み込みのときに中身を取り出している（分割代入・スプレッド）
                    const p = ch.top._p;
                    if ((p?.type === 'VariableDeclarator' && p.init === ch.top && p.id.type === 'ObjectPattern') || p?.type === 'SpreadElement') {
                        note(ref);
                    }
                }
            }
        }
    }

    return {
        bom, text, ast, comments, style, rootFn, rootContainer, rootBody, rootRefs, refs, idents, cands, eol, indentUnit,
        lineStart, lineEnd, indentOf, startsLine, leadingComments, trailingComment, loadFnOf,
    };
};

/** 気を付ける所を集める */
const collectNotices = ctx => {
    const notices = [];
    const note = (kind, line, text) => notices.push({ kind, line, text });
    const { ast, rootBody, style, refs, idents } = ctx;

    if (idents.has('g_danoniPlugins')) {
        note('already', null, 'すでに g_danoniPlugins を使っています。規格に合わせてあるファイルのようです。');
    }
    const oldFns = ast.body.filter(s => s.type === 'FunctionDeclaration' && /^custom[A-Z]/.test(s.id?.name ?? ''));
    if (oldFns.length > 0) {
        note('oldStyle', oldFns[0].loc.start.line,
            `function ${oldFns[0].id.name}() のように、本体から名前で呼ばれる関数を ${oldFns.length} 個書いています（旧式の書き方）。`
            + '全体は包まずに、宣言だけを固有の名前（g_plugin_◯◯）で足します。');
    }
    if (style === 'iife') {
        for (const s of rootBody) {
            if (s.type === 'IfStatement' && !s.alternate) {
                const body = s.consequent.type === 'BlockStatement' ? s.consequent.body : [s.consequent];
                if (body.some(b => b.type === 'ReturnStatement')) {
                    note('earlyReturn', s.loc.start.line,
                        'ここで抜けると、一覧には出ますが何もしません。使えない理由があるなら、抜ける前に def.unsupported に理由を入れると、一覧に薄く出せます。');
                }
            }
        }
    }
    const seen = new Set();
    const once = (kind, line, text) => {
        if (!seen.has(`${kind}:${line}`)) {
            seen.add(`${kind}:${line}`);
            note(kind, line, text);
        }
    };
    for (const ref of refs) {
        const line = ref.node.loc.start.line;
        const p = ref.node._p;
        if (ref.name === 'g_settings') {
            const ch = memberChain(ref);
            if (ch.write && ch.path.length > 0) {
                once('displayOption', line,
                    `本体の設定画面の選択肢（g_settings.${ch.path.join('.')}）を書き換えています。ランチャーの「選択」の設定に移すと、本体の画面に足さずに済みます（手で直す所）。`);
            }
        } else if ((ref.name === 'createCss2Button' || ref.name === 'createCssButton') && p?.type === 'CallExpression' && p.callee === ref.node) {
            once('button', line,
                '画面に自前のボタンを足しています。宣言の actions に同じ動きを置くと、ランチャーの中から押せます（手で直す所。両方に置いてもよい）。');
        } else if (ref.name === 'localStorage' && resolve(ref).scope === null) {
            once('storage', line,
                '自前で localStorage を使っています。設定にした値はランチャーが保存するので、その分の保存の処理は外せます（手で直す所）。');
        }
    }
    return notices.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
};

/**
 * 元の js を調べる
 * @param {string} source 元の js
 * @param {{ fileName?: string }} [opts]
 */
export const analyze = (source, opts = {}) => {
    const ctx = prepare(source);
    if (ctx.error) return { ok: false, error: ctx.error };

    const usedKeys = new Set();
    const candidates = ctx.cands.map(c => {
        const label = commentLine(c.leading[0] ?? c.trailing ?? { value: '' }).replace(UNIT_RE, '').trim();
        const allComment = [...c.leading, ...(c.trailing ? [c.trailing] : [])].map(x => x.value).join('\n');
        let key = toKey(c.kind === 'const' ? c.name : c.path.at(-1));
        if (usedKeys.has(key) && c.kind === 'prop' && c.path.length > 1) key = toKey(c.path.slice(-2).join('_'));
        for (let n = 2, base = key; usedKeys.has(key); n++) key = `${base.slice(0, 28)}${n}`;
        usedKeys.add(key);
        const shape = c.valueType === 'color' ? colorShape(c.value) : null;
        return {
            id: c.id, kind: c.kind, name: c.name, valueType: c.valueType, value: c.value, line: c.line,
            comment: label, mutated: c.mutated,
            // 読み込みのときに 1 回だけ読む所（読み込みのときにだけ呼ばれる関数の中で読む所も入れる）
            loadReadLines: [...new Set([...c.loadReads, ...c.loadCalls.map(x => x.ref)].map(r => r.node.loc.start.line))].sort((x, y) => x - y),
            suggest: {
                key,
                type: { boolean: 'toggle', number: 'number', color: 'color', string: 'select' }[c.valueType],
                labelJa: label.replace(/[。.]$/, '').slice(0, 40),
                ...(c.valueType === 'number' ? suggestRange(c.value) : {}),
                ...(c.valueType === 'number' ? { unit: (UNIT_RE.exec(allComment)?.[1] ?? '').replace('％', '%') } : {}),
                ...(shape !== null ? { alpha: shape.alpha } : {}),
            },
        };
    });
    return {
        ok: true,
        style: ctx.style,
        lines: ctx.text.split('\n').length,
        suggestId: suggestId(opts.fileName),
        candidates,
        notices: collectNotices(ctx),
    };
};

/* ------------------------------------------------------------
 * 書き換え
 * ------------------------------------------------------------ */

/** 文字を、テンプレート文字列（`…`）の形で書く */
const quote = s => `\`${String(s).replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${').replace(/\r?\n/g, '\\n')}\``;

/** 日本語と英語の文字を、規格の書き方にする。どちらも空なら null */
const localized = v => {
    const ja = String(v?.ja ?? '').trim();
    const en = String(v?.en ?? '').trim();
    if (ja !== '' && en !== '') return `{ ja: ${quote(ja)}, en: ${quote(en)} }`;
    return ja !== '' || en !== '' ? quote(ja || en) : null;
};

const literal = v => (typeof v === 'string' ? quote(v) : String(v));

/** ASCII でない文字を \uXXXX に */
export const toAscii = text => {
    let out = '';
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        out += code > 0x7f ? `\\u${code.toString(16).toUpperCase().padStart(4, '0')}` : text[i];
    }
    return out;
};
const asciiUnsafe = text => {
    if (/\\[^\x00-\x7f]/.test(text)) return 'バックスラッシュの直後に、ASCII でない文字があります';
    if (/String\.raw/.test(text)) return 'String.raw を使っています（中の文字が、書いたままの形で使われます）';
    return null;
};

/** 差し替えをまとめて当てる（後ろから順に。重なっていたら例外） */
const applyEdits = (text, edits) => {
    const ranges = edits.filter(e => e.end > e.start).sort((a, b) => a.start - b.start);
    for (let i = 1; i < ranges.length; i++) {
        if (ranges[i].start < ranges[i - 1].end) throw new Error('書き換える場所が重なりました');
    }
    for (const e of edits) {
        if (e.end === e.start && ranges.some(r => r.start < e.start && e.start < r.end)) {
            throw new Error('書き換える場所が重なりました');
        }
    }
    // 同じ位置なら、置き換えを先に当ててから、差し込みを当てる（差し込んだ文字が前に来る）
    const sorted = edits.map((e, i) => ({ ...e, i }))
        .sort((a, b) => (b.start - a.start) || ((a.end > a.start ? 0 : 1) - (b.end > b.start ? 0 : 1)) || (a.i - b.i));
    let out = text;
    for (const e of sorted) {
        out = out.slice(0, e.start) + e.text + out.slice(e.end);
    }
    return out;
};

/**
 * 書き換える
 * @param {string} source 元の js
 * @param {object} config
 *   id, name{ja,en}, version, description{ja,en}, affectsPlay,
 *   settings: [{ cand, key, type, label{ja,en}, note{ja,en}, min, max, step, unit, options[{value,label{ja,en}}], alpha }],
 *   options: { ascii, lazy, onChangeStub }
 * @returns {{ ok: boolean, output?: string, errors: object[], warnings: object[], info?: object }}
 */
export const convert = (source, config) => {
    const ctx = prepare(source);
    if (ctx.error) return { ok: false, errors: [{ field: 'source', text: ctx.error.text, line: ctx.error.line }], warnings: [] };
    const { text, eol, cands, rootRefs, idents } = ctx;
    const opt = { ascii: false, lazy: true, onChangeStub: true, ...(config.options ?? {}) };
    const settings = Array.isArray(config.settings) ? config.settings : [];

    const errors = validateConfig(config, new Map(cands.map(c => [c.id, c])));
    if (idents.has('g_danoniPlugins')) {
        errors.push({ field: 'source', text: 'すでに g_danoniPlugins を使っているファイルは、書き換えません。' });
    }
    if (errors.length > 0) return { ok: false, errors, warnings: [] };

    const warnings = [];
    const warned = new Set();
    const warn = (line, msg) => {
        if (!warned.has(`${line}:${msg}`)) {
            warned.add(`${line}:${msg}`);
            warnings.push({ line, text: msg });
        }
    };
    const lineOf = node => node.loc.start.line;

    // 足す名前（元のファイルに同じ名前があれば、別の名前にする）
    const pick = (...names) => {
        const free = names.find(n => !idents.has(n));
        if (free !== undefined) return free;
        for (let n = 2; ; n++) {
            if (!idents.has(`${names.at(-1)}${n}`)) return `${names.at(-1)}${n}`;
        }
    };
    const camelId = config.id.replace(/[^A-Za-z0-9]+([A-Za-z0-9])?/g, (_, c) => (c ?? '').toUpperCase());
    const defName = ctx.style === 'iife' ? pick('def', 'pluginDef') : pick(`g_plugin_${camelId}`);
    const listName = pick('list', 'pluginList');
    const valueExpr = key => `${defName}.values.${key}`;

    const edits = [];
    const replaceRef = (ref, expr) => edits.push({
        start: ref.node.start, end: ref.node.end, text: ref.shorthand ? `${ref.name}: ${expr}` : expr,
    });

    const chosen = settings.map(s => ({ s, c: cands.find(c => c.id === s.cand) }));
    const constNames = new Set(chosen.filter(x => x.c.kind === 'const').map(x => x.c.name));

    // 1. 値を読む所を差し替える
    for (const { s, c } of chosen) {
        if (c.mutated) {
            warn(c.line, `「${c.name}」は、途中で書き換えられています。設定ではなく、状態を持つ変数かもしれません。`);
        }
        if (s.type === 'toggle' && s.key === 'enabled') {
            warn(c.line, 'key が enabled のオン／オフは、ランチャーでは全体のスイッチになります（OFF の間、ほかの設定とボタンは出ません）。');
        }
        if (c.kind === 'const') {
            c.refs.forEach(ref => replaceRef(ref, valueExpr(s.key)));
            if (ctx.style === 'global') {
                warn(c.line, `「${c.name}」の宣言を外しました。ほかのファイルからこの名前を読んでいるなら、そちらも ${valueExpr(s.key)} に直してください。`);
            }
        } else {
            const keyText = text.slice(c.node.key.start, c.node.key.end);
            const getter = `get ${keyText}() { return ${valueExpr(s.key)}; }`;
            const setter = `set ${keyText}(_v) { ${valueExpr(s.key)} = _v; }`;
            edits.push({ start: c.node.start, end: c.node.end, text: c.frozen ? getter : `${getter}, ${setter}` });
        }
    }

    // 2. 読み込みのときに 1 回だけ読む所。定数を足し合わせるだけの定数は、関数に直す
    const rootStatementOf = node => {
        let cur = node;
        while (cur._p && cur._p !== ctx.rootContainer) cur = cur._p;
        return cur._p === ctx.rootContainer ? cur : null;
    };
    const inside = (outer, inner) => inner.start >= outer.start && inner.end <= outer.end;
    const lazy = new Map();   // 名前 → 宣言（関数に直す定数）
    const queue = chosen.filter(x => x.c.kind === 'const').flatMap(x => x.c.loadReads.map(ref => ({ ref, from: x.c.name })));
    while (queue.length > 0) {
        const { ref, from } = queue.shift();
        const stmt = rootStatementOf(ref.node);
        const d = stmt?.type === 'VariableDeclaration' && stmt.kind === 'const'
            ? stmt.declarations.find(x => x.init && inside(x.init, ref.node)) : undefined;
        if (opt.lazy && d !== undefined && d.id.type === 'Identifier' && !constNames.has(d.id.name) && isPure(d.init)) {
            if (!lazy.has(d.id.name)) {
                lazy.set(d.id.name, d);
                for (const r of rootRefs.get(d.id.name) ?? []) {
                    if (r.depth === 0) queue.push({ ref: r, from: d.id.name });
                }
            }
            continue;
        }
        const via = constNames.has(from) ? '' : `（${[...constNames].join('・')} から計算した値）`;
        warn(lineOf(ref.node), `「${from}」${via}を、読み込みのときに 1 回だけ読んでいます。ランチャーで変えた値が、ここには届きません。値を使う関数の中で読むように直してください。`);
    }
    /** 読み込みのときにだけ呼ばれる関数の中で読んでいる所の注意 */
    const warnLoadCall = (ref, fn, what) => warn(lineOf(ref.node),
        `${what}を、読み込みのときにだけ呼ばれる関数 ${fn}() の中で読んでいます。ランチャーが後から読み込まれると、変えた値がここには届きません。`
        + `値を使うたびに呼ばれる所で読むように直してください。`);
    for (const [name, d] of lazy) {
        edits.push({ start: d.init.start, end: d.init.start, text: '() => (' });
        edits.push({ start: d.init.end, end: d.init.end, text: ')' });
        (rootRefs.get(name) ?? []).forEach(ref => {
            replaceRef(ref, `${name}()`);
            const fn = ctx.loadFnOf(ref);
            if (fn !== null) warnLoadCall(ref, fn, `「${name}」（${[...constNames].join('・')} から計算した値）`);
        });
    }
    for (const { c } of chosen) {
        if (c.kind === 'prop') {
            c.loadReads.forEach(ref => warn(lineOf(ref.node),
                `「${c.name}」を、読み込みのときに 1 回だけ読んでいます。ランチャーで変えた値が、ここには届きません。値を使う関数の中で読むように直してください。`));
        }
        c.loadCalls.forEach(({ ref, fn }) => warnLoadCall(ref, fn, `「${c.name}」`));
    }

    // 3. 定数の宣言を外す（上と横の注釈は、宣言の設定の行の上へ移す）
    const moved = new Map();   // 候補の id → 移す注釈
    const byDecl = new Map();
    for (const { c } of chosen) {
        if (c.kind !== 'const') continue;
        if (!byDecl.has(c.decl)) byDecl.set(c.decl, []);
        byDecl.get(c.decl).push(c);
    }
    for (const [decl, list] of byDecl) {
        const ds = decl.declarations;
        if (list.length === ds.length) {
            const lead = ctx.leadingComments(decl.start);
            const trail = ctx.trailingComment(decl.end);
            let start = decl.start;
            let end = decl.end;
            const restOfLine = text.slice(trail ? trail.end : decl.end, ctx.lineEnd(decl.end));
            if (ctx.startsLine(decl.start) && /^[ \t\r]*$/.test(restOfLine)) {
                // 行ごと外す
                start = ctx.lineStart(lead.length > 0 ? lead[0].start : decl.start);
                end = Math.min(ctx.lineEnd(decl.end) + 1, text.length);
                // 前後が空行なら、空行が 2 つ続かないように、後ろの空行も外す
                const prevBlank = start === 0 || /^[ \t\r]*$/.test(text.slice(ctx.lineStart(start - 1), start - 1))
                    || /\{[ \t\r]*$/.test(text.slice(ctx.lineStart(start - 1), start - 1));
                const nextEnd = ctx.lineEnd(end);
                if (prevBlank && end < text.length && /^[ \t\r]*$/.test(text.slice(end, nextEnd))) {
                    end = Math.min(nextEnd + 1, text.length);
                }
                moved.set(list[0].id, [...lead, ...(trail ? [trail] : [])]);
            }
            edits.push({ start, end, text: '' });
        } else {
            // 一部だけ外す（const A = 1, B = 2; の A だけ、など）
            const gone = ds.map(d => list.some(c => c.node === d));
            for (let i = 0; i < ds.length; i++) {
                if (!gone[i]) continue;
                let j = i;
                while (j + 1 < ds.length && gone[j + 1]) j++;
                if (j < ds.length - 1) edits.push({ start: ds[i].start, end: ds[j + 1].start, text: '' });
                else edits.push({ start: ds[i - 1].end, end: ds[j].end, text: '' });
                i = j;
            }
        }
    }

    // 4. 宣言と登録を作る
    const first = ctx.rootBody.find(s => !s.directive);
    const U = ctx.indentUnit;
    let I;
    let insertAt;
    let inline = false;
    if (first !== undefined) {
        const lead = ctx.leadingComments(first.start);
        // ファイルの頭から続く注釈（ファイルの説明）の上には置かない
        const header = ctx.style === 'global' && lead.length > 0 && /^\s*$/.test(text.slice(0, lead[0].start));
        const target = lead.length > 0 && !header ? lead[0].start : first.start;
        I = ctx.indentOf(first.start);
        if (ctx.startsLine(target)) {
            insertAt = ctx.lineStart(target);
        } else {
            insertAt = target;
            inline = true;
        }
    } else if (ctx.style === 'iife') {
        insertAt = ctx.rootContainer.end - 1;
        I = U;
        inline = true;
    } else {
        insertAt = text.length;
        I = '';
        inline = true;
    }

    const reindent = (c, indent) => {
        if (c.type === 'Line') return [`${indent}//${c.value}`];
        return `/*${c.value}*/`.split(/\r?\n/).map((l, i) => {
            const t = l.trim();
            return indent + (i > 0 && t.startsWith('*') ? ' ' : '') + t;
        });
    };
    const settingLines = [];
    for (const { s, c } of chosen) {
        (moved.get(c.id) ?? []).forEach(cm => settingLines.push(...reindent(cm, I + U + U)));
        const parts = [`key: ${quote(s.key)}`, `type: ${quote(s.type)}`];
        const label = localized(s.label);
        if (label !== null) parts.push(`label: ${label}`);
        let def;
        if (s.type === 'number') {
            parts.push(`min: ${Number(s.min)}`, `max: ${Number(s.max)}`, `step: ${Number(s.step)}`);
            def = String(c.value);
        } else if (s.type === 'color') {
            def = quote(cleanColor(c.value, s.alpha === true));
            if (def !== quote(c.value)) {
                warn(c.line, `「${c.name}」の色コードを、規格の書き方（${def.slice(1, -1)}）にそろえました。色は同じです。`);
            }
        } else {
            def = literal(c.value);
        }
        parts.push(`default: ${def}`);
        if (s.type === 'number' && String(s.unit ?? '').trim() !== '') parts.push(`unit: ${quote(String(s.unit).trim())}`);
        if (s.type === 'color' && s.alpha === true) parts.push('alpha: true');
        const note = localized(s.note);
        if (note !== null) parts.push(`note: ${note}`);
        s._default = def;
        if (s.type === 'select') {
            const opts = s.options.map(o => {
                const l = localized(o.label);
                return l === null ? literal(o.value) : `{ value: ${literal(o.value)}, label: ${l} }`;
            });
            const oneLine = `options: [${opts.join(', ')}]`;
            if (parts.join(', ').length + oneLine.length <= 110) {
                settingLines.push(`${I}${U}${U}{ ${parts.join(', ')}, ${oneLine} },`);
            } else {
                settingLines.push(`${I}${U}${U}{`, `${I}${U}${U}${U}${parts.join(', ')},`, `${I}${U}${U}${U}options: [`,
                    ...opts.map(o => `${I}${U}${U}${U}${U}${o},`), `${I}${U}${U}${U}],`, `${I}${U}${U}},`);
            }
        } else {
            settingLines.push(`${I}${U}${U}{ ${parts.join(', ')} },`);
        }
    }

    const b = [];
    b.push(`${I}// ---- ランチャーの規格 v${SPEC_VERSION}: 宣言と登録 ----`);
    b.push(`${I}const ${defName} = {`);
    b.push(`${I}${U}id: ${quote(config.id)},`);
    const name = localized(config.name);
    if (name !== null) b.push(`${I}${U}name: ${name},`);
    if (String(config.version ?? '').trim() !== '') b.push(`${I}${U}version: ${quote(String(config.version).trim())},`);
    const desc = localized(config.description);
    if (desc !== null) b.push(`${I}${U}description: ${desc},`);
    if (config.affectsPlay === true) b.push(`${I}${U}affectsPlay: true,`);
    if (chosen.length > 0) {
        b.push(`${I}${U}settings: [`, ...settingLines, `${I}${U}],`);
        const pairs = chosen.map(({ s }) => `${s.key}: ${s._default}`);
        const oneLine = `${I}${U}values: { ${pairs.join(', ')} },`;
        if (oneLine.length <= 110) {
            b.push(oneLine);
        } else {
            b.push(`${I}${U}values: {`, ...pairs.map(p => `${I}${U}${U}${p},`), `${I}${U}},`);
        }
        if (opt.onChangeStub) {
            b.push(`${I}${U}// 値が変わったときに、その場で反映したい処理があれば書く`);
            b.push(`${I}${U}// onChange: (key, value, values) => { },`);
        }
    }
    b.push(`${I}};`);
    if (ctx.style === 'iife') {
        b.push(`${I}const ${listName} = (window.g_danoniPlugins ??= []);`);
        b.push(`${I}if (${listName}.some(p => p.id === ${defName}.id)) {`, `${I}${U}return;`, `${I}}`);
        b.push(`${I}${listName}.push(${defName});`);
    } else {
        b.push(`${I}{`);
        b.push(`${I}${U}const list = (window.g_danoniPlugins ??= []);`);
        b.push(`${I}${U}if (!list.some(p => p.id === ${defName}.id)) {`, `${I}${U}${U}list.push(${defName});`, `${I}${U}}`);
        b.push(`${I}}`);
    }
    settings.forEach(s => delete s._default);
    const block = b.join(eol);
    edits.push({
        start: insertAt, end: insertAt,
        text: inline ? `${eol}${block}${eol}${first !== undefined ? I : ''}` : `${block}${eol}${eol}`,
    });

    // 5. 当てて、確かめる
    let output;
    try {
        output = applyEdits(text, edits);
        parse(output, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true });
    } catch (e) {
        return { ok: false, errors: [{ field: 'internal', text: `書き換えた結果が、正しい js になりませんでした（道具の不具合です）: ${e.message}` }], warnings };
    }
    if (opt.ascii) {
        const why = asciiUnsafe(output);
        if (why !== null) {
            return { ok: false, errors: [{ field: 'ascii', text: `ASCII だけの形にできません: ${why}` }], warnings };
        }
        output = toAscii(output);
    } else if (ctx.bom) {
        output = `\ufeff${output}`;
    }
    warnings.sort((a, b2) => (a.line ?? 0) - (b2.line ?? 0));
    return { ok: true, output, errors: [], warnings, info: { defName, style: ctx.style, lazy: [...lazy.keys()] } };
};

/**
 * 候補を、下書きのまま全部選んだ指定を作る（試験と、コマンドラインの --auto 用）
 * 途中で書き換えられている変数と、選択肢を人が決める必要のある文字の定数は選ばない。
 */
export const autoConfig = (analysis, base = {}) => ({
    id: base.id ?? (analysis.suggestId || 'my-plugin'),
    name: base.name ?? { ja: '', en: '' },
    version: base.version ?? '1.0.0',
    description: base.description ?? { ja: '', en: '' },
    settings: analysis.candidates.filter(c => !c.mutated && c.suggest.type !== 'select').slice(0, 40).map(c => ({
        cand: c.id, key: c.suggest.key, type: c.suggest.type, label: { ja: c.suggest.labelJa, en: '' },
        min: c.suggest.min, max: c.suggest.max, step: c.suggest.step, unit: c.suggest.unit, alpha: c.suggest.alpha,
    })),
    options: base.options ?? {},
});
