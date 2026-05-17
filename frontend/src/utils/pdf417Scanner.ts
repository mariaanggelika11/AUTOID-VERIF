import { BarcodeFormat, BrowserCodeReader, BrowserMultiFormatReader } from '@zxing/browser';
import { ChecksumException, DecodeHintType, FormatException, NotFoundException } from '@zxing/library';

export type ScanQuality = {
  attempts: number;
  brightness: number;
  blurScore: number;
  contrastRange: number;
  message: string;
};

export type ScanResult = {
  raw: string;
  captureImage: string;
};

export type ManualCaptureError = {
  message: string;
  captureImage: string;
};

export type CapturedFrame = {
  frame: HTMLCanvasElement;
  captureImage?: string;
};

export type CaptureAttempt =
  | {
      ok: true;
      result: ScanResult;
    }
  | {
      ok: false;
      error: ManualCaptureError;
    };

type ScannerOptions = {
  video: HTMLVideoElement;
  deviceId?: string;
  onCapture?: (captureImage: string) => void;
  onResult: (result: ScanResult) => void;
  onQuality: (quality: ScanQuality) => void;
  onError: (message: string) => void;
};

type FrameMetrics = {
  brightness: number;
  blurScore: number;
  contrastRange: number;
};

type FrameVariant = {
  canvas: HTMLCanvasElement;
  captureImage?: string;
};

type ImageTransform = (source: HTMLCanvasElement) => void;
type ImageCaptureLike = {
  takePhoto?: () => Promise<Blob>;
  grabFrame?: () => Promise<ImageBitmap>;
};
type DetectedBarcodeLike = {
  rawValue?: string;
};
type BarcodeDetectorLike = {
  detect: (source: CanvasImageSource | Blob | ImageData) => Promise<DetectedBarcodeLike[]>;
};
type BarcodeDetectorCtorLike = {
  new (options?: { formats?: string[] }): BarcodeDetectorLike;
  getSupportedFormats?: () => Promise<string[]>;
};

export type ScannerSession = {
  pause: () => void;
  resume: () => void;
  stop: () => void;
  setTorch: (enabled: boolean) => Promise<void>;
  torchSupported: boolean;
};

const SCAN_INTERVAL_MS = 120;
const ROI_WIDTH_RATIO = 0.94;
const ROI_HEIGHT_RATIO = 0.76;
const CAPTURE_SCALE = 1.4;
const MAX_DECODE_FRAME_WIDTH = 1600;
const MANUAL_CAPTURE_FRAMES = 5;
const MANUAL_CAPTURE_DELAY_MS = 45;
const AUTO_METRICS_INTERVAL = 2;
const AUTO_FULL_SCAN_START_ATTEMPT = 4;
const AUTO_HEAVY_PREPROCESS_INTERVAL = 3;
const MIN_STEADY_BLUR_SCORE = 3.5;
const MAX_COMFORT_BRIGHTNESS = 240;
const MIN_FAIL_ATTEMPTS = 8;
const PREVIEW_IMAGE_TYPE = 'image/jpeg';
const PREVIEW_IMAGE_QUALITY = 0.82;
const IDEAL_MANUAL_BRIGHTNESS = 140;
const LOW_CONTRAST_RANGE = 72;
const DIRECT_DECODE_IMAGE_TYPE = 'image/png';
const AUTO_STILL_CAPTURE_INTERVAL = 10;
const BARCODE_DETECTOR_PDF417_FORMAT = 'pdf417';

let barcodeDetectorPromise: Promise<BarcodeDetectorLike | null> | null = null;

function createDecodeHints() {
  return new Map<DecodeHintType, unknown>([
    [DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.PDF_417]],
    [DecodeHintType.TRY_HARDER, true]
  ]);
}

function createPdf417Reader() {
  return new BrowserMultiFormatReader(createDecodeHints()) as BrowserMultiFormatReader & {
    timeBetweenDecodingAttempts?: number;
  };
}

async function createPdf417BarcodeDetector() {
  const BarcodeDetectorCtor = (globalThis as typeof globalThis & { BarcodeDetector?: BarcodeDetectorCtorLike }).BarcodeDetector;
  if (!BarcodeDetectorCtor) return null;

  const supportedFormats: string[] = BarcodeDetectorCtor.getSupportedFormats
    ? await BarcodeDetectorCtor.getSupportedFormats().catch(() => [] as string[])
    : [];
  if (supportedFormats && !supportedFormats.includes(BARCODE_DETECTOR_PDF417_FORMAT)) {
    return null;
  }

  try {
    return new BarcodeDetectorCtor({ formats: [BARCODE_DETECTOR_PDF417_FORMAT] });
  } catch {
    return null;
  }
}

async function getPdf417BarcodeDetector() {
  if (!barcodeDetectorPromise) {
    barcodeDetectorPromise = createPdf417BarcodeDetector();
  }

  return barcodeDetectorPromise;
}

const reader = createPdf417Reader();
reader.timeBetweenDecodingAttempts = SCAN_INTERVAL_MS;

function getCameraConstraints(deviceId?: string): MediaStreamConstraints {
  const video: MediaTrackConstraints = {
    width: { ideal: 1280 },
    height: { ideal: 720 },
    facingMode: { ideal: 'environment' }
  };

  if (deviceId) {
    video.deviceId = { exact: deviceId };
  }

  return { audio: false, video };
}

async function applyCameraControls(stream: MediaStream) {
  const [track] = stream.getVideoTracks();
  if (!track) return;

  const constraints = {
    advanced: [
      { focusMode: 'continuous' },
      { exposureMode: 'continuous' },
      { whiteBalanceMode: 'continuous' }
    ]
  } as unknown as MediaTrackConstraints;

  await track.applyConstraints(constraints).catch(() => undefined);
}

function createCanvas(width: number, height: number) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  getCanvasContext(canvas, true);
  return canvas;
}

function getCanvasContext(canvas: HTMLCanvasElement, willReadFrequently = false) {
  const context = canvas.getContext('2d', willReadFrequently ? { willReadFrequently: true } : undefined);
  if (!context) throw new Error('Canvas context is not available.');
  return context;
}

function getRoi(video: HTMLVideoElement) {
  const width = Math.round(video.videoWidth * ROI_WIDTH_RATIO);
  const height = Math.round(video.videoHeight * ROI_HEIGHT_RATIO);
  const x = Math.round((video.videoWidth - width) / 2);
  const y = Math.round((video.videoHeight - height) / 2);
  return { x, y, width, height };
}

function getRoiForSize(width: number, height: number) {
  const roiWidth = Math.round(width * ROI_WIDTH_RATIO);
  const roiHeight = Math.round(height * ROI_HEIGHT_RATIO);
  const x = Math.round((width - roiWidth) / 2);
  const y = Math.round((height - roiHeight) / 2);
  return { x, y, width: roiWidth, height: roiHeight };
}

function normalizeFrameSize(width: number, height: number, maxWidth = MAX_DECODE_FRAME_WIDTH) {
  if (width <= maxWidth) {
    return { width, height };
  }

  const scale = maxWidth / width;
  return {
    width: Math.round(width * scale),
    height: Math.round(height * scale)
  };
}

function captureDecodeFrame(source: CanvasImageSource, width: number, height: number) {
  const normalized = normalizeFrameSize(width, height);
  const canvas = createCanvas(normalized.width, normalized.height);
  const context = getCanvasContext(canvas, true);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, 0, 0, width, height, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function buildPreviewFrame(source: HTMLCanvasElement) {
  const roi = getRoiForSize(source.width, source.height);
  const canvas = createCanvas(roi.width * CAPTURE_SCALE, roi.height * CAPTURE_SCALE);
  const context = getCanvasContext(canvas, true);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, roi.x, roi.y, roi.width, roi.height, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function buildPreviewFrameFromSource(source: CanvasImageSource, width: number, height: number) {
  const roi = getRoiForSize(width, height);
  const canvas = createCanvas(roi.width, roi.height);
  const context = getCanvasContext(canvas, true);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'medium';
  context.drawImage(source, roi.x, roi.y, roi.width, roi.height, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function createCapturedFrame(source: CanvasImageSource, width: number, height: number, includePreview = false): CapturedFrame {
  const frame = captureDecodeFrame(source, width, height);
  return {
      frame,
    captureImage: includePreview ? toPreviewImage(buildPreviewFrame(frame)) : undefined
  };
}

function captureFrame(video: HTMLVideoElement, includePreview = false) {
  return createCapturedFrame(video, video.videoWidth, video.videoHeight, includePreview);
}

export function capturePdf417Preview(video: HTMLVideoElement, includePreview = true): CapturedFrame {
  return captureFrame(video, includePreview);
}

export function capturePdf417UiPreview(video: HTMLVideoElement) {
  const preview = buildPreviewFrameFromSource(video, video.videoWidth, video.videoHeight);
  return toPreviewImage(preview);
}

export async function capturePdf417Burst(video: HTMLVideoElement, initialCapture?: CapturedFrame) {
  const captures: CapturedFrame[] = initialCapture ? [initialCapture] : [capturePdf417Preview(video, false)];

  for (let attempt = captures.length; attempt < MANUAL_CAPTURE_FRAMES; attempt += 1) {
    await wait(MANUAL_CAPTURE_DELAY_MS);
    captures.push(capturePdf417Preview(video, false));
  }

  return captures;
}

async function captureFromPhotoBlob(blob: Blob) {
  const bitmap = await createImageBitmap(blob);

  try {
    return createCapturedFrame(bitmap, bitmap.width, bitmap.height, false);
  } finally {
    bitmap.close();
  }
}

async function captureFromBitmap(bitmap: ImageBitmap) {
  try {
    return createCapturedFrame(bitmap, bitmap.width, bitmap.height, false);
  } finally {
    bitmap.close();
  }
}

export async function capturePdf417HighResStill(video: HTMLVideoElement) {
  const stream = video.srcObject;
  if (!(stream instanceof MediaStream)) return null;

  const [track] = stream.getVideoTracks();
  if (!track) return null;

  const ImageCaptureCtor = (window as Window & { ImageCapture?: new (track: MediaStreamTrack) => ImageCaptureLike }).ImageCapture;
  if (!ImageCaptureCtor) return null;

  try {
    const imageCapture = new ImageCaptureCtor(track);

    if (typeof imageCapture.takePhoto === 'function') {
      const blob = await imageCapture.takePhoto();
      return await captureFromPhotoBlob(blob);
    }

    if (typeof imageCapture.grabFrame === 'function') {
      const bitmap = await imageCapture.grabFrame();
      return await captureFromBitmap(bitmap);
    }
  } catch {
    return null;
  }

  return null;
}

function wait(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function cropCanvas(source: HTMLCanvasElement, xRatio: number, yRatio: number, widthRatio: number, heightRatio: number) {
  const sx = Math.max(0, Math.round(source.width * xRatio));
  const sy = Math.max(0, Math.round(source.height * yRatio));
  const sw = Math.max(1, Math.min(source.width - sx, Math.round(source.width * widthRatio)));
  const sh = Math.max(1, Math.min(source.height - sy, Math.round(source.height * heightRatio)));
  const canvas = createCanvas(sw, sh);
  const context = getCanvasContext(canvas, true);
  context.drawImage(source, sx, sy, sw, sh, 0, 0, sw, sh);
  return canvas;
}

function captureMetrics(source: HTMLCanvasElement) {
  const context = getCanvasContext(source, true);
  const step = 4;
  const image = context.getImageData(0, 0, source.width, source.height);
  const { data } = image;
  const width = source.width;
  const height = source.height;
  let brightnessTotal = 0;
  let brightnessCount = 0;
  let laplacianTotal = 0;
  let laplacianSquared = 0;
  let laplacianCount = 0;
  let minGray = 255;
  let maxGray = 0;

  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const index = (y * width + x) * 4;
      const value = data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114;
      if (value < minGray) minGray = value;
      if (value > maxGray) maxGray = value;
      brightnessTotal += value;
      brightnessCount += 1;

      if (x < step || y < step || x >= width - step || y >= height - step) continue;

      const up = ((y - step) * width + x) * 4;
      const down = ((y + step) * width + x) * 4;
      const left = (y * width + (x - step)) * 4;
      const right = (y * width + (x + step)) * 4;
      const upGray = data[up] * 0.299 + data[up + 1] * 0.587 + data[up + 2] * 0.114;
      const downGray = data[down] * 0.299 + data[down + 1] * 0.587 + data[down + 2] * 0.114;
      const leftGray = data[left] * 0.299 + data[left + 1] * 0.587 + data[left + 2] * 0.114;
      const rightGray = data[right] * 0.299 + data[right + 1] * 0.587 + data[right + 2] * 0.114;
      const laplacian = upGray + leftGray - value * 4 + rightGray + downGray;

      laplacianTotal += laplacian;
      laplacianSquared += laplacian * laplacian;
      laplacianCount += 1;
    }
  }

  const brightness = brightnessCount ? brightnessTotal / brightnessCount : 0;
  const mean = laplacianCount ? laplacianTotal / laplacianCount : 0;
  const blurScore = laplacianCount ? laplacianSquared / laplacianCount - mean * mean : 0;
  const contrastRange = Math.max(0, maxGray - minGray);

  return { brightness, blurScore, contrastRange };
}

function applyGrayscaleContrast(source: HTMLCanvasElement) {
  const context = getCanvasContext(source, true);
  const image = context.getImageData(0, 0, source.width, source.height);
  const { data } = image;
  const contrast = 1.4;

  for (let index = 0; index < data.length; index += 4) {
    const gray = data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114;
    const value = Math.max(0, Math.min(255, (gray - 128) * contrast + 128));
    data[index] = value;
    data[index + 1] = value;
    data[index + 2] = value;
  }

  context.putImageData(image, 0, 0);
}

function applyAutoLevels(source: HTMLCanvasElement) {
  const context = getCanvasContext(source, true);
  const image = context.getImageData(0, 0, source.width, source.height);
  const { data } = image;
  let min = 255;
  let max = 0;

  for (let index = 0; index < data.length; index += 4) {
    const gray = data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114;
    if (gray < min) min = gray;
    if (gray > max) max = gray;
  }

  if (max - min < 24) {
    context.putImageData(image, 0, 0);
    return;
  }

  const scale = 255 / (max - min);

  for (let index = 0; index < data.length; index += 4) {
    const gray = data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114;
    const value = Math.max(0, Math.min(255, (gray - min) * scale));
    data[index] = value;
    data[index + 1] = value;
    data[index + 2] = value;
  }

  context.putImageData(image, 0, 0);
}

function applyBinaryThreshold(source: HTMLCanvasElement) {
  const context = getCanvasContext(source, true);
  const image = context.getImageData(0, 0, source.width, source.height);
  const { data } = image;
  let total = 0;

  for (let index = 0; index < data.length; index += 4) {
    total += data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114;
  }

  const threshold = Math.max(90, Math.min(180, total / (data.length / 4)));

  for (let index = 0; index < data.length; index += 4) {
    const gray = data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114;
    const value = gray >= threshold ? 255 : 0;
    data[index] = value;
    data[index + 1] = value;
    data[index + 2] = value;
  }

  context.putImageData(image, 0, 0);
}

function applySharpen(source: HTMLCanvasElement) {
  const context = getCanvasContext(source, true);
  const image = context.getImageData(0, 0, source.width, source.height);
  const { data } = image;
  const original = new Uint8ClampedArray(data);
  const width = source.width;
  const height = source.height;
  const kernel = [0, -1, 0, -1, 5, -1, 0, -1, 0];

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      for (let channel = 0; channel < 3; channel += 1) {
        let value = 0;
        let kernelIndex = 0;

        for (let ky = -1; ky <= 1; ky += 1) {
          for (let kx = -1; kx <= 1; kx += 1) {
            const sourceIndex = ((y + ky) * width + (x + kx)) * 4 + channel;
            value += original[sourceIndex] * kernel[kernelIndex];
            kernelIndex += 1;
          }
        }

        data[(y * width + x) * 4 + channel] = Math.max(0, Math.min(255, value));
      }
    }
  }

  context.putImageData(image, 0, 0);
}

function cloneCanvas(source: HTMLCanvasElement) {
  const canvas = createCanvas(source.width, source.height);
  const context = getCanvasContext(canvas, true);
  context.drawImage(source, 0, 0);
  return canvas;
}

function toPreviewImage(canvas: HTMLCanvasElement) {
  return canvas.toDataURL(PREVIEW_IMAGE_TYPE, PREVIEW_IMAGE_QUALITY);
}

function canvasToBlob(canvas: HTMLCanvasElement, type = DIRECT_DECODE_IMAGE_TYPE, quality?: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('Failed to convert canvas to blob.'));
        return;
      }

      resolve(blob);
    }, type, quality);
  });
}

function getVariantCaptureImage(variant: FrameVariant) {
  if (!variant.captureImage) {
    variant.captureImage = toPreviewImage(variant.canvas);
  }

  return variant.captureImage;
}

function withTransforms(source: HTMLCanvasElement, transforms: ImageTransform[]) {
  const canvas = cloneCanvas(source);

  for (const transform of transforms) {
    transform(canvas);
  }

  return canvas;
}

function getQualityMessage(attempts: number, metrics: FrameMetrics, error?: unknown) {
  if (metrics.brightness < 42) return 'The image is a bit dark. Move to brighter light or turn on the torch.';
  if (metrics.brightness > MAX_COMFORT_BRIGHTNESS) return 'The image is too bright or has glare. Tilt the card slightly or reduce direct light.';
  if (metrics.contrastRange < LOW_CONTRAST_RANGE) return 'Barcode contrast is low. Move closer and keep the barcode area centered.';
  if (metrics.blurScore < MIN_STEADY_BLUR_SCORE) return 'The card is slightly blurry. Hold it steady for a moment.';
  if (error instanceof ChecksumException) return 'Barcode is visible. Hold the card steady for a moment.';
  if (error instanceof FormatException) return 'Barcode is partly visible. Keep the full card inside the box.';
  if (attempts >= MIN_FAIL_ATTEMPTS) return 'Keep the full Driver License inside the box and make sure the barcode stays visible.';
  return 'Place the full Driver License inside the box.';
}

type DecodedCapture =
  | {
      ok: true;
      metrics: FrameMetrics;
      result: ScanResult;
    }
  | {
      ok: false;
      metrics: FrameMetrics;
      error: unknown;
      message: string;
    };

type DecodeMode = 'fast' | 'full' | 'manual';

type DecodedFrame = {
  decoded: ScanResult;
  metrics: FrameMetrics;
};

function decodeCapture(
  capture: CapturedFrame,
  attempts: number,
  mode: DecodeMode = 'full',
  includeHeavyPreprocessing = true,
  metricsOverride?: FrameMetrics
): DecodedCapture {
  try {
    const outcome = decodeCapturedFrame(capture.frame, mode, includeHeavyPreprocessing, metricsOverride);
    return {
      ok: true,
      metrics: outcome.metrics,
      result: outcome.decoded
    };
  } catch (error) {
    const metrics = metricsOverride ?? captureMetrics(capture.frame);
    return {
      ok: false,
      metrics,
      error,
      message: getQualityMessage(attempts, metrics, error)
    };
  }
}

function isAamva(raw: string) {
  return raw.includes('ANSI') || raw.includes('AAMVA');
}

function buildFrameVariants(frame: HTMLCanvasElement): FrameVariant[] {
  const fullFrame = cropCanvas(frame, 0, 0, 1, 1);
  const paddedFrame = cropCanvas(frame, 0.02, 0.02, 0.96, 0.96);
  const lowerHalf = cropCanvas(frame, 0, 0.36, 1, 0.56);
  const lowerWideBand = cropCanvas(frame, 0.02, 0.48, 0.96, 0.28);
  const centeredBarcodeBand = cropCanvas(frame, 0.08, 0.53, 0.84, 0.2);
  const bottomThird = cropCanvas(frame, 0, 0.52, 1, 0.34);
  return [
    {
      canvas: fullFrame
    },
    {
      canvas: paddedFrame
    },
    {
      canvas: centeredBarcodeBand
    },
    {
      canvas: lowerWideBand
    },
    {
      canvas: lowerHalf
    },
    {
      canvas: bottomThird
    }
  ];
}

function getFrameVariants(frame: HTMLCanvasElement, mode: DecodeMode): FrameVariant[] {
  const variants = buildFrameVariants(frame);

  if (mode === 'fast') {
    return [variants[3], variants[2], variants[0]];
  }

  if (mode === 'manual') {
    return [variants[0], variants[4], variants[3], variants[2], variants[1], variants[5]];
  }

  return variants;
}

function decodeCanvas(canvas: HTMLCanvasElement) {
  return reader.decodeFromCanvas(canvas).getText();
}

function buildDecodeCandidates(variant: FrameVariant, transformsList: ImageTransform[][]) {
  return transformsList.map((transforms) => (transforms.length === 0 ? variant.canvas : withTransforms(variant.canvas, transforms)));
}

function getDecodeCandidates(
  variant: FrameVariant,
  metrics: FrameMetrics,
  mode: DecodeMode,
  includeHeavyPreprocessing: boolean
) {
  const lowContrast = metrics.contrastRange < LOW_CONTRAST_RANGE;
  const slightlyBlurry = metrics.blurScore < MIN_STEADY_BLUR_SCORE * 1.3;
  const preferredTransforms: ImageTransform[][] =
    mode === 'manual'
      ? lowContrast
        ? [
            [],
            [applyAutoLevels],
            [applyAutoLevels, applySharpen],
            [applyGrayscaleContrast],
            [applyGrayscaleContrast, applySharpen],
            [applySharpen]
          ]
        : [
            [],
            [applySharpen],
            [applyGrayscaleContrast],
            [applyGrayscaleContrast, applySharpen],
            [applyAutoLevels],
            [applyAutoLevels, applySharpen]
          ]
      : lowContrast
        ? [[], [applyAutoLevels], [applyAutoLevels, applySharpen], [applyGrayscaleContrast], [applyGrayscaleContrast, applySharpen]]
        : [
            [],
            slightlyBlurry ? [applySharpen] : [applyGrayscaleContrast],
            slightlyBlurry ? [applyGrayscaleContrast] : [applySharpen],
            [applyGrayscaleContrast, applySharpen]
          ];

  const decodeCandidates = buildDecodeCandidates(variant, preferredTransforms);

  if (mode === 'full' || includeHeavyPreprocessing) {
    const heavyTransforms: ImageTransform[][] = lowContrast
      ? [[applyAutoLevels, applyBinaryThreshold], [applyGrayscaleContrast, applyBinaryThreshold]]
      : [[applyGrayscaleContrast, applyBinaryThreshold], [applyAutoLevels, applyBinaryThreshold]];

    decodeCandidates.push(...buildDecodeCandidates(variant, heavyTransforms));
  }

  return decodeCandidates;
}

function decodeVariant(variant: FrameVariant, metrics: FrameMetrics, mode: DecodeMode, includeHeavyPreprocessing: boolean) {
  const decodeCandidates = getDecodeCandidates(variant, metrics, mode, includeHeavyPreprocessing);

  let lastError: unknown = new NotFoundException();

  for (const candidate of decodeCandidates) {
    try {
      return {
        raw: decodeCanvas(candidate),
        captureImage: getVariantCaptureImage(variant)
      };
    } catch (error) {
      if (!(error instanceof NotFoundException)) throw error;
      lastError = error;
    }
  }

  throw lastError;
}

function decodeFrame(
  frame: HTMLCanvasElement,
  mode: DecodeMode = 'full',
  includeHeavyPreprocessing = true,
  metricsOverride?: FrameMetrics
): DecodedFrame {
  const metrics = metricsOverride ?? captureMetrics(frame);
  let lastError: unknown = new NotFoundException();

  for (const variant of getFrameVariants(frame, mode)) {
    try {
      return {
        decoded: decodeVariant(variant, metrics, mode, includeHeavyPreprocessing),
        metrics
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

function buildManualCaptureError(frame: HTMLCanvasElement, error: unknown): ManualCaptureError {
  const metrics = captureMetrics(frame);
  const fallbackMessage = getQualityMessage(MIN_FAIL_ATTEMPTS, metrics, error);
  let detail = 'Detected barcode could not be read correctly.';

  if (error instanceof ChecksumException || error instanceof FormatException || error instanceof NotFoundException) {
    detail = fallbackMessage;
  } else if (error instanceof Error && error.name === 'InvalidAamvaBarcodeError') {
    detail = 'Barcode was detected, but it is not a valid Driver License PDF417.';
  }

  return {
    message: `Manual capture failed. ${detail} Press "Capture Again" to retry.`,
    captureImage: toPreviewImage(buildPreviewFrame(frame))
  };
}

function decodeCapturedFrame(
  frame: HTMLCanvasElement,
  mode: DecodeMode = 'full',
  includeHeavyPreprocessing = true,
  metricsOverride?: FrameMetrics
): DecodedFrame {
  const outcome = decodeFrame(frame, mode, includeHeavyPreprocessing, metricsOverride);
  const { decoded } = outcome;
  if (!isAamva(decoded.raw)) {
    const error = new Error('Detected barcode is not a valid AAMVA PDF417 barcode.');
    error.name = 'InvalidAamvaBarcodeError';
    throw error;
  }

  return outcome;
}

export function createUploadPdf417Reader() {
  return createPdf417Reader();
}

export async function decodeCapturedFrameWithBarcodeDetector(capture: CapturedFrame): Promise<ScanResult | null> {
  const detector = await getPdf417BarcodeDetector();
  if (!detector) return null;

  const barcodes = await detector.detect(capture.frame).catch(() => []);
  const raw = barcodes.find((barcode) => typeof barcode.rawValue === 'string' && barcode.rawValue.trim())?.rawValue?.trim();
  if (!raw) return null;
  if (!isAamva(raw)) return null;

  return {
    raw,
    captureImage: capture.captureImage ?? toPreviewImage(buildPreviewFrame(capture.frame))
  };
}

export async function decodeCapturedFrameWithUploadReader(capture: CapturedFrame): Promise<ScanResult> {
  const reader = createUploadPdf417Reader();
  const blob = await canvasToBlob(capture.frame);
  const url = URL.createObjectURL(blob);

  try {
    const result = await reader.decodeFromImageUrl(url);
    const raw = result.getText();

    if (!isAamva(raw)) {
      const error = new Error('Detected barcode is not a valid AAMVA PDF417 barcode.');
      error.name = 'InvalidAamvaBarcodeError';
      throw error;
    }

    return {
      raw,
      captureImage: capture.captureImage ?? toPreviewImage(buildPreviewFrame(capture.frame))
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function decodeCapturedFrameHybrid(
  capture: CapturedFrame,
  mode: DecodeMode = 'full',
  includeHeavyPreprocessing = true
): Promise<DecodedFrame> {
  const detectorResult = await decodeCapturedFrameWithBarcodeDetector(capture);
  if (detectorResult) {
    return {
      decoded: detectorResult,
      metrics: captureMetrics(capture.frame)
    };
  }

  try {
    const uploadReaderResult = await decodeCapturedFrameWithUploadReader(capture);
    return {
      decoded: uploadReaderResult,
      metrics: captureMetrics(capture.frame)
    };
  } catch {
    return decodeCapturedFrame(capture.frame, mode, includeHeavyPreprocessing);
  }
}

export function capturePdf417AttemptFromBurst(captures: CapturedFrame[]): CaptureAttempt {
  return capturePdf417AttemptFromBurstWithLockedPreview(captures);
}

export function capturePdf417AttemptFromBurstWithLockedPreview(captures: CapturedFrame[], lockedPreviewImage?: string): CaptureAttempt {
  if (captures.length === 0) {
    return {
      ok: false,
      error: {
        message: 'Manual capture failed. No frame was captured. Press "Capture Again" to retry.',
        captureImage: lockedPreviewImage ?? ''
      }
    };
  }

  let bestCapture: CapturedFrame | null = captures[0] ?? null;
  let bestMetrics: FrameMetrics | null = null;
  let lastError: unknown = new NotFoundException();

  for (let attempt = 0; attempt < captures.length; attempt += 1) {
    const capture = captures[attempt];
    const outcome = decodeCapture(capture, attempt + 1, 'manual', true);
    const metrics = outcome.metrics;

    if (
      !bestCapture ||
      !bestMetrics ||
      metrics.blurScore > bestMetrics.blurScore ||
      (metrics.blurScore === bestMetrics.blurScore &&
        Math.abs(metrics.brightness - IDEAL_MANUAL_BRIGHTNESS) < Math.abs(bestMetrics.brightness - IDEAL_MANUAL_BRIGHTNESS)) ||
      (metrics.blurScore === bestMetrics.blurScore && metrics.contrastRange > bestMetrics.contrastRange)
    ) {
      bestCapture = capture;
      bestMetrics = metrics;
    }

    if (outcome.ok) {
      return {
        ok: true as const,
        result: {
          ...outcome.result,
          captureImage: lockedPreviewImage ?? outcome.result.captureImage
        }
      };
    }

    lastError = outcome.error;

  }

  const fallbackCapture = bestCapture ?? captures[0];
  const fallbackError = buildManualCaptureError(fallbackCapture.frame, lastError);
  return {
    ok: false as const,
    error: {
      ...fallbackError,
      captureImage: lockedPreviewImage ?? fallbackError.captureImage
    }
  };
}

export async function startPdf417Scanner(options: ScannerOptions): Promise<ScannerSession> {
  const stream = await navigator.mediaDevices.getUserMedia(getCameraConstraints(options.deviceId));

  try {
    await applyCameraControls(stream);
    options.video.srcObject = stream;
    options.video.muted = true;
    options.video.playsInline = true;
    await options.video.play();
  } catch (error) {
    stream.getTracks().forEach((item) => item.stop());
    BrowserCodeReader.cleanVideoSource(options.video);
    throw error;
  }

  const [track] = stream.getVideoTracks();
  const torchSupported = Boolean(track && BrowserCodeReader.mediaStreamIsTorchCompatibleTrack(track));
  let stopped = false;
  let paused = false;
  let completed = false;
  let attempts = 0;
  let timeoutId = 0;
  let lastMetrics: FrameMetrics = { brightness: 0, blurScore: 0, contrastRange: 0 };
  let scanInFlight = false;
  let stillCaptureInFlight = false;

  const scheduleNextScan = (delay = SCAN_INTERVAL_MS) => {
    if (stopped || paused || completed) return;
    window.clearTimeout(timeoutId);
    timeoutId = window.setTimeout(() => {
      void scanOnce();
    }, delay);
  };

  function pause() {
    if (stopped || paused) return;
    paused = true;
    window.clearTimeout(timeoutId);
  }

  function resume() {
    if (stopped || completed || !paused) return;
    paused = false;
    scheduleNextScan(0);
  }

  const stop = () => {
    if (stopped) return;
    stopped = true;
    window.clearTimeout(timeoutId);
    stream.getTracks().forEach((item) => item.stop());
    BrowserCodeReader.cleanVideoSource(options.video);
  };

  const finish = (decoded: ScanResult, metrics: FrameMetrics) => {
    completed = true;
    stop();
    options.onCapture?.(decoded.captureImage);
    options.onQuality({
      attempts,
      brightness: metrics.brightness,
      blurScore: metrics.blurScore,
      contrastRange: metrics.contrastRange,
      message: 'Parsing barcode...'
    });
    options.onResult(decoded);
  };

  async function tryStillCaptureFallback() {
    if (stopped || paused || completed || stillCaptureInFlight) return;

    stillCaptureInFlight = true;
    pause();

    try {
      const stillCapture = await capturePdf417HighResStill(options.video);
      if (!stillCapture) return;

      try {
        const directResult = await decodeCapturedFrameHybrid(stillCapture, 'manual', true);
        finish(directResult.decoded, directResult.metrics);
        return;
      } catch {
        return;
      }
    } finally {
      stillCaptureInFlight = false;
      if (!stopped && !completed) {
        resume();
      }
    }
  }

  const scanOnce = async () => {
    if (stopped || paused || completed) return;
    if (scanInFlight) {
      scheduleNextScan();
      return;
    }

    if (options.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      scheduleNextScan();
      return;
    }

    scanInFlight = true;

    try {
      attempts += 1;

      const capture = capturePdf417Preview(options.video, false);
      const detectorResult = await decodeCapturedFrameWithBarcodeDetector(capture);
      if (detectorResult) {
        finish(detectorResult, captureMetrics(capture.frame));
        return;
      }

      const useFastPath = attempts < AUTO_FULL_SCAN_START_ATTEMPT;
      const includeHeavyPreprocessing = !useFastPath && attempts % AUTO_HEAVY_PREPROCESS_INTERVAL === 0;
      const shouldRefreshMetrics = attempts === 1 || attempts % AUTO_METRICS_INTERVAL === 0;
      const outcome = decodeCapture(
        capture,
        attempts,
        useFastPath ? 'fast' : 'full',
        includeHeavyPreprocessing,
        shouldRefreshMetrics ? undefined : lastMetrics
      );

      if (shouldRefreshMetrics) {
        lastMetrics = outcome.metrics;
      }

      if (outcome.ok) {
        finish(outcome.result, outcome.metrics);
        return;
      }

      if (outcome.error instanceof Error && outcome.error.name === 'InvalidAamvaBarcodeError') {
        options.onError('Detected barcode is not a valid AAMVA PDF417 barcode.');
      }

      const shouldTryStillCapture =
        !stillCaptureInFlight &&
        attempts >= AUTO_STILL_CAPTURE_INTERVAL &&
        attempts % AUTO_STILL_CAPTURE_INTERVAL === 0 &&
        lastMetrics.contrastRange < LOW_CONTRAST_RANGE;

      if (shouldTryStillCapture) {
        void tryStillCaptureFallback();
      }

      options.onQuality({
        attempts,
        brightness: lastMetrics.brightness,
        blurScore: lastMetrics.blurScore,
        contrastRange: lastMetrics.contrastRange,
        message: attempts <= 2 ? 'Scanning barcode...' : outcome.message
      });
    } finally {
      scanInFlight = false;
      if (!stopped && !paused && !completed && !stillCaptureInFlight) {
        scheduleNextScan();
      }
    }
  };

  scheduleNextScan(0);

  return {
    pause,
    resume,
    torchSupported,
    stop,
    setTorch: async (enabled: boolean) => {
      if (!track || !torchSupported) return;
      await BrowserCodeReader.mediaStreamSetTorch(track, enabled);
    }
  };
}
