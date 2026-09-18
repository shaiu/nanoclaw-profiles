import { esc } from '../escape.mjs';

const CSS = `
:root{--bg:#f7f6f3;--card:#fff;--text:#1f1f1f;--muted:#6b6b6b;--line:#e6e3dc;--accent:#2f6f4f;--warn:#9a4b00;--chip:#eef3ef}
@media (prefers-color-scheme:dark){:root{--bg:#161616;--card:#202020;--text:#ececec;--muted:#a3a3a3;--line:#333;--accent:#7cc39c;--warn:#f0a35c;--chip:#23302a}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:760px;margin:0 auto;padding:24px 16px 64px}
a{color:var(--accent)}
h1{font-size:1.6rem;margin:0}
h2{font-size:1.1rem;margin:0 0 12px}
h3,h4,h5,h6{font-size:1rem;margin:12px 0 4px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 18px;margin:14px 0}
.muted{color:var(--muted)}
.hero{display:flex;gap:16px;align-items:center}
.avatar{width:64px;height:64px;border-radius:50%;display:grid;place-items:center;font-size:2rem;background:var(--chip);flex:none;object-fit:cover}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(220px,1fr))}
.agent{display:block;text-decoration:none;color:inherit}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin:6px 0 0;padding:0;list-style:none}
.chips li{background:var(--chip);border-radius:999px;padding:4px 12px;font-size:.92rem}
.badge{display:inline-block;font-size:.75rem;border:1px solid var(--line);border-radius:6px;padding:0 6px;margin-left:6px;color:var(--muted)}
.warn{color:var(--warn)}
ul.plain{padding-left:18px;margin:4px 0}
.row{display:flex;justify-content:space-between;gap:12px;border-top:1px solid var(--line);padding:8px 0}
.row:first-child{border-top:0}
.bars{display:flex;gap:8px;align-items:flex-end;height:90px;margin-top:10px}
.bar{flex:1;text-align:center;font-size:.75rem;color:var(--muted)}
.bar span{display:block;background:var(--accent);border-radius:4px 4px 0 0;margin-bottom:4px;min-height:2px}
pre{white-space:pre-wrap;font-size:.85rem;background:var(--bg);padding:12px;border-radius:8px}
`;

export function page({ title, body }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body><main>
${body}
</main></body>
</html>`;
}
