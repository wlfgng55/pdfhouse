// PDF Stüdyo - qpdf WebAssembly worker
// PDF bytes are processed locally in the browser. No upload or server API is used.
import { configure, optimize } from "https://cdn.jsdelivr.net/npm/@arshad-shah/qpdf-wasm@0.1.0/dist/index.js";

const CDN_BASE = "https://cdn.jsdelivr.net/npm/@arshad-shah/qpdf-wasm@0.1.0/dist/";
configure({ wasmUrl: new URL("qpdf.wasm", CDN_BASE) });

self.onmessage = async ({ data }) => {
  try {
    const input = new Uint8Array(data.bytes);
    let options;

    switch (data.level) {
      case "light":
        options = {
          objectStreams: "preserve",
          compressStreams: true,
          recompressFlate: false,
          removeUnreferenced: true,
          linearize: false
        };
        break;
      case "strong":
        options = {
          objectStreams: "generate",
          compressStreams: true,
          recompressFlate: true,
          removeUnreferenced: true,
          linearize: false
        };
        break;
      case "balanced":
      default:
        options = {
          objectStreams: "generate",
          compressStreams: true,
          recompressFlate: false,
          removeUnreferenced: true,
          linearize: false
        };
    }

    const result = await optimize(input, options);
    const transferable = result.bytes.slice();
    self.postMessage({
      bytes: transferable.buffer,
      warnings: result.warnings || [],
      stderr: result.stderr || ""
    }, [transferable.buffer]);
  } catch (error) {
    self.postMessage({
      error: error && error.message ? error.message : String(error)
    });
  }
};
