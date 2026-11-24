// node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { analyze, convert, autoConfig } from '../src/core.js';

/** js を動かして、window を返す */
const run = code => {
    const window = {};
    vm.runInContext(code, vm.createContext({ window, console, Math }));
    return window;
};
/** 名前で候補を選び、下書きのままの指定にする */
const pickSettings = (source, names, patch = {}) => {
    const a = analyze(source);
    assert.equal(a.ok, true);
    return a.candidates.filter(c => names.includes(c.name)).map(c => ({
        cand: c.id, key: c.suggest.key, type: c.suggest.type, label: { ja: c.suggest.labelJa, en: '' },
        min: c.suggest.min, max: c.suggest.max, step: c.suggest.step, unit: c.suggest.unit, alpha: c.suggest.alpha,
        ...(patch[c.name] ?? {}),
    }));
};

const SAMPLE = `'use strict';
/** 見本 */
(() => {

    /** ゲージの太さ(px) */
    const BAR_H = 10;
    /** 帯の余白 */
    const PAD = 24, GAP = 2;
    const BAND_H = BAR_H + PAD;
    const DOUBLE = BAND_H * 2;
    const COLOR = \`#FF8800\`;
    const USE = true;   // 使う
    const frozenAtLoad = [BAR_H, BAR_H + 1];

    const layout = (BAR_H_local) => {
        const inner = BAR_H => BAR_H * 100;          // 内側の同じ名前は別物
        return { BAR_H, band: BAND_H, double: DOUBLE, gap: GAP, inner: inner(1), local: BAR_H_local, color: COLOR, use: USE };
    };
    window.result = () => layout(5);
    window.frozen = frozenAtLoad;
})();
`;

test('即時関数: 既定の値のままなら、元と同じ結果', () => {
    const settings = pickSettings(SAMPLE, ['BAR_H', 'COLOR', 'USE', 'GAP']);
    assert.equal(settings.length, 4);
    const r = convert(SAMPLE, { id: 'sample', name: { ja: '見本', en: 'Sample' }, version: '1.0.0', settings });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    const before = run(SAMPLE).result();
    const w = run(r.output);
    assert.equal(JSON.stringify({ ...w.result(), color: before.color }), JSON.stringify({ ...before }));
    assert.equal(w.result().color, '#ff8800');           // 色コードは規格の書き方にそろう
    assert.deepEqual(r.info.lazy, ['BAND_H', 'DOUBLE']);  // 足し合わせるだけの定数は、関数になる
    assert.equal(w.g_danoniPlugins.length, 1);
    assert.equal(w.g_danoniPlugins[0].id, 'sample');
});

test('即時関数: 値を変えると、その場で効く（計算した定数にも届く）', () => {
    const settings = pickSettings(SAMPLE, ['BAR_H', 'GAP']);
    const r = convert(SAMPLE, { id: 'sample', settings });
    const w = run(r.output);
    w.g_danoniPlugins[0].values.barH = 16;
    w.g_danoniPlugins[0].values.gap = 7;
    const res = w.result();
    assert.equal(res.BAR_H, 16);
    assert.equal(res.band, 40);
    assert.equal(res.double, 80);
    assert.equal(res.gap, 7);
    assert.equal(res.inner, 100);   // 内側の同じ名前は書き換えない
    // 配列に入れて読み込みのときに固めた値には届かない → 注意に出る
    assert.deepEqual([...w.frozen], [10, 11]);
    assert.equal(r.warnings.filter(x => x.text.includes('読み込みのときに 1 回だけ')).length, 1);
});

test('即時関数: 注釈は設定の行の上へ移り、宣言の行は消える', () => {
    const r = convert(SAMPLE, { id: 'sample', settings: pickSettings(SAMPLE, ['BAR_H', 'USE', 'GAP']) });
    assert.match(r.output, /\/\*\* ゲージの太さ\(px\) \*\/\r?\n\s+\{ key: `barH`, type: `number`, label: `ゲージの太さ`, min: 0, max: 20, step: 1, default: 10, unit: `px` \}/);
    assert.doesNotMatch(r.output, /const BAR_H = 10/);
    assert.match(r.output, /const PAD = 24;/);            // 並んだ宣言の片方だけを外す
    assert.doesNotMatch(r.output, /const USE/);
    assert.match(r.output, /\/\/ 使う/);
});

test('2 回読み込んでも、登録は 1 つ・処理は 1 回', () => {
    const src = `(() => { const N = 3; window.count = (window.count ?? 0) + N; })();`;
    const r = convert(src, { id: 'twice', settings: pickSettings(src, ['N']) });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    const window = {};
    const ctx = vm.createContext({ window });
    vm.runInContext(r.output, ctx);
    vm.runInContext(r.output, ctx);
    assert.equal(window.g_danoniPlugins.length, 1);
    assert.equal(window.count, 3);
});

test('オブジェクトの設定: 読む所はそのままで、値が入れ替わる', () => {
    const src = `(() => {
    const C = window.g_conf = {
        // 色
        blue: '#2a3754',
        'max-size': 3,
        nest: { on: false },
    };
    window.read = () => [C.blue, C['max-size'], C.nest.on, JSON.stringify(C)];
})();`;
    const settings = pickSettings(src, ['C.blue', 'C.max-size', 'C.nest.on']);
    assert.equal(settings.length, 3);
    const r = convert(src, { id: 'obj', settings });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    const w = run(r.output);
    assert.deepEqual([...w.read()], [...run(src).read()]);
    const v = w.g_danoniPlugins[0].values;
    v.blue = '#000000';
    v.on = true;
    assert.equal(w.read()[0], '#000000');
    assert.equal(w.read()[2], true);
    w.g_conf.blue = '#111111';            // 外から書く形も、今までどおり通る
    assert.equal(v.blue, '#111111');
});

test('旧式（包まれていない）ファイル: 固有の名前で宣言を足す', () => {
    const src = `/**\n * 説明\n */\n\nconst SPEED = 2;\nlet state = false;\n\nfunction customTitleInit() {\n\tstate = true;\n\twindow.out = SPEED * 2;\n}\n`;
    const a = analyze(src, { fileName: 'danoni_custom_my_gauge.js' });
    assert.equal(a.style, 'global');
    assert.equal(a.suggestId, 'my-gauge');
    assert.equal(a.candidates.find(c => c.name === 'state').mutated, true);
    assert.ok(a.notices.some(n => n.kind === 'oldStyle'));
    const r = convert(src, { id: 'my-gauge', settings: pickSettings(src, ['SPEED']) });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.match(r.output, /^\/\*\*\n \* 説明\n \*\/\n\n\/\/ ---- ランチャー/);
    const window = {};
    const ctx = vm.createContext({ window });
    vm.runInContext(`${r.output}\ncustomTitleInit();`, ctx);
    assert.equal(window.out, 4);
    assert.equal(window.g_danoniPlugins[0].id, 'my-gauge');
    assert.equal(vm.runInContext('g_plugin_myGauge.values.speed', ctx), 2);
});

test('名前がぶつかるときは、別の名前にする', () => {
    const src = `(() => { const def = 1, list = 2; const N = 3; window.out = () => def + list + N; })();`;
    const r = convert(src, { id: 'clash', settings: pickSettings(src, ['N']) });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.info.defName, 'pluginDef');
    assert.equal(run(r.output).out(), 6);
});

test('決まりに合わない指定は、書き換えない', () => {
    const src = `(() => { const N = 5; const S = 'abc'; window.n = () => N + S; })();`;
    const [n] = pickSettings(src, ['N']);
    const [s] = pickSettings(src, ['S']);
    const bad = cfg => convert(src, cfg).errors.map(e => e.text).join('\n');
    assert.match(bad({ id: 'bad id', settings: [] }), /id は/);
    assert.match(bad({ id: 'x', settings: [{ ...n, key: '1abc' }] }), /key は/);
    assert.match(bad({ id: 'x', settings: [{ ...n, min: 0, max: 10, step: 2 }] }), /乗っていません/);
    assert.match(bad({ id: 'x', settings: [{ ...n, min: 10, max: 0, step: 1 }] }), /最小は/);
    assert.match(bad({ id: 'x', settings: [{ ...s, type: 'select', options: [{ value: 'x' }, { value: 'y' }] }] }), /選択肢に入れて/);
    assert.match(bad({ id: 'x', settings: [{ ...s, type: 'color' }] }), /色コード/);
    const ok = convert(src, { id: 'x', settings: [{ ...s, type: 'select', options: [{ value: 'abc', label: { ja: 'あ', en: 'A' } }, { value: 'y' }] }] });
    assert.equal(ok.ok, true, JSON.stringify(ok.errors));
    assert.equal(run(ok.output).n(), '5abc');
});

test('ASCII だけの形: 中身は同じで、ASCII でない文字が残らない', () => {
    const r = convert(SAMPLE, { id: 'sample', name: { ja: '見本', en: '' }, settings: pickSettings(SAMPLE, ['BAR_H']), options: { ascii: true } });
    assert.equal(r.ok, true);
    assert.doesNotMatch(r.output, /[^\x00-\x7f]/);
    assert.equal(run(r.output).g_danoniPlugins[0].name, '見本');
});

test('構文エラーのファイルと、対応済みのファイル', () => {
    assert.equal(analyze('const = ;').ok, false);
    const done = convert(SAMPLE, { id: 'sample', settings: [] });
    assert.match(convert(done.output, { id: 'sample', settings: [] }).errors[0].text, /すでに/);
});

const LOAD_FN = `(() => {
    const C = { mode: \`a\`, size: 3 };
    const GAP = 2;
    const WIDE = GAP * 10;
    const loadMode = () => {
        const inner = [1].map(() => C.mode);
        return inner[0] + GAP + WIDE;
    };
    function setup() { return loadMode(); }
    let mode = setup();
    const draw = () => C.size + GAP;
    const both = () => C.size;
    both();
    window.hooks = [draw, () => both()];
    window.mode = () => mode;
})();
`;

test('読み込みのときにだけ呼ばれる関数の中で読む設定は、注意に出る', () => {
    const lineOf = text => LOAD_FN.split('\n').findIndex(l => l.includes(text)) + 1;
    const a = analyze(LOAD_FN);
    const cand = name => a.candidates.find(c => c.name === name);
    // loadMode は setup からだけ、setup は読み込みのときにだけ呼ばれる（その場で呼ばれる map の中も同じ扱い）
    assert.deepEqual(cand('C.mode').loadReadLines, [lineOf('C.mode);')]);
    assert.deepEqual(cand('GAP').loadReadLines, [lineOf('const WIDE'), lineOf('inner[0] + GAP')]);
    // フックに渡す関数（draw）・あとからも呼ぶ関数（both）の中は、何度も読まれるので出さない
    assert.deepEqual(cand('C.size').loadReadLines, []);

    const settings = pickSettings(LOAD_FN, ['C.mode', 'C.size', 'GAP'], {
        'C.mode': { options: [{ value: 'a' }, { value: 'b' }] },
    });
    const r = convert(LOAD_FN, { id: 'load-fn', settings });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    const warns = r.warnings.filter(x => x.text.includes('読み込みのときにだけ呼ばれる関数'));
    assert.deepEqual(warns.map(x => x.line), [lineOf('C.mode);'), lineOf('inner[0] + GAP'), lineOf('inner[0] + GAP')]);
    assert.equal(warns.every(x => x.text.includes('loadMode()')), true);
    assert.equal(warns.some(x => x.text.includes('「C.mode」')), true);
    assert.equal(warns.some(x => x.text.includes('「GAP」')), true);
    assert.equal(warns.some(x => x.text.includes('「WIDE」')), true);   // 設定から計算した定数も
    // 書き換えたあとも、既定の値なら元と同じ結果
    assert.equal(run(r.output).mode(), run(LOAD_FN).mode());
});

// 実物のカスタムjs（手元にあるときだけ）。下書きのまま全部選んで、正しい js になること
const REAL = [
    'lifegauge_pos/danoni_lifegauge_pos.js', 'judgdist/danoni_judgdist.js', 'danoni/js/danoni_touch_slide.js',
    'danoni/js/danoni_hardgauge.js', 'danoni/js/danoni_random_expansion.js', 'danoni/js/danoni_smooth_switch.js',
    'danoniplus-50.5.4/danoniplus-50.5.4/js/danoni_custom_17key_lanecolor.js', 'tap_play/tap.js',
].map(p => new URL(`../../${p}`, import.meta.url));
for (const url of REAL) {
    test(`実物: ${url.pathname.split('/').pop()}`, { skip: !fs.existsSync(url) }, () => {
        const source = fs.readFileSync(url, 'utf8');
        const a = analyze(source, { fileName: url.pathname });
        assert.equal(a.ok, true);
        if (a.notices.some(n => n.kind === 'already')) return;
        const r = convert(source, autoConfig(a));
        assert.equal(r.ok, true, JSON.stringify(r.errors));
        new vm.Script(r.output);
        // 改行の種類と BOM は元のまま
        assert.equal(/\r\n/.test(r.output), /\r\n/.test(source));
        assert.equal(r.output.charCodeAt(0) === 0xfeff, source.charCodeAt(0) === 0xfeff);
    });
}
