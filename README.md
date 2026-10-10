# Sakura Event — Utang Usaha & Reimbursement

Aplikasi desktop sederhana untuk mencatat utang usaha, pengajuan reimbursement karyawan, pembayaran, dan laporan. Server menggunakan Node.js bawaan tanpa dependensi npm; data disimpan di Supabase PostgreSQL.

## ERD — empat entitas

- **parties** menyimpan nama supplier atau karyawan (`party_type`).
- **expense_categories** menyimpan kategori pengeluaran reimbursement.
- **obligations** menyimpan utang maupun reimbursement dan merujuk ke satu pihak; reimbursement juga merujuk kategori.
- **payments** menyimpan pembayaran untuk satu kewajiban.

Relasi: `parties 1—N obligations`, `expense_categories 1—N obligations`, `obligations 1—N payments`.

## Menyiapkan Supabase

1. Buat project Supabase.
2. Buka **SQL Editor**, lalu jalankan seluruh isi `backend\schema.sql`.
3. `backend\schema.sql` mengaktifkan akses tanpa login untuk role `anon`. Ini membuat seluruh data dapat dibaca/diubah siapa pun yang mengetahui URL project. Gunakan konfigurasi ini hanya jika memang menginginkan akses publik.
4. Frontend langsung menggunakan Project URL dan publishable key; keduanya boleh berada di browser. Jangan pernah menaruh `service_role` key pada frontend.

## Menjalankan aplikasi

Gunakan Node.js 18 atau lebih baru (membutuhkan `fetch` bawaan). Dari PowerShell pada folder proyek:

```powershell
$env:SUPABASE_URL = "https://PROJECT-REF.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY = "SERVICE-ROLE-KEY"
node backend\app.js
```

Buka `http://localhost:3000`. Untuk menghentikan server tekan `Ctrl+C`. Port dapat diubah melalui variabel lingkungan `PORT`.

## Membuka frontend langsung

`frontend\index.html` dapat dibuka langsung di browser tanpa menjalankan server. Frontend menggunakan Project URL dan publishable key yang telah dikonfigurasi, lalu membaca dan menyimpan transaksi langsung ke Supabase melalui REST API tanpa layar login. Jalankan `backend\schema.sql` di SQL Editor agar tabel dan kebijakan RLS publik tersedia.

Untuk mode server lokal, jalankan langkah berikut. **Service role key hanya digunakan oleh server lokal dan tidak boleh dimasukkan ke frontend atau dibagikan.**

## Laporan Excel

Di menu **Laporan**, pilih periode lalu klik **Unduh Excel**. File `.xlsx` yang dihasilkan dapat dibuka di Microsoft Excel dan berisi lembar ringkasan, daftar kewajiban, serta riwayat pembayaran. Ringkasan juga mencantumkan persentase sisa utang usaha dan reimbursement terhadap nilai total masing-masing.

Struktur folder aplikasi:

```text
backend/
  app.js
  schema.sql
frontend/
  index.html
  styles.css
  script.js
```

Backend server lokal tidak memiliki autentikasi pengguna dan ditujukan hanya untuk penggunaan pada komputer/jaringan tepercaya; jangan mengeksposnya ke internet publik. Mode frontend langsung menggunakan Supabase Auth dan kebijakan RLS yang dijalankan melalui `backend\schema.sql`.
# Sakura_Event
