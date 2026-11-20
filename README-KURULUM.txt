PDF STÜDYO — PDF SIKIŞTIRMA DOSYALARI

Dosyalar:
- sikistir.html
- pdf-compress-worker.js

Kurulum:
1. İki dosyayı da GitHub deposunun ana dizinine (index.html ve editor.html ile aynı yere) yükle.
2. GitHub'da Add file > Upload files seç.
3. İki dosyayı sürükleyip bırak.
4. Commit changes ile kaydet.
5. Ana sayfadaki PDF Sıkıştır kartının bağlantısı sikistir.html olmalı:
   href="sikistir.html"
6. GitHub Pages yayına aldıktan sonra sayfayı şu biçimde aç:
   https://KULLANICI.github.io/DEPO-ADI/sikistir.html

ÖNEMLİ:
- qpdf WebAssembly motoru jsDelivr CDN üzerinden yüklenir. Bu nedenle ilk kullanımda internet bağlantısı gerekir.
- PDF dosyası CDN'ye veya başka bir sunucuya gönderilmez. PDF verisi tarayıcıdaki Web Worker içinde işlenir.
- Bu sürüm sayfaları JPEG'e dönüştürmez. Metinleri/vektörleri rasterleştirmez ve görselleri yeniden boyutlandırmaz.
- Her PDF küçülmeyebilir. Çıktı orijinalden büyükse indirme düğmesi otomatik olarak orijinal dosyayı verir.
- Şifreli PDF'lerde parola gerekiyorsa bu sürüm şifre çözme/parola girişi akışı sunmaz.
- CDN sürümü sabitlenmiştir: @arshad-shah/qpdf-wasm@0.1.0
- Optimizasyon sonucu kritik belgelerde mutlaka açıp sayfa, form ve imzaları kontrol et. PDF yeniden yazıldığı için dijital imzalar geçersizleşebilir.

Klasör yapısı:
PDF-Stüdyo/
  index.html
  editor.html
  sikistir.html
  pdf-compress-worker.js
