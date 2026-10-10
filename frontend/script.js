const state = { page: 'dashboard', obligations: [], categories: [], filters: { search: '', status: 'all' }, supabaseConfig: null };
const pageNames = { dashboard: 'Dashboard', debt: 'Utang Usaha', reimbursement: 'Reimbursement', reports: 'Laporan' };
const moneyFormatter = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 });
const dateFormatter = new Intl.DateTimeFormat('id-ID', { day: '2-digit', month: '2-digit', year: 'numeric' });
const today = localDate();
const defaultSupabaseConfig = {
  url: 'https://ubkwkbnxcfakgeptysnq.supabase.co',
  key: 'sb_publishable_yUoCgfBpgRXp2tJXH9t3VQ_LyoNQzkL'
};

document.addEventListener('DOMContentLoaded', initialize);
document.addEventListener('click', handleClick);
document.addEventListener('input', handleFilterInput);
document.addEventListener('change', handleFilterInput);

async function initialize() {
  state.supabaseConfig = defaultSupabaseConfig;
  await refreshData();
}

async function refreshData() {
  const container = document.getElementById('page-content');
  container.innerHTML = '<div class="loading-state">Memuat data Sakura Event...</div>';
  try {
    const [obligations, categories] = await Promise.all([api('/api/obligations'), api('/api/categories')]);
    state.obligations = obligations;
    state.categories = categories;
    renderPage();
  } catch (error) {
    if (isDatabaseSetupError(error)) {
      container.innerHTML = `<section class="panel setup-state"><div class="eyebrow">Penyiapan aplikasi</div><h2>Dashboard belum siap</h2><p>Struktur database belum tersedia. Buka SQL Editor project, jalankan seluruh isi file <code>backend/schema.sql</code>, lalu muat ulang dashboard.</p><button class="btn btn-secondary" data-action="refresh">Coba lagi</button></section>`;
      return;
    }
    container.innerHTML = `<div class="panel empty-state">${escapeHtml(error.message)}<br><br><button class="btn btn-secondary" data-action="refresh">Coba lagi</button></div>`;
  }
}

async function api(url, options = {}) {
  return supabaseApi(url, options);
}

function isDatabaseSetupError(error) {
  return error.code === 'PGRST205' || error.code === '42P01' ||
    /could not find the table|schema cache|relation .+ does not exist|database belum tersedia/i.test(error.message);
}

async function supabaseRest(resource, options = {}) {
  const response = await fetch(`${state.supabaseConfig.url}/rest/v1/${resource}`, {
    method: options.method || 'GET',
    headers: {
      apikey: state.supabaseConfig.key,
      'Content-Type': 'application/json',
      Prefer: options.prefer || (options.method === 'POST' || options.method === 'PATCH' ? 'return=representation' : 'return=minimal')
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {})
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { throw new Error('Respons Supabase tidak valid.'); }
  }
  if (!response.ok) {
    const error = new Error(data?.message || data?.details || data?.hint || `Permintaan data gagal (${response.status}).`);
    error.code = data?.code;
    throw error;
  }
  return data;
}

async function supabaseApi(url, options = {}) {
  const method = options.method || 'GET';
  const body = options.body ? JSON.parse(options.body) : {};
  if (url === '/api/categories') {
    return supabaseRest('expense_categories?select=id,name&order=name.asc');
  }
  if (url === '/api/obligations') {
    if (method === 'GET') {
      const query = 'select=*,party:parties!obligations_party_id_fkey(id,name,party_type),category:expense_categories!obligations_category_id_fkey(id,name),payments(id,payment_date,amount,method,notes)&order=transaction_date.desc,created_at.desc';
      return (await supabaseRest(`obligations?${query}`)).map(localComputedBalance);
    }
    if (method === 'POST') {
      const party = await supabaseParty(body.party_name, body.obligation_type === 'debt' ? 'supplier' : 'employee');
      const rows = await supabaseRest('obligations', { method, body: {
        party_id: party.id,
        category_id: body.category_id || null,
        obligation_type: body.obligation_type,
        transaction_date: body.transaction_date,
        due_date: body.due_date || null,
        amount: Number(body.amount),
        description: body.description || '',
        status: body.obligation_type === 'debt' ? 'approved' : 'submitted'
      } });
      return localComputedBalance(rows[0]);
    }
  }
  const match = url.match(/^\/api\/obligations\/([^/]+)(?:\/(payments|status))?$/);
  if (!match) throw new Error('Endpoint tidak ditemukan.');
  const [, id, action] = match;
  const row = state.obligations.find(item => item.id === id);
  if (!row) throw new Error('Data kewajiban tidak ditemukan.');
  if (method === 'PATCH' && !action) {
    const party = await supabaseParty(body.party_name, row.obligation_type === 'debt' ? 'supplier' : 'employee');
    const rows = await supabaseRest(`obligations?id=eq.${encodeURIComponent(id)}`, { method, body: {
      party_id: party.id,
      category_id: body.category_id || null,
      transaction_date: body.transaction_date,
      due_date: body.due_date || null,
      amount: Number(body.amount),
      description: body.description || '',
      updated_at: new Date().toISOString()
    } });
    return localComputedBalance(rows[0]);
  }
  if (method === 'DELETE' && !action) {
    await supabaseRest(`obligations?id=eq.${encodeURIComponent(id)}`, { method, prefer: 'return=minimal' });
    return { ok: true };
  }
  if (method === 'PATCH' && action === 'status') {
    const rows = await supabaseRest(`obligations?id=eq.${encodeURIComponent(id)}`, { method, body: { status: body.status, updated_at: new Date().toISOString() } });
    return localComputedBalance(rows[0]);
  }
  if (method === 'POST' && action === 'payments') {
    const computed = localComputedBalance(row);
    if (row.obligation_type === 'reimbursement' && row.status !== 'approved') throw new Error('Setujui reimbursement sebelum mencatat pembayaran.');
    if (Number(body.amount) > computed.remaining) throw new Error('Nominal pembayaran melebihi sisa kewajiban.');
    const rows = await supabaseRest('payments', { method, body: { obligation_id: id, payment_date: body.payment_date, amount: Number(body.amount), method: body.method, notes: body.notes || '' } });
    return rows[0];
  }
  throw new Error('Permintaan Supabase tidak didukung.');
}

async function supabaseParty(name, type) {
  const query = new URLSearchParams({ select: 'id,name,party_type', name: `eq.${name.trim()}`, party_type: `eq.${type}`, limit: '1' });
  const found = await supabaseRest(`parties?${query}`);
  if (found[0]) return found[0];
  const rows = await supabaseRest('parties', { method: 'POST', body: { name: name.trim(), party_type: type } });
  return rows[0];
}

function localComputedBalance(row) {
  const paid = (row.payments || []).reduce((total, payment) => total + Number(payment.amount), 0);
  return { ...row, paid_amount: paid, remaining: Math.max(0, Number(row.amount) - paid), payment_status: paid >= Number(row.amount) ? 'paid' : paid > 0 ? 'partial' : 'unpaid' };
}

function handleClick(event) {
  const nav = event.target.closest('[data-page]');
  if (nav) {
    state.page = nav.dataset.page;
    state.filters = { search: '', status: 'all' };
    document.querySelectorAll('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.page === state.page));
    renderPage();
    return;
  }
  const action = event.target.closest('[data-action]');
  if (!action) return;
  const id = action.dataset.id;
  switch (action.dataset.action) {
    case 'refresh': refreshData(); break;
    case 'add-debt': openObligationForm('debt'); break;
    case 'add-reimbursement': openObligationForm('reimbursement'); break;
    case 'edit': openObligationForm(getObligation(id).obligation_type, getObligation(id)); break;
    case 'detail': openDetail(getObligation(id)); break;
    case 'delete': deleteObligation(id); break;
    case 'payment': openPaymentForm(getObligation(id)); break;
    case 'approve': updateApproval(id, 'approved'); break;
    case 'submit': updateApproval(id, 'submitted'); break;
    case 'report-excel': exportReport(); break;
    case 'report-print': window.print(); break;
    case 'clear-report-filter': state.filters.from = ''; state.filters.to = ''; renderPage(); break;
    case 'close-modal': closeModal(); break;
  }
}

function handleFilterInput(event) {
  const target = event.target;
  if (target.matches('[data-filter]')) {
    state.filters[target.dataset.filter] = target.value;
    if (state.page === 'reports') renderPage();
    else updateTableRows();
  }
}

function renderPage() {
  document.getElementById('breadcrumb-current').textContent = pageNames[state.page];
  document.querySelectorAll('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.page === state.page));
  const root = document.getElementById('page-content');
  if (state.page === 'dashboard') root.innerHTML = renderDashboard();
  if (state.page === 'debt') root.innerHTML = renderListPage('debt');
  if (state.page === 'reimbursement') root.innerHTML = renderListPage('reimbursement');
  if (state.page === 'reports') root.innerHTML = renderReports();
}

function renderDashboard() {
  const rows = state.obligations;
  const debts = rows.filter(row => row.obligation_type === 'debt');
  const reimbursements = rows.filter(row => row.obligation_type === 'reimbursement');
  const totalDebt = sum(debts, row => row.amount);
  const totalReimbursement = sum(reimbursements, row => row.amount);
  const unpaidDebt = sum(debts, row => row.remaining);
  const unpaidReimbursement = sum(reimbursements, row => row.remaining);
  const unpaid = sum(rows, row => row.remaining);
  const paid = sum(rows, row => row.paid_amount);
  const paymentProgress = totalDebt + totalReimbursement > 0
    ? Math.min(100, Math.round(paid / (totalDebt + totalReimbursement) * 100))
    : 0;
  const dueSoon = debts.filter(row => row.remaining > 0 && dueState(row).kind !== 'normal').sort((a, b) => a.due_date.localeCompare(b.due_date));
  const latest = [...rows].sort((a, b) => `${b.transaction_date}${b.created_at}`.localeCompare(`${a.transaction_date}${a.created_at}`)).slice(0, 6);
  return `<section class="dashboard-hero">
      <div class="hero-copy"><span class="hero-kicker"><span class="hero-kicker-dot"></span>RUANG KEUANGAN · SAKURA EVENT</span>
        <h1>Semua kewajiban,<br><span>dalam kendali.</span></h1>
        <p>Pantau utang usaha dan reimbursement dalam satu ruang kerja yang rapi.</p>
        <div class="hero-actions"><button class="btn btn-hero-light" data-action="add-debt"><span>＋</span> Catat utang</button><button class="btn btn-hero-ghost" data-action="add-reimbursement"><span>＋</span> Reimbursement</button></div>
      </div>
      <div class="hero-side"><div class="hero-orbit orbit-one"></div><div class="hero-orbit orbit-two"></div><div class="hero-flower">✿</div>
        <div class="hero-glass-card"><div class="hero-card-top"><span>RINGKASAN PEMBAYARAN</span><span class="hero-live"><i></i> LIVE</span></div>
          <div class="hero-paid-value">${money(paid)}</div><div class="hero-card-caption">sudah dibayarkan</div>
          <div class="hero-progress"><span style="width:${paymentProgress}%"></span></div>
          <div class="hero-progress-label"><span>${paymentProgress}% dari total kewajiban</span><strong>${money(unpaid)} tersisa</strong></div>
        </div>
        <div class="hero-sparkle sparkle-one">✦</div><div class="hero-sparkle sparkle-two">✧</div>
      </div>
    </section>
    <section class="summary-grid">
      ${summaryCard('Total utang usaha', money(totalDebt), `${percentage(unpaidDebt, totalDebt)}% belum dibayar · ${money(unpaidDebt)}`, '↗', 'pink')}
      ${summaryCard('Total reimbursement', money(totalReimbursement), `${percentage(unpaidReimbursement, totalReimbursement)}% belum dibayar · ${money(unpaidReimbursement)}`, '◉', 'blue')}
      ${summaryCard('Belum dibayar', money(unpaid), `${rows.filter(row => row.remaining > 0).length} kewajiban masih terbuka`, '◷', 'orange')}
      ${summaryCard('Sudah dibayar', money(paid), 'Akumulasi pembayaran tercatat', '✓', 'green')}
    </section>
    <section class="dashboard-grid">
      <div class="panel"><div class="panel-header"><div><h2 class="panel-title">Transaksi terbaru</h2><p class="panel-subtitle">Catatan kewajiban yang baru ditambahkan</p></div><button class="link-button" data-page="debt">Lihat semua →</button></div>
        <div class="table-wrap"><table><thead><tr><th>Supplier / Karyawan</th><th>Jenis</th><th>Tanggal</th><th>Nominal</th><th>Status</th></tr></thead><tbody>
          ${latest.length ? latest.map(row => `<tr><td><span class="party-cell">${escapeHtml(row.party?.name || '—')}</span><span class="cell-note">${escapeHtml(row.description || row.category?.name || 'Tanpa keterangan')}</span></td><td>${typeLabel(row.obligation_type)}</td><td>${formatDate(row.transaction_date)}</td><td class="money">${money(row.amount)}</td><td>${statusBadge(row)}</td></tr>`).join('') : `<tr><td colspan="5" class="table-empty">Belum ada transaksi. Tambahkan utang atau reimbursement pertama.</td></tr>`}
        </tbody></table></div></div>
      <div class="panel"><div class="panel-header"><div><h2 class="panel-title">Pengingat jatuh tempo</h2><p class="panel-subtitle">Utang yang perlu diperhatikan</p></div><span class="badge ${dueSoon.length ? 'badge-due-soon' : 'badge-paid'}">${dueSoon.length} perlu perhatian</span></div>
        <div class="reminder-list">${dueSoon.length ? dueSoon.slice(0, 5).map(row => { const due = dueState(row); return `<div class="reminder-item"><span class="reminder-dot ${due.kind === 'late' ? 'late' : ''}"></span><div class="reminder-copy"><strong>${escapeHtml(row.party?.name || '—')}</strong><small>${due.label} · ${formatDate(row.due_date)}</small></div><span class="reminder-amount">${money(row.remaining)}</span></div>`; }).join('') : '<div class="empty-state">Tidak ada utang yang mendekati jatuh tempo.</div>'}</div>
      </div>
    </section>`;
}

function renderListPage(type) {
  const isDebt = type === 'debt';
  const title = isDebt ? 'Utang Usaha' : 'Reimbursement';
  const subset = state.obligations.filter(row => row.obligation_type === type);
  const statuses = isDebt ? [['all', 'Semua status'], ['unpaid', 'Belum dibayar'], ['partial', 'Dibayar sebagian'], ['paid', 'Sudah dibayar'], ['overdue', 'Lewat jatuh tempo']] : [['all', 'Semua status'], ['submitted', 'Diajukan'], ['approved', 'Disetujui'], ['unpaid', 'Belum dibayar'], ['partial', 'Dibayar sebagian'], ['paid', 'Dibayar']];
  return `<div class="page-heading"><div><div class="eyebrow">Pencatatan kewajiban</div><h1>${title}</h1><p class="page-subtitle">${isDebt ? 'Kelola tagihan supplier dan pantau tanggal jatuh temponya.' : 'Kelola pengajuan biaya karyawan dari pengajuan hingga pembayaran.'}</p></div><button class="btn btn-primary" data-action="${isDebt ? 'add-debt' : 'add-reimbursement'}">＋ Tambah ${isDebt ? 'Utang' : 'Reimbursement'}</button></div>
    <section class="summary-grid">
      ${summaryCard(isDebt ? 'Total utang' : 'Total pengajuan', money(sum(subset, row => row.amount)), `${subset.length} transaksi`, isDebt ? '↗' : '◉', isDebt ? 'pink' : 'blue')}
      ${summaryCard('Belum dibayar', money(sum(subset, row => row.remaining)), `${subset.filter(row => row.remaining > 0).length} transaksi terbuka`, '◷', 'orange')}
      ${summaryCard('Sudah dibayar', money(sum(subset, row => row.paid_amount)), 'Total pembayaran tercatat', '✓', 'green')}
      ${summaryCard(isDebt ? 'Lewat jatuh tempo' : 'Menunggu persetujuan', isDebt ? `${subset.filter(row => row.remaining > 0 && dueState(row).kind === 'late').length} transaksi` : `${subset.filter(row => row.status === 'submitted').length} pengajuan`, isDebt ? 'Perlu segera ditindaklanjuti' : 'Perlu ditinjau admin', '!', 'orange')}
    </section>
    <section class="panel list-panel"><div class="panel-header"><div><h2 class="panel-title">Daftar ${title.toLowerCase()}</h2><p class="panel-subtitle">Data tersimpan dan diperbarui secara langsung</p></div></div>
      <div class="toolbar"><label class="search-box"><span>⌕</span><input class="field-control" data-filter="search" type="search" placeholder="Cari ${isDebt ? 'supplier' : 'karyawan'}..." value="${escapeAttribute(state.filters.search)}"></label>
        <select class="field-control" data-filter="status">${statuses.map(([value, label]) => `<option value="${value}" ${state.filters.status === value ? 'selected' : ''}>${label}</option>`).join('')}</select>
        <input class="field-control" data-filter="from" type="date" aria-label="Dari tanggal" value="${escapeAttribute(state.filters.from || '')}">
        <input class="field-control" data-filter="to" type="date" aria-label="Sampai tanggal" value="${escapeAttribute(state.filters.to || '')}">
      </div>
      <div class="table-wrap"><table><thead><tr><th>${isDebt ? 'Supplier / Vendor' : 'Karyawan'}</th><th>${isDebt ? 'Tanggal transaksi' : 'Kategori'}</th>${isDebt ? '<th>Jatuh tempo</th>' : '<th>Tanggal pengeluaran</th>'}<th>Nominal</th><th>Sudah dibayar</th><th>Sisa</th><th>Status</th><th>Aksi</th></tr></thead><tbody id="obligation-table-body">${renderObligationRows(subset, type)}</tbody></table></div>
      <div class="pagination-note"><span id="table-count">${subset.length} transaksi</span><span>Nominal dalam Rupiah (Rp)</span></div>
    </section>`;
}

function renderObligationRows(rows, type) {
  const isDebt = type === 'debt';
  const filtered = rows.filter(row => {
    const query = (state.filters.search || '').trim().toLocaleLowerCase('id-ID');
    const name = (row.party?.name || '').toLocaleLowerCase('id-ID');
    const due = isDebt ? dueState(row).kind : '';
    const status = row.payment_status === 'paid' ? 'paid' : row.payment_status === 'partial' ? 'partial' : row.status === 'submitted' ? 'submitted' : 'unpaid';
    return (!query || name.includes(query)) &&
      (state.filters.status === 'all' || (state.filters.status === 'overdue' ? due === 'late' : state.filters.status === status || (state.filters.status === 'approved' && row.status === 'approved'))) &&
      (!state.filters.from || row.transaction_date >= state.filters.from) &&
      (!state.filters.to || row.transaction_date <= state.filters.to);
  });
  if (!filtered.length) return '<tr><td colspan="8" class="table-empty">Tidak ada data yang sesuai dengan pencarian atau filter.</td></tr>';
  return filtered.map(row => {
    const due = isDebt ? dueState(row) : null;
    return `<tr><td><span class="party-cell">${escapeHtml(row.party?.name || '—')}</span><span class="cell-note">${escapeHtml(row.description || (isDebt ? 'Utang usaha' : 'Pengajuan reimbursement'))}</span></td>
      <td>${isDebt ? formatDate(row.transaction_date) : escapeHtml(row.category?.name || 'Lainnya')}</td>
      <td>${isDebt ? `${formatDate(row.due_date)}<span class="due-text ${due.kind === 'late' ? 'due-late' : due.kind === 'soon' || due.kind === 'today' ? 'due-soon' : 'due-ok'}">${due.label}</span>` : formatDate(row.transaction_date)}</td>
      <td class="money">${money(row.amount)}</td><td>${money(row.paid_amount)}</td><td class="money">${money(row.remaining)}</td><td>${statusBadge(row)}</td>
      <td><div class="action-group"><button class="btn btn-secondary btn-small" data-action="detail" data-id="${row.id}" title="Lihat detail">Detail</button>
      ${!isDebt && row.status === 'submitted' ? `<button class="btn btn-secondary btn-small" data-action="approve" data-id="${row.id}">Setujui</button>` : ''}
      ${row.remaining > 0 && (isDebt || row.status === 'approved') ? `<button class="btn btn-secondary btn-small" data-action="payment" data-id="${row.id}">Bayar</button>` : ''}
      <button class="btn btn-secondary btn-small" data-action="edit" data-id="${row.id}" title="Edit">Edit</button><button class="btn btn-danger btn-small" data-action="delete" data-id="${row.id}" title="Hapus">Hapus</button></div></td></tr>`;
  }).join('');
}

function renderReports() {
  const from = state.filters.from || '';
  const to = state.filters.to || '';
  const inPeriod = state.obligations.filter(row => (!from || row.transaction_date >= from) && (!to || row.transaction_date <= to));
  const debts = inPeriod.filter(row => row.obligation_type === 'debt');
  const reimbursements = inPeriod.filter(row => row.obligation_type === 'reimbursement');
  const debtAmount = sum(debts, row => row.amount);
  const reimbursementAmount = sum(reimbursements, row => row.amount);
  const unpaidDebt = sum(debts, row => row.remaining);
  const unpaidReimbursement = sum(reimbursements, row => row.remaining);
  const payments = state.obligations.flatMap(row => (row.payments || []).map(payment => ({ ...payment, obligation: row }))).filter(payment => (!from || payment.payment_date >= from) && (!to || payment.payment_date <= to)).sort((a, b) => b.payment_date.localeCompare(a.payment_date));
  return `<div class="page-heading"><div><div class="eyebrow">Pusat laporan</div><h1>Laporan</h1><p class="page-subtitle">Ringkasan utang, reimbursement, pembayaran, dan kewajiban terbuka.</p></div><div class="action-group"><button class="btn btn-secondary" data-action="report-print">Cetak laporan</button><button class="btn btn-primary" data-action="report-excel">▦ Unduh Excel</button></div></div>
    <div class="report-filters"><label>Dari tanggal<input type="date" class="field-control" data-filter="from" value="${escapeAttribute(from)}"></label><label>Sampai tanggal<input type="date" class="field-control" data-filter="to" value="${escapeAttribute(to)}"></label><button class="btn btn-secondary" data-action="clear-report-filter">Atur ulang</button><span class="form-help">Periode transaksi berdasarkan tanggal pencatatan.</span></div>
    <div class="report-cards">${summaryCard('Utang usaha', money(debtAmount), `${percentage(unpaidDebt, debtAmount)}% belum dibayar · ${money(unpaidDebt)}`, '↗', 'pink')}
    ${summaryCard('Reimbursement', money(reimbursementAmount), `${percentage(unpaidReimbursement, reimbursementAmount)}% belum dibayar · ${money(unpaidReimbursement)}`, '◉', 'blue')}
    ${summaryCard('Kewajiban belum dibayar', money(sum(inPeriod, row => row.remaining)), 'Sisa kewajiban transaksi periode', '◷', 'orange')}</div>
    <section class="panel report-section"><div class="panel-header"><div><h2 class="panel-title">Laporan kewajiban</h2><p class="panel-subtitle">Utang usaha dan reimbursement berdasarkan tanggal transaksi</p></div></div>
      <div class="table-wrap"><table><thead><tr><th>Tanggal</th><th>Jenis</th><th>Supplier / Karyawan</th><th>Kategori</th><th>Nominal</th><th>Dibayar</th><th>Sisa</th><th>Status</th></tr></thead><tbody>${inPeriod.length ? inPeriod.map(row => `<tr><td>${formatDate(row.transaction_date)}</td><td>${typeLabel(row.obligation_type)}</td><td class="party-cell">${escapeHtml(row.party?.name || '—')}</td><td>${escapeHtml(row.category?.name || '—')}</td><td class="money">${money(row.amount)}</td><td>${money(row.paid_amount)}</td><td class="money">${money(row.remaining)}</td><td>${statusBadge(row)}</td></tr>`).join('') : '<tr><td colspan="8" class="table-empty">Tidak ada transaksi pada periode ini.</td></tr>'}</tbody></table></div></section>
    <section class="panel"><div class="panel-header"><div><h2 class="panel-title">Laporan pembayaran</h2><p class="panel-subtitle">Riwayat pembayaran pada periode terpilih</p></div></div>
      <div class="table-wrap"><table><thead><tr><th>Tanggal bayar</th><th>Jenis</th><th>Supplier / Karyawan</th><th>Metode</th><th>Keterangan</th><th>Nominal</th></tr></thead><tbody>${payments.length ? payments.map(payment => `<tr><td>${formatDate(payment.payment_date)}</td><td>${typeLabel(payment.obligation.obligation_type)}</td><td class="party-cell">${escapeHtml(payment.obligation.party?.name || '—')}</td><td>${escapeHtml(payment.method)}</td><td>${escapeHtml(payment.notes || '—')}</td><td class="money">${money(payment.amount)}</td></tr>`).join('') : '<tr><td colspan="6" class="table-empty">Belum ada pembayaran pada periode ini.</td></tr>'}</tbody></table></div></section>`;
}

function openObligationForm(type, row) {
  const editing = Boolean(row);
  const isDebt = type === 'debt';
  const categoryOptions = state.categories.map(category => `<option value="${category.id}" ${row?.category_id === category.id ? 'selected' : ''}>${escapeHtml(category.name)}</option>`).join('');
  showModal(`<div class="modal-header"><div><h2>${editing ? 'Edit' : 'Tambah'} ${isDebt ? 'Utang Usaha' : 'Reimbursement'}</h2><p>Lengkapi data transaksi Sakura Event di bawah ini.</p></div><button class="modal-close" data-action="close-modal" aria-label="Tutup">×</button></div>
    <form id="obligation-form"><div class="modal-body"><div class="form-grid">
      <label class="full">${isDebt ? 'Nama supplier / vendor' : 'Nama karyawan'} <span class="required">*</span><input class="field-control" name="party_name" maxlength="120" required value="${escapeAttribute(row?.party?.name || '')}" placeholder="${isDebt ? 'Contoh: PT Sumber Acara' : 'Contoh: Andi Pratama'}"></label>
      ${!isDebt ? `<label>Kategori pengeluaran <span class="required">*</span><select class="field-control" name="category_id" required><option value="">Pilih kategori</option>${categoryOptions}</select></label>` : ''}
      ${dateInput('transaction_date', isDebt ? 'Tanggal transaksi' : 'Tanggal pengeluaran', row?.transaction_date || '')}
      ${isDebt ? dateInput('due_date', 'Tanggal jatuh tempo', row?.due_date || '') : ''}
      <label>Nominal (Rp) <span class="required">*</span><input class="field-control" type="number" name="amount" min="1" step="1" required value="${escapeAttribute(row?.amount || '')}" placeholder="Contoh: 250000"></label>
      <label class="full">Keterangan<textarea class="field-control" name="description" maxlength="1000" placeholder="Tambahkan detail transaksi (opsional)">${escapeHtml(row?.description || '')}</textarea></label>
    </div></div><div class="modal-footer"><button type="button" class="btn btn-secondary" data-action="close-modal">Batal</button><button type="submit" class="btn btn-primary">${editing ? 'Simpan perubahan' : 'Simpan transaksi'}</button></div></form>`);
  document.getElementById('obligation-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const payload = Object.fromEntries(form.entries());
    const transactionDate = parseDateInput(payload.transaction_date);
    const dueDate = isDebt ? parseDateInput(payload.due_date) : null;
    if (!transactionDate || (isDebt && !dueDate)) {
      const input = event.currentTarget.querySelector(`[name="${!transactionDate ? 'transaction_date' : 'due_date'}"]`);
      input.setCustomValidity('Masukkan tanggal yang valid dengan format dd/mm/yyyy.');
      input.reportValidity();
      return;
    }
    payload.transaction_date = transactionDate;
    if (isDebt) payload.due_date = dueDate;
    payload.obligation_type = type;
    payload.amount = Number(payload.amount);
    const submit = event.currentTarget.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      await api(editing ? `/api/obligations/${row.id}` : '/api/obligations', { method: editing ? 'PATCH' : 'POST', body: JSON.stringify(payload) });
      closeModal();
      toast(editing ? 'Perubahan transaksi berhasil disimpan.' : 'Transaksi berhasil ditambahkan.');
      await refreshData();
    } catch (error) { toast(error.message, true); submit.disabled = false; }
  });
}

function openPaymentForm(row) {
  showModal(`<div class="modal-header"><div><h2>Catat pembayaran</h2><p>${escapeHtml(row.party?.name || '')} · Sisa kewajiban ${money(row.remaining)}</p></div><button class="modal-close" data-action="close-modal" aria-label="Tutup">×</button></div>
    <form id="payment-form"><div class="modal-body"><div class="form-grid">
      ${dateInput('payment_date', 'Tanggal pembayaran', today)}
      <label>Nominal pembayaran (Rp) <span class="required">*</span><input class="field-control" type="number" name="amount" min="1" max="${Math.floor(row.remaining)}" step="1" required value="${Math.floor(row.remaining)}"></label>
      <label>Metode pembayaran <span class="required">*</span><select class="field-control" name="method" required><option>Transfer bank</option><option>Tunai</option><option>E-wallet</option><option>Lainnya</option></select></label>
      <label class="full">Keterangan<textarea class="field-control" name="notes" maxlength="500" placeholder="Nomor referensi atau catatan (opsional)"></textarea></label>
    </div></div><div class="modal-footer"><button type="button" class="btn btn-secondary" data-action="close-modal">Batal</button><button type="submit" class="btn btn-primary">Simpan pembayaran</button></div></form>`);
  document.getElementById('payment-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const payload = Object.fromEntries(form.entries());
    const paymentDate = parseDateInput(payload.payment_date);
    if (!paymentDate) {
      const input = event.currentTarget.querySelector('[name="payment_date"]');
      input.setCustomValidity('Masukkan tanggal yang valid dengan format dd/mm/yyyy.');
      input.reportValidity();
      return;
    }
    payload.payment_date = paymentDate;
    payload.amount = Number(payload.amount);
    const submit = event.currentTarget.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      await api(`/api/obligations/${row.id}/payments`, { method: 'POST', body: JSON.stringify(payload) });
      closeModal(); toast('Pembayaran berhasil dicatat.'); await refreshData();
    } catch (error) { toast(error.message, true); submit.disabled = false; }
  });
}

function openDetail(row) {
  const payments = row.payments || [];
  const due = row.obligation_type === 'debt' ? dueState(row) : null;
  showModal(`<div class="modal-header"><div><h2>Detail ${row.obligation_type === 'debt' ? 'utang usaha' : 'reimbursement'}</h2><p>${escapeHtml(row.party?.name || '—')}</p></div><button class="modal-close" data-action="close-modal" aria-label="Tutup">×</button></div>
    <div class="modal-body"><div class="detail-grid">
      ${detailItem('Jenis transaksi', row.obligation_type === 'debt' ? 'Utang usaha' : 'Reimbursement')}
      ${detailItem(row.obligation_type === 'debt' ? 'Supplier / vendor' : 'Karyawan', escapeHtml(row.party?.name || '—'))}
      ${detailItem(row.obligation_type === 'debt' ? 'Tanggal transaksi' : 'Tanggal pengeluaran', formatDate(row.transaction_date))}
      ${detailItem('Kategori', escapeHtml(row.category?.name || '—'))}
      ${row.obligation_type === 'debt' ? detailItem('Jatuh tempo', `${formatDate(row.due_date)} · ${escapeHtml(due.label)}`) : detailItem('Status persetujuan', row.status === 'approved' ? 'Disetujui' : 'Diajukan')}
      ${detailItem('Total kewajiban', money(row.amount))}
      ${detailItem('Sudah dibayar', money(row.paid_amount))}
      ${detailItem('Sisa kewajiban', money(row.remaining))}
      <div class="detail-item detail-note"><small>Keterangan</small><strong>${escapeHtml(row.description || 'Tidak ada keterangan')}</strong></div>
    </div><div class="payment-history"><h3>Riwayat pembayaran (${payments.length})</h3>${payments.length ? [...payments].sort((a,b) => b.payment_date.localeCompare(a.payment_date)).map(payment => `<div class="history-row"><span>${formatDate(payment.payment_date)} · ${escapeHtml(payment.method)}${payment.notes ? `<small class="cell-note">${escapeHtml(payment.notes)}</small>` : ''}</span><strong>${money(payment.amount)}</strong></div>`).join('') : '<div class="empty-state">Belum ada pembayaran.</div>'}</div></div>
    <div class="modal-footer"><button class="btn btn-secondary" data-action="close-modal">Tutup</button>${row.obligation_type === 'reimbursement' && row.status === 'submitted' ? `<button class="btn btn-primary" data-action="approve" data-id="${row.id}">Setujui pengajuan</button>` : ''}${row.remaining > 0 && (row.obligation_type === 'debt' || row.status === 'approved') ? `<button class="btn btn-primary" data-action="payment" data-id="${row.id}">Catat pembayaran</button>` : ''}</div>`);
}

async function updateApproval(id, status) {
  try {
    await api(`/api/obligations/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) });
    closeModal(); toast(status === 'approved' ? 'Reimbursement berhasil disetujui.' : 'Status reimbursement diperbarui.'); await refreshData();
  } catch (error) { toast(error.message, true); }
}

async function deleteObligation(id) {
  const row = getObligation(id);
  if (!window.confirm(`Hapus transaksi ${row.party?.name || ''}? Riwayat pembayarannya juga akan dihapus. Tindakan ini tidak dapat dibatalkan.`)) return;
  try {
    await api(`/api/obligations/${id}`, { method: 'DELETE' });
    toast('Transaksi berhasil dihapus.');
    await refreshData();
  } catch (error) { toast(error.message, true); }
}

function updateTableRows() {
  const body = document.getElementById('obligation-table-body');
  if (!body) return;
  const type = state.page === 'debt' ? 'debt' : 'reimbursement';
  const countRows = renderObligationRows(state.obligations.filter(row => row.obligation_type === type), type);
  body.innerHTML = countRows;
  const count = (body.innerHTML.match(/<tr>/g) || []).length;
  document.getElementById('table-count').textContent = `${countRows.includes('Tidak ada data') ? 0 : count} transaksi`;
}

function exportReport() {
  const from = state.filters.from || '';
  const to = state.filters.to || '';
  const rows = state.obligations.filter(row => (!from || row.transaction_date >= from) && (!to || row.transaction_date <= to));
  const payments = state.obligations.flatMap(row => (row.payments || []).map(payment => ({ ...payment, obligation: row })))
    .filter(payment => (!from || payment.payment_date >= from) && (!to || payment.payment_date <= to))
    .sort((a, b) => a.payment_date.localeCompare(b.payment_date));
  const debts = rows.filter(row => row.obligation_type === 'debt');
  const reimbursements = rows.filter(row => row.obligation_type === 'reimbursement');
  const debtTotal = sum(debts, row => row.amount);
  const reimbursementTotal = sum(reimbursements, row => row.amount);
  const workbook = [
    {
      name: 'Ringkasan',
      rows: [
        [excelCell('LAPORAN KEUANGAN · SAKURA EVENT', 'title')],
        [excelCell('Periode'), excelCell(from ? formatDate(from) : 'Semua tanggal'), excelCell('s.d.'), excelCell(to ? formatDate(to) : 'Hari ini')],
        [],
        [excelCell('JENIS KEWAJIBAN', 'header'), excelCell('TOTAL (RP)', 'header'), excelCell('DIBAYAR (RP)', 'header'), excelCell('SISA (RP)', 'header'), excelCell('BELUM DIBAYAR', 'header')],
        [excelCell('Utang usaha'), excelCell(debtTotal, 'currency'), excelCell(sum(debts, row => row.paid_amount), 'currency'), excelCell(sum(debts, row => row.remaining), 'currency'), excelCell(debtTotal ? sum(debts, row => row.remaining) / debtTotal : 0, 'percent')],
        [excelCell('Reimbursement'), excelCell(reimbursementTotal, 'currency'), excelCell(sum(reimbursements, row => row.paid_amount), 'currency'), excelCell(sum(reimbursements, row => row.remaining), 'currency'), excelCell(reimbursementTotal ? sum(reimbursements, row => row.remaining) / reimbursementTotal : 0, 'percent')],
        [excelCell('TOTAL'), excelCell(sum(rows, row => row.amount), 'currency'), excelCell(sum(rows, row => row.paid_amount), 'currency'), excelCell(sum(rows, row => row.remaining), 'currency'), excelCell(sum(rows, row => row.amount) ? sum(rows, row => row.remaining) / sum(rows, row => row.amount) : 0, 'percent')]
      ]
    },
    {
      name: 'Kewajiban',
      rows: [
        [excelCell('DAFTAR KEWAJIBAN · SAKURA EVENT', 'title')],
        ['Tanggal transaksi', 'Jenis', 'Supplier / Karyawan', 'Kategori', 'Jatuh tempo', 'Nominal (Rp)', 'Dibayar (Rp)', 'Sisa (Rp)', 'Persentase belum dibayar', 'Status'].map(value => excelCell(value, 'header')),
        ...rows.map(row => [excelCell(row.transaction_date, 'date'), excelCell(typeLabel(row.obligation_type)), excelCell(row.party?.name || ''), excelCell(row.category?.name || ''), excelCell(row.due_date || '', row.due_date ? 'date' : 'text'), excelCell(Number(row.amount), 'currency'), excelCell(Number(row.paid_amount), 'currency'), excelCell(Number(row.remaining), 'currency'), excelCell(Number(row.amount) ? Number(row.remaining) / Number(row.amount) : 0, 'percent'), excelCell(readableStatus(row))])
      ]
    },
    {
      name: 'Pembayaran',
      rows: [
        [excelCell('RIWAYAT PEMBAYARAN · SAKURA EVENT', 'title')],
        ['Tanggal pembayaran', 'Jenis', 'Supplier / Karyawan', 'Metode', 'Keterangan', 'Nominal (Rp)'].map(value => excelCell(value, 'header')),
        ...payments.map(payment => [excelCell(payment.payment_date, 'date'), excelCell(typeLabel(payment.obligation.obligation_type)), excelCell(payment.obligation.party?.name || ''), excelCell(payment.method), excelCell(payment.notes || ''), excelCell(Number(payment.amount), 'currency')])
      ]
    }
  ];
  const xlsx = buildExcelWorkbook(workbook);
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([xlsx], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  link.download = `laporan-sakura-event-${today}.xlsx`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function excelCell(value, style = 'text') { return { value, style }; }

function buildExcelWorkbook(sheets) {
  const escapeXml = value => String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[character]));
  const styleId = { title: 1, header: 2, currency: 3, percent: 4, date: 5 };
  const columnName = index => {
    let name = '';
    for (index++; index; index = Math.floor((index - 1) / 26)) name = String.fromCharCode(65 + (index - 1) % 26) + name;
    return name;
  };
  const dateSerial = value => (Date.parse(`${value}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86400000;
  const worksheetFiles = sheets.map((sheet, sheetIndex) => {
    const rows = sheet.rows.map((row, rowIndex) => `<row r="${rowIndex + 1}">${row.map((cell, columnIndex) => {
      if (cell == null) return '';
      const item = typeof cell === 'object' && Object.hasOwn(cell, 'value') ? cell : excelCell(cell);
      const value = item.value;
      const reference = `${columnName(columnIndex)}${rowIndex + 1}`;
      const style = styleId[item.style] ? ` s="${styleId[item.style]}"` : '';
      if (item.style === 'date' && value) return `<c r="${reference}"${style}><v>${dateSerial(value)}</v></c>`;
      if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${reference}"${style}><v>${value}</v></c>`;
      return `<c r="${reference}"${style} t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
    }).join('')}</row>`).join('');
    return [`xl/worksheets/sheet${sheetIndex + 1}.xml`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="2" topLeftCell="A3" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="18"/><sheetData>${rows}</sheetData></worksheet>`];
  });
  const files = [
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((sheet, index) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')}</sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="3"><numFmt numFmtId="164" formatCode="#,##0;[Red]-#,##0"/><numFmt numFmtId="165" formatCode="0.00%"/><numFmt numFmtId="166" formatCode="dd mmm yyyy"/></numFmts><fonts count="3"><font><sz val="10"/><name val="Aptos"/><color rgb="FF302C3C"/></font><font><b/><sz val="16"/><name val="Aptos Display"/><color rgb="FF9E3F5C"/></font><font><b/><sz val="10"/><name val="Aptos"/><color rgb="FFFFFFFF"/></font></fonts><fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFF0F4"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FF563548"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="6"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="0" fontId="2" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`],
    ...worksheetFiles
  ];
  return zipStore(files);
}

function zipStore(files) {
  const encoder = new TextEncoder();
  const crcTable = Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
  });
  const crc32 = bytes => {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunks = [];
  const centralDirectory = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const [filename, content] of files) {
    const name = encoder.encode(filename);
    const data = encoder.encode(content);
    const checksum = crc32(data);
    const local = new Uint8Array(30 + name.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, dosTime, true);
    localView.setUint16(12, dosDate, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, data.length, true);
    localView.setUint32(22, data.length, true);
    localView.setUint16(26, name.length, true);
    local.set(name, 30);
    chunks.push(local, data);

    const directory = new Uint8Array(46 + name.length);
    const directoryView = new DataView(directory.buffer);
    directoryView.setUint32(0, 0x02014b50, true);
    directoryView.setUint16(4, 20, true);
    directoryView.setUint16(6, 20, true);
    directoryView.setUint16(8, 0x0800, true);
    directoryView.setUint16(10, 0, true);
    directoryView.setUint16(12, dosTime, true);
    directoryView.setUint16(14, dosDate, true);
    directoryView.setUint32(16, checksum, true);
    directoryView.setUint32(20, data.length, true);
    directoryView.setUint32(24, data.length, true);
    directoryView.setUint16(28, name.length, true);
    directoryView.setUint32(42, offset, true);
    directory.set(name, 46);
    centralDirectory.push(directory);
    offset += local.length + data.length;
  }
  const directorySize = centralDirectory.reduce((total, item) => total + item.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, directorySize, true);
  endView.setUint32(16, offset, true);
  const parts = [...chunks, ...centralDirectory, end];
  const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let cursor = 0;
  for (const part of parts) {
    output.set(part, cursor);
    cursor += part.length;
  }
  return output;
}

function showModal(content) {
  document.getElementById('modal-root').innerHTML = `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true">${content}</section></div>`;
  document.querySelector('.modal-backdrop').addEventListener('click', event => { if (event.target.classList.contains('modal-backdrop')) closeModal(); });
  document.querySelectorAll('#modal-root input[name$="_date"]').forEach(input => input.addEventListener('input', () => input.setCustomValidity('')));
}
function closeModal() { document.getElementById('modal-root').innerHTML = ''; }
function getObligation(id) { return state.obligations.find(row => row.id === id); }

function toast(message, error = false) {
  const region = document.getElementById('toast-region');
  const item = document.createElement('div');
  item.className = `toast${error ? ' error' : ''}`;
  item.textContent = message;
  region.appendChild(item);
  setTimeout(() => item.remove(), 4000);
}

function dueState(row) {
  if (row.remaining <= 0) return { kind: 'normal', label: 'Lunas' };
  if (!row.due_date) return { kind: 'normal', label: 'Belum jatuh tempo' };
  const due = new Date(`${row.due_date}T00:00:00`);
  const current = new Date(`${today}T00:00:00`);
  const days = Math.round((due - current) / 86400000);
  if (days < 0) return { kind: 'late', label: `Lewat ${Math.abs(days)} hari` };
  if (days === 0) return { kind: 'today', label: 'Jatuh tempo hari ini' };
  if (days <= 7) return { kind: 'soon', label: `Jatuh tempo ${days} hari lagi` };
  return { kind: 'normal', label: 'Belum jatuh tempo' };
}

function statusBadge(row) {
  if (row.payment_status === 'paid') return '<span class="badge badge-paid">Dibayar</span>';
  if (row.payment_status === 'partial') return '<span class="badge badge-partial">Dibayar sebagian</span>';
  if (row.obligation_type === 'reimbursement' && row.status === 'submitted') return '<span class="badge badge-submitted">Diajukan</span>';
  if (row.obligation_type === 'reimbursement' && row.status === 'approved') return '<span class="badge badge-approved">Disetujui</span>';
  const due = dueState(row);
  if (due.kind === 'late') return '<span class="badge badge-overdue">Lewat jatuh tempo</span>';
  if (due.kind === 'today') return '<span class="badge badge-due-today">Jatuh tempo hari ini</span>';
  if (due.kind === 'soon') return '<span class="badge badge-due-soon">Mendekati jatuh tempo</span>';
  return '<span class="badge badge-unpaid">Belum dibayar</span>';
}

function readableStatus(row) {
  if (row.payment_status === 'paid') return 'Dibayar';
  if (row.payment_status === 'partial') return 'Dibayar sebagian';
  if (row.obligation_type === 'reimbursement' && row.status === 'submitted') return 'Diajukan';
  if (row.obligation_type === 'reimbursement' && row.status === 'approved') return 'Disetujui';
  return dueState(row).kind === 'late' ? 'Lewat jatuh tempo' : 'Belum dibayar';
}
function summaryCard(title, value, note, icon, color) { return `<article class="summary-card"><div class="summary-top"><span>${title}</span><span class="summary-icon icon-${color}">${icon}</span></div><div class="summary-value">${value}</div><div class="summary-note">${note}</div></article>`; }
function detailItem(label, value) { return `<div class="detail-item"><small>${label}</small><strong>${value}</strong></div>`; }
function typeLabel(type) { return type === 'debt' ? 'Utang usaha' : 'Reimbursement'; }
function sum(rows, getValue) { return rows.reduce((total, row) => total + Number(getValue(row) || 0), 0); }
function percentage(value, total) { return total > 0 ? Number((value / total * 100).toFixed(1)) : 0; }
function money(value) { return moneyFormatter.format(Number(value) || 0); }
function formatDate(value) { if (!value) return '—'; const date = new Date(`${value}T00:00:00`); return Number.isNaN(date.getTime()) ? '—' : dateFormatter.format(date); }
function localDate() { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
function dateInput(name, label, value) {
  const formattedValue = value ? `${value.slice(8, 10)}/${value.slice(5, 7)}/${value.slice(0, 4)}` : '';
  return `<label>${label} <span class="required">*</span><input class="field-control" type="text" name="${name}" inputmode="numeric" autocomplete="off" maxlength="10" pattern="[0-9]{2}/[0-9]{2}/[0-9]{4}" placeholder="dd/mm/yyyy" title="Gunakan format dd/mm/yyyy" aria-description="Format tanggal: dd/mm/yyyy" required value="${escapeAttribute(formattedValue)}"><small class="date-format-hint">Format: dd/mm/yyyy</small></label>`;
}
function parseDateInput(value) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (!match) return null;
  const [, dayText, monthText, yearText] = match;
  const day = Number(dayText);
  const month = Number(monthText);
  const year = Number(yearText);
  if (year < 1 || month < 1 || month > 12) return null;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > daysInMonth[month - 1]) return null;
  return `${yearText}-${monthText}-${dayText}`;
}
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character])); }
function escapeAttribute(value) { return escapeHtml(value); }
