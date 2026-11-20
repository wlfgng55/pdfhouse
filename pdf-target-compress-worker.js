
import {
  optimizeStructure,
  getImageEngine,
  analyzeImages,
  compressImages,
  finalizeStructure
} from "./pdf-optimization.js";

function progress(percent, message) {
  self.postMessage({ progress: percent, message });
}

function result(bytes, details = {}) {
  const transferable = bytes.slice();

  self.postMessage({
    bytes: transferable.buffer,
    ...details
  }, [transferable.buffer]);
}

function chooseBest(candidates, targetBytes) {
  const valid = candidates.filter(
    item => item.bytes && item.bytes.length > 5
  );

  const underTarget = valid.filter(
    item => item.bytes.length <= targetBytes
  );

  if (underTarget.length) {
    // Keep the largest result under the target
    // to preserve as much quality as possible.
    return underTarget.reduce((best, item) =>
      item.bytes.length > best.bytes.length
        ? item
        : best
    );
  }

  // If the target is impossible, return the smallest.
  return valid.reduce((best, item) =>
    item.bytes.length < best.bytes.length
      ? item
      : best
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
      result(originalBytes, {
        targetReached: true,
        alreadyUnderTarget: true,
        changedImages: 0,
        structuralOptimized: false,
        imageOptimized: false,
        analysis: null,
        warnings: []
      });

      return;
    }

    const warnings = [];
    const candidates = [];

    // Original file is always a fallback.
    candidates.push({
      bytes: originalBytes,
      changedImages: 0,
      source: "original"
    });

    // ----------------------------------------------
    // STAGE 1: STRUCTURAL OPTIMIZATION
    // ----------------------------------------------

    progress(5, "PDF yapısı kayıpsız optimize ediliyor…");

    let stage1;

    try {
      stage1 = await optimizeStructure(
        originalBytes,
        "balanced"
      );

      warnings.push(...stage1.warnings);

    } catch (error) {
      warnings.push(
        "İlk yapısal optimizasyon başarısız: " +
        (error?.message || String(error))
      );

      stage1 = {
        bytes: originalBytes,
        optimized: false
      };
    }

    const structuralBytes = stage1.bytes;

    candidates.push({
      bytes: structuralBytes,
      changedImages: 0,
      source: "structural"
    });

    // ----------------------------------------------
    // STAGE 2: IMAGE ANALYSIS
    // ----------------------------------------------

    progress(16, "PDF görselleri analiz ediliyor…");

    let engine;
    let analysis = null;

    try {
      engine = await getImageEngine();

      analysis = await analyzeImages(
        engine,
        structuralBytes
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
      const ratio =
        targetBytes / structuralBytes.length;

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
            structuralBytes,
            setting.quality,
            setting.scale
          );

          if (
            compressed.bytes.length <
            structuralBytes.length
          ) {
            candidates.push({
              bytes: compressed.bytes,
              changedImages: compressed.changedImages,
              source: "image"
            });
          }

          // We have a result close enough to the target.
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

    } else if (
      analysis &&
      analysis.jpegCount > 0
    ) {
      warnings.push(
        "Tarayıcı JPEG yeniden kodlamayı desteklemiyor."
      );

    } else if (analysis) {
      progress(
        68,
        "Optimize edilebilir JPEG bulunamadı; yapısal sonuç korunuyor…"
      );
    }

    // ----------------------------------------------
    // SELECT BEST IMAGE / STRUCTURAL CANDIDATE
    // ----------------------------------------------

    const preFinal = chooseBest(
      candidates,
      targetBytes
    );

    // ----------------------------------------------
    // STAGE 3: STRUCTURAL OPTIMIZATION AGAIN
    // ----------------------------------------------

    progress(
      76,
      "Optimize edilmiş PDF yeniden yapılandırılıyor…"
    );

    let finalCandidate = preFinal;

    try {
      const stage3 = await finalizeStructure(
        preFinal.bytes,
        "balanced"
      );

      warnings.push(...stage3.warnings);

      // The second structural pass is accepted only
      // if it creates a smaller valid PDF.
      if (
        stage3.bytes.length < preFinal.bytes.length
      ) {
        finalCandidate = {
          bytes: stage3.bytes,
          changedImages: preFinal.changedImages,
          source: "image-plus-structure"
        };
      }

    } catch (error) {
      warnings.push(
        "Son yapısal optimizasyon uygulanamadı: " +
        (error?.message || String(error))
      );
    }

    // Compare final result against every earlier candidate.
    candidates.push(finalCandidate);

    const best = chooseBest(
      candidates,
      targetBytes
    );

    progress(96, "Sonuç kontrol ediliyor…");

    result(best.bytes, {
      targetReached: best.bytes.length <= targetBytes,
      alreadyUnderTarget: false,
      changedImages: best.changedImages || 0,
      structuralOptimized: stage1.optimized,
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
