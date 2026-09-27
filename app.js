const path = require('path');
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

let config = {};
try {
	config = require('./config');
} catch (_error) {
}

const app = express();
const port = process.env.PORT || 3000;
// Isi dua nilai ini dengan Project URL dan publishable key dari Supabase.
const SUPABASE_URL_INPUT = 'https://puxjqiivpfkcbarbidbn.supabase.co';
const SUPABASE_PUBLISHABLE_KEY_INPUT = 'sb_publishable_tlrfPu7aZQe71s8N99Tixg_N1xPI-LW';

const supabaseUrl = process.env.SUPABASE_URL || config.supabaseUrl || SUPABASE_URL_INPUT;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || config.supabaseKey || SUPABASE_PUBLISHABLE_KEY_INPUT;
const placeholderSupabase = supabaseUrl.includes('abcxyz.supabase.co') || supabaseKey.includes('xxxxxxxxx');
const supabaseReady = Boolean(supabaseUrl && supabaseKey) && !placeholderSupabase;
const supabase = supabaseReady ? createClient(supabaseUrl, supabaseKey) : null;

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'frontend')));

app.get('/api/health', async (_req, res) => {
	if (!supabaseReady) return res.status(503).json({ connected: false, error: 'Konfigurasi Supabase belum diisi.' });
	const { error } = await supabase.from('suppliers').select('id').limit(1);
	if (error?.code === 'PGRST205') return res.status(503).json({ connected: true, schemaReady: false, error: 'Supabase terhubung, tetapi tabel belum dibuat. Jalankan backend/database.sql di Supabase SQL Editor.' });
	if (error) return databaseError(res, error);
	res.json({ connected: true, schemaReady: true, message: 'Backend terhubung ke Supabase.' });
});

function requireDatabase(res) {
	if (supabaseReady) return true;
	res.status(503).json({ error: 'SUPABASE_URL dan SUPABASE_PUBLISHABLE_KEY belum diatur atau masih menggunakan nilai placeholder.' });
	return false;
}

function databaseError(res, error) {
	console.error(error);
	return res.status(500).json({ error: error.message || 'Operasi database gagal.' });
}

function validateText(value, label) {
	if (!value || !value.trim()) return `${label} wajib diisi.`;
	return null;
}

function validateAmount(value, label = 'Nominal') {
	const amount = Number(value);
	return Number.isFinite(amount) && amount > 0 ? null : `${label} harus lebih besar dari nol.`;
}

app.get('/api/suppliers', async (_req, res) => {
	if (!requireDatabase(res)) return;
	const { data, error } = await supabase.from('suppliers').select('id, name, contact').order('name');
	if (error) return databaseError(res, error);
	res.json(data);
});

app.post('/api/suppliers', async (req, res) => {
	if (!requireDatabase(res)) return;
	const { name, contact } = req.body;
	const textError = validateText(name, 'Nama supplier');
	if (textError) return res.status(400).json({ error: textError });
	const { data, error } = await supabase.from('suppliers').insert({ name: name.trim(), contact: contact?.trim() || null }).select().single();
	if (error) return error.code === '23505' ? res.status(409).json({ error: 'Supplier tersebut sudah terdaftar.' }) : databaseError(res, error);
	res.status(201).json(data);
});

app.get('/api/debts', async (req, res) => {
	if (!requireDatabase(res)) return;
	const { data: debts, error } = await supabase.from('debts').select('id, supplier_id, transaction_date, amount, paid_amount, due_date, payment_date, payment_method, note, supplier:suppliers(id, name)').order('due_date');
	if (error) return databaseError(res, error);
	const data = req.query.status === 'open' ? debts.filter((debt) => Number(debt.paid_amount || 0) < Number(debt.amount)) : debts;
	res.json(data);
});

app.post('/api/debts', async (req, res) => {
	if (!requireDatabase(res)) return;
	const { supplier_id, supplier_name, transaction_date, amount, due_date, note } = req.body;
	const textError = validateText(supplier_name, 'Nama supplier');
	const amountError = validateAmount(amount, 'Nominal utang');
	if (textError || amountError || !transaction_date || !due_date) return res.status(400).json({ error: textError || amountError || 'Tanggal transaksi dan jatuh tempo wajib diisi.' });
	let supplierId = supplier_id;
	if (!supplierId) {
		const { data: supplier, error: supplierError } = await supabase.from('suppliers').upsert({ name: supplier_name.trim() }, { onConflict: 'name' }).select('id').single();
		if (supplierError) return databaseError(res, supplierError);
		supplierId = supplier.id;
	}
	const { data, error } = await supabase.from('debts').insert({ supplier_id: supplierId, transaction_date, amount: Number(amount), due_date, note: note?.trim() || null }).select().single();
	if (error) return databaseError(res, error);
	res.status(201).json(data);
});

app.patch('/api/debts/:id', async (req, res) => {
	if (!requireDatabase(res)) return;
	const allowed = ['supplier_id', 'transaction_date', 'amount', 'due_date', 'note'];
	const update = Object.fromEntries(Object.entries(req.body).filter(([key]) => allowed.includes(key)));
	if (req.body.supplier_name?.trim()) {
		const { data: supplier, error: supplierError } = await supabase.from('suppliers').upsert({ name: req.body.supplier_name.trim() }, { onConflict: 'name' }).select('id').single();
		if (supplierError) return databaseError(res, supplierError);
		update.supplier_id = supplier.id;
	}
	if (update.amount !== undefined) update.amount = Number(update.amount);
	const { data, error } = await supabase.from('debts').update(update).eq('id', req.params.id).select().single();
	if (error) return databaseError(res, error);
	res.json(data);
});

app.post('/api/debts/:id/payments', async (req, res) => {
	if (!requireDatabase(res)) return;
	const { amount, payment_date, payment_method, note } = req.body;
	const amountError = validateAmount(amount, 'Nominal pembayaran');
	if (amountError || !payment_date || !payment_method) return res.status(400).json({ error: amountError || 'Tanggal dan metode pembayaran wajib diisi.' });
	const { data: debt, error: findError } = await supabase.from('debts').select('amount, paid_amount').eq('id', req.params.id).single();
	if (findError) return databaseError(res, findError);
	const paidAmount = Number(debt.paid_amount || 0) + Number(amount);
	if (paidAmount > Number(debt.amount)) return res.status(400).json({ error: 'Pembayaran melebihi sisa utang.' });
	const { data, error } = await supabase.from('debts').update({ paid_amount: paidAmount, payment_date, payment_method, note: note?.trim() || null }).eq('id', req.params.id).select().single();
	if (error) return databaseError(res, error);
	res.json(data);
});

app.delete('/api/debts/:id', async (req, res) => {
	if (!requireDatabase(res)) return;
	const { error } = await supabase.from('debts').delete().eq('id', req.params.id);
	if (error) return databaseError(res, error);
	res.status(204).end();
});

app.get('/api/reimbursements', async (req, res) => {
	if (!requireDatabase(res)) return;
	let query = supabase.from('reimbursements').select('*').order('expense_date', { ascending: false });
	if (req.query.status) query = query.eq('status', req.query.status);
	const { data, error } = await query;
	if (error) return databaseError(res, error);
	res.json(data);
});

app.post('/api/reimbursements', async (req, res) => {
	if (!requireDatabase(res)) return;
	const { employee_name, expense_date, category, amount, note } = req.body;
	const textError = validateText(employee_name, 'Nama karyawan') || validateText(category, 'Kategori');
	const amountError = validateAmount(amount, 'Nominal reimbursement');
	if (textError || amountError || !expense_date) return res.status(400).json({ error: textError || amountError || 'Tanggal pengeluaran wajib diisi.' });
	const { data, error } = await supabase.from('reimbursements').insert({ employee_name: employee_name.trim(), expense_date, category: category.trim(), amount: Number(amount), note: note?.trim() || null }).select().single();
	if (error) return databaseError(res, error);
	res.status(201).json(data);
});

app.patch('/api/reimbursements/:id', async (req, res) => {
	if (!requireDatabase(res)) return;
	const allowed = ['employee_name', 'expense_date', 'category', 'amount', 'note', 'status'];
	const update = Object.fromEntries(Object.entries(req.body).filter(([key]) => allowed.includes(key)));
	if (update.amount !== undefined) update.amount = Number(update.amount);
	const { data, error } = await supabase.from('reimbursements').update(update).eq('id', req.params.id).select().single();
	if (error) return databaseError(res, error);
	res.json(data);
});

app.post('/api/reimbursements/:id/payments', async (req, res) => {
	if (!requireDatabase(res)) return;
	const { amount, payment_date, payment_method, note } = req.body;
	const amountError = validateAmount(amount, 'Nominal pembayaran');
	if (amountError || !payment_date || !payment_method) return res.status(400).json({ error: amountError || 'Tanggal dan metode pembayaran wajib diisi.' });
	const { data: reimbursement, error: findError } = await supabase.from('reimbursements').select('amount, paid_amount').eq('id', req.params.id).single();
	if (findError) return databaseError(res, findError);
	const paidAmount = Number(reimbursement.paid_amount || 0) + Number(amount);
	if (paidAmount > Number(reimbursement.amount)) return res.status(400).json({ error: 'Pembayaran melebihi sisa reimbursement.' });
	const { data, error } = await supabase.from('reimbursements').update({ paid_amount: paidAmount, payment_date, payment_method, note: note?.trim() || null, status: paidAmount >= Number(reimbursement.amount) ? 'Dibayar' : 'Disetujui' }).eq('id', req.params.id).select().single();
	if (error) return databaseError(res, error);
	res.json(data);
});

app.delete('/api/reimbursements/:id', async (req, res) => {
	if (!requireDatabase(res)) return;
	const { error } = await supabase.from('reimbursements').delete().eq('id', req.params.id);
	if (error) return databaseError(res, error);
	res.status(204).end();
});

app.get('/api/dashboard', async (_req, res) => {
	if (!requireDatabase(res)) return;
	const [debts, reimbursements] = await Promise.all([
		supabase.from('debts').select('id, amount, paid_amount, due_date, transaction_date, note, supplier:suppliers(name)').order('due_date'),
		supabase.from('reimbursements').select('id, employee_name, amount, paid_amount, status, expense_date, category, note').order('expense_date', { ascending: false })
	]);
	if (debts.error) return databaseError(res, debts.error);
	if (reimbursements.error) return databaseError(res, reimbursements.error);
	const debtTotal = debts.data.reduce((sum, item) => sum + Number(item.amount), 0);
	const reimbursementTotal = reimbursements.data.reduce((sum, item) => sum + Number(item.amount), 0);
	const paid = [...debts.data, ...reimbursements.data].reduce((sum, item) => sum + Number(item.paid_amount || 0), 0);
	res.json({ summary: { debtTotal, reimbursementTotal, unpaid: debtTotal + reimbursementTotal - paid, paid }, debts: debts.data, reimbursements: reimbursements.data });
});

app.get('/api/reports', async (req, res) => {
	if (!requireDatabase(res)) return;
	const from = req.query.from || '1900-01-01';
	const to = req.query.to || '2999-12-31';
	const [debts, reimbursements] = await Promise.all([
		supabase.from('debts').select('*').gte('transaction_date', from).lte('transaction_date', to),
		supabase.from('reimbursements').select('*').gte('expense_date', from).lte('expense_date', to)
	]);
	if (debts.error) return databaseError(res, debts.error);
	if (reimbursements.error) return databaseError(res, reimbursements.error);
	res.json({ debts: debts.data, reimbursements: reimbursements.data });
});

app.get(/.*/, (_req, res) => res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html')));
app.listen(port, () => console.log(`Sakura Event berjalan di http://localhost:${port}`));