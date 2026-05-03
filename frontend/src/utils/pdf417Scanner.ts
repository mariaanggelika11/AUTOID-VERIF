import { BarcodeFormat, BrowserCodeReader, BrowserMultiFormatReader } from '@zxing/browser';
import { ChecksumException, DecodeHintType, FormatException, NotFoundException } from '@zxing/library';

export type ScanQuality = {
  attempts: number;
  brightness: number;
  blurScore: number;
  message: string;
};

export type ScanResult = {
  raw: string;
  captureImage: string;
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
};

type FrameVariant = {
  canvas: HTMLCanvasElement;
  captureImage: string;
};

export type ScannerSession = {
  stop: () => void;
  setTorch: (enabled: boolean) => Promise<void>;
  torchSupported: boolean;
};

const SCAN_INTERVAL_MS = 120;
const ROI_WIDTH_RATIO = 0.94;
const ROI_HEIGHT_RATIO = 0.76;
const CAPTURE_SCALE = 1.4;
const MIN_STEADY_BLUR_SCORE = 6;
const MAX_COMFORT_BRIGHTNESS = 225;
const MIN_FAIL_ATTEMPTS = 6;

const hints = new Map<DecodeHintType, unknown>([
  [DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.PDF_417]]
]);

const reader = new BrowserMultiFormatReader(hints) as BrowserMultiFormatReader & {
  timeBetweenDecodingAttempts?: number;
};
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
  return canvas;
}

function getRoi(video: HTMLVideoElement) {
  const width = Math.round(video.videoWidth * ROI_WIDTH_RATIO);
  const height = Math.round(video.videoHeight * ROI_HEIGHT_RATIO);
  const x = Math.round((video.videoWidth - width) / 2);
  const y = Math.round((video.videoHeight - height) / 2);
  return { x, y, width, height };
}

function captureFrame(video: HTMLVideoElement) {
  const roi = getRoi(video);
  const canvas = createCanvas(roi.width * CAPTURE_SCALE, roi.height * CAPTURE_SCALE);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas context is not available.');

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(video, roi.x, roi.y, roi.width, roi.height, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function cropCanvas(source: HTMLCanvasElement, xRatio: number, yRatio: number, widthRatio: number, heightRatio: number) {
  const sx = Math.max(0, Math.round(source.width * xRatio));
  const sy = Math.max(0, Math.round(source.height * yRatio));
  const sw = Math.max(1, Math.min(source.width - sx, Math.round(source.width * widthRatio)));
  const sh = Math.max(1, Math.min(source.height - sy, Math.round(source.height * heightRatio)));
  const canvas = createCanvas(sw, sh);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas context is not available.');

  context.drawImage(source, sx, sy, sw, sh, 0, 0, sw, sh);
  return canvas;
}

function captureMetrics(source: HTMLCanvasElement) {
  const context = source.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Canvas context is not available.');

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

  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const index = (y * width + x) * 4;
      const value = data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114;
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

  return { brightness, blurScore };
}

function applyGrayscaleContrast(source: HTMLCanvasElement) {
  const context = source.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Canvas context is not available.');

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

function getQualityMessage(attempts: number, metrics: FrameMetrics, error?: unknown) {
  if (metrics.brightness < 55) return 'The image is too dark. Move to brighter light or turn on the torch.';
  if (metrics.brightness > MAX_COMFORT_BRIGHTNESS) return 'The image is too bright or has glare. Tilt the card slightly or reduce direct light.';
  if (metrics.blurScore < MIN_STEADY_BLUR_SCORE) return 'The card is a bit blurry. Hold it steady for a moment.';
  if (error instanceof ChecksumException) return 'Barcode is visible. Hold the card steady for a moment.';
  if (error instanceof FormatException) return 'Barcode is partly visible. Keep the full card inside the box.';
  if (attempts >= MIN_FAIL_ATTEMPTS) return 'Keep the full Driver License inside the box and make sure the barcode stays visible.';
  return 'Place the full Driver License inside the box.';
}

function isAamva(raw: string) {
  return raw.includes('ANSI') || raw.includes('AAMVA');
}

function buildFrameVariants(frame: HTMLCanvasElement): FrameVariant[] {
  const fullFrame = cropCanvas(frame, 0, 0, 1, 1);
  const barcodeBand = cropCanvas(frame, 0.02, 0.56, 0.96, 0.24);
  const widerBarcodeBand = cropCanvas(frame, 0, 0.5, 1, 0.3);
  return [
    {
      canvas: fullFrame,
      captureImage: fullFrame.toDataURL('image/jpeg', 0.84)
    },
    {
      canvas: barcodeBand,
      captureImage: barcodeBand.toDataURL('image/jpeg', 0.88)
    },
    {
      canvas: widerBarcodeBand,
      captureImage: widerBarcodeBand.toDataURL('image/jpeg', 0.86)
    }
  ];
}

function decodeCanvas(canvas: HTMLCanvasElement) {
  return reader.decodeFromCanvas(canvas).getText();
}

function decodeVariant(variant: FrameVariant) {
  try {
    return {
      raw: decodeCanvas(variant.canvas),
      captureImage: variant.captureImage
    };
  } catch (error) {
    if (!(error instanceof NotFoundException)) throw error;
  }

  applyGrayscaleContrast(variant.canvas);
  return {
    raw: decodeCanvas(variant.canvas),
    captureImage: variant.captureImage
  };
}

function decodeFrame(frame: HTMLCanvasElement) {
  let lastError: unknown = new NotFoundException();

  for (const variant of buildFrameVariants(frame)) {
    try {
      return decodeVariant(variant);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

export function createUploadPdf417Reader() {
  return new BrowserMultiFormatReader(
    new Map<DecodeHintType, unknown>([
      [DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.PDF_417]],
      [DecodeHintType.TRY_HARDER, true]
    ])
  );
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
  let completed = false;
  let attempts = 0;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    window.clearInterval(intervalId);
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
      message: 'Parsing barcode...'
    });
    options.onResult(decoded);
  };

  const scanOnce = () => {
    if (stopped || completed || options.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;

    attempts += 1;

    try {
      const frame = captureFrame(options.video);
      const metrics = captureMetrics(frame);
      options.onQuality({
        attempts,
        brightness: metrics.brightness,
        blurScore: metrics.blurScore,
        message: attempts <= 2 ? 'Scanning barcode...' : getQualityMessage(attempts, metrics)
      });

      const decoded = decodeFrame(frame);

      if (!isAamva(decoded.raw)) {
        options.onError('Detected barcode is not a valid AAMVA PDF417 barcode.');
        options.onQuality({
          attempts,
          brightness: metrics.brightness,
          blurScore: metrics.blurScore,
          message: 'Barcode was detected, but it is not a valid Driver License PDF417.'
        });
        return;
      }

      finish(decoded, metrics);
    } catch (error) {
      const metrics = { brightness: 0, blurScore: 0 };
      options.onQuality({
        attempts,
        brightness: metrics.brightness,
        blurScore: metrics.blurScore,
        message: getQualityMessage(attempts, metrics, error)
      });
    }
  };

  const intervalId = window.setInterval(scanOnce, SCAN_INTERVAL_MS);

  return {
    torchSupported,
    stop,
    setTorch: async (enabled: boolean) => {
      if (!track || !torchSupported) return;
      await BrowserCodeReader.mediaStreamSetTorch(track, enabled);
    }
  };
}
