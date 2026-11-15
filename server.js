// Chạy: node server.js   (không cần npm install)
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000, DB = path.join(__dirname, 'data.json');
let db = { key: '', accounts: {} };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DB, 'utf8'))); } catch {}
if (process.env.KEY) db.key = process.env.KEY;
if (!db.key) db.key = crypto.randomUUID();
let dirty = true;
setInterval(() => { if (dirty) { fs.writeFileSync(DB, JSON.stringify(db)); dirty = false; } }, 5000);

const readBody = r => new Promise(res => {
  let b = '';
  r.on('data', c => { b += c; if (b.length > 3e6) r.destroy(); });
  r.on('end', () => { try { res(JSON.parse(b)); } catch { res({}); } });
});
const send = (s, c, t, b) => { s.writeHead(c, { 'Content-Type': t + '; charset=utf-8', 'Access-Control-Allow-Origin': '*' }); s.end(b); };
const json = (s, c, o) => send(s, c, 'application/json', JSON.stringify(o));

http.createServer(async (q, s) => {
  const u = q.url.split('?')[0];
  if (q.method === 'OPTIONS') return send(s, 204, 'text/plain', '');

  if (u === '/api/report' && q.method === 'POST') {
    const b = await readBody(q);
    if (b.key !== db.key || !b.user) return json(s, 401, { error: 'sai key' });
    const a = db.accounts[b.user] || (db.accounts[b.user] = { first: Date.now() });
    // Khi acc đang trong trận mà không quét được data, giữ lại data cũ từ lobby
    Object.assign(a, {
      user: b.user, userId: b.userId, pc: b.pc || 'NO-PC', place: b.place, seen: Date.now(),
      flat: b.flat && Object.keys(b.flat).length ? b.flat : a.flat,
      items: b.items && Object.keys(b.items).length ? b.items : a.items,
    });
    dirty = true;
    return json(s, 200, { ok: 1 });
  }
  if (u === '/api/state') return json(s, 200, { now: Date.now(), accounts: Object.values(db.accounts) });
  if (u === '/api/delete' && q.method === 'POST') {
    const b = await readBody(q);
    (b.users || []).forEach(x => delete db.accounts[x]);
    dirty = true;
    return json(s, 200, { ok: 1 });
  }
  if (u === '/main.lua') { // tự điền địa chỉ server vào script
    const proto = q.headers['x-forwarded-proto'] || 'http';
    const lua = fs.readFileSync(path.join(__dirname, 'main.lua'), 'utf8').replace('%%SERVER_URL%%', proto + '://' + q.headers.host);
    return send(s, 200, 'text/plain', lua);
  }
  send(s, 200, 'text/html', fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8'));
}).listen(PORT, () => console.log(`Server: http://localhost:${PORT}\nKEY của bạn: ${db.key}`));
