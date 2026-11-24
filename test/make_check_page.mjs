// 実物のランチャーで確かめるためのページを作る（手元用。test/check/ に出す）
//   node test/make_check_page.mjs
// ランチャーの試作のデモページ（plugin_launcher/demo/v53.html）を写し、読み込むカスタムjsを
// 「ランチャー ＋ この道具で書き換えた 2 本」に差し替える。本体と曲は、C:/dev/danoni の下のものをそのまま読む。
import fs from 'node:fs';
import { analyze, convert, autoConfig } from '../src/core.js';
import { SAMPLE } from '../src/sample.js';

const here = new URL('.', import.meta.url);
const root = new URL('../../', here);
const out = new URL('check/', here);
fs.mkdirSync(out, { recursive: true });

// 1 本目: 画面の見本（4 つの型をすべて使う）
const a1 = analyze(SAMPLE, { fileName: 'danoni_color_band.js' });
const c1 = autoConfig(a1, { name: { ja: '色の帯', en: 'Color band' } });
const pos = a1.candidates.find(c => c.name === 'BAND_POS');
c1.settings.push({
    cand: pos.id, key: 'bandPos', type: 'select', label: { ja: '帯の位置', en: 'Position' },
    options: [{ value: 'top', label: { ja: '上', en: 'Top' } }, { value: 'bottom', label: { ja: '下', en: 'Bottom' } }],
});
const r1 = convert(SAMPLE, c1);

// 2 本目: 実物（17key のレーンの背景色。設定用のオブジェクトを持つ）
const src2 = fs.readFileSync(new URL('danoniplus-50.5.4/danoniplus-50.5.4/js/danoni_custom_17key_lanecolor.js', root), 'utf8');
const r2 = convert(src2, autoConfig(analyze(src2), { id: '17key-lanecolor', name: { ja: '17key レーン背景色', en: '17key lane color' } }));

for (const [name, r] of [['color_band.js', r1], ['lanecolor17.js', r2]]) {
    if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.errors)}`);
    fs.writeFileSync(new URL(name, out), r.output);
}

let html = fs.readFileSync(new URL('plugin_launcher/demo/v53.html', root), 'utf8');
html = html.replace(/\|customjs=[^|]*\|/, '|customjs=(..)../../../plugin_launcher/launcher/js/danoni_launcher.js,(..)color_band.js,(..)lanecolor17.js|')
    .replaceAll('../../danoniplus-53.0.0/', '../../../danoniplus-53.0.0/')
    .replace('(..)../../danoni/music/', '(..)../../../danoni/music/')
    .replace(/<title>[^<]*<\/title>/, '<title>変換の確かめ</title>');
fs.writeFileSync(new URL('v53.html', out), html);
console.log('test/check/ に書き出しました');
