#!/usr/bin/env node
// コマンドラインから使う
//   node cli.mjs analyze <元の js>                         … 候補と、気を付ける所を JSON で出す
//   node cli.mjs convert <元の js> <指定の json> [-o 出力]  … 指定どおりに書き換える
//   node cli.mjs convert <元の js> --auto [--id 名前] [-o 出力] … 候補を下書きのまま全部選んで書き換える（試し用）
import fs from 'node:fs';
import path from 'node:path';
import { analyze, convert, autoConfig } from './src/core.js';

/** UTF-8 で読めなければ Shift_JIS で読む */
export const readSource = file => {
    const bytes = fs.readFileSync(file);
    try {
        return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
        return new TextDecoder('shift_jis').decode(bytes);
    }
};

const main = argv => {
    const [cmd, file, ...rest] = argv;
    if (!['analyze', 'convert'].includes(cmd) || !file) {
        console.error('使い方: node cli.mjs analyze <js> | convert <js> <config.json | --auto> [--id 名前] [-o 出力]');
        return 2;
    }
    const source = readSource(file);
    const analysis = analyze(source, { fileName: path.basename(file) });
    if (cmd === 'analyze') {
        console.log(JSON.stringify(analysis, null, 2));
        return analysis.ok ? 0 : 1;
    }
    if (!analysis.ok) {
        console.error(analysis.error.text);
        return 1;
    }
    const flag = name => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : undefined);
    const config = rest[0] === '--auto'
        ? autoConfig(analysis, { id: flag('--id') })
        : JSON.parse(fs.readFileSync(rest[0], 'utf8'));
    const result = convert(source, config);
    result.warnings.forEach(w => console.error(`注意${w.line ? ` ${w.line} 行目` : ''}: ${w.text}`));
    if (!result.ok) {
        result.errors.forEach(e => console.error(`エラー: ${e.text}`));
        return 1;
    }
    const out = flag('-o');
    if (out) fs.writeFileSync(out, result.output);
    else process.stdout.write(result.output);
    return 0;
};

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
    process.exitCode = main(process.argv.slice(2));
}
