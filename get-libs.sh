#!/bin/sh
# İsteğe bağlı: kütüphaneleri internetten (CDN) çekmek yerine kendi sitenden sunmak için.
# Çalıştırınca lib/ klasörü oluşur. Ardından README.md'deki "Kendi sunucundan sunmak" adımlarını uygula.
set -e
mkdir -p lib
BASE=https://cdnjs.cloudflare.com/ajax/libs
curl -fL "$BASE/pdf.js/3.11.174/pdf.min.js"        -o lib/pdf.min.js
curl -fL "$BASE/pdf.js/3.11.174/pdf.worker.min.js" -o lib/pdf.worker.min.js
curl -fL "$BASE/pdf-lib/1.17.1/pdf-lib.min.js"     -o lib/pdf-lib.min.js
echo "Tamam: lib/ klasörüne indirildi."
