
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

self.onmessage = async ({ data }) => {
  try {
    const originalBytes = new Uint8Array(data.bytes);
    const level = data.level || "balanced";

    if (!originalBytes.length) {
      throw new Error("PDF dosyası boş.");
    }

    const settings = {
      light: { quality: 0.90, scale: 1 },
      balanced: { quality: 0.78, scale: 1 },
      strong: { quality: 0.62, scale: 0.90 }
    };

    const selected = settings[level] || settings.balanced;
    const warnings = [];

    let bestBytes = originalBytes;
    let changedImages = 0;
    let structuralOptimized = false;

    function consider(candidate) {
      if (
        candidate instanceof Uint8Array &&
        candidate.length > 0 &&
        candidate.length < bestBytes.length
      ) {
        bestBytes = candidate;
        return true;
      }
      return false;
    }

    // STAGE 1: NORMAL STRUCTURAL OPTIMIZATION

    progress(8, "PDF yapısı optimize ediliyor…");

    let workingBytes = originalBytes;

    try {
      const result = await optimizeStructure(originalBytes, level);

      workingBytes = result.bytes;
      consider(result.bytes);

      warnings.push(...(result.warnings || []));
    } catch (error) {
      warnings.push("Yapısal optimizasyon: " + (error?.message || String(error)));
    }

    // STAGE 1B: MAXIMUM DEFLATE OPTIMIZATION

    progress(20, "İleri düzey stream sıkıştırması deneniyor…");

    try {
      const result = await optimizeFlateMaximum(workingBytes);

      consider(result.bytes);

      if (result.bytes.length < workingBytes.length) {
        workingBytes = result.bytes;
      }

      if (result.warnings) warnings.push(result.warnings);
    } catch (error) {
      warnings.push("İleri düzey sıkıştırma: " + (error?.message || String(error)));
    }

    // STAGE 2: IMAGE ANALYSIS

    progress(34, "PDF görselleri analiz ediliyor…");

    let analysis = null;
    let engine = null;

    try {
      engine = await getImageEngine();
      analysis = await analyzeImages(engine, workingBytes);
    } catch (error) {
      warnings.push("Görsel analizi: " + (error?.message || String(error)));
    }

    // STAGE 2B: IMAGE OPTIMIZATION

    if (
      engine &&
      analysis &&
      analysis.jpegCount > 0 &&
      typeof OffscreenCanvas !== "undefined" &&
      typeof createImageBitmap !== "undefined"
    ) {
      progress(50, "JPEG görseller optimize ediliyor…");

      try {
        const result = await compressImages(
          engine,
          workingBytes,
          selected.quality,
          selected.scale
        );

        if (result.bytes.length < workingBytes.length) {
          workingBytes = result.bytes;
          changedImages = result.changedImages;
          consider(result.bytes);
        }
      } catch (error) {
        warnings.push("Görsel optimizasyonu: " + (error?.message || String(error)));
      }
    }

    // STAGE 3: FINAL STRUCTURAL OPTIMIZATION

    progress(76, "Son PDF yapısı optimize ediliyor…");

    try {
      const result = await finalizeStructure(workingBytes, level);

      consider(result.bytes);
      warnings.push(...(result.warnings || []));
    } catch (error) {
      warnings.push("Son yapısal optimizasyon: " + (error?.message || String(error)));
    }

    // STAGE 4: FINAL RESULT

    progress(96, "Sonuç kontrol ediliyor…");

    structuralOptimized = bestBytes.length < originalBytes.length;

    sendResult(bestBytes, {
      changedImages,
      structuralOptimized,
      imageOptimized: changedImages > 0,
      analysis,
      originalSize: originalBytes.length,
      finalSize: bestBytes.length,
      selectedLevel: level,
      warnings
    });

  } catch (error) {
    self.postMessage({
      error: error?.message || String(error)
    });
  }
};
