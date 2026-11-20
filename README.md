# PDF Stüdyo

Tarayıcıda çalışan PDF düzenleyici: yazı, imza, resim, serbest çizim, metni takip eden vurgu, sayfa ekleme ve silme.
Dosyalar sunucuya yüklenmez. Sitede derleme adımı yoktur, düz HTML + JavaScript'tir.

## Dosyalar
- `index.html`: tüm site (arayüz ve kod)
- `lisanslar.html`, `LICENSES.md`: açık kaynak lisans bilgisi
- `render.yaml`: Render için isteğe bağlı ayar dosyası
- `get-libs.sh`: kütüphaneleri kendi sunucundan sunmak istersen (isteğe bağlı)

## 1) GitHub'a yükle
Tarayıcıdan: github.com'da yeni depo (repository) aç, **Add file → Upload files** ile bu klasörün içindeki
dosyaları sürükle (klasörün kendisini değil, içindekileri) ve **Commit** et.

Komut satırından:
```
git init
git add .
git commit -m "PDF Stüdyo"
git branch -M main
git remote add origin https://github.com/KULLANICI/DEPO.git
git push -u origin main
```

## 2) Render'da yayınla (Static Site)
1. render.com → **New + → Static Site** → GitHub deposunu seç.
2. **Build Command:** boş bırak (veya `echo ok`)
3. **Publish Directory:** `.` (nokta)
4. **Create Static Site**. Birkaç dakika sonra `https://ADIN.onrender.com` adresinde yayında olur.
   Her `git push` sonrası site kendiliğinden güncellenir.

`render.yaml` dosyasını kullanmak istersen: **New + → Blueprint** ile depoyu seç.
Kendi alan adını Render panelinde **Settings → Custom Domains** bölümünden bağlarsın.

## Bilmen gerekenler
- Kütüphaneler (PDF.js, pdf-lib) ve yazı tipi şu an internetten yüklenir (cdnjs.cloudflare.com, Google Fonts).
  Site bu yüzden internet olmadan çalışmaz.
- **Kendi sunucundan sunmak** (hız ve gizlilik için, Almanya/AB ziyaretçileri için önerilir):
  1. `sh get-libs.sh` çalıştır (veya `lib/` altına üç dosyayı elle indir).
  2. `index.html` içinde üç `<script src="...">` adresini `lib/pdf.min.js`, `lib/pdf.worker.min.js`, `lib/pdf-lib.min.js` yap.
  3. Kodda `const PDFJS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/";` satırını `const PDFJS = "lib/";` yap.
  4. Google Fonts `<link>` satırlarını kaldır ya da yazı tipini kendi sunucundan sun.
- Reklam eklemeyi düşünüyorsan çerez onayı, gizlilik politikası ve (Almanya'da) künye (Impressum) gerekebilir.
- Lisanslar için `LICENSES.md` dosyasına bak.
