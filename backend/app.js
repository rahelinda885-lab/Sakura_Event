const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT || 3000);
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const ROOT = path.resolve(__dirname, '..', 'Frontend');
const MAX_BODY_BYTES = 1024 * 1024;
const METHODS = ['Transfer bank', 'Tunai', 'E-wallet', 'Lainnya'];

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) {
      if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
        return sendJson(res, 503, { error: 'Konfigurasi SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY belum diatur.' });
      }
      return await handleApi(req, res, url);
    }
    return serveStatic(req, res, url.pathname);
  } catch (error) {
    console.error(error);
    return sendJson(res, error.status || 500, { error: error.message || 'Terjadi kesalahan pada server.' });
  }
});

server.listen(PORT, () => {
  console.log(`Sakura Event berjalan di http://localhost:${PORT}`);
});

async function handleApi(req, res, url) {
  const pathname = url.pathname;
  if (req.method === 'GET' && pathname === '/api/health') {
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === 'GET' && pathname === '/api/categories') {
    const rows = await supabase('expense_categories?select=id,name&order=name.asc');
    return sendJson(res, 200, rows);
  }
  if (req.method === 'GET' && pathname === '/api/obligations') {
    const rows = await supabase('obligations?select=*,party:parties!obligations_party_id_fkey(id,name,party_type),category:expense_categories!obligations_category_id_fkey(id,name),payments(id,payment_date,amount,method,notes)&order=transaction_date.desc,created_at.desc');
    return sendJson(res, 200, rows.map(withComputedBalance));
  }
  if (req.method === 'POST' && pathname === '/api/obligations') {
    const data = await readJson(req);
    const normalized = validateObligation(data);
    const party = await ensureParty(normalized.party_name, normalized.obligation_type === 'debt' ? 'supplier' : 'employee');
    const body = {
      party_id: party.id,
      category_id: normalized.category_id || null,
      obligation_type: normalized.obligation_type,
      transaction_date: normalized.transaction_date,
      due_date: normalized.due_date || null,
      amount: normalized.amount,
      description: normalized.description,
      status: normalized.obligation_type === 'debt' ? 'approved' : 'submitted'
    };
    const rows = await supabase('obligations', { method: 'POST', body });
    return sendJson(res, 201, withComputedBalance(rows[0]));
  }
  const obligationMatch = pathname.match(/^\/api\/obligations\/([0-9a-f-]+)(?:\/(payments|status))?$/i);
  if (obligationMatch) {
    const [, id, action] = obligationMatch;
    if (req.method === 'PATCH' && !action) {
      const existing = await getObligation(id);
      const data = await readJson(req);
      const normalized = validateObligation(data, existing);
      const party = await ensureParty(normalized.party_name, existing.obligation_type === 'debt' ? 'supplier' : 'employee');
      const rows = await supabase(`obligations?id=eq.${id}`, {
        method: 'PATCH',
        body: {
          party_id: party.id,
          category_id: normalized.category_id || null,
          transaction_date: normalized.transaction_date,
          due_date: normalized.due_date || null,
          amount: normalized.amount,
          description: normalized.description,
          updated_at: new Date().toISOString()
        }
      });
      return sendJson(res, 200, withComputedBalance(rows[0]));
    }
    if (req.method === 'DELETE' && !action) {
      await getObligation(id);
      await supabase(`obligations?id=eq.${id}`, { method: 'DELETE', prefer: 'return=minimal' });
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'PATCH' && action === 'status') {
      const existing = await getObligation(id);
      if (existing.obligation_type !== 'reimbursement') throw httpError(400, 'Status persetujuan hanya tersedia untuk reimbursement.');
      const { status } = await readJson(req);
      if (!['submitted', 'approved'].includes(status)) throw httpError(400, 'Status reimbursement tidak valid.');
      if (status === 'submitted' && (existing.payments || []).length) throw httpError(409, 'Reimbursement yang sudah dibayar tidak dapat dikembalikan ke status diajukan.');
      const rows = await supabase(`obligations?id=eq.${id}`, { method: 'PATCH', body: { status, updated_at: new Date().toISOString() } });
      return sendJson(res, 200, withComputedBalance(rows[0]));
    }
    if (req.method === 'POST' && action === 'payments') {
      const existing = await getObligation(id);
      const data = await readJson(req);
      const payment = validatePayment(data);
      const computed = withComputedBalance(existing);
      if (existing.obligation_type === 'reimbursement' && existing.status !== 'approved') {
        throw httpError(409, 'Setujui reimbursement sebelum mencatat pembayaran.');
      }
      if (payment.amount > computed.remaining) throw httpError(400, 'Nominal pembayaran melebihi sisa kewajiban.');
      const rows = await supabase('payments', { method: 'POST', body: { obligation_id: id, ...payment } });
      return sendJson(res, 201, rows[0]);
    }
  }
  if (req.method === 'GET' && pathname === '/api/payments') {
    const rows = await supabase('payments?select=*,obligation:obligations(id,obligation_type,party:parties(name))&order=payment_date.desc,created_at.desc');
    return sendJson(res, 200, rows);
  }
  return sendJson(res, 404, { error: 'Endpoint tidak ditemukan.' });
}

async function supabase(resource, options = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${resource}`, {
    method: options.method || 'GET',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: options.prefer || (options.method === 'POST' || options.method === 'PATCH' ? 'return=representation' : 'return=minimal')
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {})
  });
  const text = await response.text();
  if (!response.ok) {
    let message = text || 'Permintaan ke Supabase gagal.';
    try { message = JSON.parse(text).message || JSON.parse(text).details || message; } catch {}
    throw httpError(response.status === 404 ? 404 : 502, `Supabase: ${message}`);
  }
  return text ? JSON.parse(text) : [];
}

async function ensureParty(name, type) {
  const query = new URLSearchParams({ select: 'id,name,party_type', name: `eq.${name}`, party_type: `eq.${type}`, limit: '1' });
  const found = await supabase(`parties?${query}`);
  if (found[0]) return found[0];
  const created = await supabase('parties', { method: 'POST', body: { name, party_type: type } });
  return created[0];
}

async function getObligation(id) {
  const rows = await supabase(`obligations?select=*,party:parties!obligations_party_id_fkey(id,name,party_type),category:expense_categories!obligations_category_id_fkey(id,name),payments(id,payment_date,amount,method,notes)&id=eq.${id}&limit=1`);
  if (!rows[0]) throw httpError(404, 'Data kewajiban tidak ditemukan.');
  return rows[0];
}

function withComputedBalance(row) {
  if (!row) return row;
  const paid = (row.payments || []).reduce((sum, payment) => sum + Number(payment.amount), 0);
  return { ...row, paid_amount: paid, remaining: Math.max(0, Number(row.amount) - paid), payment_status: paid >= Number(row.amount) ? 'paid' : paid > 0 ? 'partial' : 'unpaid' };
}

function validateObligation(data, existing) {
  const type = existing ? existing.obligation_type : data.obligation_type;
  if (!['debt', 'reimbursement'].includes(type)) throw httpError(400, 'Jenis transaksi tidak valid.');
  const party_name = cleanText(data.party_name, 'Nama supplier/karyawan', 120);
  const transaction_date = validDate(data.transaction_date, 'Tanggal transaksi');
  const amount = Number(data.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 999999999999) throw httpError(400, 'Nominal harus lebih besar dari nol.');
  const description = cleanText(data.description || '', 'Keterangan', 1000, true);
  const due_date = type === 'debt' ? validDate(data.due_date, 'Tanggal jatuh tempo') : null;
  if (due_date && due_date < transaction_date) throw httpError(400, 'Tanggal jatuh tempo tidak boleh sebelum tanggal transaksi.');
  const category_id = type === 'reimbursement' ? cleanText(data.category_id, 'Kategori', 80) : null;
  if (type === 'reimbursement' && !/^[0-9a-f-]{36}$/i.test(category_id)) throw httpError(400, 'Kategori reimbursement tidak valid.');
  if (existing && amount < withComputedBalance(existing).paid_amount) throw httpError(400, 'Nominal kewajiban tidak boleh lebih kecil dari total pembayaran.');
  return { obligation_type: type, party_name, transaction_date, amount, due_date, description, category_id };
}

function validatePayment(data) {
  const payment_date = validDate(data.payment_date, 'Tanggal pembayaran');
  const amount = Number(data.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 999999999999) throw httpError(400, 'Nominal pembayaran harus lebih besar dari nol.');
  if (!METHODS.includes(data.method)) throw httpError(400, 'Metode pembayaran tidak valid.');
  return { payment_date, amount, method: data.method, notes: cleanText(data.notes || '', 'Keterangan', 500, true) };
}

function cleanText(value, label, maxLength, allowEmpty = false) {
  if (typeof value !== 'string') throw httpError(400, `${label} wajib diisi.`);
  const result = value.trim();
  if ((!allowEmpty && !result) || result.length > maxLength) throw httpError(400, `${label} wajib diisi dan maksimal ${maxLength} karakter.`);
  return result;
}

function validDate(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw httpError(400, `${label} tidak valid.`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw httpError(400, `${label} tidak valid.`);
  return value;
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw httpError(413, 'Ukuran data terlalu besar.');
  }
  let parsed;
  try { parsed = JSON.parse(body || '{}'); } catch { throw httpError(400, 'Format JSON tidak valid.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw httpError(400, 'Data permintaan harus berupa objek JSON.');
  return parsed;
}

function serveStatic(req, res, pathname) {
  if (!['GET', 'HEAD'].includes(req.method)) return sendJson(res, 405, { error: 'Metode tidak diizinkan.' });
  const requested = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.resolve(ROOT, `.${decodeURIComponent(requested)}`);
  if (!filePath.startsWith(`${ROOT}${path.sep}`)) return sendJson(res, 403, { error: 'Akses ditolak.' });
  fs.readFile(filePath, (error, contents) => {
    if (error) return sendJson(res, 404, { error: 'File tidak ditemukan.' });
    const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
    res.writeHead(200, { 'Content-Type': types[path.extname(filePath)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : contents);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}
