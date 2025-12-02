# 🎵 Soundcloud Downloader CLI

**Soundcloud Downloader CLI** adalah tool command-line untuk mengunduh konten dari SoundCloud menggunakan API publik.  
Mendukung berbagai tipe konten seperti **track**, **likes**, **album**, **artist**, dan **playlist**.

---

## ⚙️ Arguments

| Argument | Deskripsi |
|---------|-----------|
| `--temp-dir` | Lokasi direktori sementara untuk file proses. |
| `--download-dir` | Lokasi direktori hasil download. |
| `--original-cover-size` | Mendownload cover art dengan ukuran asli. |
| `--disable-cache` | Menonaktifkan cache agar request selalu fresh. |
| `--thread-count` | Jumlah thread untuk proses download paralel. |

---

## 📦 Supported Types

| Type | Deskripsi |
|------|-----------|
| `track` | Mengunduh satu track berdasarkan ID. |
| `likes` | Mengunduh semua track yang di-like oleh user. |
| `album` | Mengunduh seluruh lagu dalam album. |
| `artist` | Mengunduh semua track yang dimiliki artist. |
| `playlist` | Mengunduh playlist lengkap. |

---

## 🚀 Contoh Penggunaan

```bash
node main.js <track/album/playlist/artist/likes> <uri/url>
```

## Credit
SCDownload (Rust)
🔗 https://github.com/Zeunig/SCDownload
