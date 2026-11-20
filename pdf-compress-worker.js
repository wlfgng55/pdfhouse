
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
      light: {
        quality: 0.90,
        scale: 1
      },
      balanced: {
        quality: 0.78,
        scale: 1
      },
      strong: {
        quality: 0.62,
        scale: 0.90
      }
    };

    const selected =
      settings[level] || settings.balanced;

    const warnings = [];

    // Original PDF is always a fallback.
    let bestBytes = originalBytes;
    let changedImages = 0;
    let structuralOptimized = false;

    // ----------------------------------------------
    // STAGE 1: STRUCTURAL OPTIMIZATION
    // ----------------------------------------------

    progress(8, "PDF yapısı optimize ediliyor…");

    try {
      const stage1 = await optimizeStructure(
        originalBytes,
        level
      );

      warnings.push(...stage1.warnings);

      if (stage1.bytes.length < bestBytes.length) {
        bestBytes = stage1.bytes;
        structuralOptimized = true;
      }

    } catch (error) {
      warnings.push(
        "İlk yapısal optimizasyon başarısız: " +
        (error?.message || String(error))
      );
    }

    // Use the structurally optimized result as the
    // input to image processing, even if it is not
    // smaller than the original.
    let workingBytes = bestBytes;

    // ----------------------------------------------
    // STAGE 2: IMAGE ANALYSIS
    // ----------------------------------------------

    progress(24, "PDF görselleri analiz ediliyor…");

    let analysis = null;
    let engine = null;

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
      progress(42, "JPEG görseller optimize ediliyor…");

      try {
        const imageResult = await compressImages(
          engine,
          workingBytes,
          selected.quality,
          selected.scale
        );

        if (
          imageResult.bytes.length < workingBytes.length
        ) {
          workingBytes = imageResult.bytes;
          changedImages = imageResult.changedImages;

          if (workingBytes.length < bestBytes.length) {
            bestBytes = workingBytes;
          }
        }

      } catch (error) {
        warnings.push(
          "Görsel optimizasyonu başarısız: " +
          (error?.message || String(error))
        );
      }

    } else if (
      analysis &&
      analysis.jpegCount > 0
    ) {
      warnings.push(
        "Tarayıcı görsel yeniden kodlamayı desteklemiyor."
      );
    }

    // ----------------------------------------------
    // STAGE 3: STRUCTURAL OPTIMIZATION AGAIN
    // ----------------------------------------------

    progress(
      76,
      "Son PDF yapısal olarak yeniden optimize ediliyor…"
    );

    try {
      const stage3 = await finalizeStructure(
        workingBytes,
        level
      );

      warnings.push(...stage3.warnings);

      if (stage3.bytes.length < bestBytes.length) {
        bestBytes = stage3.bytes;
      }

    } catch (error) {
      warnings.push(
        "Son yapısal optimizasyon başarısız: " +
        (error?.message || String(error))
      );
    }

    // ----------------------------------------------
    // STAGE 4: FINAL RESULT
    // ----------------------------------------------

    progress(96, "Sonuç kontrol ediliyor…");

    sendResult(bestBytes, {
      changedImages,
      structuralOptimized:
        structuralOptimized ||
        bestBytes.length < originalBytes.length,
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
