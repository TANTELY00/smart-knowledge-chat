export type PdfExtractionProgress = {
  phase: "text" | "ocr-init" | "ocr";
  page: number;
  pageCount: number;
  image?: number;
  imagesOnPage?: number;
  progress?: number;
};

export type PdfExtractionResult = {
  text: string;
  pageCount: number;
  imageCount: number;
  imagesWithText: number;
  ocrCharacterCount: number;
};

type OcrSegment = { image: number; text: string };

type PdfImage = {
  data?: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
  kind?: number;
  bitmap?: ImageBitmap;
};

type PdfPageLike = {
  objs: { get: (id: string, callback?: (value: PdfImage) => void, errorCallback?: (reason: unknown) => void) => PdfImage | null; has: (id: string) => boolean };
  commonObjs: PdfPageLike["objs"];
  getTextContent: () => Promise<{ items: unknown[] }>;
  getOperatorList: () => Promise<{ fnArray: number[]; argsArray: unknown[][] }>;
  cleanup: () => void;
};

type OcrWorker = {
  recognize: (image: HTMLCanvasElement) => Promise<{ data: { text: string } }>;
  setParameters: (parameters: Record<string, string>) => Promise<unknown>;
  terminate: () => Promise<unknown>;
};

/** Keep native PDF text and OCR text together, with explicit image/page provenance. */
export function composePageText(pageNumber: number, nativeText: string, ocrSegments: OcrSegment[]): string {
  const sections: string[] = [];
  const cleanNativeText = nativeText.trim();
  if (cleanNativeText) sections.push(cleanNativeText);

  const readableSegments = ocrSegments.filter((segment) => segment.text.trim());
  if (readableSegments.length) {
    sections.push(
      readableSegments
        .map((segment) => `[Texte OCR de l’image ${segment.image}, page ${pageNumber}]\n${segment.text.trim()}`)
        .join("\n\n"),
    );
  }
  return sections.join("\n\n");
}

function cleanOcrText(text: string): string {
  return text
    .replace(/\r/g, "")
    .replace(/[\t ]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function getImageReferences(operatorList: { fnArray: number[]; argsArray: unknown[][] }, ops: Record<string, number>) {
  const references: { key: string | null; image?: PdfImage }[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < operatorList.fnArray.length; index += 1) {
    const operation = operatorList.fnArray[index];
    const args = operatorList.argsArray[index] ?? [];
    const isNamedImage = operation === ops["paintImageXObject"] || operation === ops["paintImageXObjectRepeat"];
    const isInlineImage = operation === ops["paintInlineImageXObject"] || operation === ops["paintInlineImageXObjectGroup"];

    if (isNamedImage && typeof args[0] === "string") {
      const key = args[0];
      if (!seen.has(key)) {
        seen.add(key);
        references.push({ key });
      }
    } else if (isInlineImage && args[0] && typeof args[0] === "object") {
      const image = args[0] as PdfImage;
      if (!seen.has(`inline-${index}`)) {
        seen.add(`inline-${index}`);
        references.push({ key: null, image });
      }
    }
  }
  return references;
}

async function resolveImage(page: PdfPageLike, key: string): Promise<PdfImage> {
  const objects = key.startsWith("g_") ? page.commonObjs : page.objs;
  if (objects.has(key)) {
    const image = objects.get(key);
    if (image) return image;
  }
  return new Promise<PdfImage>((resolve, reject) => {
    objects.get(key, resolve, reject);
  });
}

function imageDataToCanvas(image: PdfImage): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Canvas indisponible");

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);

  if (image.bitmap) {
    context.drawImage(image.bitmap, 0, 0);
    return canvas;
  }
  if (!image.data || !image.width || !image.height) throw new Error("Image PDF vide ou non décodée");
  const data = image.data;

  const rgba = new Uint8ClampedArray(image.width * image.height * 4);
  if (image.kind === 3) {
    rgba.set(data.subarray(0, rgba.length));
  } else if (image.kind === 2) {
    for (let source = 0, target = 0; target < rgba.length; source += 3, target += 4) {
      rgba[target] = data[source]!;
      rgba[target + 1] = data[source + 1]!;
      rgba[target + 2] = data[source + 2]!;
      rgba[target + 3] = 255;
    }
  } else if (image.kind === 1) {
    for (let pixel = 0, target = 0; pixel < image.width * image.height; pixel += 1, target += 4) {
      const isWhite = (data[pixel >> 3]! >> (7 - (pixel & 7))) & 1;
      const value = isWhite ? 255 : 0;
      rgba[target] = value;
      rgba[target + 1] = value;
      rgba[target + 2] = value;
      rgba[target + 3] = 255;
    }
  } else {
    throw new Error(`Format d’image PDF non pris en charge (${image.kind ?? "inconnu"})`);
  }

  const sourceCanvas = document.createElement("canvas");
  sourceCanvas.width = image.width;
  sourceCanvas.height = image.height;
  sourceCanvas.getContext("2d")?.putImageData(new ImageData(rgba, image.width, image.height), 0, 0);
  context.drawImage(sourceCanvas, 0, 0);
  sourceCanvas.width = 0;
  sourceCanvas.height = 0;
  return canvas;
}

function scaleForOcr(source: HTMLCanvasElement): HTMLCanvasElement {
  const largestSide = Math.max(source.width, source.height);
  let scale = Math.min(3, Math.max(1, 1800 / largestSide));
  scale = Math.min(scale, 4096 / source.width, 4096 / source.height);
  if (scale === 1) return source;

  const scaled = document.createElement("canvas");
  scaled.width = Math.max(1, Math.round(source.width * scale));
  scaled.height = Math.max(1, Math.round(source.height * scale));
  const context = scaled.getContext("2d");
  if (!context) throw new Error("Canvas indisponible");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, scaled.width, scaled.height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(source, 0, 0, scaled.width, scaled.height);
  source.width = 0;
  source.height = 0;
  return scaled;
}

async function createOcrWorker(onProgress: (progress: number) => void): Promise<OcrWorker> {
  const { createWorker, OEM, PSM } = await import("tesseract.js");
  const worker = await createWorker(["fra", "eng"], OEM.LSTM_ONLY, {
    workerPath: "/ocr/worker.min.js",
    corePath: "/ocr/core",
    langPath: "/ocr/lang",
    logger: (message) => {
      if (message.status === "recognizing text") onProgress(message.progress);
    },
  });
  await worker.setParameters({
    tessedit_pageseg_mode: PSM.AUTO,
    preserve_interword_spaces: "1",
  });
  return worker;
}

/** Extract native text and OCR every raster image embedded in a PDF. */
export async function extractPdfContent(
  file: File,
  onProgress: (update: PdfExtractionProgress) => void = () => {},
): Promise<PdfExtractionResult> {
  const pdfjs = await import("pdfjs-dist");
  const workerUrl = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl.default;

  const documentTask = pdfjs.getDocument({ data: await file.arrayBuffer() });
  const pdf = await documentTask.promise;
  const pages: string[] = [];
  const ocrCache = new Map<string, Promise<string>>();
  let worker: OcrWorker | null = null;
  let imageCount = 0;
  let imagesWithText = 0;
  let ocrCharacterCount = 0;

  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      onProgress({ phase: "text", page: pageNumber, pageCount: pdf.numPages });
      const page = (await pdf.getPage(pageNumber)) as unknown as PdfPageLike;
      const content = await page.getTextContent();
      const nativeText = content.items
        .map((item) => {
          if (!item || typeof item !== "object" || !("str" in item)) return "";
          const textItem = item as { str: string; hasEOL?: boolean };
          return textItem.str + (textItem.hasEOL ? "\n" : " ");
        })
        .join("");

      const operatorList = await page.getOperatorList();
      // PDF.js operator values are stable; the fallback also covers optimized browser bundles
      // that omit the OPS namespace from the dynamically imported module.
      const imageOps = {
        paintImageXObject: pdfjs.OPS?.paintImageXObject ?? 85,
        paintInlineImageXObject: pdfjs.OPS?.paintInlineImageXObject ?? 86,
        paintInlineImageXObjectGroup: pdfjs.OPS?.paintInlineImageXObjectGroup ?? 87,
        paintImageXObjectRepeat: pdfjs.OPS?.paintImageXObjectRepeat ?? 88,
      };
      const references = getImageReferences(operatorList, imageOps);
      const ocrSegments: OcrSegment[] = [];

      if (references.length && !worker) {
        onProgress({ phase: "ocr-init", page: pageNumber, pageCount: pdf.numPages });
        worker = await createOcrWorker((progress) => {
          onProgress({ phase: "ocr", page: pageNumber, pageCount: pdf.numPages, progress });
        });
      }

      for (let imageIndex = 0; imageIndex < references.length; imageIndex += 1) {
        const reference = references[imageIndex]!;
        imageCount += 1;
        onProgress({
          phase: "ocr",
          page: pageNumber,
          pageCount: pdf.numPages,
          image: imageIndex + 1,
          imagesOnPage: references.length,
          progress: 0,
        });

        const recognize = async () => {
          const image = reference.image ?? (await resolveImage(page, reference.key!));
          const canvas = scaleForOcr(imageDataToCanvas(image));
          try {
            const result = await worker!.recognize(canvas);
            return cleanOcrText(result.data.text);
          } finally {
            canvas.width = 0;
            canvas.height = 0;
          }
        };

        let textPromise: Promise<string>;
        if (reference.key) {
          const cached = ocrCache.get(reference.key);
          if (cached) {
            textPromise = cached;
          } else {
            textPromise = recognize();
            ocrCache.set(reference.key, textPromise);
          }
        } else {
          textPromise = recognize();
        }

        let text: string;
        try {
          text = await textPromise;
        } catch (error) {
          if (reference.key) ocrCache.delete(reference.key);
          throw new Error(
            `OCR impossible pour l’image ${imageIndex + 1}, page ${pageNumber} : ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        if (text) {
          ocrSegments.push({ image: imageIndex + 1, text });
          imagesWithText += 1;
          ocrCharacterCount += text.length;
        }
      }
      pages.push(composePageText(pageNumber, nativeText, ocrSegments));
      page.cleanup();
    }
  } finally {
    if (worker) await worker.terminate();
    await documentTask.destroy();
  }

  return {
    text: pages.filter(Boolean).join("\n\n"),
    pageCount: pdf.numPages,
    imageCount,
    imagesWithText,
    ocrCharacterCount,
  };
}
