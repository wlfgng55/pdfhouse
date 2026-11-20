
// PDF Stüdyo - Target size image compression worker
// All PDF processing stays inside the browser.
// Uses Apache-2.0 @lipoe/browser-qpdf 0.3.1.

import {
  createQpdfImageStreams
} from "https://cdn.jsdelivr.net/npm/@lipoe/browser-qpdf@0.3.1/dist/index.js";

const CDN_BASE =
  "https://cdn.jsdelivr.net/npm/@lipoe/browser-qpdf@0.3.1/dist/";

let enginePromise = null;

function progress(percent, message) {
  self.postMessage({
    progress: percent,
    message
  });
}

async function getEngine() {
  if (!enginePromise) {
    enginePromise = createQpdfImageStreams({
      locateFile: filename =>
        new URL(filename, CDN_BASE).href
    });
  }

  return enginePromise;
}

function isSafeJpeg(info) {
  const masks = info.masks || {};

  // Only handle ordinary RGB JPEG images.
  // Masks, transparency and special color spaces are
  // deliberately left untouched.

  if (info.bitsPerComponent !== 8) return false;
  if (info.colorSpaceInfo?.family !== "DeviceRGB") return false;

  if (
    !info.filters ||
    info.filters.length !== 1 ||
    info.filters[0] !== "DCTDecode"
  ) return false;

  if (info.decode !== null) return false;

  if (
    masks.isStencilMask ||
    masks.softMaskInData ||
    masks.softMask ||
    masks.mask ||
    masks.softMaskOf?.length ||
    masks.maskOf?.length
  ) return false;

  return true;
}

async function compressAttempt(
  engine,
  originalBytes,
  quality,
  scale
) {
  const loaded = engine.loadPdf(originalBytes.slice());

  if (!loaded.ok) {
    throw new Error(loaded.error);
  }

  const doc = loaded.value;

  try {
    const listed = doc.getImages({ recursive: true });

    if (!listed.ok) {
      throw new Error(listed.error);
    }

    let changedImages = 0;

    if (typeof OffscreenCanvas === "undefined") {
      throw new Error(
        "Tarayıcın OffscreenCanvas desteklemiyor."
      );
    }

    for (const info of listed.value) {
      if (!isSafeJpeg(info)) continue;

      const read = doc.readImage(
        info.objId,
        info.generation
      );

      if (!read.ok || read.value.encoding.kind !== "jpeg") {
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

      const canvas = new OffscreenCanvas(width, height);
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

      // Do not replace an image if it did not become smaller.
      if (jpegBytes.length >= read.value.data.length) {
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

self.onmessage = async ({ data }) => {
  try {
    const originalBytes = new Uint8Array(data.bytes);
    const targetBytes = Number(data.targetBytes);

    if (!Number.isFinite(targetBytes) || targetBytes <= 0) {
      throw new Error("Geçersiz hedef dosya boyutu.");
    }

    // If the original already meets the requested limit,
    // do not modify it.
    if (originalBytes.length <= targetBytes) {
      const copy = originalBytes.slice();

      self.postMessage({
        bytes: copy.buffer,
        alreadyUnderTarget: true,
        targetReached: true,
        changedImages: 0
      }, [copy.buffer]);

      return;
    }

    progress(12, "Görseller analiz ediliyor…");

    const engine = await getEngine();

    // Each attempt starts from the ORIGINAL PDF.
    // This prevents cumulative quality loss.
    const ratio = targetBytes / originalBytes.length;

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

    let best = null;
    let bestUnderTarget = null;

    for (let i = 0; i < attempts.length; i++) {
      const setting = attempts[i];

      progress(
        20 + Math.round((i / attempts.length) * 65),
        `Görsel kalitesi ayarlanıyor… (${i + 1}/${attempts.length})`
      );

      const candidate = await compressAttempt(
        engine,
        originalBytes,
        setting.quality,
        setting.scale
      );

      const size = candidate.bytes.length;

      if (!best || size < best.bytes.length) {
        best = candidate;
      }

      // Keep the largest result that satisfies the target.
      if (
        size <= targetBytes &&
        (!bestUnderTarget || size > bestUnderTarget.bytes.length)
      ) {
        bestUnderTarget = candidate;
      }

      // Close enough to the target.
      if (size <= targetBytes && size >= targetBytes * 0.95) {
        break;
      }
    }

    const finalResult = bestUnderTarget || best;

    if (!finalResult) {
      throw new Error("Sıkıştırma sonucu oluşturulamadı.");
    }

    const transferable = finalResult.bytes.slice();

    self.postMessage({
      bytes: transferable.buffer,
      targetReached: transferable.length <= targetBytes,
      changedImages: finalResult.changedImages,
      targetBytes,
      attempts: attempts.length
    }, [transferable.buffer]);

  } catch (error) {
    self.postMessage({
      error: error?.message || String(error)
    });
  }
};
