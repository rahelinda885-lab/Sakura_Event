# Sakura Event

Sistem informasi utang usaha dan reimbursement karyawan untuk Sakura Event Organizer.

## Struktur

- `frontend/index.html`, `style.css`, `script.js`: antarmuka web desktop.
- `frontend/api.js`: penghubung frontend ke API backend.
- `backend/app.js`: server Express dan API Supabase.
- `backend/database.sql`: ERD PostgreSQL Supabase dengan tepat 3 entitas.

## Menjalankan

Pastikan Node.js sudah terpasang, kemudian jalankan dari folder proyek:

```powershell
npm.cmd install --no-save --no-package-lock express @supabase/supabase-js
node backend/app.js
```

Buka `http://localhost:3000`. Jalankan isi `backend/database.sql` di Supabase SQL Editor jika tabel belum tersedia.

Folder `node_modules` tidak disertakan di GitHub. Dependency dapat dipasang kembali menggunakan perintah di atas; proyek ini tidak menggunakan `package.json`.

## GitHub Pages

Workflow `.github/workflows/jekyll-gh-pages.yml` yang sudah ada di repository menerbitkan isi branch `main` sebagai situs statis. Pastikan **Settings → Pages → Build and deployment** menggunakan **GitHub Actions**. Setelah workflow berhasil di tab **Actions**, situs tersedia di `https://<username>.github.io/<nama-repository>/`; `index.html` root meneruskan pengunjung ke `frontend/index.html`.

GitHub Pages hanya menjalankan frontend statis, bukan Express. Karena itu halaman Pages memakai Supabase JS dan publishable key langsung dari browser. Publishable key memang dirancang untuk frontend; keamanan data harus diatur melalui Row Level Security (RLS) di Supabase. Jangan masukkan service-role key ke file frontend.

Pastikan folder `frontend/` dan file proyek lainnya sudah diunggah ke branch `main`. GitHub tidak menerbitkan file yang hanya ada di komputer lokal. Setelah itu tunggu workflow **Deploy Jekyll with GitHub Pages** selesai di tab **Actions**.
