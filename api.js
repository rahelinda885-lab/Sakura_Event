const SUPABASE_URL = 'https://puxjqiivpfkcbarbidbn.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_tlrfPu7aZQe71s8N99Tixg_N1xPI-LW';
const supabaseClient = window.supabase?.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY) || null;
window.sakuraSupabaseClient = supabaseClient;

const modalObserver = new MutationObserver(() => {
	const form = document.querySelector('#form');
	if (form && window.sakuraEditContext) {
		form.dataset.recordId = window.sakuraEditContext.id;
		form.dataset.recordType = window.sakuraEditContext.type;
	}
});
modalObserver.observe(document.getElementById('modal'), { childList: true, subtree: true });

function exportDebtExcel() {
	if (!window.XLSX) {
		toast('Library Excel belum termuat. Periksa koneksi internet lalu coba lagi.');
		return;
	}

	const debts = [...data.debts].sort((a, b) => (a.due || '').localeCompare(b.due || ''));
	const totalDebt = debts.reduce((total, item) => total + Number(item.amount || 0), 0);
	const totalPaid = debts.reduce((total, item) => total + Number(item.paid || 0), 0);
	const totalRemaining = debts.reduce((total, item) => total + Math.max(0, Number(item.amount || 0) - Number(item.paid || 0)), 0);
	const rows = [
		['SAKURA EVENT'],
		['LAPORAN UTANG USAHA'],
		['Tanggal ekspor', new Date()],
		[],
		['RINGKASAN'],
		['Jumlah transaksi', debts.length],
		['Total utang', totalDebt],
		['Total dibayar', totalPaid],
		['Sisa utang', totalRemaining],
		[],
		['No.', 'Supplier / Vendor', 'Tanggal transaksi', 'Jatuh tempo', 'Nominal utang', 'Total dibayar', 'Sisa utang', 'Status', 'Keterangan'],
		...debts.map((item, index) => {
			const remaining = Math.max(0, Number(item.amount || 0) - Number(item.paid || 0));
			const days = Math.ceil((new Date(`${item.due}T00:00:00`) - new Date(new Date().toDateString())) / 86400000);
			const dueStatus = remaining === 0 ? 'Lunas' : days < 0 ? `Terlambat ${Math.abs(days)} hari` : days === 0 ? 'Jatuh tempo hari ini' : days <= 7 ? 'Mendekati jatuh tempo' : 'Belum jatuh tempo';
			return [index + 1, item.supplier, item.date, item.due, Number(item.amount || 0), Number(item.paid || 0), remaining, remaining === 0 ? 'Lunas' : 'Belum Dibayar', `${dueStatus}${item.note ? ` | ${item.note}` : ''}`];
		})
	];
	const worksheet = XLSX.utils.aoa_to_sheet(rows);
	worksheet['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 8 } }, { s: { r: 1, c: 0 }, e: { r: 1, c: 8 } }];
	worksheet['!cols'] = [{ wch: 6 }, { wch: 30 }, { wch: 19 }, { wch: 19 }, { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 23 }, { wch: 48 }];
	worksheet['!autofilter'] = { ref: `A11:I${Math.max(11, rows.length)}` };
	worksheet['!freeze'] = { xSplit: 0, ySplit: 11, topLeftCell: 'A12', activePane: 'bottomLeft', state: 'frozen' };
	for (const address of ['B3', 'E7', 'E8', 'E9']) {
		if (worksheet[address]) worksheet[address].z = address === 'B3' ? 'dd mmmm yyyy hh:mm' : '#,##0';
	}
	for (let row = 11; row < rows.length; row += 1) {
		for (const column of ['E', 'F', 'G']) {
			const cell = worksheet[`${column}${row + 1}`];
			if (cell) cell.z = '"Rp" #,##0';
		}
	}
	const workbook = XLSX.utils.book_new();
	XLSX.utils.book_append_sheet(workbook, worksheet, 'Laporan Utang');
	XLSX.writeFile(workbook, `Laporan-Utang-Sakura-Event-${new Date().toISOString().slice(0, 10)}.xlsx`);
	toast('Laporan utang berhasil diekspor ke Excel.');
}

async function apiRequest(url, options = {}) {
	if (supabaseClient) return supabaseRequest(url, options);

	const response = await fetch(url, {
		...options,
		headers: { 'Content-Type': 'application/json', ...options.headers },
		body: options.body ? JSON.stringify(options.body) : undefined
	});
	const payload = response.status === 204 ? null : await response.json().catch(() => null);
	if (!response.ok) throw new Error(payload?.error || `Request gagal (${response.status}).`);
	return payload;
}

async function supabaseRequest(url, options = {}) {
	const method = options.method || 'GET';
	const body = options.body || {};
	const path = new URL(url, window.location.href).pathname.replace(/^.*\/api\//, '');
	const debtMatch = path.match(/^debts\/([^/]+)(?:\/(payments))?$/);
	const reimburseMatch = path.match(/^reimbursements\/([^/]+)(?:\/(payments))?$/);

	if (path === 'dashboard' && method === 'GET') {
		const [debtsResult, reimbursementsResult] = await Promise.all([
			supabaseClient.from('debts').select('id, supplier_id, transaction_date, amount, paid_amount, due_date, payment_date, payment_method, note, supplier:suppliers(id, name)').order('due_date'),
			supabaseClient.from('reimbursements').select('*').order('expense_date', { ascending: false })
		]);
		if (debtsResult.error) throw new Error(debtsResult.error.message);
		if (reimbursementsResult.error) throw new Error(reimbursementsResult.error.message);
		return { debts: debtsResult.data, reimbursements: reimbursementsResult.data };
	}

	if (path === 'debts' && method === 'POST') {
		const supplierResult = await supabaseClient.from('suppliers').upsert({ name: body.supplier_name.trim() }, { onConflict: 'name' }).select('id').single();
		if (supplierResult.error) throw new Error(supplierResult.error.message);
		const result = await supabaseClient.from('debts').insert({ supplier_id: supplierResult.data.id, transaction_date: body.transaction_date, due_date: body.due_date, amount: Number(body.amount), note: body.note?.trim() || null }).select().single();
		if (result.error) throw new Error(result.error.message);
		return result.data;
	}

	if (debtMatch) {
		const id = debtMatch[1];
		if (method === 'DELETE') {
			const result = await supabaseClient.from('debts').delete().eq('id', id);
			if (result.error) throw new Error(result.error.message);
			return null;
		}
		if (method === 'PATCH') {
			const update = { ...body };
			if (update.supplier_name) {
				const supplierResult = await supabaseClient.from('suppliers').upsert({ name: update.supplier_name.trim() }, { onConflict: 'name' }).select('id').single();
				if (supplierResult.error) throw new Error(supplierResult.error.message);
				update.supplier_id = supplierResult.data.id;
				delete update.supplier_name;
			}
			if (update.amount !== undefined) update.amount = Number(update.amount);
			const result = await supabaseClient.from('debts').update(update).eq('id', id).select().single();
			if (result.error) throw new Error(result.error.message);
			return result.data;
		}
		if (debtMatch[2] === 'payments' && method === 'POST') {
			const current = await supabaseClient.from('debts').select('amount, paid_amount').eq('id', id).single();
			if (current.error) throw new Error(current.error.message);
			const paidAmount = Number(current.data.paid_amount || 0) + Number(body.amount);
			if (paidAmount > Number(current.data.amount)) throw new Error('Pembayaran melebihi sisa utang.');
			const result = await supabaseClient.from('debts').update({ paid_amount: paidAmount, payment_date: body.payment_date, payment_method: body.payment_method, note: body.note?.trim() || null }).eq('id', id).select().single();
			if (result.error) throw new Error(result.error.message);
			return result.data;
		}
	}

	if (path === 'reimbursements' && method === 'POST') {
		const result = await supabaseClient.from('reimbursements').insert({ employee_name: body.employee_name.trim(), expense_date: body.expense_date, category: body.category, amount: Number(body.amount), note: body.note?.trim() || null }).select().single();
		if (result.error) throw new Error(result.error.message);
		return result.data;
	}

	if (reimburseMatch) {
		const id = reimburseMatch[1];
		if (method === 'DELETE') {
			const result = await supabaseClient.from('reimbursements').delete().eq('id', id);
			if (result.error) throw new Error(result.error.message);
			return null;
		}
		if (method === 'PATCH') {
			const result = await supabaseClient.from('reimbursements').update(body).eq('id', id).select().single();
			if (result.error) throw new Error(result.error.message);
			return result.data;
		}
		if (reimburseMatch[2] === 'payments' && method === 'POST') {
			const current = await supabaseClient.from('reimbursements').select('amount, paid_amount').eq('id', id).single();
			if (current.error) throw new Error(current.error.message);
			const paidAmount = Number(current.data.paid_amount || 0) + Number(body.amount);
			if (paidAmount > Number(current.data.amount)) throw new Error('Pembayaran melebihi sisa reimbursement.');
			const result = await supabaseClient.from('reimbursements').update({ paid_amount: paidAmount, payment_date: body.payment_date, payment_method: body.payment_method, note: body.note?.trim() || null, status: paidAmount >= Number(current.data.amount) ? 'Dibayar' : 'Disetujui' }).eq('id', id).select().single();
			if (result.error) throw new Error(result.error.message);
			return result.data;
		}
	}

	throw new Error(`Operasi Supabase tidak dikenali: ${method} ${path}`);
}

function getRecordFromMenu(button) {
	const title = document.querySelector('#modal .modal-head h2')?.textContent || '';
	const debt = data.debts.find((item) => item.supplier === title);
	const reimbursement = data.reimbursements.find((item) => item.employee === title);
	const record = debt || reimbursement;
	return record ? { record, type: debt ? 'debt' : 'reimburse' } : null;
}

async function refreshFromSupabase(message) {
	await loadSupabaseData();
	if (message) toast(message);
}

document.addEventListener('click', async (event) => {
	if (event.target.closest('#export')) {
		event.preventDefault();
		event.stopImmediatePropagation();
		exportDebtExcel();
		return;
	}

	const saveButton = event.target.closest('#save');
	if (saveButton && apiConnected) {
		event.preventDefault();
		event.stopImmediatePropagation();
		try {
			const form = document.getElementById('form');
			if (!form.reportValidity()) return;
			const values = Object.fromEntries(new FormData(form));
			const editing = Boolean(form.dataset.recordId);
			const type = form.dataset.recordType || (form.querySelector('[name="supplier"]') ? 'debt' : 'reimburse');
			const isDebt = type === 'debt';
			const url = isDebt ? '/api/debts' : '/api/reimbursements';
			const body = isDebt
				? { supplier_name: values.supplier, transaction_date: values.date, due_date: values.due, amount: Number(values.amount), note: values.note }
				: { employee_name: values.employee, expense_date: values.date, category: values.category, amount: Number(values.amount), note: values.note };
			await apiRequest(editing ? `${url}/${form.dataset.recordId}` : url, { method: editing ? 'PATCH' : 'POST', body });
			window.sakuraEditContext = null;
			document.getElementById('modal').innerHTML = '';
			await refreshFromSupabase(editing ? 'Perubahan tersimpan di Supabase.' : 'Transaksi tersimpan di Supabase.');
		} catch (error) {
			console.error(error);
			toast(error.message);
		}
		return;
	}

	const choiceButton = event.target.closest('[data-choice]');
	if (!choiceButton || !apiConnected) return;
	const choice = choiceButton.dataset.choice;
	const selected = getRecordFromMenu(choiceButton);
	if (!selected) return;
	event.preventDefault();
	event.stopImmediatePropagation();
	const { record, type } = selected;
	const baseUrl = type === 'debt' ? '/api/debts' : '/api/reimbursements';

	if (choice === 'edit') {
		window.sakuraEditContext = { id: record.id, type };
		if (type === 'debt') form('debt', record);
		else form('reimburse', record);
		return;
	}

	if (choice === 'delete') {
		if (!confirm('Hapus transaksi ini dari Supabase?')) return;
		try {
			await apiRequest(`${baseUrl}/${record.id}`, { method: 'DELETE' });
			document.getElementById('modal').innerHTML = '';
			await refreshFromSupabase('Transaksi dihapus dari Supabase.');
		} catch (error) {
			toast(error.message);
		}
		return;
	}

	if (choice === 'approve') {
		try {
			await apiRequest(`${baseUrl}/${record.id}`, { method: 'PATCH', body: { status: 'Disetujui' } });
			document.getElementById('modal').innerHTML = '';
			await refreshFromSupabase('Pengajuan disetujui di Supabase.');
		} catch (error) {
			toast(error.message);
		}
		return;
	}

	if (choice === 'pay') {
		const amount = Number(prompt('Nominal pembayaran:', Math.max(0, record.amount - record.paid)));
		if (!Number.isFinite(amount) || amount <= 0) return;
		const paymentDate = prompt('Tanggal pembayaran (YYYY-MM-DD):', new Date().toISOString().slice(0, 10));
		if (!paymentDate) return;
		const paymentMethod = prompt('Metode pembayaran:', 'Transfer bank');
		if (!paymentMethod) return;
		try {
			await apiRequest(`${baseUrl}/${record.id}/payments`, {
				method: 'POST',
				body: { amount, payment_date: paymentDate, payment_method: paymentMethod }
			});
			document.getElementById('modal').innerHTML = '';
			await refreshFromSupabase('Pembayaran tersimpan di Supabase.');
		} catch (error) {
			toast(error.message);
		}
	}
}, true);

loadSupabaseData();
document.getElementById('export').textContent = '↓ Export Excel';
