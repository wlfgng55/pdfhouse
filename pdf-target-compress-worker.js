
// PDF Stüdyo - Advanced target-size compression worker
// All processing happens locally in the browser.
//
// Pipeline:
// 1. Structural PDF optimization with qpdf.
// 2. Safe JPEG image recompression.
// 3. Select the best result without exceeding the requested target,
//    whenever possible.
//
// No page rasterization. Text, vector content and page layout remain PDF content.

import {
  configure,
  optimize
} from "https://cdn.jsdelivr.net/npm/@arshad-shah/qpdf-wasm@0.1.0/dist/index.js";

import {
  createQpdfImageStreams
} from "https://cdn.jsdelivr.net/npm/@lipoe/browser-qpdf@0.3.1/dist/index.js";

const QPDF_CDN_BASE =
  "https://cdn.jsdelivr.net/npm/@arshad-shah/qpdf-wasm@0.1.0/dist/";

const IMAGE_CDN_BASE =
  "https://cdn.jsdelivr.net/npm/@lipoe/browser-qpdf@0.3.1/dist/";

configure({
  wasmUrl: new URL("qpdf.wasm", QPDF_CDN_BASE)
});

let imageEnginePromise = null;

function sendProgress(percent, message) {
  self.postMessage({
    progress: percent,
    message
  });
}

function sendResult(bytes, details = {}) {
  const transferable = bytes.slice();

  self.postMessage({
    bytes: transferable.buffer,
    ...details
  }, [transferable.buffer]);
}

async function getImageEngine() {
  if (!imageEnginePromise) {
    imageEnginePromise = createQpdfImageStreams({
      locateFile: filename =>
        new URL(filename, IMAGE_CDN_BASE).href
    });
  }

  return imageEnginePromise;
}


// --------------------------------------------------
// 1. STRUCTURAL PDF OPTIMIZATION
// --------------------------------------------------

async function optimizeStructure(originalBytes) {
  sendProgress(5, "PDF yapısı optimize ediliyor…");

  const result = await optimize(originalBytes, {
    objectStreams: "generate",
    compressStreams: true,
    recompressFlate: true,
    removeUnreferenced: true,
    linearize: false
  });

  const optimizedBytes = result.bytes;

  // Never use a structurally optimized result if it is larger.
  const useOptimized =
    optimizedBytes.length <= originalBytes.length;

  return {
    bytes: useOptimized ? optimizedBytes : originalBytes,
    optimized: useOptimized &&
      optimizedBytes.length < originalBytes.length,
    warnings: result.warnings || [],
    originalSize: originalBytes.length,
    optimizedSize: optimizedBytes.length
  };
}


// --------------------------------------------------
// 2. SAFE IMAGE DETECTION
// --------------------------------------------------

function isSafeJpeg(info) {
  // Only ordinary RGB JPEG images are modified.
  // Transparency, masks and special colour spaces
  // are deliberately preserved without modification.

  if (info.bitsPerComponent !== 8) return false;

  if (info.colorSpaceInfo?.family !== "DeviceRGB") {
    return false;
  }

  if (
    !info.filters ||
    info.filters.length !== 1 ||
    info.filters[0] !== "DCTDecode"
  ) {
    return false;
  }

  if (info.decode !== null) return false;

  const masks = info.masks || {};

  if (
    masks.isStencilMask ||
    masks.softMaskInData ||
    masks.softMask ||
    masks.mask ||
    masks.softMaskOf?.length ||
    masks.maskOf?.length
  ) {
    return false;
  }

  return true;
}


async function hasOptimizableImages(engine, bytes) {
  const loaded = engine.loadPdf(bytes.slice());

  if (!loaded.ok) {
    throw new Error(loaded.error);
  }

  const doc = loaded.value;

  try {
    const listed = doc.getImages({
      recursive: true
    });

    if (!listed.ok) {
      throw new Error(listed.error);
    }

    return listed.value.some(isSafeJpeg);

  } finally {
    doc.close();
  }
}


// --------------------------------------------------
// 3. IMAGE OPTIMIZATION
// --------------------------------------------------

async function compressAttempt(
  engine,
  sourceBytes,
  quality,
  scale
) {
  const loaded = engine.loadPdf(sourceBytes.slice());

  if (!loaded.ok) {
    throw new Error(loaded.error);
  }

  const doc = loaded.value;

  try {
    const listed = doc.getImages({
      recursive: true
    });

    if (!listed.ok) {
      throw new Error(listed.error);
    }

    let changedImages = 0;

    for (const info of listed.value) {
      if (!isSafeJpeg(info)) continue;

      const read = doc.readImage(
        info.objId,
        info.generation
      );

      if (
        !read.ok ||
        read.value.encoding.kind !== "jpeg"
      ) {
        continue;
      }

      const bitmap = await createImageBitmap(
        new Blob([read.value.data], {
          type: "image/jpeg"
        })
      );

      const width = Math.max(
        1,
        Math.round(info.width * scale)
      );

      const height = Math.max(
        1,
        Math.round(info.height * scale)
      );

      const canvas = new OffscreenCanvas(
        width,
        height
      );

      const context = canvas.getContext("2d", {
        alpha: false
      });

      if (!context) {
        bitmap.close();
        continue;
      }

      context.drawImage(
        bitmap,
        0,
        0,
        width,
        height
      );

      bitmap.close();

      const blob = await canvas.convertToBlob({
        type: "image/jpeg",
        quality
      });

      const jpegBytes = new Uint8Array(
        await blob.arrayBuffer()
      );

      // Never replace an image if the new JPEG
      // is not smaller than the original image data.
      if (
        jpegBytes.length >= read.value.data.length
      ) {
        continue;
      }

      const replaced = doc.replaceImageStream(
        info.objId,
        info.generation,
        jpegBytes,
        {
          width,
          height,
          bitsPerComponent: 8,
          colorSpace: "DeviceRGB",
          filter: "DCTDecode"
        }
      );

      if (replaced.ok) {
        changedImages++;
      }
    }

    const written = doc.writePdf();

    if (!written.ok) {
      throw new Error(written.error);
    }

    return {
      bytes: written.value,
      changedImages
    };

  } finally {
    doc.close();
  }
}


// --------------------------------------------------
// 4. MAIN WORKER
// --------------------------------------------------

self.onmessage = async ({ data }) => {
  try {
    const originalBytes = new Uint8Array(data.bytes);
    const targetBytes = Number(data.targetBytes);

    if (
      !Number.isFinite(targetBytes) ||
      targetBytes <= 0
    ) {
      throw new Error(
        "Geçersiz hedef dosya boyutu."
      );
    }

    if (
      typeof OffscreenCanvas === "undefined"
    ) {
      throw new Error(
        "Tarayıcın OffscreenCanvas desteklemiyor."
      );
    }

    if (originalBytes.length === 0) {
      throw new Error("PDF dosyası boş.");
    }

    // If the original already meets the requested limit,
    // preserve it without unnecessary processing.
    if (originalBytes.length <= targetBytes) {
      sendResult(originalBytes, {
        alreadyUnderTarget: true,
        targetReached: true,
        changedImages: 0,
        structuralOptimized: false,
        imageOptimized: false,
        warnings: []
      });

      return;
    }


    // ----------------------------------------------
    // STAGE 1: STRUCTURAL OPTIMIZATION
    // ----------------------------------------------

    let structural;

    try {
      structural = await optimizeStructure(
        originalBytes
      );
    } catch (error) {
      // If qpdf optimization fails, continue with
      // the original PDF and attempt image optimization.
      structural = {
        bytes: originalBytes,
        optimized: false,
        warnings: [
          "Yapısal optimizasyon uygulanamadı: " +
          (error?.message || String(error))
        ]
      };
    }

    const workingBytes = structural.bytes;
    const warnings = [...structural.warnings];

    // Structural optimization alone reached the target.
    if (workingBytes.length <= targetBytes) {
      sendProgress(
        95,
        "Hedef boyuta yapısal optimizasyonla ulaşıldı…"
      );

      sendResult(workingBytes, {
        targetReached: true,
        alreadyUnderTarget: false,
        changedImages: 0,
        structuralOptimized: structural.optimized,
        imageOptimized: false,
        warnings
      });

      return;
    }


    // ----------------------------------------------
    // STAGE 2: IMAGE ANALYSIS
    // ----------------------------------------------

    sendProgress(
      18,
      "Görseller analiz ediliyor…"
    );

    let engine;
    let hasImages = false;

    try {
      engine = await getImageEngine();

      hasImages = await hasOptimizableImages(
        engine,
        workingBytes
      );

    } catch (error) {
      warnings.push(
        "Görsel optimizasyonu başlatılamadı: " +
        (error?.message || String(error))
      );

      sendResult(workingBytes, {
        targetReached: workingBytes.length <= targetBytes,
        alreadyUnderTarget: false,
        changedImages: 0,
        structuralOptimized: structural.optimized,
        imageOptimized: false,
        warnings
      });

      return;
    }


    // No supported JPEG images were found.
    // Return the structurally optimized PDF.
    if (!hasImages) {
      sendProgress(
        95,
        "Desteklenen JPEG görsel bulunamadı…"
      );

      sendResult(workingBytes, {
        targetReached: workingBytes.length <= targetBytes,
        alreadyUnderTarget: false,
        changedImages: 0,
        structuralOptimized: structural.optimized,
        imageOptimized: false,
        warnings
      });

      return;
    }


    // ----------------------------------------------
    // STAGE 3: IMAGE QUALITY ATTEMPTS
    // ----------------------------------------------

    const ratio =
      targetBytes / workingBytes.length;

    const baseScale = Math.max(
      0.35,
      Math.min(
        1,
        Math.sqrt(ratio) * 1.2
      )
    );

    const attempts = [
      {
        quality: 0.90,
        scale: Math.min(1, baseScale * 1.20)
      },
      {
        quality: 0.82,
        scale: Math.min(1, baseScale * 1.10)
      },
      {
        quality: 0.74,
        scale: baseScale
      },
      {
        quality: 0.66,
        scale: baseScale * 0.92
      },
      {
        quality: 0.58,
        scale: baseScale * 0.84
      },
      {
        quality: 0.50,
        scale: baseScale * 0.76
      },
      {
        quality: 0.42,
        scale: baseScale * 0.68
      }
    ];

    // The structural result is always a valid fallback.
    let best = {
      bytes: workingBytes,
      changedImages: 0
    };

    let bestUnderTarget =
      workingBytes.length <= targetBytes
        ? best
        : null;

    for (
      let i = 0;
      i < attempts.length;
      i++
    ) {
      const setting = attempts[i];

      sendProgress(
        22 + Math.round(
          (i / attempts.length) * 68
        ),
        `Görseller optimize ediliyor… (${i + 1}/${attempts.length})`
      );

      const candidate = await compressAttempt(
        engine,
        workingBytes,
        setting.quality,
        setting.scale
      );

      const size = candidate.bytes.length;

      // Keep the smallest result overall.
      if (
        size < best.bytes.length
      ) {
        best = candidate;
      }

      // Keep the largest result that meets the target.
      // This favours the best possible image quality.
      if (
        size <= targetBytes &&
        (
          !bestUnderTarget ||
          size > bestUnderTarget.bytes.length
        )
      ) {
        bestUnderTarget = candidate;
      }

      // Stop when we are within 5% of the target.
      if (
        size <= targetBytes &&
        size >= targetBytes * 0.95
      ) {
        break;
      }
    }


    // ----------------------------------------------
    // STAGE 4: FINAL RESULT
    // ----------------------------------------------

    const finalResult =
      bestUnderTarget || best;

    const finalBytes = finalResult.bytes;

    sendProgress(
      96,
      "Sonuç kontrol ediliyor…"
    );

    sendResult(finalBytes, {
      targetReached:
        finalBytes.length <= targetBytes,

      alreadyUnderTarget: false,

      changedImages:
        finalResult.changedImages,

      structuralOptimized:
        structural.optimized,

      imageOptimized:
        finalResult.changedImages > 0,

      warnings,

      targetBytes
    });

  } catch (error) {
    self.postMessage({
      error:
        error?.message ||
        String(error)
    });
  }
};
