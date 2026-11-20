
import {
  optimizeStructure,
  optimizeFlateMaximum,
  getImageEngine,
  analyzeImages,
  compressImages,
  finalizeStructure
} from "./pdf-optimization.js";

function progress(percent, message) {
  self.postMessage({ progress: percent, message });
}

function sendResult(bytes, details = {}) {
  const transferable = bytes.slice();

  self.postMessage({
    bytes: transferable.buffer,
    ...details
  }, [transferable.buffer]);
}

function chooseBest(candidates, targetBytes) {
  const valid = candidates.filter(
    item =>
      item.bytes instanceof Uint8Array &&
      item.bytes.length > 5
  );

  if (!valid.length) {
    throw new Error("Geçerli bir PDF sonucu üretilemedi.");
  }

  const underTarget = valid.filter(
    item => item.bytes.length <= targetBytes
  );

  if (underTarget.length) {
    return underTarget.reduce((best, item) =>
      item.bytes.length > best.bytes.length ? item : best
    );
  }

  return valid.reduce((best, item) =>
    item.bytes.length < best.bytes.length ? item : best
  );
}

self.onmessage = async ({ data }) => {
  try {
    const originalBytes = new Uint8Array(data.bytes);
    const targetBytes = Number(data.targetBytes);

    if (!originalBytes.length) {
      throw new Error("PDF dosyası boş.");
    }

    if (!Number.isFinite(targetBytes) || targetBytes <= 0) {
      throw new Error("Geçersiz hedef dosya boyutu.");
    }

    if (originalBytes.length <= targetBytes) {
      sendResult(originalBytes, {
        targetReached: true,
        alreadyUnderTarget: true,
        changedImages: 0,
        structuralOptimized: false,
        imageOptimized: false,
        analysis: null,
        originalSize: originalBytes.length,
        finalSize: originalBytes.length,
        targetBytes,
        selectedMethod: "original",
        warnings: []
      });

      return;
    }

    const warnings = [];

    const candidates = [{
      bytes: originalBytes,
      changedImages: 0,
      source: "original"
    }];

    // ----------------------------------------------
    // STAGE 1: NORMAL STRUCTURAL OPTIMIZATION
    // ----------------------------------------------

    progress(5, "PDF yapısı optimize ediliyor…");

    let structuralBytes = originalBytes;
    let stage1Optimized = false;

    try {
      const stage1 = await optimizeStructure(
        originalBytes,
        "balanced"
      );

      structuralBytes = stage1.bytes;
      stage1Optimized = stage1.optimized;

      candidates.push({
        bytes: structuralBytes,
        changedImages: 0,
        source: "structural"
      });

      warnings.push(...(stage1.warnings || []));

    } catch (error) {
      warnings.push(
        "Yapısal optimizasyon başarısız: " +
        (error?.message || String(error))
      );
    }

    // ----------------------------------------------
    // STAGE 1B: MAXIMUM DEFLATE OPTIMIZATION
    // ----------------------------------------------

    progress(14, "İleri düzey stream sıkıştırması deneniyor…");

    let workingBytes = structuralBytes;

    try {
      const advanced = await optimizeFlateMaximum(
        structuralBytes
      );

      candidates.push({
        bytes: advanced.bytes,
        changedImages: 0,
        source: "maximum-deflate"
      });

      if (advanced.bytes.length < workingBytes.length) {
        workingBytes = advanced.bytes;
      }

      if (advanced.warnings) {
        warnings.push(advanced.warnings);
      }

    } catch (error) {
      warnings.push(
        "İleri düzey Deflate optimizasyonu başarısız: " +
        (error?.message || String(error))
      );
    }

    // ----------------------------------------------
    // STAGE 2: IMAGE ANALYSIS
    // ----------------------------------------------

    progress(19, "PDF görselleri analiz ediliyor…");

    let engine = null;
    let analysis = null;

    try {
      engine = await getImageEngine();

      analysis = await analyzeImages(
        engine,
        workingBytes
      );

    } catch (error) {
      warnings.push(
        "Görsel analizi yapılamadı: " +
        (error?.message || String(error))
      );
    }

    // ----------------------------------------------
    // STAGE 2B: IMAGE OPTIMIZATION
    // ----------------------------------------------

    if (
      engine &&
      analysis &&
      analysis.jpegCount > 0 &&
      typeof OffscreenCanvas !== "undefined" &&
      typeof createImageBitmap !== "undefined"
    ) {
      const ratio = targetBytes / workingBytes.length;

      const baseScale = Math.max(
        0.35,
        Math.min(1, Math.sqrt(ratio) * 1.2)
      );

      const attempts = [
        { quality: 0.90, scale: Math.min(1, baseScale * 1.20) },
        { quality: 0.82, scale: Math.min(1, baseScale * 1.10) },
        { quality: 0.74, scale: baseScale },
        { quality: 0.66, scale: baseScale * 0.92 },
        { quality: 0.58, scale: baseScale * 0.84 },
        { quality: 0.50, scale: baseScale * 0.76 },
        { quality: 0.42, scale: baseScale * 0.68 }
      ];

      for (let i = 0; i < attempts.length; i++) {
        const setting = attempts[i];

        progress(
          22 + Math.round((i / attempts.length) * 48),
          `Görseller optimize ediliyor… (${i + 1}/${attempts.length})`
        );

        try {
          const compressed = await compressImages(
            engine,
            workingBytes,
            setting.quality,
            setting.scale
          );

          if (
            compressed.bytes.length < workingBytes.length &&
            compressed.changedImages > 0
          ) {
            candidates.push({
              bytes: compressed.bytes,
              changedImages: compressed.changedImages,
              source: "image"
            });
          }

          if (
            compressed.bytes.length <= targetBytes &&
            compressed.bytes.length >= targetBytes * 0.95
          ) {
            break;
          }

        } catch (error) {
          warnings.push(
            `Görsel denemesi ${i + 1} başarısız: ` +
            (error?.message || String(error))
          );
        }
      }

    } else if (analysis && analysis.jpegCount > 0) {
      warnings.push(
        "Tarayıcı JPEG yeniden kodlamayı desteklemiyor."
      );
    }

    // ----------------------------------------------
    // SELECT BEST PRE-FINAL CANDIDATE
    // ----------------------------------------------

    const preFinal = chooseBest(
      candidates,
      targetBytes
    );

    // ----------------------------------------------
    // STAGE 3: FINAL STRUCTURAL OPTIMIZATION
    // ----------------------------------------------

    progress(
      76,
      "En iyi PDF sonucu yeniden optimize ediliyor…"
    );

    try {
      const stage3 = await finalizeStructure(
        preFinal.bytes,
        "balanced"
      );

      if (stage3.bytes.length < preFinal.bytes.length) {
        candidates.push({
          bytes: stage3.bytes,
          changedImages: preFinal.changedImages || 0,
          source: preFinal.source + "-final-structure"
        });
      }

      warnings.push(...(stage3.warnings || []));

    } catch (error) {
      warnings.push(
        "Son yapısal optimizasyon başarısız: " +
        (error?.message || String(error))
      );
    }

    // ----------------------------------------------
    // STAGE 4: FINAL SELECTION
    // ----------------------------------------------

    progress(96, "En iyi sonuç seçiliyor…");

    const best = chooseBest(
      candidates,
      targetBytes
    );

    sendResult(best.bytes, {
      targetReached: best.bytes.length <= targetBytes,
      alreadyUnderTarget: false,
      changedImages: best.changedImages || 0,
      structuralOptimized:
        best.bytes.length < originalBytes.length,
      imageOptimized: (best.changedImages || 0) > 0,
      analysis,
      originalSize: originalBytes.length,
      finalSize: best.bytes.length,
      targetBytes,
      selectedMethod: best.source,
      warnings
    });

  } catch (error) {
    self.postMessage({
      error: error?.message || String(error)
    });
  }
};
