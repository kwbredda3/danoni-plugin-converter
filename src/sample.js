// 画面の「見本を入れる」と、実物のランチャーでの確かめに使う見本

export const SAMPLE = `/**
 * 見本: プレイ画面の上に、色の帯を出すカスタムjs
 */
(() => {

\t/** 帯を出す */
\tconst SHOW = true;
\t/** 帯の高さ(px) */
\tconst BAND_H = 12;
\t/** 帯の色 */
\tconst BAND_COLOR = \`#286eff\`;
\t/** 帯の位置 */
\tconst BAND_POS = \`top\`;
\t/** 文字の高さ(px)。帯の高さから決まる */
\tconst TEXT_H = BAND_H - 2;

\tg_customJsObj.main.push(() => {
\t\tif (!SHOW) {
\t\t\treturn;
\t\t}
\t\tconst band = document.createElement(\`div\`);
\t\tband.style.cssText = \`position:absolute;left:0;width:100%;height:\${BAND_H}px;background:\${BAND_COLOR};font-size:\${TEXT_H}px\`;
\t\tband.style[BAND_POS] = \`0px\`;
\t\tdocument.getElementById(\`divRoot\`).appendChild(band);
\t});
})();
`;
