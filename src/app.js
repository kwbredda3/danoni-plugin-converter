// 画面。貼られた js を調べて候補を並べ、選んだ内容で書き換えた結果を出す
// 貼られた文字は、textContent と value でだけ画面に入れる（HTML として解釈させない）。

import { analyze, convert, SPEC_VERSION, TOOL_VERSION } from './core.js';
import { diffLines, withContext } from './diff.js';
import { SAMPLE } from './sample.js';

const $ = id => document.getElementById(id);

/** 要素を作る */
const h = (tag, props = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
        if (k === 'class') el.className = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else if (v === true) el.setAttribute(k, '');
        else if (v !== false && v !== undefined && v !== null) el.setAttribute(k, v);
    }
    kids.flat().forEach(c => c !== null && c !== undefined && el.append(c));
    return el;
};

const TYPE_LABEL = { toggle: 'オン／オフ', number: '数', color: '色コード', select: '選択' };
/** 定数の種類ごとの、選べる型 */
const TYPES_FOR = { boolean: ['toggle'], number: ['number', 'select'], color: ['color', 'select'], string: ['select'] };

const state = {
    source: '',
    fileName: '',
    analysis: null,
    /** 候補ごとの入力（定数の名前 → 入力）。貼り直しても、同じ名前なら残す */
    forms: new Map(),
    /** いま出している結果 */
    output: '',
    tab: 'diff',
};

/* ---------------- 候補の入力 ---------------- */

const formFor = c => {
    if (!state.forms.has(c.name)) {
        const s = c.suggest;
        state.forms.set(c.name, {
            on: false, key: s.key, type: s.type, labelJa: s.labelJa, labelEn: '', noteJa: '', noteEn: '',
            min: s.min ?? 0, max: s.max ?? 10, step: s.step ?? 1, unit: s.unit ?? '', alpha: s.alpha === true,
            options: c.valueType === 'boolean' ? '' : `${c.value}`,
        });
    }
    return state.forms.get(c.name);
};

/** 選択肢の欄（1 行に 1 つ。値 | 日本語 | English）を読む */
const parseOptions = (text, asNumber) => text.split(/\r?\n/).map(l => l.trim()).filter(l => l !== '').map(l => {
    const [value, ja = '', en = ''] = l.split('|').map(x => x.trim());
    return { value: asNumber ? Number(value) : value, label: { ja, en } };
});

const buildConfig = () => ({
    id: $('fId').value.trim(),
    name: { ja: $('fNameJa').value, en: $('fNameEn').value },
    version: $('fVersion').value,
    description: { ja: $('fDescJa').value, en: $('fDescEn').value },
    affectsPlay: $('fAffects').checked,
    settings: state.analysis.candidates.filter(c => formFor(c).on).map(c => {
        const f = formFor(c);
        return {
            cand: c.id, key: f.key.trim(), type: f.type,
            label: { ja: f.labelJa, en: f.labelEn }, note: { ja: f.noteJa, en: f.noteEn },
            min: f.min, max: f.max, step: f.step, unit: f.unit, alpha: f.alpha,
            options: f.type === 'select' ? parseOptions(f.options, c.valueType === 'number') : undefined,
        };
    }),
    options: { lazy: $('oLazy').checked, onChangeStub: $('oStub').checked, ascii: $('oAscii').checked },
});

/** 入力欄を 1 つ作る（変わるたびに、入力を覚えて結果を出し直す） */
const field = (f, name, label, attrs = {}, cls = '') => {
    const input = h('input', { type: 'text', ...attrs });
    input.value = f[name];
    input.addEventListener('input', () => {
        f[name] = attrs.type === 'number' ? (input.value === '' ? NaN : Number(input.value)) : input.value;
        update();
    });
    return h('label', { class: cls }, label, input);
};

const renderForm = (c, f, box) => {
    box.replaceChildren();
    const types = TYPES_FOR[c.valueType];
    const typeSel = h('select', {}, types.map(t => h('option', { value: t }, TYPE_LABEL[t])));
    typeSel.value = f.type;
    typeSel.disabled = types.length === 1;
    typeSel.addEventListener('change', () => {
        f.type = typeSel.value;
        renderForm(c, f, box);
        update();
    });
    const grid = h('div', { class: 'grid' },
        field(f, 'key', 'key', { maxlength: 30 }),
        h('label', {}, '型', typeSel),
        field(f, 'labelJa', 'ラベル（日本語）', { maxlength: 80 }),
        field(f, 'labelEn', 'ラベル（英語）', { maxlength: 80 }),
    );
    if (f.type === 'number') {
        grid.append(
            field(f, 'min', '最小', { type: 'number', step: 'any' }),
            field(f, 'max', '最大', { type: 'number', step: 'any' }),
            field(f, 'step', '刻み', { type: 'number', step: 'any' }),
            field(f, 'unit', '単位', { maxlength: 10, placeholder: 'px・% など' }),
        );
    } else if (f.type === 'color') {
        const cb = h('input', { type: 'checkbox' });
        cb.checked = f.alpha;
        cb.addEventListener('change', () => {
            f.alpha = cb.checked;
            update();
        });
        grid.append(h('label', { class: 'check half' }, cb, '不透明度も選ぶ'));
    } else if (f.type === 'select') {
        const ta = h('textarea', { spellcheck: 'false' });
        ta.value = f.options;
        ta.addEventListener('input', () => {
            f.options = ta.value;
            update();
        });
        grid.append(h('label', { class: 'wide' }, '選択肢', ta,
            h('small', {}, '1 行に 1 つ。「値 | 日本語のラベル | 英語のラベル」の形です（ラベルは省けます）。いまの値を必ず入れます')));
    }
    grid.append(field(f, 'noteJa', '補足（日本語）', { maxlength: 80 }, 'half'), field(f, 'noteEn', '補足（英語）', { maxlength: 80 }, 'half'));
    box.append(grid);
};

const renderCandidates = () => {
    const list = $('cands');
    list.replaceChildren();
    const cands = state.analysis.candidates;
    $('candLead').textContent = cands.length === 0
        ? '設定にできそうな定数（冒頭に書かれた true / false・数・文字）は、見つかりませんでした。宣言と登録だけを足します。'
        : `冒頭の定数が ${cands.length} 個あります。ランチャーで変えられるようにしたいものを選びます。`;
    for (const c of cands) {
        const f = formFor(c);
        const cb = h('input', { type: 'checkbox', 'aria-label': `${c.name} を設定にする` });
        cb.checked = f.on;
        const formBox = h('div', { class: 'cand-form' });
        formBox.hidden = !f.on;
        const errBox = h('p', { class: 'error cand-error', 'data-cand': c.id });
        errBox.hidden = true;
        cb.addEventListener('change', () => {
            f.on = cb.checked;
            formBox.hidden = !f.on;
            if (f.on) renderForm(c, f, formBox);
            update();
        });
        const value = h('span', { class: 'cand-value' });
        if (c.valueType === 'color') {
            const sw = h('span', { class: 'swatch' });
            sw.style.background = c.value;
            value.append(sw);
        }
        value.append(JSON.stringify(c.value));
        const head = h('label', { class: 'cand-head' }, cb,
            h('span', { class: 'cand-name' }, c.name), value,
            h('span', { class: 'muted' }, `${c.line} 行目`),
            c.comment !== '' ? h('span', { class: 'cand-comment' }, c.comment) : null,
            c.mutated ? h('span', { class: 'tag' }, '途中で書き換えあり') : null,
            c.valueType === 'string' ? h('span', { class: 'tag' }, '選択肢を決めます') : null,
        );
        if (f.on) renderForm(c, f, formBox);
        list.append(h('div', { class: 'cand' }, head, formBox, errBox));
    }
};

/* ---------------- 結果 ---------------- */

const noteItem = (cls, line, text) => h('li', { class: cls },
    line ? h('span', { class: 'line' }, `${line} 行目`) : null, text);

const renderDiff = (before, after) => {
    const ops = diffLines(before.split(/\r?\n/), after.split(/\r?\n/));
    const add = ops.filter(o => o.type === 'add').length;
    const del = ops.filter(o => o.type === 'del').length;
    $('diffStat').textContent = `＋${add} 行　−${del} 行`;
    const box = $('diff');
    box.replaceChildren(...withContext(ops).map(op => (op.type === 'skip'
        ? h('div', { class: 'dl skip' }, `… 同じ ${op.count} 行 …`)
        : h('div', { class: `dl ${op.type}` },
            h('span', { class: 'ln' }, op.a ?? ''), h('span', { class: 'ln' }, op.b ?? ''),
            h('span', {}, `${{ same: ' ', add: '+', del: '-' }[op.type]} ${op.text}`)))));
};

const showTab = tab => {
    state.tab = tab;
    $('tabDiff').setAttribute('aria-selected', String(tab === 'diff'));
    $('tabFull').setAttribute('aria-selected', String(tab === 'full'));
    $('diff').hidden = tab !== 'diff';
    $('output').hidden = tab !== 'full';
};

/** 入力が変わるたびに、書き換えをやり直す */
const update = () => {
    if (state.analysis === null || !state.analysis.ok) return;
    const result = convert(state.source, buildConfig());

    // 候補ごとの直す所は、その候補の下に出す
    document.querySelectorAll('.cand-error').forEach(el => {
        const mine = result.errors.filter(e => e.field === `setting:${el.dataset.cand}`);
        el.hidden = mine.length === 0;
        el.textContent = mine.map(e => e.text).join(' ／ ');
    });
    const rest = result.errors.filter(e => !e.field.startsWith('setting:'));
    $('errors').hidden = result.ok;
    $('errors').replaceChildren(
        ...rest.map(e => noteItem('err', e.line, e.text)),
        ...(rest.length === 0 && !result.ok ? [noteItem('err', null, '「3 設定にする定数」に、直す所があります。')] : []),
    );
    $('resultBody').hidden = !result.ok;

    const notes = [
        ...result.warnings.map(w => noteItem('', w.line, w.text)),
        ...state.analysis.notices.map(n => noteItem('info', n.line, n.text)),
        ...(result.ok && result.info.lazy.length > 0
            ? [noteItem('info', null, `設定から計算している定数（${result.info.lazy.join('・')}）は、使うたびに計算する関数に直しました。`)] : []),
    ];
    $('secNotes').hidden = notes.length === 0;
    $('notes').replaceChildren(...notes);

    state.output = result.ok ? result.output : '';
    if (result.ok) {
        $('output').value = result.output;
        renderDiff(state.source.replace(/^﻿/, ''), result.output.replace(/^﻿/, ''));
    }
};

/** 元の js が変わったとき */
const setSource = (text, fileName) => {
    state.source = text;
    if (fileName !== undefined) state.fileName = fileName;
    const has = text.trim() !== '';
    state.analysis = has ? analyze(text, { fileName: state.fileName }) : null;
    const ok = state.analysis?.ok === true;
    $('sourceError').hidden = !has || ok;
    if (has && !ok) {
        const e = state.analysis.error;
        $('sourceError').textContent = `${e.line ? `${e.line} 行目: ` : ''}${e.text}`;
    }
    for (const id of ['secBasic', 'secCands', 'secResult']) $(id).hidden = !ok;
    if (!ok) {
        $('secNotes').hidden = true;
        return;
    }
    if ($('fId').value === '' && state.analysis.suggestId !== '') $('fId').value = state.analysis.suggestId;
    renderCandidates();
    update();
};

/** ファイルを読む（UTF-8 で読めなければ Shift_JIS） */
const readFile = async file => {
    const bytes = await file.arrayBuffer();
    let text;
    let note = '';
    try {
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
        text = new TextDecoder('shift_jis').decode(bytes);
        note = '（Shift_JIS として読みました。結果は UTF-8 で出します）';
    }
    $('fileNote').textContent = `${file.name}${note}`;
    $('fId').value = '';
    state.forms.clear();
    $('source').value = text;
    setSource(text, file.name);
};

/* ---------------- つなぐ ---------------- */

$('specVer').textContent = SPEC_VERSION;
$('toolVer').textContent = TOOL_VERSION;

let timer = 0;
$('source').addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => setSource($('source').value), 200);
});
$('file').addEventListener('change', e => {
    const file = e.target.files[0];
    if (file) readFile(file);
    e.target.value = '';
});
$('source').addEventListener('dragover', e => {
    e.preventDefault();
    $('source').classList.add('drop');
});
$('source').addEventListener('dragleave', () => $('source').classList.remove('drop'));
$('source').addEventListener('drop', e => {
    $('source').classList.remove('drop');
    const file = e.dataTransfer?.files?.[0];
    if (file) {
        e.preventDefault();
        readFile(file);
    }
});
$('btnSample').addEventListener('click', () => {
    $('fileNote').textContent = '見本';
    $('fId').value = '';
    state.forms.clear();
    $('source').value = SAMPLE;
    setSource(SAMPLE, 'danoni_color_band.js');
});
for (const id of ['fId', 'fVersion', 'fNameJa', 'fNameEn', 'fDescJa', 'fDescEn']) $(id).addEventListener('input', update);
for (const id of ['fAffects', 'oLazy', 'oStub', 'oAscii']) $(id).addEventListener('change', update);
$('tabDiff').addEventListener('click', () => showTab('diff'));
$('tabFull').addEventListener('click', () => showTab('full'));

$('btnCopy').addEventListener('click', async () => {
    try {
        await navigator.clipboard.writeText(state.output);
        $('btnCopy').textContent = 'コピーしました';
    } catch {
        showTab('full');
        $('output').select();
        $('btnCopy').textContent = '全文を選択しました';
    }
    setTimeout(() => { $('btnCopy').textContent = 'コピー'; }, 1500);
});
$('btnSave').addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([state.output], { type: 'text/javascript' }));
    const a = h('a', { href: url, download: state.fileName || 'danoni_custom.js' });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
});
