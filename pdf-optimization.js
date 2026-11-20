
import {
  configure,
  optimize,
  run
} from "https://cdn.jsdelivr.net/npm/@arshad-shah/qpdf-wasm@0.1.0/dist/index.js";

const QPDF_CDN =
  "https://cdn.jsdelivr.net/npm/@arshad-shah/qpdf-wasm@0.1.0/dist/";

const IMAGE_CDN =
  "https://cdn.jsdelivr.net/npm/@lipoe/browser-qpdf@0.3.1/dist/";

configure({
  wasmUrl: new URL("qpdf.wasm", QPDF_CDN)
});

let imageEnginePromise = null;

function uniqueImages(images) {
  const seen = new Set();

  return images.filter(info => {
    const key = `${info.objId}:${info.generation}`;

    if (seen.has(key)) return false;

    seen.add(key);
    return true;
  });
}

function isSafeJpeg(info) {
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

function isPdf(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 5) {
    return false;
  }

  const limit = Math.min(bytes.length - 4, 1024);

  for (let i = 0; i < limit; i++) {
    if (
      bytes[i] === 0x25 &&
      bytes[i + 1] === 0x50 &&
      bytes[i + 2] === 0x44 &&
      bytes[i + 3] === 0x46 &&
      bytes[i + 4] === 0x2D
    ) {
      return true;
    }
  }

  return false;
}
export async function getImageEngine() {
  if (!imageEnginePromise) {
    imageEnginePromise = import(
      "https://cdn.jsdelivr.net/npm/@lipoe/browser-qpdf@0.3.1/dist/index.js"
    ).then(module =>
      module.createQpdfImageStreams({
        locateFile: filename =>
          new URL(filename, IMAGE_CDN).href
      })
    );
  }

  return imageEnginePromise;
}


// --------------------------------------------------
// STAGE 1 / 3: LOSSLESS STRUCTURAL OPTIMIZATION
// --------------------------------------------------
// --------------------------------------------------
// ADVANCED FLATE OPTIMIZATION
// --------------------------------------------------

export async function optimizeFlateMaximum(bytes) {
  const result = await run(
    [
      "--compress-streams=y",
      "--decode-level=generalized",
      "--recompress-flate",
      "--compression-level=9",
      "--object-streams=generate",
      "input.pdf",
      "output.pdf"
    ],
    {
      "input.pdf": bytes
    }
  );

  // qpdf: 0 = success, 3 = success with warnings
  if (result.exitCode !== 0 && result.exitCode !== 3) {
    throw new Error(
      result.stderr || "İleri düzey PDF sıkıştırması başarısız."
    );
  }

  const output = result.files["output.pdf"];

  if (!(output instanceof Uint8Array) || !isPdf(output)) {
    throw new Error(
      "İleri düzey optimizasyon geçerli PDF üretmedi."
    );
  }

  return {
    bytes: output,
    optimized: output.length < bytes.length,
    originalSize: bytes.length,
    optimizedSize: output.length,
    warnings: result.stderr || ""
  };
}
export async function optimizeStructure(bytes, level = "balanced") {
  const options = {
    objectStreams: "generate",
    compressStreams: true,
    recompressFlate: true,
    removeUnreferenced: true,
    linearize: false
  };

  if (level === "light") {
    options.objectStreams = "preserve";
    options.recompressFlate = false;
  }

  const result = await optimize(bytes, options);
  const optimized = result.bytes;

  if (!isPdf(optimized)) {
    throw new Error("Yapısal optimizasyon geçerli bir PDF üretmedi.");
  }

  // Keep the smaller valid result.
  const useOptimized =
    optimized.length < bytes.length;

  return {
    bytes: useOptimized ? optimized : bytes,
    optimized: useOptimized,
    warnings: result.warnings || [],
    stderr: result.stderr || ""
  };
}


// --------------------------------------------------
// STAGE 2: IMAGE ANALYSIS
// --------------------------------------------------

export async function analyzeImages(engine, bytes) {
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

    const images = uniqueImages(listed.value);

    let jpegCount = 0;
    let jpegBytes = 0;
    let otherImageCount = 0;

    for (const info of images) {
      if (!isSafeJpeg(info)) {
        otherImageCount++;
        continue;
      }

      const read = doc.readImage(
        info.objId,
        info.generation
      );

      if (
        read.ok &&
        read.value.encoding.kind === "jpeg"
      ) {
        jpegCount++;
        jpegBytes += read.value.data.length;
      }
    }

    return {
      imageCount: images.length,
      jpegCount,
      jpegBytes,
      otherImageCount,
      jpegRatio: bytes.length
        ? jpegBytes / bytes.length
        : 0
    };

  } finally {
    doc.close();
  }
}


// --------------------------------------------------
// STAGE 2: SAFE JPEG RECOMPRESSION
// --------------------------------------------------

export async function compressImages(
  engine,
  sourceBytes,
  quality,
  scale
) {
  if (
    typeof OffscreenCanvas === "undefined" ||
    typeof createImageBitmap === "undefined"
  ) {
    throw new Error(
      "Tarayıcı görsel yeniden kodlama özelliklerini desteklemiyor."
    );
  }

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

    const images = uniqueImages(listed.value);
    let changedImages = 0;

    for (const info of images) {
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

      let bitmap;

      try {
        bitmap = await createImageBitmap(
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

        if (!context) continue;

        context.drawImage(
          bitmap,
          0,
          0,
          width,
          height
        );

        const blob = await canvas.convertToBlob({
          type: "image/jpeg",
          quality
        });

        const jpegBytes = new Uint8Array(
          await blob.arrayBuffer()
        );

        // Never replace an image with a larger one.
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

      } catch (error) {
        // Skip a problematic image and continue.
        continue;

      } finally {
        if (bitmap) bitmap.close();
      }
    }

    const written = doc.writePdf();

    if (!written.ok) {
      throw new Error(written.error);
    }

    if (!isPdf(written.value)) {
      throw new Error("Görsel optimizasyonu geçerli PDF üretmedi.");
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
// STAGE 3: FINAL STRUCTURAL OPTIMIZATION
// --------------------------------------------------

export async function finalizeStructure(bytes, level = "balanced") {
  return optimizeStructure(bytes, level);
}
